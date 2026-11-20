// Version badge backend (lib/latest.js): version ordering, registry fallback, caching, install kind.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareVersions, createLatestChecker, installKind, LATEST_OK_TTL_MS, LATEST_FAIL_TTL_MS } from '../lib/latest.js'

const tests = []
const t = (name, fn) => tests.push([name, fn])
const answer = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })

t('compareVersions orders releases and prereleases', () => {
  assert.ok(compareVersions('0.2.5', '0.2.4') > 0)
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0, 'numeric, not lexical')
  assert.equal(compareVersions('0.2.4', '0.2.4'), 0)
  assert.ok(compareVersions('0.2.4', '0.2.5') < 0)
  assert.ok(compareVersions('0.3.0', '0.3.0-rc.1') > 0, 'release after its prerelease')
  assert.equal(compareVersions('garbage', '0.2.4'), 0)
})

t('npm answers: latest from the first registry', async () => {
  const seen = []
  const check = createLatestChecker({ fetchImpl: async (url) => { seen.push(url); return answer({ version: '0.2.9' }) } })
  const r = await check()
  assert.equal(r.latest, '0.2.9')
  assert.equal(seen.length, 1)
  assert.match(seen[0], /^https:\/\/registry\.npmjs\.org\/dsh-llm-acp\/latest$/)
})

t('npm fails: falls back to npmmirror', async () => {
  const check = createLatestChecker({ fetchImpl: async (url) => (url.includes('npmjs.org') ? answer({}, 503) : answer({ version: '0.2.8' })) })
  const r = await check()
  assert.equal(r.latest, '0.2.8')
  assert.match(r.registry, /npmmirror/)
})

t('every registry fails: error, no latest', async () => {
  const check = createLatestChecker({ fetchImpl: async () => { throw new Error('offline') } })
  const r = await check()
  assert.equal(r.latest, null)
  assert.match(r.error, /offline/)
})

t('cache: 30 min after success, 5 min after failure, force skips it', async () => {
  let clock = 0
  let calls = 0
  let fail = false
  const check = createLatestChecker({ now: () => clock, fetchImpl: async () => { calls++; if (fail) throw new Error('down'); return answer({ version: '0.2.5' }) } })
  await check(); clock += LATEST_OK_TTL_MS - 1; await check()
  assert.equal(calls, 1, 'cached within the success TTL')
  await check({ force: true })
  assert.equal(calls, 2, 'force asks again')
  fail = true; clock += LATEST_OK_TTL_MS
  await check() // npm + npmmirror both fail
  const after = calls
  clock += LATEST_FAIL_TTL_MS - 1; await check()
  assert.equal(calls, after, 'failure cached for the shorter TTL')
  clock += 2; await check()
  assert.ok(calls > after, 'retried after the failure TTL')
})

t('concurrent checks share one request', async () => {
  let calls = 0
  const check = createLatestChecker({ fetchImpl: async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return answer({ version: '1.0.0' }) } })
  const [a, b] = await Promise.all([check(), check()])
  assert.equal(calls, 1)
  assert.equal(a.latest, b.latest)
})

t('installKind: node_modules copy is registry, a symlinked checkout is link', () => {
  const root = mkdtempSync(join(tmpdir(), 'acp-kind-'))
  try {
    const reg = join(root, 'profile', 'node_modules', 'dsh-llm-acp')
    mkdirSync(reg, { recursive: true })
    const dev = join(root, 'dev', 'dsh-llm-acp')
    mkdirSync(dev, { recursive: true })
    const linked = join(root, 'profile2', 'node_modules', 'dsh-llm-acp')
    mkdirSync(join(root, 'profile2', 'node_modules'), { recursive: true })
    symlinkSync(dev, linked, 'dir')
    assert.equal(installKind(reg), 'registry')
    assert.equal(installKind(linked), 'link', 'a link: install resolves to the checkout')
    assert.equal(installKind(join(root, 'missing')), 'unknown')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`) } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e?.message}`) }
}
console.log(`\nlatest-check: ${tests.length - failed}/${tests.length} passed`)
process.exit(failed ? 1 : 0)
