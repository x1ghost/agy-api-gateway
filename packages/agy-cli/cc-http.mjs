import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { createHash, randomUUID, timingSafeEqual } from "node:crypto"

const hash = value => createHash("sha256").update(value).digest("hex")
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const errorBody = (message, status) => JSON.stringify({ type: "error", error: { type: status === 429 ? "rate_limit_error" : "invalid_request_error", message } })
const fail = (status, message) => Object.assign(new Error(message), { status })
const cancellation = message => Object.assign(new Error(message), { code: "CC_CANCELLED" })
const authenticated = (left, right) => {
  const a = Buffer.from(left || ""), b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

// HTTP disconnects detach only the subscriber. The sole upstream reader keeps
// journalling, so reconnects can replay exactly the same bytes and tool IDs.
// A process crash before completion is an explicit 409, never an automatic
// second generation whose tools CC may already have executed.
export function createCcServer({ fetchMessages, cancelSession = async () => {}, resolveMessage, stateDir, token, upstreamTransport = "acp", statelessRequests = false,
  maxRequestBytes = 32 * 1024 * 1024, maxResponseBytes = 32 * 1024 * 1024, maxRecords = 1024, upstreamCooldownMs = 0 }) {
  if (!token || !stateDir || typeof fetchMessages !== "function") throw new Error("token, stateDir and fetchMessages are required")
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(stateDir, 0o700)
  if (!Number.isSafeInteger(upstreamCooldownMs) || upstreamCooldownMs < 0) throw new Error("Invalid upstream cooldown")
  const cooldownPath = path.join(stateDir, "upstream-cooldown.json")
  let cooldownUntil = 0
  try { cooldownUntil = Number(JSON.parse(fs.readFileSync(cooldownPath, "utf8")).until) || 0 } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  function rateLimited() {
    if (!upstreamCooldownMs) return
    cooldownUntil = Math.max(cooldownUntil, Date.now() + upstreamCooldownMs)
    const temporary = cooldownPath + ".tmp"
    fs.writeFileSync(temporary, JSON.stringify({ until: cooldownUntil }), { mode: 0o600 })
    fs.renameSync(temporary, cooldownPath)
  }
  const records = new Map()
  const busy = new Map()
  let shuttingDown = false
  let inFlight = 0
  const metaPath = id => path.join(stateDir, `${id}.json`)
  const bodyPath = id => path.join(stateDir, `${id}.body`)
  function save(meta) {
    const temporary = `${metaPath(meta.id)}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(meta), { mode: 0o600 })
    fs.renameSync(temporary, metaPath(meta.id))
  }
  function load(id) {
    try { return JSON.parse(fs.readFileSync(metaPath(id), "utf8")) } catch (error) {
      if (error.code === "ENOENT") return null
      throw error
    }
  }
  function wake(record) {
    for (const resolve of record.waiters) resolve()
    record.waiters.clear()
  }
  async function readBody(req) {
    let size = 0
    const chunks = []
    for await (const chunk of req) {
      size += chunk.length
      if (size > maxRequestBytes) throw fail(413, "Request body exceeds the configured byte limit")
      chunks.push(chunk)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) } catch { throw fail(400, "Invalid JSON body") }
  }
  function scope(req, body) {
    const id = req.headers["x-cc-session-id"] || body?.metadata?.user_id
    if (id === undefined && statelessRequests && req.method === "POST" && req.url?.split("?")[0] === "/v1/messages") {
      const key = req.headers["idempotency-key"]
      if (key !== undefined && (typeof key !== "string" || !key || key.length > 256)) throw fail(400, "Invalid Idempotency-Key")
      return key ? `gateway:${hash(key)}` : `gateway:${randomUUID()}`
    }
    if (typeof id !== "string" || !id || id.length > 4096) {
      throw fail(400, "Provide CC metadata.user_id or X-CC-Session-ID; use a distinct ID for each branch")
    }
    return `cc:${hash(id)}`
  }
  async function pump(record, body) {
    let fd
    try {
      const response = await fetchMessages("agy://local/v1/messages", {
        method: "POST", body: JSON.stringify(body), signal: record.controller.signal, requestId: record.meta.id,
      })
      if (response.status === 429) rateLimited()
      record.meta.statusCode = response.status
      record.meta.headers = Object.fromEntries(response.headers)
      // Do not forward hop-by-hop or byte-length headers onto a replay.
      for (const key of ["content-length", "connection", "transfer-encoding", "content-encoding"]) delete record.meta.headers[key]
      save(record.meta)
      fd = fs.openSync(bodyPath(record.meta.id), "wx", 0o600)
      record.ready = true
      wake(record)
      const reader = response.body?.getReader()
      record.reader = reader
      const decoder = new TextDecoder()
      let sseTail = ""
      const observesSse = upstreamCooldownMs > 0 && response.headers.get("content-type")?.includes("text/event-stream")
      for (;;) {
        const next = reader ? await reader.read() : { done: true }
        if (next.done) break
        if (record.controller.signal.aborted) throw new Error("Request cancelled")
        const chunk = Buffer.from(next.value)
        if (observesSse) {
          sseTail += decoder.decode(next.value, { stream: true })
          let boundary
          while ((boundary = sseTail.indexOf("\n\n")) >= 0) {
            const frame = sseTail.slice(0, boundary)
            sseTail = sseTail.slice(boundary + 2)
            if (!/^event:\s*error\s*$/m.test(frame)) continue
            const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n")
            let payload
            try { payload = JSON.parse(data) } catch { continue }
            if (payload.error?.type === "rate_limit_error") rateLimited()
          }
          if (sseTail.length > maxResponseBytes) throw new Error("Oversized SSE frame")
        }
        record.bytes += chunk.length
        if (record.bytes > maxResponseBytes) throw new Error("Response exceeds the configured journal byte limit")
        let offset = 0
        while (offset < chunk.length) {
          const written = fs.writeSync(fd, chunk, offset, chunk.length - offset)
          if (!written) throw new Error("Response journal write made no progress")
          offset += written
        }
        fs.fdatasyncSync(fd)
        record.chunks.push(chunk)
        wake(record)
      }
      if (record.controller.signal.aborted) throw new Error("Request cancelled")
      record.meta.state = "complete"
      save(record.meta)
    } catch (error) {
      record.error = error
      record.meta.state = record.controller.signal.aborted ? "cancelled" : "interrupted"
      try { save(record.meta) } catch { /* An existing generating record also prevents unsafe replay. */ }
      record.controller.abort(error)
      try { await record.reader?.cancel(error) } catch {}
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd) } catch {} }
      record.done = true
      wake(record)
      if (busy.get(record.meta.scope) === record) busy.delete(record.meta.scope)
      records.delete(record.meta.id)
    }
  }
  async function write(res, chunk) {
    if (res.destroyed) return false
    if (res.write(chunk)) return true
    return new Promise(resolve => {
      const finish = ok => { res.off("drain", drained); res.off("close", closed); resolve(ok) }
      const drained = () => finish(true), closed = () => finish(false)
      res.once("drain", drained)
      res.once("close", closed)
      if (res.destroyed) finish(false)
    })
  }
  function wait(record, res) {
    if (res.destroyed) return Promise.resolve()
    return new Promise(resolve => {
      const finish = () => { record.waiters.delete(finish); res.off("close", finish); resolve() }
      record.waiters.add(finish)
      res.once("close", finish)
    })
  }
  async function subscribe(record, res) {
    while (!record.ready && !record.done && !res.destroyed) await wait(record, res)
    if (res.destroyed) return
    if (!record.ready) throw fail(502, "AGY request failed before response headers")
    res.writeHead(record.meta.statusCode, { ...record.meta.headers, "x-agy-request-id": record.meta.id, "cache-control": "no-store" })
    res.flushHeaders()
    let index = 0
    for (;;) {
      while (index < record.chunks.length) if (!await write(res, record.chunks[index++])) return
      if (res.destroyed) return
      if (record.done) break
      await wait(record, res)
    }
    if (record.error) res.destroy(record.error)
    else res.end()
  }
  async function replay(meta, res) {
    if (meta.state !== "complete") throw fail(409, "Previous generation was cancelled or interrupted; continue from CC's retained history")
    if (!fs.existsSync(bodyPath(meta.id))) throw fail(409, "Response journal is missing; continue from CC's retained history")
    res.writeHead(meta.statusCode, { ...meta.headers, "x-agy-request-id": meta.id, "cache-control": "no-store" })
    res.flushHeaders()
    for await (const chunk of fs.createReadStream(bodyPath(meta.id))) if (!await write(res, chunk)) return
    res.end()
  }
  const server = http.createServer(async (req, res) => {
    inFlight++
    res.on("error", () => {})
    try {
      if (shuttingDown) throw fail(503, "Bridge is shutting down")
      const url = new URL(req.url, "http://localhost")
      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok", mode: "cc-strict", transport: upstreamTransport, active: busy.size }))
        return
      }
      const key = req.headers["x-api-key"] || req.headers.authorization?.replace(/^Bearer /i, "")
      if (!authenticated(key, token)) throw fail(401, "Invalid bridge token")
      if (req.method !== "POST" || !["/v1/messages", "/v1/messages/count_tokens", "/v1/cancel"].includes(url.pathname)) {
        throw fail(404, "Unknown endpoint")
      }
      const body = await readBody(req)
      if (!body || typeof body !== "object" || Array.isArray(body)) throw fail(400, "Expected a JSON object")
      if (url.pathname === "/v1/messages/count_tokens") {
        const response = await fetchMessages("agy://local/v1/messages/count_tokens", { method: "POST", body: JSON.stringify(body) })
        res.writeHead(response.status, { "content-type": "application/json", "x-agy-usage-kind": "estimate" }).end(await response.text())
        return
      }
      if (url.pathname === "/v1/cancel" && Object.hasOwn(body, "message_id")) {
        if (typeof body.message_id !== "string" || !/^msg_[a-f0-9]{32}$/.test(body.message_id)) throw fail(400, "Invalid message_id")
        if (typeof resolveMessage !== "function") throw fail(501, "Targeted message cancellation is unavailable")
        // Resolve the exact currently running response, never its whole branch.
        // A delayed transcript event cannot cancel a newer generation.
        const id = resolveMessage(body.message_id), record = id && records.get(id)
        if (!record || record.done) {
          res.writeHead(200, { "content-type": "application/json" }).end('{"cancelled":false,"reason":"not_active"}')
          return
        }
        record.controller.abort(cancellation("CC interrupted this message"))
        record.meta.state = "cancelled"; save(record.meta)
        res.writeHead(200, { "content-type": "application/json" }).end('{"cancelled":true}')
        return
      }
      const sessionScope = scope(req, body)
      if (url.pathname === "/v1/cancel") {
        for (const record of records.values()) if (record.meta.scope === sessionScope) record.controller.abort(cancellation("CC cancelled"))
        await cancelSession(sessionScope)
        for (const file of fs.readdirSync(stateDir).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
          const meta = load(file.slice(0, -5))
          if (meta?.scope === sessionScope) { meta.state = "cancelled"; save(meta) }
        }
        res.writeHead(200, { "content-type": "application/json" }).end('{"cancelled":true}')
        return
      }
      if (!Array.isArray(body.messages) || !body.messages.length || typeof body.model !== "string" || !body.model) {
        throw fail(400, "model and nonempty messages are required")
      }
      body.metadata = { ...body.metadata, user_id: sessionScope }
      const requestHash = hash(stable(body))
      const keyHeader = req.headers["idempotency-key"]
      if (keyHeader && (typeof keyHeader !== "string" || keyHeader.length > 256)) throw fail(400, "Invalid Idempotency-Key")
      const id = hash(`${sessionScope}\n${keyHeader || requestHash}`)
      let record = records.get(id)
      const meta = record?.meta || load(id)
      if (meta && meta.requestHash !== requestHash) throw fail(409, "Idempotency-Key was already used with a different body")
      if (meta && !record) { await replay(meta, res); return }
      if (!record) {
        if (upstreamCooldownMs && Date.now() < cooldownUntil) {
          const error = fail(429, "Official AGY refused the previous request; bridge cooldown is active. No new model request was sent.")
          error.retryAfter = Math.max(1, Math.ceil((cooldownUntil - Date.now()) / 1000))
          throw error
        }
        const previous = busy.get(sessionScope)
        if (previous) {
          if (previous.subscribers.size) throw fail(409, "This CC branch already has an active HTTP response")
          // A different CC request after detachment supersedes the orphaned
          // generation. An identical retry above always reattaches instead.
          previous.controller.abort(cancellation("CC continued with different retained history"))
          await cancelSession(sessionScope)
          await previous.task
          if (busy.has(sessionScope)) throw fail(409, "This CC branch already has an active HTTP response")
        }
        // Never evict a pending tool response implicitly. Explicit retention
        // limits return 507 so the operator can archive a finished state dir.
        if (fs.readdirSync(stateDir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length >= maxRecords) {
          throw fail(507, "Journal record limit reached; archive the state directory after completing pending tools")
        }
        record = { meta: { id, requestHash, scope: sessionScope, state: "generating" },
          chunks: [], bytes: 0, waiters: new Set(), subscribers: new Set(), controller: new AbortController(), ready: false, done: false }
        save(record.meta)
        records.set(id, record)
        busy.set(sessionScope, record)
        record.task = pump(record, body)
      }
      record.subscribers.add(res)
      try { await subscribe(record, res) } finally { record.subscribers.delete(res) }
    } catch (error) {
      if (res.headersSent) res.destroy(error)
      else if (!res.destroyed) res.writeHead(error.status || 500, { "content-type": "application/json", "x-should-retry": "false", ...(error.retryAfter ? { "retry-after": String(error.retryAfter) } : {}) }).end(errorBody(error.message, error.status))
    } finally { inFlight-- }
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 15_000
  return {
    server,
    async close() {
      shuttingDown = true
      for (const record of records.values()) record.controller.abort(cancellation("Bridge shutting down"))
      await Promise.all([...busy.keys()].map(cancelSession))
      await Promise.all([...records.values()].map(record => record.task))
      const closed = new Promise(resolve => server.close(resolve))
      server.closeAllConnections()
      await closed
    },
    get activeRequests() { return inFlight },
  }
}
