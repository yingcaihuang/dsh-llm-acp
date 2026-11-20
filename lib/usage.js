// lib/usage.js — per-turn usage log for the ACP console.
//
// One JSON line per finished turn (see adapter #recordTurn):
//   { at, provider, model, session?, cwd?, ok, ms, firstMs?, aborted?, code?, message?, chars?,
//     inputTokens?, outputTokens?, cacheReadTokens?, cacheWriteTokens?, estimated? }
// `firstMs` = time to the first output chunk (TTFT); only turns recorded after it was added carry it.
// `estimated: true` means the CLI reported no token usage and the figures are chars/4.
// The file rotates once to `.1` past 20 MB; reads are cached by size+mtime.
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_BYTES = 20 * 1024 * 1024
const statKey = (f) => { try { const s = statSync(f); return `${s.size}:${s.mtimeMs}` } catch { return '-' } }
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function createUsageLog({ file, warn = () => {} }) {
  let broken = false
  let cache = { key: '', records: [] }
  return {
    file,
    append(rec) {
      if (!file || broken) return
      try {
        mkdirSync(dirname(file), { recursive: true })
        try { if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`) } catch { /* no file yet */ }
        appendFileSync(file, `${JSON.stringify(rec)}\n`, { mode: 0o600 })
      } catch (e) {
        broken = true // stop retrying every turn
        warn('usage', { phase: 'write', message: e?.message })
      }
    },
    read() {
      if (!file) return []
      const key = `${statKey(`${file}.1`)}|${statKey(file)}`
      if (cache.key === key) return cache.records
      const records = []
      for (const f of [`${file}.1`, file]) {
        let text
        try { text = readFileSync(f, 'utf8') } catch { continue }
        for (const line of text.split('\n')) {
          if (!line) continue
          try { const r = JSON.parse(line); if (r && typeof r.at === 'number' && typeof r.provider === 'string') records.push(r) } catch { /* torn line */ }
        }
      }
      cache = { key, records }
      return records
    },
  }
}

/** Local calendar day, YYYY-MM-DD. */
export const dayOf = (t) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const bucket = (extra) => ({ ...extra, turns: 0, ok: 0, failed: 0, aborted: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, chars: 0, estimatedTokens: 0, ms: 0, estimated: 0, lastAt: 0 })
/** A turn ended by us (abort, plugin reload) rather than by a CLI failure. Old records lack `aborted` for DISPOSED. */
export const isAborted = (r) => r?.aborted === true || r?.code === 'DISPOSED'
const add = (b, r) => {
  b.turns++
  if (r.ok) b.ok++; else if (isAborted(r)) b.aborted++; else b.failed++
  b.inputTokens += num(r.inputTokens)
  b.outputTokens += num(r.outputTokens)
  b.cacheReadTokens += num(r.cacheReadTokens)
  b.cacheWriteTokens += num(r.cacheWriteTokens)
  b.chars += num(r.chars)
  b.ms += num(r.ms)
  if (r.estimated) { b.estimated++; b.estimatedTokens += num(r.inputTokens) + num(r.outputTokens) }
  b.lastAt = Math.max(b.lastAt, num(r.at))
}
const get = (map, key, extra) => { let b = map.get(key); if (!b) { b = bucket(extra); map.set(key, b) } return b }
/** Per-day slice for one model (or provider): token split + turns, for the trend chart's dimensions. */
const addSlice = (map, key, r) => {
  const e = map[key] ?? (map[key] = { inputTokens: 0, outputTokens: 0, turns: 0 })
  e.inputTokens += num(r.inputTokens)
  e.outputTokens += num(r.outputTokens)
  e.turns++
}

/** q-quantile of a list of numbers (nearest rank); 0 for an empty list. */
const quant = (list, q) => {
  if (!list.length) return 0
  const s = [...list].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.round(q * (s.length - 1)))]
}

/** Duration buckets of successful turns (upper bound exclusive; null = open-ended). */
export const DURATION_BINS = Object.freeze([[10_000, '<10 秒'], [30_000, '10–30 秒'], [60_000, '30 秒–1 分'], [300_000, '1–5 分'], [Infinity, '>5 分']])
/** Turns-per-session buckets (upper bound inclusive). */
const DEPTH_BINS = [[1, '1 轮'], [3, '2–3 轮'], [10, '4–10 轮'], [Infinity, '11 轮以上']]
/** Turn positions tracked for the context-growth curve; the last one collects every later turn. */
const DEPTH_INDEX = 10

/** Session depth: turns per session, per-turn tokens, and average input by turn position. */
function sessionDepth(seqs) {
  const lists = [...seqs.values()]
  const dist = DEPTH_BINS.map(([, label]) => ({ label, count: 0 }))
  const idx = Array.from({ length: DEPTH_INDEX }, (_, i) => ({ i: i + 1, label: i + 1 === DEPTH_INDEX ? `${DEPTH_INDEX}+` : String(i + 1), inSum: 0, outSum: 0, count: 0 }))
  let turns = 0
  let maxTurns = 0
  let inSum = 0
  let outSum = 0
  for (const q of lists) {
    q.sort((a, b) => num(a.at) - num(b.at))
    turns += q.length
    maxTurns = Math.max(maxTurns, q.length)
    dist[DEPTH_BINS.findIndex(([max]) => q.length <= max)].count++
    q.forEach((r, i) => {
      const b = idx[Math.min(i, DEPTH_INDEX - 1)]
      b.inSum += num(r.inputTokens); b.outSum += num(r.outputTokens); b.count++
      inSum += num(r.inputTokens); outSum += num(r.outputTokens)
    })
  }
  const n = lists.length
  return {
    sessions: n, turns, avgTurns: n ? turns / n : 0, maxTurns,
    avgIn: turns ? inSum / turns : 0, avgOut: turns ? outSum / turns : 0, ratio: outSum > 0 ? inSum / outSum : 0,
    dist,
    byIndex: idx.map((b) => ({ i: b.i, label: b.label, count: b.count, avgIn: b.count ? b.inSum / b.count : 0, avgOut: b.count ? b.outSum / b.count : 0 })),
  }
}

/** Totals, per provider / model / day / session, error codes and the most recent turns since `since`.
 *  Each byDay bucket also carries `providers` (provider → total tokens, kept a number for the
 *  provider sparkline) and `models` (`provider/model` → { inputTokens, outputTokens, turns }) so
 *  the daily trend can be split by model or by provider. bySession carries the same model slices
 *  per session (top 100 by tokens; sessionCount is the uncapped distinct-session count). */
export function aggregate(records, { since = 0, until = 0, recent = 100, now = Date.now() } = {}) {
  const rows = records.filter((r) => num(r.at) >= since && (until <= 0 || num(r.at) <= until))
  const end = until > 0 ? Math.min(now, until) : now
  const total = bucket()
  const byP = new Map()
  const byM = new Map()
  const byD = new Map()
  const byS = new Map()
  const errs = new Map()
  const hours = Array.from({ length: 24 }, () => 0)
  const lat = []
  const durs = DURATION_BINS.map(([max, label]) => ({ label, max: Number.isFinite(max) ? max : null, count: 0, models: {} }))
  const byC = new Map()
  const cwdSessions = new Map()
  const seqs = new Map()
  const ttft = []
  for (const r of rows) {
    const model = r.model ?? 'default'
    add(total, r)
    add(get(byP, r.provider, { provider: r.provider }), r)
    add(get(byM, `${r.provider}/${model}`, { provider: r.provider, model }), r)
    const day = get(byD, dayOf(r.at), { date: dayOf(r.at), providers: {}, models: {} })
    add(day, r)
    day.providers[r.provider] = (day.providers[r.provider] ?? 0) + num(r.inputTokens) + num(r.outputTokens)
    addSlice(day.models, `${r.provider}/${model}`, r)
    const sb = get(byS, r.session ?? '', { session: r.session ?? '', cwd: '', firstAt: 0, models: {} })
    add(sb, r)
    if (r.cwd) sb.cwd = r.cwd
    if (!sb.firstAt || num(r.at) < sb.firstAt) sb.firstAt = num(r.at)
    addSlice(sb.models, `${r.provider}/${model}`, r)
    hours[new Date(num(r.at)).getHours()]++
    const mkey = `${r.provider}/${model}`
    if (r.ok) {
      const d = durs.find((b) => b.max === null || num(r.ms) < b.max)
      d.count++
      d.models[mkey] = (d.models[mkey] ?? 0) + 1
    }
    const cwdKey = r.cwd ?? ''
    add(get(byC, cwdKey, { cwd: cwdKey }), r)
    if (r.session) {
      let s = cwdSessions.get(cwdKey)
      if (!s) cwdSessions.set(cwdKey, (s = new Set()))
      s.add(r.session)
      let q = seqs.get(r.session)
      if (!q) seqs.set(r.session, (q = []))
      q.push(r)
    }
    if (num(r.firstMs) > 0) ttft.push(num(r.firstMs))
    if (r.ok) lat.push(num(r.ms))
    if (!r.ok && !isAborted(r)) {
      const code = r.code ?? 'UNKNOWN'
      const e = errs.get(code) ?? { code, count: 0, lastAt: 0 }
      e.count++
      if (num(r.at) >= e.lastAt) Object.assign(e, { lastAt: num(r.at), message: r.message, provider: r.provider, model })
      errs.set(code, e)
    }
  }
  // Continuous days (empty ones as zero buckets), so charts keep a real time axis.
  const days = []
  const first = since > 0 ? since : rows.length ? Math.min(...rows.map((r) => num(r.at))) : end
  const cur = new Date(first)
  cur.setHours(0, 0, 0, 0)
  for (let guard = 0; cur.getTime() <= end && guard < 400; guard++) {
    const k = dayOf(cur.getTime())
    days.push(byD.get(k) ?? bucket({ date: k, providers: {}, models: {} }))
    cur.setDate(cur.getDate() + 1)
  }
  lat.sort((a, b) => a - b)
  const q = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.round(p * (lat.length - 1)))] : 0)
  const sessions = [...byS.values()].sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens) || b.turns - a.turns)
  const projects = [...byC.values()]
    .map((b) => ({ ...b, sessions: cwdSessions.get(b.cwd)?.size ?? 0 }))
    .sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens) || b.turns - a.turns)
  return {
    since,
    count: rows.length,
    total,
    latency: { p50: q(0.5), p90: q(0.9), max: lat.length ? lat[lat.length - 1] : 0 },
    hours,
    byProvider: [...byP.values()].sort((a, b) => b.turns - a.turns),
    byModel: [...byM.values()].sort((a, b) => b.turns - a.turns),
    byDay: days,
    bySession: sessions.slice(0, 100),
    sessionCount: sessions.length,
    errors: [...errs.values()].sort((a, b) => b.count - a.count),
    recent: recent > 0 ? rows.slice(-recent).reverse() : [],
    // Successful turns by duration bucket (models: `provider/model` → count).
    durations: durs,
    // Per working directory (= project), top 20 by tokens; projectCount is uncapped.
    byProject: projects.slice(0, 20),
    projectCount: projects.length,
    depth: sessionDepth(seqs),
    // Time to first output, over the turns that recorded it.
    ttft: { p50: quant(ttft, 0.5), p90: quant(ttft, 0.9), count: ttft.length },
  }
}

/** Today's totals from local midnight, independent of the console range (the header strip).
 *  `providers` lists the CLIs used today, most turns first; aborted turns count as turns but
 *  neither as success nor as failure. */
export function todaySummary(records, { now = Date.now() } = {}) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  const since = d.getTime()
  const total = bucket()
  const byP = new Map()
  for (const r of records) {
    const at = num(r.at)
    if (at < since || at > now) continue
    add(total, r)
    byP.set(r.provider, (byP.get(r.provider) ?? 0) + 1)
  }
  const providers = [...byP.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([id, turns]) => ({ id, turns }))
  const { turns, ok, failed, aborted, inputTokens, outputTokens, cacheReadTokens, estimated, lastAt } = total
  return { since, turns, ok, failed, aborted, inputTokens, outputTokens, cacheReadTokens, estimated, lastAt, providers }
}

export const TPS_STEP_MS = 5 * 60_000
export const TPS_WINDOWS = Object.freeze({ day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 })
const round2 = (x) => Math.round(x * 100) / 100

/**
 * Per-model output tokens per second in 5-minute buckets over the last day / week / month (the
 * console keeps no more than 30 days). tps = Σ output tokens ÷ Σ turn seconds (duration-weighted,
 * end-to-end, CLI tool time included); genTps uses Σ(ms − firstMs) of the turns that recorded the
 * first-output time. Only successful turns with output count. Points are sparse (empty buckets are
 * left out) and carry their sums, so the client can merge them into coarser buckets exactly.
 */
export function tpsSeries(records, { window = 'day', now = Date.now() } = {}) {
  const win = Object.prototype.hasOwnProperty.call(TPS_WINDOWS, window) ? window : 'day'
  const step = TPS_STEP_MS
  const until = Math.floor(now / step) * step + step
  const since = until - TPS_WINDOWS[win]
  const models = new Map()
  for (const r of records) {
    const at = num(r.at)
    if (at < since || at >= until || !r.ok || isAborted(r)) continue
    const out = num(r.outputTokens)
    const ms = num(r.ms)
    if (out <= 0 || ms <= 0) continue
    const model = r.model ?? 'default'
    const key = `${r.provider}/${model}`
    let m = models.get(key)
    if (!m) models.set(key, (m = { key, provider: r.provider, model, buckets: new Map(), out: 0, ms: 0, genOut: 0, genMs: 0, turns: 0, estimated: 0, ttft: [] }))
    const t = Math.floor(at / step) * step
    let b = m.buckets.get(t)
    if (!b) m.buckets.set(t, (b = { t, out: 0, ms: 0, genOut: 0, genMs: 0, turns: 0, estimated: 0 }))
    const first = num(r.firstMs)
    const gen = first > 0 && first < ms ? ms - first : 0
    for (const x of [b, m]) {
      x.out += out; x.ms += ms; x.turns++
      if (r.estimated) x.estimated++
      if (gen > 0) { x.genOut += out; x.genMs += gen }
    }
    if (first > 0) m.ttft.push(first)
  }
  const rate = (o, ms) => (ms > 0 ? round2(o / (ms / 1000)) : 0)
  const list = [...models.values()].map((m) => ({
    key: m.key, provider: m.provider, model: m.model, turns: m.turns, out: m.out, estimated: m.estimated,
    tps: rate(m.out, m.ms),
    ...(m.genMs > 0 ? { genTps: rate(m.genOut, m.genMs) } : {}),
    ...(m.ttft.length ? { ttft: { p50: quant(m.ttft, 0.5), p90: quant(m.ttft, 0.9), count: m.ttft.length } } : {}),
    points: [...m.buckets.values()].sort((a, b) => a.t - b.t).map((b) => ({
      t: b.t, tps: rate(b.out, b.ms), turns: b.turns, out: b.out, ms: b.ms,
      ...(b.genMs > 0 ? { genTps: rate(b.genOut, b.genMs), genOut: b.genOut, genMs: b.genMs } : {}),
      ...(b.estimated ? { estimated: b.estimated } : {}),
    })),
  })).sort((a, b) => b.out - a.out)
  return { window: win, step, since, until, models: list }
}

/** Daily activity for the heatmap: the last `days` days, independent of the selected range. */
export function activity(records, { days = 84, now = Date.now() } = {}) {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (days - 1))
  const map = new Map()
  for (const r of records) {
    if (num(r.at) < start.getTime()) continue
    const k = dayOf(r.at)
    const e = map.get(k) ?? { turns: 0, tokens: 0, failed: 0 }
    e.turns++
    e.tokens += num(r.inputTokens) + num(r.outputTokens)
    if (!r.ok && !isAborted(r)) e.failed++
    map.set(k, e)
  }
  const out = []
  const c = new Date(start)
  for (let i = 0; i < days; i++) {
    const k = dayOf(c.getTime())
    out.push({ date: k, dow: c.getDay(), ...(map.get(k) ?? { turns: 0, tokens: 0, failed: 0 }) })
    c.setDate(c.getDate() + 1)
  }
  return out
}

export const CSV_COLUMNS = ['at', 'provider', 'model', 'session', 'cwd', 'ok', 'aborted', 'code', 'ms', 'firstMs', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'estimated', 'chars', 'message']
const cell = (v) => {
  if (v === undefined || v === null) return ''
  const s = String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export function csvOf(records) {
  const lines = [CSV_COLUMNS.join(',')]
  for (const r of records) lines.push(CSV_COLUMNS.map((c) => cell(c === 'at' ? new Date(r.at).toISOString() : r[c])).join(','))
  return `${lines.join('\r\n')}\r\n`
}
