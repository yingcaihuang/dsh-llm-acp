// Offline tests for the console's new usage metrics (lib/usage.js): per-model 5-minute TPS series,
// duration buckets, project ranking, session depth and time to first output.
import assert from 'node:assert/strict'
import { aggregate, todaySummary, tpsSeries, TPS_STEP_MS } from '../lib/usage.js'

const tests = []
const t = (name, fn) => tests.push([name, fn])

const now = Date.UTC(2026, 10, 18, 12, 0, 0) // on a 5-minute boundary
const ago = (min) => now - min * 60_000
const rec = (o) => ({ provider: 'kiro', model: 'm1', ok: true, ms: 10_000, inputTokens: 1000, outputTokens: 100, ...o })

t('tps is duration-weighted within a 5-minute bucket', () => {
  const s = tpsSeries([rec({ at: ago(1) }), rec({ at: ago(2), outputTokens: 300 })], { window: 'day', now })
  assert.equal(s.step, TPS_STEP_MS)
  assert.equal(s.models.length, 1)
  const m = s.models[0]
  assert.equal(m.points.length, 1, 'both turns share one bucket')
  assert.equal(m.points[0].tps, 20) // 400 tokens / 20 s, not the mean of 10 and 30
  assert.equal(m.points[0].turns, 2)
  assert.equal(m.points[0].t % TPS_STEP_MS, 0)
  assert.equal(m.tps, 20)
})

t('failed, aborted and empty turns are left out', () => {
  const s = tpsSeries([
    rec({ at: ago(1), ok: false, code: 'ACP_ERROR' }),
    rec({ at: ago(1), ok: false, aborted: true }),
    rec({ at: ago(1), outputTokens: 0 }),
    rec({ at: ago(1), ms: 0 }),
  ], { window: 'day', now })
  assert.deepEqual(s.models, [])
})

t('windows: day / week / month cut at 1 / 7 / 30 days', () => {
  const recs = [rec({ at: ago(60 * 25) }), rec({ at: ago(60 * 24 * 6) }), rec({ at: ago(60 * 24 * 31) })]
  const n = (w) => tpsSeries(recs, { window: w, now }).models[0]?.turns ?? 0
  assert.equal(n('day'), 0)
  assert.equal(n('week'), 2)
  assert.equal(n('month'), 2, 'nothing older than 30 days')
  assert.equal(tpsSeries(recs, { window: 'bogus', now }).window, 'day')
})

t('generation tps and ttft from firstMs', () => {
  const s = tpsSeries([rec({ at: ago(1), firstMs: 5000 }), rec({ at: ago(3), firstMs: 7000 })], { window: 'day', now })
  const m = s.models[0]
  assert.equal(m.tps, 10)
  assert.equal(m.genTps, round(200 / 8)) // 200 tokens over (5 + 3) s
  assert.equal(m.ttft.count, 2)
  assert.equal(m.points[0].genTps, round(200 / 8))
})
const round = (x) => Math.round(x * 100) / 100

t('points are sparse, sorted, one series per model', () => {
  const s = tpsSeries([rec({ at: ago(40) }), rec({ at: ago(1) }), rec({ at: ago(1), provider: 'qoder', model: 'g', outputTokens: 900 })], { window: 'day', now })
  assert.deepEqual(s.models.map((m) => m.key), ['qoder/g', 'kiro/m1'])
  const k = s.models.find((m) => m.key === 'kiro/m1')
  assert.equal(k.points.length, 2)
  assert.ok(k.points[0].t < k.points[1].t)
})

t('aggregate: duration buckets count successful turns per model', () => {
  const a = aggregate([rec({ at: ago(1), ms: 5000 }), rec({ at: ago(2), ms: 20_000 }), rec({ at: ago(3), ms: 400_000 }), rec({ at: ago(4), ok: false, ms: 1000 })], { now })
  assert.deepEqual(a.durations.map((d) => d.count), [1, 1, 0, 0, 1])
  assert.equal(a.durations[0].models['kiro/m1'], 1)
  assert.equal(a.durations.at(-1).max, null)
})

t('aggregate: projects by cwd with session counts, sorted by tokens', () => {
  const a = aggregate([
    rec({ at: ago(1), cwd: '/a', session: 's1' }), rec({ at: ago(2), cwd: '/a', session: 's2' }),
    rec({ at: ago(3), cwd: '/b', session: 's3', inputTokens: 9000 }),
  ], { now })
  assert.deepEqual(a.byProject.map((p) => [p.cwd, p.turns, p.sessions]), [['/b', 1, 1], ['/a', 2, 2]])
  assert.equal(a.projectCount, 2)
})

t('aggregate: session depth and input by turn position', () => {
  const a = aggregate([
    rec({ at: ago(5), session: 's1', inputTokens: 100 }), rec({ at: ago(4), session: 's1', inputTokens: 200 }),
    rec({ at: ago(3), session: 's1', inputTokens: 300 }), rec({ at: ago(2), session: 's2', inputTokens: 50 }),
    rec({ at: ago(1), inputTokens: 999 }), // no session: not part of depth
  ], { now })
  const d = a.depth
  assert.equal(d.sessions, 2)
  assert.equal(d.avgTurns, 2)
  assert.equal(d.maxTurns, 3)
  assert.deepEqual(d.dist.map((b) => b.count), [1, 1, 0, 0])
  assert.equal(d.byIndex[0].avgIn, 75)
  assert.equal(d.byIndex[1].avgIn, 200)
  assert.equal(d.byIndex[2].avgIn, 300)
  assert.equal(d.byIndex[9].label, '10+')
})

t('aggregate: ttft quantiles over turns that recorded it', () => {
  const a = aggregate([rec({ at: ago(1), firstMs: 1000 }), rec({ at: ago(2), firstMs: 3000 }), rec({ at: ago(3) })], { now })
  assert.equal(a.ttft.count, 2)
  assert.ok(a.ttft.p50 >= 1000 && a.ttft.p90 === 3000)
  assert.equal(aggregate([], { now }).ttft.count, 0)
})

// todaySummary works in local time (midnight = the console's「今日」), so build local instants.
const noon = new Date(2026, 10, 20, 12, 0, 0).getTime()
const local = (h, m = 0, day = 20) => new Date(2026, 10, day, h, m, 0).getTime()

t('todaySummary: counts from local midnight to now only', () => {
  const s = todaySummary([
    rec({ at: local(23, 59, 19) }), // yesterday
    rec({ at: local(0, 0) }), // exactly midnight: today
    rec({ at: local(11, 30), provider: 'qoder', inputTokens: 500, outputTokens: 50 }),
    rec({ at: local(13, 0) }), // after now
  ], { now: noon })
  assert.equal(s.since, local(0, 0))
  assert.equal(s.turns, 2)
  assert.equal(s.inputTokens, 1500)
  assert.equal(s.outputTokens, 150)
  assert.equal(s.lastAt, local(11, 30))
})

t('todaySummary: failed vs aborted, providers by turns', () => {
  const s = todaySummary([
    rec({ at: local(9) }), rec({ at: local(10), ok: false, code: 'SERVER' }),
    rec({ at: local(10, 5), ok: false, aborted: true }), rec({ at: local(10, 6), ok: false, code: 'DISPOSED' }),
    rec({ at: local(11), provider: 'qoder' }),
  ], { now: noon })
  assert.equal(s.turns, 5)
  assert.equal(s.ok, 2)
  assert.equal(s.failed, 1)
  assert.equal(s.aborted, 2)
  assert.deepEqual(s.providers, [{ id: 'kiro', turns: 4 }, { id: 'qoder', turns: 1 }])
})

t('todaySummary: empty day', () => {
  const s = todaySummary([rec({ at: local(8, 0, 19) })], { now: noon })
  assert.equal(s.turns, 0)
  assert.equal(s.lastAt, 0)
  assert.deepEqual(s.providers, [])
})

let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`) } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e?.stack?.split('\n').slice(0, 3).join('\n     ')}`) }
}
console.log(`\nusage-metrics: ${tests.length - failed}/${tests.length} passed`)
process.exit(failed ? 1 : 0)
