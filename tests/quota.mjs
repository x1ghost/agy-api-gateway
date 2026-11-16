import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { readQuota, refreshQuota } from '../quota.mjs'
import { parseUsageReport } from '../packages/agy-cli/usage.mjs'

test('quota refresh preserves reported values and cache remains private', async t => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-quota-'))
  t.after(() => fs.rm(state, { recursive: true, force: true }))
  let calls = 0
  const report = await refreshQuota(state, async () => { calls++; return { windows: [{ name: 'Fixture', used: 25 }, { name: 'Unknown', display: 'Limits not available' }] } }, 'fixture')
  assert.equal(calls, 1)
  assert.deepEqual(await readQuota(state), report)
  assert.equal(calls, 1)
  const entry = new URL('../agy-usage', import.meta.url).pathname
  assert.deepEqual(JSON.parse(execFileSync(entry, [], { env: { ...process.env, NODE_PATH: process.execPath, AGY_MITM_STATE_DIR: state }, encoding: 'utf8' })), report)
  assert.equal((await fs.stat(path.join(state, 'quota-cache.json'))).mode & 0o777, 0o600)
  await assert.rejects(refreshQuota(state, async () => { throw Error('unavailable') }), /unavailable/)
  assert.deepEqual(await readQuota(state), report)
})

test('official usage report does not invent unknown allowance', () => {
  const report = { status: 'SUCCESS', command: { name: 'usage', data: { groups: [{ name: 'Fixture', buckets: [{ id: 'weekly', remainingFraction: .75 }, { id: 'other' }] }] } } }
  const { windows } = parseUsageReport(report)
  assert.equal(windows[0].used, 25)
  assert.equal(windows[1].display, 'Limits not available')
})
