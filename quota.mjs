#!/usr/bin/env node
// Read a private, timestamped quota snapshot or explicitly refresh via AGY.
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { fetchUsage } from './packages/agy-cli/usage.mjs'

export async function readQuota(state) {
  const report = JSON.parse(await fs.readFile(path.join(state, 'quota-cache.json'), 'utf8'))
  if (report.version !== 1 || typeof report.fetched_at !== 'string' || !Array.isArray(report.windows)) throw Error('Invalid quota cache')
  return report
}

export async function refreshQuota(state, read = fetchUsage, agy = process.env.AGY_PATH || 'agy') {
  const result = await read(agy)
  const report = { version: 1, fetched_at: new Date().toISOString(), windows: result.windows }
  const temporary = path.join(state, `.quota-${randomUUID()}.tmp`)
  try {
    await fs.writeFile(temporary, JSON.stringify(report), { mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, path.join(state, 'quota-cache.json'))
  } finally { await fs.rm(temporary, { force: true }) }
  return report
}

async function main() {
  const state = process.env.AGY_MITM_STATE_DIR
  if (!state || !path.isAbsolute(state)) throw Error('Set AGY_MITM_STATE_DIR to the gateway state directory')
  const stat = await fs.lstat(state)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) throw Error('State directory must be private and owned by the current user')
  const args = process.argv.slice(2)
  if (args.length > 1 || args.length === 1 && args[0] !== '--refresh') throw Error('Usage: node quota.mjs [--refresh]')
  try {
    const report = args[0] === '--refresh' ? await refreshQuota(state) : await readQuota(state)
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } catch (error) {
    if (error.code === 'ENOENT' && args.length === 0) throw Error('No cached quota report; run node quota.mjs --refresh')
    throw error
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
