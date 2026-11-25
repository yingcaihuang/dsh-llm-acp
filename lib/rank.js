// lib/rank.js — 「模型性价比排行」 for the insights page.
//
// Every intervalMs (default 5 min, `rankIntervalMs` in the plugin config, 0 = manual only) the
// configured CLIs are asked for their model lists through the adapter's own single-flight
// discovery — there is no second fetching path. Providers run one after another, with a stagger
// after each CLI start, so several CLIs never cold-start together. Not started:
//   - a provider switched off in the console;
//   - a static `models` channel (its list is the config);
//   - a provider inside its failure backoff (logged out, broken, empty list);
//   - a provider running a turn right now (unless its list is older than 3 intervals);
//   - a provider someone else (model picker, console) discovered within the last half interval.
// Those use the list already cached. 「立即重新采集」 (force) starts every enabled CLI anyway.
//
// Ranking: free (0x) → likely free (named free, no multiplier) → low (<0.3x) → mid (<1x) →
// high (≥1x) → unknown, by multiplier inside a tier. Multipliers of different CLIs are separate
// credit pools, so the console groups by provider by default. Real use over the last 7 days
// (success rate, latency, rate limits) is attached; a model that keeps failing is flagged and
// sorts after its tier mates.
//
// Each run is diffed against the last good list per provider (new / removed models, changed
// multipliers, new free models). Changes are kept 7 days in rank.json next to the other llm-acp
// files: model metadata only, atomic writes, 0600; unreadable or unwritable ⇒ memory only.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { rateOf } from './adapter.js'
import { isAborted } from './usage.js'

export const RANK_INTERVAL_MS = 5 * 60_000
export const RANK_MIN_INTERVAL_MS = 60_000
export const RANK_STAGGER_MS = 15_000
export const RANK_FIRST_DELAY_MS = 30_000
export const RANK_REFRESH_TIMEOUT_MS = 90_000
export const CHANGE_KEEP_MS = 7 * 86_400_000
export const QUALITY_WINDOW_MS = 7 * 86_400_000
export const NEW_FREE_MS = 86_400_000
export const TIERS = Object.freeze(['free', 'likely', 'low', 'mid', 'high', 'unknown'])
const VERSION = 1
const MAX_MODELS = 500
const MAX_CHANGES = 500
const MAX_ID = 200
const MAX_NAME = 200
const MAX_DESCRIPTION = 400
const MAX_RATE = 32
const LIMIT_RE = /RATE|429|THROTTL|TOO_MANY|QUOTA|CREDIT|BILLING/i
const KINDS = new Set(['added', 'removed', 'rate', 'free'])

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const safe = (f) => { try { return f() } catch { return undefined } }
const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : undefined)

/** `rankIntervalMs` from the plugin config: undefined ⇒ 5 min, 0 ⇒ manual only, else ≥ 60 s. */
export function intervalOf(raw) {
  const v = raw?.rankIntervalMs
  if (v === undefined) return RANK_INTERVAL_MS
  if (v === 0) return 0
  if (!Number.isSafeInteger(v) || v < RANK_MIN_INTERVAL_MS) throw new Error(`llm-acp: rankIntervalMs must be 0 (manual only) or an integer >= ${RANK_MIN_INTERVAL_MS} (got ${JSON.stringify(v)})`)
  return v
}

/** "0.29x" / "0x 免费" / "2.20x", else the description ("x0.29 credits", "x0.29") → number. */
export function rateValue(rate, description) {
  for (const s of [rate, rateOf(description)]) {
    if (typeof s !== 'string') continue
    const m = /^\s*x?\s*(\d{1,4}(?:\.\d{1,4})?)\s*x?(?:\s|$)/i.exec(s)
    if (m) return Number(m[1])
  }
  return undefined
}

/** Tier of a multiplier; no multiplier but "free" in the id or name ⇒ likely free. */
export function tierOf(value, { id = '', name = '' } = {}) {
  if (value === undefined) return /free|免费/i.test(`${id} ${name}`) ? 'likely' : 'unknown'
  if (value === 0) return 'free'
  if (value < 0.3) return 'low'
  if (value < 1) return 'mid'
  return 'high'
}

/** The name without the multiplier the adapter appended: "Hy3 · 0x 免费" → "Hy3". */
export function plainName(name, rate) {
  const n = String(name ?? '').trim()
  return typeof rate === 'string' && rate !== '' && n.endsWith(` · ${rate}`) ? n.slice(0, -(rate.length + 3)).trim() : n
}

/** A catalog entry → the stored item { id, name, description?, rate? }. */
export function itemOf(m) {
  const rate = typeof m.rate === 'string' && m.rate !== '' ? m.rate : rateOf(m.description)
  const item = { id: str(m.id, MAX_ID), name: str(plainName(m.name || m.id, rate), MAX_NAME) || str(m.id, MAX_ID) }
  if (typeof m.description === 'string' && m.description !== '') item.description = str(m.description, MAX_DESCRIPTION)
  if (typeof rate === 'string' && rate !== '') item.rate = str(rate, MAX_RATE)
  return item
}

/** Usage records → Map("provider/model" → quality) over turns since `since`. Aborted turns don't count. */
export function qualityOf(records, { since = 0 } = {}) {
  const by = new Map()
  for (const r of Array.isArray(records) ? records : []) {
    if (r === null || typeof r !== 'object' || typeof r.provider !== 'string' || num(r.at) < since) continue
    const key = `${r.provider}/${r.model ?? 'default'}`
    let q = by.get(key)
    if (!q) by.set(key, (q = { turns: 0, ok: 0, failed: 0, limited: 0, ms: 0, lastAt: 0 }))
    q.turns++
    q.lastAt = Math.max(q.lastAt, num(r.at))
    if (isAborted(r)) continue
    if (r.ok) { q.ok++; q.ms += num(r.ms) } else { q.failed++; if (LIMIT_RE.test(String(r.code ?? ''))) q.limited++ }
  }
  const out = new Map()
  for (const [k, q] of by) {
    const done = q.ok + q.failed
    const successRate = done > 0 ? Math.round((q.ok / done) * 100) : null
    out.set(k, {
      turns: q.turns, ok: q.ok, failed: q.failed, limited: q.limited, successRate,
      avgMs: q.ok > 0 ? Math.round(q.ms / q.ok) : null, lastAt: q.lastAt,
      warn: (done >= 3 && successRate < 70) || q.limited >= 2,
    })
  }
  return out
}

/** Every model of `providers` ([{ id, models }]) ranked: tier, multiplier, enabled, healthy, success, name. */
export function rankModels(providers, { quality = new Map(), disabled = {} } = {}) {
  const rows = []
  for (const p of Array.isArray(providers) ? providers : []) {
    const off = new Set(Array.isArray(disabled?.[p.id]) ? disabled[p.id] : [])
    for (const m of Array.isArray(p.models) ? p.models : []) {
      const value = rateValue(m.rate, m.description)
      const q = quality.get(`${p.id}/${m.id}`)
      rows.push({
        provider: p.id, id: m.id, name: m.name || m.id, ...(m.rate ? { rate: m.rate } : {}),
        ...(value === undefined ? {} : { value }), tier: tierOf(value, m), disabled: off.has(m.id), ...(q ? { quality: q } : {}),
      })
    }
  }
  const order = (r) => TIERS.indexOf(r.tier)
  return rows.sort((a, b) => order(a) - order(b)
    || (a.value ?? 0) - (b.value ?? 0)
    || Number(a.disabled) - Number(b.disabled)
    || Number(a.quality?.warn === true) - Number(b.quality?.warn === true)
    || (b.quality?.successRate ?? -1) - (a.quality?.successRate ?? -1)
    || String(a.name).localeCompare(String(b.name)))
}

/**
 * Changes between two { provider: { models } } snapshots. A provider absent from either side is a
 * baseline (first seen, or not collected this time) and yields nothing.
 */
export function diffSnapshots(prev, next, at) {
  const changes = []
  for (const [id, n] of Object.entries(next ?? {})) {
    const o = prev?.[id]
    if (!o || !Array.isArray(o.models) || !Array.isArray(n?.models)) continue
    const before = new Map(o.models.map((m) => [m.id, m]))
    const after = new Map(n.models.map((m) => [m.id, m]))
    for (const [mid, m] of after) {
      const b = before.get(mid)
      const v = rateValue(m.rate, m.description)
      if (b === undefined) { changes.push({ at, provider: id, model: mid, name: m.name, kind: v === 0 ? 'free' : 'added', to: m.rate ?? null }); continue }
      const bv = rateValue(b.rate, b.description)
      if (bv !== v) changes.push({ at, provider: id, model: mid, name: m.name, kind: v === 0 ? 'free' : 'rate', from: b.rate ?? null, to: m.rate ?? null })
    }
    for (const [mid, b] of before) if (!after.has(mid)) changes.push({ at, provider: id, model: mid, name: b.name, kind: 'removed', from: b.rate ?? null })
  }
  return changes
}

function cleanModels(list) {
  const out = []
  const seen = new Set()
  for (const m of Array.isArray(list) ? list : []) {
    if (out.length >= MAX_MODELS) break
    if (m === null || typeof m !== 'object' || typeof m.id !== 'string' || m.id === '' || m.id === 'default' || seen.has(m.id)) continue
    seen.add(m.id)
    out.push(itemOf(m))
  }
  return out
}

function cleanLast(last) {
  const out = {}
  if (last === null || typeof last !== 'object' || Array.isArray(last)) return out
  for (const [id, v] of Object.entries(last)) {
    if (v === null || typeof v !== 'object') continue
    const models = cleanModels(v.models)
    if (models.length) out[id] = { at: num(v.at), models }
  }
  return out
}

function cleanChanges(list, now) {
  const out = []
  for (const c of Array.isArray(list) ? list : []) {
    if (c === null || typeof c !== 'object' || !KINDS.has(c.kind) || typeof c.provider !== 'string' || typeof c.model !== 'string') continue
    if (!(num(c.at) > 0) || now - num(c.at) > CHANGE_KEEP_MS) continue
    out.push({
      at: num(c.at), provider: str(c.provider, MAX_ID), model: str(c.model, MAX_ID), name: str(c.name, MAX_NAME) ?? str(c.model, MAX_ID), kind: c.kind,
      ...(c.from === undefined ? {} : { from: str(c.from, MAX_RATE) ?? null }), ...(c.to === undefined ? {} : { to: str(c.to, MAX_RATE) ?? null }),
    })
  }
  return out.sort((a, b) => a.at - b.at).slice(-MAX_CHANGES)
}

/**
 * The scheduler. deps: adapter (catalog / refreshCatalog / runtime), providers() → Map, prefs, usage,
 * file ('' / undefined ⇒ memory only). Timers and the clock are injectable for tests.
 */
export function createRanker({
  adapter, providers, prefs, usage, file, log,
  intervalMs = RANK_INTERVAL_MS, staggerMs = RANK_STAGGER_MS, firstDelayMs = RANK_FIRST_DELAY_MS, refreshTimeoutMs = RANK_REFRESH_TIMEOUT_MS,
  now = () => Date.now(),
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t },
  clearTimer = (t) => clearTimeout(t),
}) {
  const target = typeof file === 'string' && file !== '' ? file : undefined
  const warn = (e, f) => { try { log?.warn?.(e, f) } catch { /* logging is best effort */ } }
  const disk = (() => {
    if (!target) return undefined
    try { const j = JSON.parse(readFileSync(target, 'utf8')); return j?.version === VERSION ? j : undefined } catch { return undefined }
  })()
  let last = cleanLast(disk?.last)
  let changes = cleanChanges(disk?.changes, now())
  const status = new Map() // provider → { status, at, error?, skipped?, models }
  let running
  let timer
  let stopped = false
  let nextAt = 0
  let lastRunAt = num(disk?.lastRunAt)
  let lastMs = 0

  const list = () => [...(safe(() => providers()) ?? new Map()).values()]
  const isOff = (id) => safe(() => prefs?.isProviderDisabled?.(id)) === true
  const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimer(r, ms)) : Promise.resolve())
  const within = (p, ms) => Promise.race([Promise.resolve(p).catch(() => undefined), new Promise((r) => setTimer(() => r(undefined), ms))])
  const save = () => {
    if (!target) return
    try {
      mkdirSync(dirname(target), { recursive: true })
      const tmp = `${target}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: VERSION, lastRunAt, last, changes }), { mode: 0o600 })
      renameSync(tmp, target)
    } catch (e) { warn(e, { msg: 'llm-acp: rank file write failed', file: target }) }
  }

  /** One provider: decide whether to start its CLI, then read what the adapter serves. */
  async function collect(p, force) {
    if (isOff(p.id)) return { status: 'off', at: last[p.id]?.at ?? 0, models: last[p.id]?.models ?? [] }
    const rt = safe(() => adapter.runtime(p.id)) ?? {}
    const age = rt.catalogCache && rt.catalogCache.at > 0 ? now() - rt.catalogCache.at : Infinity
    let skipped
    let refreshed = false
    if (!p.models) {
      if (!force && Array.isArray(rt.inflight) && rt.inflight.length > 0 && age < 3 * Math.max(intervalMs, RANK_MIN_INTERVAL_MS)) skipped = 'busy'
      else if (!force && rt.backoff) skipped = 'backoff'
      else if (!force && age >= 0 && age < Math.max(intervalMs, RANK_MIN_INTERVAL_MS) / 2) skipped = 'fresh'
      else { await within(adapter.refreshCatalog(p.id), refreshTimeoutMs); refreshed = true }
    }
    const catalog = await within(adapter.catalog(p.id), refreshTimeoutMs)
    const models = cleanModels(catalog)
    const rt2 = safe(() => adapter.runtime(p.id)) ?? {}
    const d = rt2.discovery
    const at = p.models ? now() : rt2.catalogCache?.at > 0 ? rt2.catalogCache.at : 0
    const base = { at, models, refreshed, ...(skipped ? { skipped } : {}) }
    if (p.models) return { ...base, status: 'static' }
    if (d?.ok === false) return { ...base, status: 'fail', error: `${d.code ?? ''} ${d.message ?? ''}`.trim().slice(0, 300) }
    if (models.length === 0) return { ...base, status: 'empty', ...(rt2.backoff?.code ? { error: String(rt2.backoff.code) } : {}) }
    if (rt2.backoff) return { ...base, status: 'fail', error: String(rt2.backoff.code ?? 'BACKOFF') }
    return { ...base, status: 'ok' }
  }

  let queuedForce
  function runOnce({ force = false } = {}) {
    // A forced run asked for while an automatic one is going: run it right after, once.
    if (running) return force ? (queuedForce ??= running.then(() => { queuedForce = undefined; return runOnce({ force: true }) })) : running
    running = (async () => {
      const t0 = now()
      const next = {}
      const ps = list()
      for (let i = 0; i < ps.length; i++) {
        if (stopped) break
        const p = ps[i]
        let r
        try { r = await collect(p, force) } catch (e) {
          r = { status: 'fail', at: last[p.id]?.at ?? 0, models: last[p.id]?.models ?? [], error: String(e?.message ?? e).slice(0, 300) }
        }
        status.set(p.id, r)
        if ((r.status === 'ok' || r.status === 'static') && r.models.length > 0) next[p.id] = { at: r.at, models: r.models }
        if (r.refreshed && i < ps.length - 1) await sleep(staggerMs)
      }
      if (stopped) return
      const ids = new Set(ps.map((p) => p.id))
      for (const id of [...status.keys()]) if (!ids.has(id)) status.delete(id)
      const at = now()
      const found = diffSnapshots(last, next, at)
      const kept = Object.fromEntries(Object.entries(last).filter(([id]) => ids.has(id)))
      last = { ...kept, ...next }
      changes = cleanChanges([...changes, ...found], at)
      lastRunAt = at
      lastMs = at - t0
      save()
      if (found.length) safe(() => log?.info?.('rank', { phase: 'changes', count: found.length, free: found.filter((c) => c.kind === 'free').length }))
    })().catch((e) => warn(e, { msg: 'llm-acp: rank run failed' })).finally(() => { running = undefined })
    return running
  }

  function schedule(ms) {
    if (stopped || intervalMs <= 0) return
    if (timer !== undefined) clearTimer(timer)
    nextAt = now() + ms
    timer = setTimer(() => {
      timer = undefined
      runOnce().finally(() => schedule(intervalMs))
    }, ms)
  }

  return {
    intervalMs,
    start() { stopped = false; schedule(firstDelayMs) },
    stop() { stopped = true; if (timer !== undefined) clearTimer(timer); timer = undefined; nextAt = 0 },
    runOnce,
    /** 「立即重新采集」: a forced run now; the next automatic run is one interval after it. */
    async refresh({ force = true } = {}) {
      await runOnce({ force })
      if (timer !== undefined) schedule(intervalMs)
    },
    view() {
      const t = now()
      const every = intervalMs > 0 ? intervalMs : RANK_INTERVAL_MS
      const quality = qualityOf(safe(() => usage?.read()) ?? [], { since: t - QUALITY_WINDOW_MS })
      const disabled = safe(() => prefs?.get()?.disabledModels) ?? {}
      const ps = list().map((p) => {
        const s = status.get(p.id)
        const models = s?.models ?? last[p.id]?.models ?? []
        const st = isOff(p.id) ? 'off' : s?.status ?? 'pending'
        const at = s?.at ?? last[p.id]?.at ?? 0
        return {
          id: p.id, name: p.displayName ?? p.id, status: st, at, count: models.length, models,
          ...(s?.error ? { error: s.error } : {}), ...(s?.skipped ? { skipped: s.skipped } : {}),
          stale: st !== 'off' && st !== 'static' && at > 0 && t - at > 2 * every,
        }
      })
      const models = rankModels(ps.filter((p) => p.status !== 'off'), { quality, disabled })
      return {
        intervalMs, nextAt: timer === undefined ? 0 : nextAt, running: running !== undefined, lastRunAt, lastMs, generatedAt: t,
        providers: ps.map(({ models: _m, ...p }) => p),
        models,
        changes: [...changes].sort((a, b) => b.at - a.at).slice(0, 100),
        newFree: changes.filter((c) => c.kind === 'free' && t - c.at < NEW_FREE_MS).sort((a, b) => b.at - a.at),
      }
    },
  }
}
