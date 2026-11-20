// lib/dashboard-host.js — the host half of the "ACP 控制台" right-sidebar tab.
//
// Routes on the shared, authenticated /api channel (same mechanism as dsh-llm-quick):
//   GET  /api/llm-acp.dashboard?range=today|7|30|0  → providers, live status, models, usage
//   POST /api/llm-acp.models    { provider, models: [id…], disabled }  → switch models off/on
//   POST /api/llm-acp.provider  { provider, enabled }                   → switch a provider off/on
//   POST /api/llm-acp.refresh   { provider }                            → re-ask the CLI for models
//   GET  /api/llm-acp.csv?range=…                                       → usage rows as CSV
//   GET  /api/llm-acp.discover                                          → installed ACP CLIs (lib/discover.js)
//   POST /api/llm-acp.probe     { spec, recipeModelVia? }               → one ACP handshake, no prompt
//   POST /api/llm-acp.add       { id, spec, overwrite? }                → add a provider via configEditor
//   POST /api/llm-acp.remove    { id }                                  → remove a provider via configEditor
//
// Switches go to the plugin's own prefs file (lib/prefs.js) and apply at once. Routes look the
// live plugin instance up through a process-global slot, so a hot reload never leaves a route
// bound to a disposed adapter.
import { execFile } from 'node:child_process'
import { accessSync, constants, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { activity, aggregate, csvOf, tpsSeries } from './usage.js'
import { rateOf } from './adapter.js'
import { probeUsage, clearUsageCache } from './usage-probe.js'
import { FORM_DEFAULTS, addProvider, probe, recommendModelVia, removeProvider, sanitizeSpec, scan } from './discover.js'
import { launchPrefix } from './config.js'

export const ROUTES = Object.freeze({
  dashboard: '/api/llm-acp.dashboard',
  models: '/api/llm-acp.models',
  provider: '/api/llm-acp.provider',
  refresh: '/api/llm-acp.refresh',
  csv: '/api/llm-acp.csv',
  discover: '/api/llm-acp.discover',
  probe: '/api/llm-acp.probe',
  add: '/api/llm-acp.add',
  remove: '/api/llm-acp.remove',
  tps: '/api/llm-acp.tps',
})

const SLOT = Symbol.for('dsh-llm-acp.dashboard')
const VERSION_TTL_MS = 10 * 60_000
const PKG_VERSION = (() => { try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version } catch { return '?' } })()

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
})
/** How long one dashboard request waits for a provider's slow probes before answering "pending". */
const DASHBOARD_WAIT_MS = 300
const structuredCloneSafe = (v) => { if (v === undefined) return undefined; try { return JSON.parse(JSON.stringify(v)) } catch { return undefined } }
const withTimeout = (p, ms) => Promise.race([Promise.resolve(p), new Promise((r) => { const t = setTimeout(() => r(null), ms); t.unref?.() })])

/** Start of the requested range: 'today' = local midnight, N = N days back, 0/all = everything. */
export function rangeSince(range, now = Date.now()) {
  if (range === 'today') { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime() }
  const days = Number(range)
  return Number.isFinite(days) && days > 0 ? now - days * 86_400_000 : 0
}

/** command → { at, promise } of { found, version, error }. */
const versionCache = new Map()
function cliInfo(p) {
  const hit = versionCache.get(p.command)
  if (hit && Date.now() - hit.at < VERSION_TTL_MS) return hit.promise
  const promise = new Promise((resolve) => {
    let found
    if (isAbsolute(p.command)) {
      try { accessSync(p.command, constants.X_OK); found = true } catch { resolve({ found: false, error: 'not found or not executable' }); return }
    }
    execFile(p.command, [...launchPrefix(p), '--version'], { timeout: 10_000, maxBuffer: 256 * 1024, env: { ...process.env, ...p.env }, windowsHide: true }, (err, stdout, stderr) => {
      const text = `${stdout ?? ''}\n${stderr ?? ''}`.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      const m = text.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?\b/)
      if (m) resolve({ found: found ?? true, version: m[0] })
      else if (err?.code === 'ENOENT') resolve({ found: false, error: 'not on PATH' })
      else resolve({ found: found ?? !err, error: err ? String(err.message ?? err).slice(0, 200) : 'no version in --version output' })
    })
  })
  versionCache.set(p.command, { at: Date.now(), promise })
  return promise
}

function statusOf({ enabled, cli, runtime, models }) {
  if (!enabled) return { status: 'off', statusText: '已停用' }
  if (cli.found === false) return { status: 'fail', statusText: `找不到 CLI（${cli.error}）` }
  // Upstream 0.4.27 backoff: say why the CLI is not being started again, and until when.
  const b = runtime.backoff
  const wait = b ? `；${b.long ? '看起来未登录，' : ''}${Math.max(1, Math.round((b.until - Date.now()) / 60_000))} 分钟内不再自动启动（点「刷新」可立即重试）` : ''
  if (runtime.discovery?.ok === false) return { status: 'fail', statusText: `模型发现失败：${runtime.discovery.code ?? ''} ${runtime.discovery.message ?? ''}`.trim() + wait }
  if (b?.long) return { status: 'fail', statusText: `CLI 未登录（${b.code ?? 'AUTH'}）${wait}` }
  if (models === null) return { status: 'loading', statusText: '正在读取模型列表…' }
  const t = runtime.lastTurn
  if (t && !t.ok && !t.aborted && Date.now() - t.at < 30 * 60_000) return { status: 'warn', statusText: `最近一轮失败：${t.code ?? 'UNKNOWN'}` }
  return { status: 'ok', statusText: '正常' }
}

const PENDING = Symbol('pending')
const settle = (p, ms) => Promise.race([Promise.resolve(p), new Promise((r) => { const t = setTimeout(() => r(PENDING), ms); t.unref?.() })])

/**
 * One provider's card data. With `waitMs` (the console's dashboard poll) the slow parts — CLI
 * --version, model discovery, usage probe — are waited on for at most that long; whatever is not
 * ready yet is returned as pending and keeps running in the background (each is cached by its
 * in-flight promise, so the next poll picks up the same work instead of spawning the CLI again).
 * Without `waitMs` (the explicit refresh button) it waits as long as it always did.
 */
async function providerView(state, p, { waitMs } = {}) {
  const enabled = !state.prefs.isProviderDisabled(p.id)
  const w = (ms) => (waitMs === undefined ? ms : Math.min(ms, waitMs))
  const [cliR, catalogR, quotaR] = await Promise.all([
    settle(cliInfo(p), w(15_000)), settle(state.adapter.catalog(p.id), w(25_000)), settle(probeUsage(p), w(15_000)),
  ])
  const background = waitMs !== undefined
  const cli = cliR === PENDING ? { pending: true } : cliR
  const catalog = catalogR === PENDING ? null : catalogR
  const quota = quotaR === PENDING
    ? (background ? { pending: true, provider: p.id } : { supported: false, provider: p.id, note: '用量探测超时' })
    : quotaR
  const pending = background && (cliR === PENDING || catalogR === PENDING || quotaR === PENDING)
  const off = new Set(state.prefs.get().disabledModels[p.id] ?? [])
  const runtime = state.adapter.runtime(p.id)
  const models = Array.isArray(catalog)
    ? catalog.map((m) => ({ id: m.id, name: m.name, description: m.description, rate: m.rate ?? rateOf(m.description), disabled: off.has(m.id) }))
    : null
  return {
    id: p.id, displayName: p.displayName, command: p.command, args: p.args,
    permission: p.permission, modelVia: p.modelVia, mode: p.mode,
    startupTimeoutMs: p.startupTimeoutMs, promptTimeoutMs: p.promptTimeoutMs, idleTimeoutMs: p.idleTimeoutMs,
    reuseSessions: p.reuseSessions, maxSessions: p.maxSessions, resumeSessions: p.resumeSessions, images: p.images,
    staticModels: Array.isArray(p.models), enabled, cli, runtime, models,
    // The provider exactly as configured (before defaults), for the console's "编辑配置" form.
    raw: structuredCloneSafe(state.rawProviders?.[p.id]),
    // Dynamically probed usage/account info (see lib/usage-probe.js). Cached 5 min; not a balance.
    quota: quota ?? { supported: false, provider: p.id, note: '用量探测超时' },
    // true ⇒ part of this card is still being read in the background; the console polls again soon.
    pending,
    // A model switched off that the CLI no longer offers still shows, so it can be switched back on.
    staleDisabled: models ? [...off].filter((id) => !models.some((m) => m.id === id)) : [],
    ...statusOf({ enabled, cli, runtime, models }),
  }
}

/** Query params shared by the dashboard and CSV routes: custom window, cross-filter, compare. */
export function queryOpts(sp) {
  const ms = (k) => { const v = Number(sp.get(k)); return Number.isFinite(v) && v > 0 ? v : 0 }
  return {
    from: ms('from'), to: ms('to'), compare: sp.get('compare') === '1',
    provider: sp.get('provider') ?? '', model: sp.get('model') ?? '', session: sp.get('session') ?? '',
  }
}

const applyFilter = (records, filter) => records.filter((r) =>
  (!filter.provider || r.provider === filter.provider)
  && (!filter.model || (r.model ?? 'default') === filter.model)
  && (!filter.session || r.session === filter.session))

export async function buildPayload(state, range, opts = {}) {
  const now = Date.now()
  const custom = opts.from > 0 && opts.to >= opts.from
  const since = custom ? opts.from : rangeSince(range, now)
  const until = custom ? opts.to : 0
  const filter = {}
  for (const k of ['provider', 'model', 'session']) if (opts[k]) filter[k] = opts[k]
  const records = applyFilter(state.usage.read(), filter)
  const providers = await Promise.all([...state.providers.values()].map((p) => providerView(state, p, { waitMs: opts.waitMs })))
  const end = until || now
  // Previous equal-length window, for the period-over-period comparison.
  const prev = opts.compare && since > 0 && end > since
    ? aggregate(records, { since: since - (end - since), until: since - 1, recent: 0, now: since - 1 })
    : undefined
  return {
    generatedAt: now, version: PKG_VERSION, pid: process.pid, range, since,
    ...(custom ? { from: since, to: until } : {}),
    ...(Object.keys(filter).length ? { filter } : {}),
    ...(prev ? { prev } : {}),
    files: { usage: state.usage.file || null, prefs: state.prefs.file || null, sessions: state.stateFile ?? null },
    providers,
    pending: providers.some((p) => p.pending),
    usage: aggregate(records, { since, until, recent: 100, now: end }),
    activity: activity(records),
    sessions: state.adapter.sessionDirectory(),
    prefs: state.prefs.get(),
    canSave: typeof state.saveConfig === 'function',
    defaults: FORM_DEFAULTS,
  }
}

const body = async (request) => { try { return await request.json() } catch { return {} } }

/**
 * Make `state` the live dashboard instance and register the routes once the connection service
 * is available. state: { adapter, providers, prefs, usage, stateFile }.
 */
export function registerDashboardRoutes(ctx, state) {
  const log = ctx.logger
  globalThis[SLOT] = state
  ctx.effect(() => () => { if (globalThis[SLOT] === state) delete globalThis[SLOT] }, 'llm-acp: dashboard state')
  const live = () => {
    const s = globalThis[SLOT]
    if (s === undefined) throw new Error('llm-acp is not running (reloading or disabled)')
    return s
  }
  const guard = (fn) => async (request) => {
    try { return await fn(request, live()) } catch (e) { return json({ ok: false, error: String(e?.message ?? e) }, 500) }
  }
  const providerOf = (s, id) => {
    const p = s.providers.get(id)
    if (!p) throw Object.assign(new Error(`unknown provider ${JSON.stringify(id)}`), { status: 400 })
    return p
  }

  const routes = [
    {
      path: ROUTES.dashboard, methods: ['GET'], requestBody: 'buffered',
      fetch: guard(async (request, s) => {
        const sp = new URL(request.url, 'http://localhost').searchParams
        // The insights card's refresh button asks us to re-run every usage probe.
        if (sp.get('quotaRefresh') === '1') clearUsageCache()
        // Answer fast: usage stats are local; slow CLI probes fill in on the following polls.
        return json(await buildPayload(s, sp.get('range') ?? '7', { ...queryOpts(sp), waitMs: DASHBOARD_WAIT_MS }))
      }),
    },
    {
      path: ROUTES.models, methods: ['POST'], requestBody: 'buffered',
      fetch: guard(async (request, s) => {
        const b = await body(request)
        providerOf(s, b.provider)
        if (!Array.isArray(b.models) || b.models.length === 0 || b.models.some((m) => typeof m !== 'string' || m === '')) return json({ ok: false, error: 'models must be a non-empty list of model ids' }, 400)
        if (typeof b.disabled !== 'boolean') return json({ ok: false, error: 'disabled must be a boolean' }, 400)
        const prefs = s.prefs.update((cur) => {
          const set = new Set(cur.disabledModels[b.provider] ?? [])
          for (const m of b.models) { if (b.disabled) set.add(m); else set.delete(m) }
          cur.disabledModels[b.provider] = [...set]
          return cur
        })
        log?.info?.(`llm-acp: console ${b.disabled ? 'disabled' : 'enabled'} ${b.provider}/${b.models.join(', ')}`)
        s.notifyModels?.(b.provider)
        return json({ ok: true, prefs })
      }),
    },
    {
      path: ROUTES.provider, methods: ['POST'], requestBody: 'buffered',
      fetch: guard(async (request, s) => {
        const b = await body(request)
        providerOf(s, b.provider)
        if (typeof b.enabled !== 'boolean') return json({ ok: false, error: 'enabled must be a boolean' }, 400)
        const prefs = s.prefs.update((cur) => {
          const set = new Set(cur.disabledProviders)
          if (b.enabled) set.delete(b.provider); else set.add(b.provider)
          cur.disabledProviders = [...set]
          return cur
        })
        log?.info?.(`llm-acp: console ${b.enabled ? 'enabled' : 'disabled'} provider ${b.provider}`)
        s.notifyModels?.(b.provider)
        return json({ ok: true, prefs })
      }),
    },
    {
      path: ROUTES.refresh, methods: ['POST'], requestBody: 'buffered',
      fetch: guard(async (request, s) => {
        const b = await body(request)
        const p = providerOf(s, b.provider)
        versionCache.delete(p.command)
        await withTimeout(s.adapter.refreshCatalog(p.id), 90_000)
        s.notifyModels?.(p.id)
        return json({ ok: true, provider: await providerView(s, p) })
      }),
    },
    {
      path: ROUTES.discover, methods: ['GET'], requestBody: 'buffered',
      fetch: guard(async (_request, s) => {
        const r = await scan({ providers: s.providers })
        return json({ ok: true, ...r, canSave: typeof s.saveConfig === 'function', defaults: FORM_DEFAULTS })
      }),
    },
    {
      path: ROUTES.probe, methods: ['POST'], requestBody: 'buffered',
      fetch: guard(async (request) => {
        const b = await body(request)
        let spec
        try { spec = sanitizeSpec(b.spec) } catch (e) { return json({ ok: false, error: String(e?.message ?? e) }, 400) }
        const result = await probe(spec)
        log?.info?.(`llm-acp: console probe ${spec.command} → ${result.ok ? `ok ${result.ms}ms, ${result.models?.length ?? 0} models` : result.code}`)
        return json({ ok: true, result, modelVia: recommendModelVia(b.recipeModelVia, result) })
      }),
    },
    {
      path: ROUTES.add, methods: ['POST'], requestBody: 'buffered',
      fetch: guard(async (request, s) => {
        const b = await body(request)
        let spec
        try { spec = sanitizeSpec(b.spec) } catch (e) { return json({ ok: false, error: String(e?.message ?? e) }, 400) }
        if (typeof s.saveConfig !== 'function') return json({ ok: false, error: '当前 profile 不支持在界面里保存配置' }, 400)
        // Validate before handing to the editor, so a bad id/spec is a 400, not a failed reload.
        // The live providers carry command/args/env, so a duplicate CLI is caught here too.
        try { addProvider({ providers: Object.fromEntries([...s.providers].map(([k, p]) => [k, { command: p.command, args: [...p.args], env: { ...p.env } }])) }, b.id, spec, { overwrite: b.overwrite === true }) }
        catch (e) { return json({ ok: false, error: String(e?.message ?? e) }, 400) }
        await s.saveConfig((current) => addProvider(current, b.id, spec, { overwrite: b.overwrite === true }))
        log?.info?.(`llm-acp: console added provider ${b.id} (${spec.command})`)
        return json({ ok: true, id: b.id })
      }),
    },
    {
      path: ROUTES.remove, methods: ['POST'], requestBody: 'buffered',
      fetch: guard(async (request, s) => {
        const b = await body(request)
        providerOf(s, b.id)
        if (typeof s.saveConfig !== 'function') return json({ ok: false, error: '当前 profile 不支持在界面里保存配置' }, 400)
        // Hide it from open pickers right away: mark it off first (listModels then returns []) and
        // announce it, so the picker drops the group even before the plugin finishes restarting
        // with the new config (whose re-registration announces the new route set again).
        try {
          s.prefs.update((cur) => { cur.disabledProviders = [...new Set([...(cur.disabledProviders ?? []), b.id])]; return cur })
          s.notifyModels?.(b.id)
        } catch { /* best effort */ }
        await s.saveConfig((current) => removeProvider(current, b.id))
        // Drop the leftover switch so a provider re-added later under the same id starts enabled.
        try {
          s.prefs.update((cur) => {
            cur.disabledProviders = (cur.disabledProviders ?? []).filter((x) => x !== b.id)
            if (cur.disabledModels) delete cur.disabledModels[b.id]
            return cur
          })
        } catch { /* best effort */ }
        log?.info?.(`llm-acp: console removed provider ${b.id}`)
        return json({ ok: true, id: b.id })
      }),
    },
    {
      // Per-model TPS in 5-minute buckets over the last day / week / month (never older than 30 days),
      // independent of the dashboard range; honours the cross-filter (provider / model / session).
      path: ROUTES.tps, methods: ['GET'], requestBody: 'buffered',
      fetch: guard(async (request, s) => {
        const sp = new URL(request.url, 'http://localhost').searchParams
        const records = applyFilter(s.usage.read(), queryOpts(sp))
        return json({ ok: true, ...tpsSeries(records, { window: sp.get('window') ?? 'day' }) })
      }),
    },
    {
      path: ROUTES.csv, methods: ['GET'], requestBody: 'buffered',
      fetch: guard(async (request, s) => {
        const sp = new URL(request.url, 'http://localhost').searchParams
        const o = queryOpts(sp)
        const custom = o.from > 0 && o.to >= o.from
        const since = custom ? o.from : rangeSince(sp.get('range') ?? '7')
        const rows = applyFilter(s.usage.read(), o).filter((r) => r.at >= since && (!custom || r.at <= o.to))
        return new Response(`\uFEFF${csvOf(rows)}`, {
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="llm-acp-usage-${new Date().toISOString().slice(0, 10)}.csv"`,
            'cache-control': 'no-store',
          },
        })
      }),
    },
  ]

  const seen = new WeakSet()
  const register = (connection, scoped) => {
    if (!connection?.fetch?.register || seen.has(connection)) return
    seen.add(connection)
    for (const route of routes) {
      try {
        const dispose = connection.fetch.register(route)
        if (typeof dispose === 'function') (scoped ?? ctx).effect(() => dispose, `llm-acp: route ${route.path}`)
      } catch (e) {
        // Already registered by a previous instance: that route reads the live state slot, so it
        // serves this instance too.
        log?.warn?.(`llm-acp: dashboard route ${route.path}: ${e?.message ?? e}`)
      }
    }
    log?.info?.(`llm-acp: dashboard routes registered (${ROUTES.dashboard})`)
  }
  if (typeof ctx.inject === 'function') ctx.inject(['connection'], (scoped) => register(scoped.connection ?? scoped.get?.('connection'), scoped))
  else { try { register(ctx.get('connection')) } catch { /* no connection service: no console */ } }
  return { routes }
}
