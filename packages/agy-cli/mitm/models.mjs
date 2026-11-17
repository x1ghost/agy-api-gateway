import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
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
