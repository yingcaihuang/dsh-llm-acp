// Version badge backend (lib/latest.js): version ordering, npm + npmmirror agreement, mirror lag,
// caching, request sharing, release notes and install kind.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanNotes, compareVersions, createLatestChecker, installKind, LATEST_OK_TTL_MS, LATEST_FAIL_TTL_MS, LATEST_LAG_TTL_MS, MIRROR_SYNC_EVERY_MS } from '../lib/latest.js'

const tests = []
const t = (name, fn) => tests.push([name, fn])
const answer = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })
const ONE = ['https://r.example/']
const SYNC = 'PUT https://registry-direct.npmmirror.com/-/package/dsh-llm-acp/syncs'
/** Fetch stub keyed by a URL fragment: a version string, a manifest object, an HTTP status or an Error. */
const regs = (table, seen = []) => async (url, init = {}) => {
  const method = init.method ?? 'GET'
  seen.push(`${method} ${url}`)
  if (method === 'PUT') return answer({ ok: true })
  for (const [frag, v] of Object.entries(table)) {
    if (!url.includes(frag)) continue
    if (v instanceof Error) throw v
    if (typeof v === 'number') return answer({}, v)
    return answer(typeof v === 'string' ? { version: v } : v)
  }
  throw new Error(`unexpected ${url}`)
}

t('compareVersions orders releases and prereleases', () => {
  assert.ok(compareVersions('0.2.5', '0.2.4') > 0)
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0, 'numeric, not lexical')
  assert.equal(compareVersions('0.2.4', '0.2.4'), 0)
  assert.ok(compareVersions('0.2.4', '0.2.5') < 0)
  assert.ok(compareVersions('0.3.0', '0.3.0-rc.1') > 0, 'release after its prerelease')
  assert.equal(compareVersions('garbage', '0.2.4'), 0)
})

t('both registries agree: that version, nothing lagging, both asked, no sync nudge', async () => {
  const seen = []
  const r = await createLatestChecker({ fetchImpl: regs({ npmjs: '0.2.9', npmmirror: '0.2.9' }, seen) })()
  assert.equal(r.latest, '0.2.9')
  assert.equal(r.newest, '0.2.9')
  assert.deepEqual(r.lagging, [])
  assert.ok(seen.includes('GET https://registry.npmjs.org/dsh-llm-acp/latest'))
  assert.ok(seen.includes('GET https://registry.npmmirror.com/dsh-llm-acp/latest'))
  assert.ok(!seen.some((s) => s.startsWith('PUT')))
})

t('mirror behind npm: offer only what the mirror has, nudge the mirror (rate-limited)', async () => {
  let clock = 0
  const seen = []
  const check = createLatestChecker({ now: () => clock, fetchImpl: regs({ npmjs: '0.2.7', npmmirror: '0.2.6' }, seen) })
  const r = await check()
  assert.equal(r.latest, '0.2.6', 'the version DSH can actually install')
  assert.equal(r.newest, '0.2.7')
  assert.deepEqual(r.lagging, ['registry.npmmirror.com'])
  assert.equal(seen.filter((s) => s === SYNC).length, 1)
  clock += LATEST_LAG_TTL_MS; await check()
  assert.equal(seen.filter((s) => s === SYNC).length, 1, 'no second nudge inside the window')
  clock += MIRROR_SYNC_EVERY_MS; await check()
  assert.equal(seen.filter((s) => s === SYNC).length, 2)
})

t('npm unreachable: the mirror alone decides', async () => {
  const r = await createLatestChecker({ fetchImpl: regs({ npmjs: 503, npmmirror: '0.2.8' }) })()
  assert.equal(r.latest, '0.2.8')
  assert.match(r.registry, /npmmirror/)
  assert.deepEqual(r.lagging, [])
})

t('mirror unreachable: npm alone decides', async () => {
  const r = await createLatestChecker({ fetchImpl: regs({ npmjs: '0.2.8', npmmirror: new Error('offline') }) })()
  assert.equal(r.latest, '0.2.8')
  assert.deepEqual(r.lagging, [])
})

t('every registry fails: error, no latest', async () => {
  const r = await createLatestChecker({ fetchImpl: regs({ npmjs: new Error('offline'), npmmirror: new Error('offline') }) })()
  assert.equal(r.latest, null)
  assert.equal(r.newest, null)
  assert.match(r.error, /offline/)
})

t('cache: 30 min after success, 5 min after failure, force skips it', async () => {
  let clock = 0
  let calls = 0
  let fail = false
  const check = createLatestChecker({ now: () => clock, registries: ONE, syncMirror: false, fetchImpl: async () => { calls++; if (fail) throw new Error('down'); return answer({ version: '0.2.5' }) } })
  await check(); clock += LATEST_OK_TTL_MS - 1; await check()
  assert.equal(calls, 1, 'cached within the success TTL')
  await check({ force: true })
  assert.equal(calls, 2, 'force asks again')
  fail = true; clock += LATEST_OK_TTL_MS; await check()
  assert.equal(calls, 3)
  clock += LATEST_FAIL_TTL_MS - 1; await check()
  assert.equal(calls, 3, 'failure cached for the shorter TTL')
  clock += 2; await check()
  assert.equal(calls, 4, 'retried after the failure TTL')
})

t('a lagging answer is asked again after 2 min', async () => {
  let clock = 0
  let gets = 0
  const check = createLatestChecker({ now: () => clock, syncMirror: false, fetchImpl: async (url) => { gets++; return answer({ version: url.includes('npmjs') ? '0.2.7' : '0.2.6' }) } })
  await check(); clock += LATEST_LAG_TTL_MS - 1; await check()
  assert.equal(gets, 2, 'one round of two registries, then cached')
  clock += 2; await check()
  assert.equal(gets, 4)
})

t('concurrent checks share one round', async () => {
  let calls = 0
  const check = createLatestChecker({ registries: ONE, fetchImpl: async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return answer({ version: '1.0.0' }) } })
  const [a, b] = await Promise.all([check(), check()])
  assert.equal(calls, 1)
  assert.equal(a.latest, b.latest)
})

t('releaseNotes come from the installable version; junk is dropped', async () => {
  const r = await createLatestChecker({ fetchImpl: regs({ npmjs: { version: '0.2.7', releaseNotes: ['newer'] }, npmmirror: { version: '0.2.6', releaseNotes: ['  更新内容 A ', '', 42, 'B'] } }) })()
  assert.deepEqual(r.notes, ['更新内容 A', 'B'])
  const bare = await createLatestChecker({ registries: ONE, fetchImpl: async () => answer({ version: '0.2.6' }) })()
  assert.deepEqual(bare.notes, [], 'no releaseNotes ⇒ empty list')
  assert.deepEqual(cleanNotes('not a list'), [])
  assert.equal(cleanNotes(Array(20).fill('x')).length, 8)
  assert.equal(cleanNotes(['y'.repeat(500)])[0].length, 200)
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
