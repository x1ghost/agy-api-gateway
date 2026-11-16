import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
export const pickerPrefix = 'claude-agy/'
export function upstreamModel(id) {
  return id.startsWith(pickerPrefix) ? id.slice(pickerPrefix.length) : id
}

// AGY supplies IDs and display names, but not model creation dates. The epoch
// is a required Anthropic-compatible placeholder, not a claim about release.
export function parseModels(output) {
  const result = [], seen = new Set()
  for (const line of output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    const match = line.match(/^\s*([a-z0-9][a-z0-9._-]*)(?:\t+| {2,})(.+?)\s*$/i)
    if (!match || seen.has(match[1])) continue
    seen.add(match[1])
    const model = { type: 'model', id: match[1], display_name: match[2], created_at: '1970-01-01T00:00:00Z' }
    result.push(model)
    if (!/claude|anthropic/i.test(model.id)) result.push({ ...model, id: pickerPrefix + model.id, description: `AGY model ${model.id}` })
  }
  if (!result.length) throw Object.assign(new Error('Official AGY returned no recognizable models'), { status: 502 })
  return result
}

export function createModelProvider({ agy, workspace, env, cacheMs = 300000 }) {
  let cached, expires = 0, pending
  return async () => {
    if (cached && Date.now() < expires) return cached
    if (!pending) pending = (async () => {
      try {
        const { stdout } = await run(agy, ['models'], { cwd: workspace, env, timeout: 60000, maxBuffer: 1024 * 1024 })
        cached = parseModels(stdout); expires = Date.now() + cacheMs
        return cached
      } catch (error) {
        if (error.status) throw error
        throw Object.assign(new Error('Could not list models using official AGY CLI'), { status: 502 })
      }
    })().finally(() => { pending = null })
    return pending
  }
}

export function modelPage(models, params) {
  const limitText = params.get('limit') ?? '20'
  if (!/^\d+$/.test(limitText) || +limitText < 1 || +limitText > 1000) throw Object.assign(new Error('Invalid model list limit'), { status: 400 })
  const after = params.get('after_id'), before = params.get('before_id')
  if (after && before) throw Object.assign(new Error('Specify only one model cursor'), { status: 400 })
  let start = 0, end = models.length
  if (after || before) {
    const pos = models.findIndex(model => model.id === (after || before))
    if (pos < 0) throw Object.assign(new Error('Unknown model cursor'), { status: 400 })
    if (after) start = pos + 1
    else end = pos
  }
  const limit = +limitText
  const data = before ? models.slice(Math.max(start, end - limit), end) : models.slice(start, Math.min(end, start + limit))
  const has_more = before ? end - start > limit : start + limit < end
  return { data, has_more, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null }
}
