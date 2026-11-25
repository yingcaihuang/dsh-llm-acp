// 模型性价比排行 (lib/rank.js): multiplier parsing, tiers, ranking with real use, change diff,
// persistence, and the scheduler (what starts a CLI, what is skipped, timers) with a fake clock.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRanker, diffSnapshots, intervalOf, plainName, qualityOf, rankModels, rateValue, tierOf, RANK_INTERVAL_MS } from '../lib/rank.js'
import { rateOf } from '../lib/adapter.js'

const tests = []
const t = (name, fn) => tests.push([name, fn])
const dir = mkdtempSync(join(tmpdir(), 'llm-acp-rank-'))

t('multipliers: rate field first, description fallback, bare x0.29 too', () => {
  assert.equal(rateValue('0.29x'), 0.29)
  assert.equal(rateValue('0x 免费'), 0)
  assert.equal(rateValue('2.20x'), 2.2)
  assert.equal(rateValue(undefined, 'x0.34 credits'), 0.34)
  assert.equal(rateValue(undefined, 'x0.00'), 0)
  assert.equal(rateValue(undefined, 'Reasoning · 0.80x Credit'), 0.8)
  assert.equal(rateValue(undefined, 'fast model'), undefined)
  assert.equal(rateValue('', undefined), undefined)
  assert.equal(rateOf('x0.29'), '0.29x')
  assert.equal(rateOf('Hy4 x0.29 preview'), undefined, 'a bare multiplier must be the whole description')
})

t('tiers and likely-free', () => {
  assert.equal(tierOf(0), 'free')
  assert.equal(tierOf(0.03), 'low')
  assert.equal(tierOf(0.29), 'low')
  assert.equal(tierOf(0.3), 'mid')
  assert.equal(tierOf(1), 'high')
  assert.equal(tierOf(undefined, { id: 'hy4flash-free' }), 'likely')
  assert.equal(tierOf(undefined, { id: 'gpt', name: 'GPT' }), 'unknown')
  assert.equal(plainName('Hy3 · 0x 免费', '0x 免费'), 'Hy3')
  assert.equal(plainName('Hy3', '0x 免费'), 'Hy3')
})

t('real use: success rate, latency, rate limits; aborted turns do not count', () => {
  const q = qualityOf([
    { at: 10, provider: 'a', model: 'm', ok: true, ms: 1000 },
    { at: 11, provider: 'a', model: 'm', ok: false, code: 'RATE_LIMIT' },
    { at: 12, provider: 'a', model: 'm', ok: false, code: 'QUOTA' },
    { at: 13, provider: 'a', model: 'm', ok: false, aborted: true },
    { at: 1, provider: 'a', model: 'old', ok: false },
    { at: 14, provider: 'b', ok: true, ms: 300 },
  ], { since: 5 })
  const m = q.get('a/m')
  assert.deepEqual([m.turns, m.ok, m.failed, m.limited, m.successRate, m.avgMs, m.warn], [4, 1, 2, 2, 33, 1000, true])
  assert.equal(q.has('a/old'), false, 'older than the window')
  assert.equal(q.get('b/default').successRate, 100)
  assert.equal(q.get('b/default').warn, false)
})

t('ranking: tier → multiplier → enabled → healthy → success', () => {
  const quality = new Map([['a/f2', { successRate: 20, warn: true }], ['a/f1', { successRate: 95, warn: false }]])
  const rows = rankModels([
    { id: 'a', models: [{ id: 'hi', rate: '2.20x' }, { id: 'f2', rate: '0x 免费' }, { id: 'u', name: 'U' }, { id: 'lo', rate: '0.03x' }, { id: 'mid', description: 'x0.59 credits' }, { id: 'f1', rate: '0x 免费' }, { id: 'x-free' }] },
    { id: 'b', models: [{ id: 'lo2', rate: '0.01x' }, { id: 'off', rate: '0.001x' }] },
  ], { quality, disabled: { b: ['off'] } })
  assert.deepEqual(rows.map((r) => r.id), ['f1', 'f2', 'x-free', 'off', 'lo2', 'lo', 'mid', 'hi', 'u'])
  assert.equal(rows.find((r) => r.id === 'off').disabled, true)
  assert.equal(rows.find((r) => r.id === 'mid').value, 0.59)
})

t('diff: added / removed / rate / free; a provider seen the first time is a baseline', () => {
  const prev = { a: { models: [{ id: 'm1', rate: '1.30x' }, { id: 'm2', rate: '0.5x' }, { id: 'gone' }] } }
  const next = { a: { models: [{ id: 'm1', rate: '1.50x' }, { id: 'm2', rate: '0x 免费' }, { id: 'new', rate: '0.2x' }, { id: 'nf', rate: '0x 免费' }] }, b: { models: [{ id: 'z' }] } }
  const c = diffSnapshots(prev, next, 99)
  const by = Object.fromEntries(c.map((x) => [x.model, x]))
  assert.equal(c.length, 5)
  assert.deepEqual([by.m1.kind, by.m1.from, by.m1.to], ['rate', '1.30x', '1.50x'])
  assert.equal(by.m2.kind, 'free')
  assert.equal(by.new.kind, 'added')
  assert.equal(by.nf.kind, 'free')
  assert.equal(by.gone.kind, 'removed')
  assert.ok(!c.some((x) => x.provider === 'b'))
  assert.deepEqual(diffSnapshots(next, next, 1), [])
})

t('rankIntervalMs: default 5 min, 0 = manual, too small or junk throws', () => {
  assert.equal(intervalOf({}), RANK_INTERVAL_MS)
  assert.equal(intervalOf({ rankIntervalMs: 0 }), 0)
  assert.equal(intervalOf({ rankIntervalMs: 120_000 }), 120_000)
  assert.throws(() => intervalOf({ rankIntervalMs: 5000 }))
  assert.throws(() => intervalOf({ rankIntervalMs: '5m' }))
})

// ── scheduler ──
function world({ file, lists, rt = {}, cacheAt = {}, off = [], staggerMs = 0, intervalMs = RANK_INTERVAL_MS, records = [] } = {}) {
  const w = { clock: 1_800_000_000_000, timers: [], refresh: [], sleeps: [] }
  const ps = new Map([
    ['a', { id: 'a', displayName: 'A' }], ['b', { id: 'b', displayName: 'B', models: ['s1'] }], ['c', { id: 'c' }], ['d', { id: 'd' }], ['e', { id: 'e' }],
  ])
  const lists0 = lists ?? { a: [{ id: 'm1', name: 'M1 · 0.29x', rate: '0.29x' }, { id: 'free1', name: 'F', rate: '0x 免费' }], b: [{ id: 's1', name: 's1' }], c: [{ id: 'c1' }], d: [{ id: 'd1', rate: '1x' }], e: [{ id: 'e1' }] }
  w.lists = lists0
  const at = { ...cacheAt }
  w.adapter = {
    catalog: async (id) => [{ id: 'default', name: `${id} · CLI default` }, ...(w.lists[id] ?? [])],
    refreshCatalog: async (id) => { w.refresh.push(id); at[id] = w.clock; return [] },
    runtime: (id) => ({ ...(at[id] ? { catalogCache: { at: at[id] } } : {}), ...(rt[id] ?? {}) }),
  }
  w.ranker = createRanker({
    adapter: w.adapter, providers: () => ps, file, intervalMs, staggerMs, firstDelayMs: 30_000,
    prefs: { isProviderDisabled: (id) => off.includes(id), get: () => ({ disabledModels: { a: ['m1'] } }) },
    usage: { read: () => records },
    now: () => w.clock,
    setTimer: (fn, ms) => { const x = { fn, ms }; w.timers.push(x); if (ms === staggerMs && ms > 0) { w.sleeps.push(ms); queueMicrotask(fn) } return x },
    clearTimer: (x) => { x.cleared = true },
  })
  return w
}
const busy = { inflight: [{ provider: 'e' }] }
const backoff = { backoff: { until: Infinity, code: 'AUTH', long: true } }

t('a run starts only CLIs that need it; static, off, backoff, busy and fresh are skipped', async () => {
  const w = world({ off: ['c'], rt: { d: backoff, e: busy }, cacheAt: { e: 1_800_000_000_000 - 200_000 } })
  await w.ranker.runOnce()
  assert.deepEqual(w.refresh, ['a'])
  const v = w.ranker.view()
  const st = Object.fromEntries(v.providers.map((p) => [p.id, [p.status, p.skipped ?? '']]))
  assert.deepEqual(st, { a: ['ok', ''], b: ['static', ''], c: ['off', ''], d: ['fail', 'backoff'], e: ['ok', 'busy'] })
  assert.equal(v.providers.find((p) => p.id === 'd').error, 'AUTH')
  assert.ok(!v.models.some((m) => m.provider === 'c'), 'a switched-off provider is not ranked')
  assert.deepEqual(v.models.slice(0, 2).map((m) => m.id), ['free1', 'm1'])
  assert.equal(v.models.find((m) => m.id === 'm1').disabled, true)
  assert.equal(v.models.find((m) => m.id === 'm1').name, 'M1', 'the appended multiplier is stripped from the name')
  w.refresh.length = 0
  w.clock += 60_000
  await w.ranker.runOnce()
  assert.deepEqual(w.refresh, [], 'listed within half an interval ⇒ fresh, no CLI start')
})

t('force: every enabled discovery CLI, backoff and busy bypassed; staggered', async () => {
  const w = world({ off: ['c'], rt: { d: backoff, e: busy }, staggerMs: 5 })
  await w.ranker.refresh({ force: true })
  assert.deepEqual(w.refresh, ['a', 'd', 'e'])
  assert.equal(w.sleeps.length, 2, 'a stagger after each CLI start except the last')
})

t('a forced run asked for during an automatic run runs right after it', async () => {
  const w = world({ rt: { d: backoff } })
  const auto = w.ranker.runOnce()
  const forced = w.ranker.runOnce({ force: true })
  await Promise.all([auto, forced])
  // automatic: a, c, e (d in backoff, b static); then the forced run: every discovery CLI, d included
  assert.deepEqual(w.refresh, ['a', 'c', 'e', 'a', 'c', 'd', 'e'])
  assert.equal(w.ranker.runOnce({ force: true }) !== forced, true, 'the queued run is not reused once it has run')
})

t('timers: first run after the delay, then every interval; stop clears; 0 = manual only', async () => {
  const w = world()
  w.ranker.start()
  const first = w.timers.at(-1)
  assert.equal(first.ms, 30_000)
  first.fn()
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(w.refresh.length > 0)
  const next = w.timers.filter((x) => x.ms === RANK_INTERVAL_MS && !x.cleared)
  assert.equal(next.length, 1)
  assert.ok(w.ranker.view().nextAt > 0)
  w.ranker.stop()
  assert.equal(next[0].cleared, true)
  assert.equal(w.ranker.view().nextAt, 0)
  const m = world({ intervalMs: 0 })
  m.ranker.start()
  assert.equal(m.timers.length, 0)
})

t('history: rank.json 0600, reloaded on restart, changes and new free models reported', async () => {
  const file = join(dir, 'rank.json')
  const w1 = world({ file })
  await w1.ranker.runOnce()
  assert.ok(existsSync(file))
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(w1.ranker.view().changes, [], 'the first snapshot is a baseline')
  const w2 = world({ file })
  w2.lists.a = [{ id: 'm1', rate: '0.50x' }, { id: 'free1', rate: '0x 免费' }, { id: 'free2', name: 'Free 2', rate: '0x 免费' }]
  w2.clock += RANK_INTERVAL_MS
  await w2.ranker.runOnce()
  const v = w2.ranker.view()
  const kinds = v.changes.map((c) => `${c.kind}:${c.model}`).sort()
  assert.deepEqual(kinds, ['free:free2', 'rate:m1'])
  assert.deepEqual(v.newFree.map((c) => c.model), ['free2'])
  const disk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(disk.changes.length, 2)
  assert.ok(!JSON.stringify(disk).includes('default'), 'the pseudo model is not stored')
})

t('stale: a list older than two intervals is flagged', async () => {
  const w = world({ rt: { d: backoff } })
  await w.ranker.runOnce()
  assert.equal(w.ranker.view().providers.find((p) => p.id === 'a').stale, false)
  w.clock += 2 * RANK_INTERVAL_MS + 1
  assert.equal(w.ranker.view().providers.find((p) => p.id === 'a').stale, true)
  assert.equal(w.ranker.view().providers.find((p) => p.id === 'b').stale, false, 'a static list never goes stale')
})

let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`) } catch (e) { failed++; console.log(`FAIL ${name}\n     ${String(e?.stack ?? e).slice(0, 700)}`) }
}
rmSync(dir, { recursive: true, force: true })
console.log(`\nrank: ${tests.length - failed}/${tests.length} passed`)
process.exit(failed ? 1 : 0)
