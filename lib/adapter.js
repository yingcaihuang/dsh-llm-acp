import { createHash } from 'node:crypto'

// lib/adapter.js — the LLM adapter. Plan A (fresh child per call) and plan B (warm sessions).
//
// createAcpAdapter({ Base }) builds a subclass of the host's LlmAdapter when it is available
// (index.js passes it in), or of a plain class in tests. Only providerInfo / providerRetryPolicy /
// listModels / resolveModel / stream are implemented. resolveModel reports image input when the CLI
// advertises it; imageRequestTarget keeps the base default (send the normalized image as is).
import { cliNameOf, modelArgsFor, retryPolicyFor } from './config.js'
import { flattenMessages, WARM_PREAMBLE } from './flatten.js'
import { createChunkMapper, mapStopReason } from './map.js'
import { openSession, abortError, effortOptionOf } from './acp-session.js'
import { AcpError, refusalFailure } from './errors.js'
import { createSessionCache } from './session-cache.js'
import { createLogger, fromHostLogger } from './log.js'
import { createSessionStore } from './session-store.js'
import { createModelsStore } from './models-store.js'
import { codebuddyCredits, isCodebuddyCommand, isKiroCommand, listKiroCredits } from './credits.js'

/** Codes that can only arise before a prompt is sent, so retrying cannot replay a side effect. */
const STARTUP_CODES = new Set(['ACP_SPAWN', 'TIMEOUT'])
/** Failures that are worth one more attempt when nothing has been produced yet. */
// Ported from upstream guozi058/dsh-llm-acp 0.4.27 (660af30): how long a failed background start
// (model discovery, image-capability probe) keeps the CLI from being started again. Each
// consecutive failure doubles the window from modelDiscoveryBackoffMs up to
// modelDiscoveryMaxBackoffMs; AUTH (the CLI is logged out) goes straight to the cap: until someone
// logs in every start is wasted, and some CLIs (kiro-cli) open a browser login page each time.
// modelDiscoveryBackoffMs: 0 keeps its old meaning: no backoff at all.
const LONG_BACKOFF_CODES = new Set(['AUTH'])
// kiro-cli started logged out opens the browser login page and then waits there, so for it a
// startup TIMEOUT means the same as AUTH: the long window, and no startup retry.
const opensLoginPage = (p) => cliNameOf(p) === 'kiro' || cliNameOf(p) === 'kiro-cli'
/** Whether a failure record { code } should wait the long (logged-out) window. */
export function isLongFailure(p, fail) {
  return fail !== undefined && fail !== null && (LONG_BACKOFF_CODES.has(fail.code) || (fail.code === 'TIMEOUT' && opensLoginPage(p)))
}
/** Milliseconds a failure record { code, count } keeps the CLI from being started in the background. */
export function backoffFor(p, fail) {
  const base = p.modelDiscoveryBackoffMs
  if (fail === undefined || fail === null || !(base > 0)) return 0
  const cap = Math.max(base, p.modelDiscoveryMaxBackoffMs ?? base)
  if (isLongFailure(p, fail)) return cap
  const n = Math.min(30, Math.max(1, fail.count ?? 1))
  return Math.min(cap, base * 2 ** (n - 1))
}
/** The failure record after prev (undefined: the first failure in a row). */
export function nextFailure(prev, e) {
  return { at: Date.now(), code: typeof e?.code === 'string' ? e.code : undefined, count: (prev?.count ?? 0) + 1 }
}

const RETRYABLE_PROMPT_CODES = new Set(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])

/**
 * @param {object} deps
 * @param {new () => object} deps.Base host LlmAdapter (or a stand-in)
 * @param {() => Map<string, object>} deps.providers current resolved profiles
 * @param {(sessionId: string|undefined, signal?: AbortSignal) => string|Promise<string>} deps.resolveCwd working directory for a host session
 * @param {{info: Function, warn: Function, error: Function}} [deps.logger]
 * @param {string} [deps.stateFile] where CLI-native session ids are remembered (undefined ⇒ memory only)
 * @param {(ref: object, target: object, signal?: AbortSignal) => Promise<{data: Uint8Array, mediaType: string}>} [deps.readImage] host attachment bytes
 */
export function createAcpAdapter({ Base, providers, resolveCwd, logger, stateFile, modelsFile, readImage, prefs, onTurn, userApproval }) {
  // Accept a plain host logger or a structured one; structured is what the tests assert on.
  // A structured logger is used as-is; anything else (the host's own logger, or a test stub with
  // only info/warn/error) gets wrapped so every line is sanitised and timed.
  const log = logger === undefined ? createLogger() : logger.structured === true ? logger : fromHostLogger(logger)
  // ACP console switches (lib/prefs.js): a disabled provider lists no models; a disabled model is
  // hidden from the picker and refused when a model reference still names it.
  const providerOff = (id) => prefs?.isProviderDisabled?.(id) === true
  const modelOff = (id, model) => prefs?.isModelDisabled?.(id, model) === true

  class AcpAdapter extends Base {
    #children = new Set()
    #sessions = new Set()
    #models = new Map() // provider → { fp, at, list, failed, code?, count? } (rendered host catalog)
    /** provider → { configId?, efforts, default? } learned from a real session or restored from disk. */
    #efforts = new Map()
    /** host sessionId → host approvals in flight (askUser); sessionId → idle refreshers of live turns. */
    #asking = new Map()
    #askWatchers = new Map()

    /**
     * Put one CLI permission request to DSH's approval service (upstream 0.4.19 askHost; local: a
     * small wait table instead of the MCP-bridge holds). While it waits, the turn's idle timer is
     * re-armed instead of firing; when it ends, the idle window starts over. Never rejects. The log
     * line says asked + outcome only: no tool title, no arguments.
     */
    async #askHost(p, sessionId, { title, signal } = {}) {
      this.#asking.set(sessionId, (this.#asking.get(sessionId) ?? 0) + 1)
      let outcome
      try { outcome = await userApproval.ask({ sessionId, providerId: p.id, title, signal }) } catch { outcome = 'unavailable' } finally {
        const n = (this.#asking.get(sessionId) ?? 1) - 1
        if (n > 0) this.#asking.set(sessionId, n)
        else this.#asking.delete(sessionId)
        for (const f of this.#askWatchers.get(sessionId) ?? []) { try { f() } catch {} }
      }
      if (!['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(outcome)) outcome = 'unavailable'
      if (signal?.aborted) outcome = 'cancelled'
      log.info('permission', { provider: p.id, asked: true, outcome })
      return outcome
    }
    /** provider → true/false once a CLI has told us (initialize.promptCapabilities.image). */
    #imageCaps = new Map()
    /** provider → { at } of the last failed capability probe, and the in-flight probe. */
    #imageProbeFailed = new Map()
    #imageProbing = new Map()
    #disposed = false
    #caches = new Map() // provider → warm-session cache
    #childProvider = new Map() // live child → provider id (ACP console)
    #discovery = new Map() // provider → last model discovery { at, ok, ms, count?, code?, message? }
    #lastTurn = new Map() // provider → last turn record
    #inflight = new Set() // turns running right now (ACP console)

    #beginFlight(p, options, started, cwd) {
      const f = { provider: p.id, model: options.model ?? 'default', ...(options.sessionId === undefined ? {} : { session: options.sessionId }), ...(cwd ? { cwd } : {}), startedAt: started }
      this.#inflight.add(f)
      return f
    }
    #store = createSessionStore({ file: stateFile, warn: (e, f) => log.warn(e, f) })
    // Last good model list per provider on disk (upstream lib/models-store.js); no file ⇒ memory only.
    #modelStore = createModelsStore({ file: typeof modelsFile === 'string' && modelsFile !== '' ? modelsFile : undefined, warn: (e, f) => log.warn(e, f) })
    #modelFlights = new Map() // provider → { promise } (one discovery at a time)

    #profile(provider) {
      const p = providers().get(provider)
      if (!p) throw new AcpError(`llm-acp: no ACP profile for provider "${provider}"`, 'NO_ADAPTER')
      return p
    }

    providerInfo(provider) {
      const p = providers().get(provider)
      return { id: provider, name: p?.displayName ?? `${provider} (外部 CLI · external CLI)` }
    }

    providerRetryPolicy(provider) {
      const p = providers().get(provider)
      return p ? retryPolicyFor(p) : undefined
    }

    /**
     * Model metadata for the host. `inputModalities` decides whether the HOST lets images through
     * at all (GUI attachment check, request projection): it must say "image" when the CLI accepts
     * images, or the ACP image path below is never reached. The CLI's own answer
     * (initialize.promptCapabilities.image) is used once known; until then one cheap probe asks it.
     */
    async resolveModel(provider, model, signal) {
      const p = providers().get(provider)
      // Read the effort list BEFORE any awaiting (upstream): never wait for a CLI just for this.
      const efforts = p === undefined ? undefined : this.#knownEfforts(p)
      if (p !== undefined && efforts === undefined) this.#requestEfforts(p)
      const image = p !== undefined && p.images && readImage !== undefined && await this.#acceptsImages(p, signal)
      // The CLI's display name (e.g. qmodel_latest → Qwen4-Max-Preview), so the host picker
      // shows which model it actually is; falls back to the raw id without a catalog.
      const label = model === 'default' ? model : (await this.catalog(provider)).find((m) => m.id === model)?.name ?? model
      return {
        provider, id: model,
        name: model === 'default' ? `${provider} · CLI default` : `${label} · via ${provider} CLI`,
        description: 'External CLI agent over ACP: runs its own tools, cannot call harness tools, sees the conversation as a transcript.',
        inputModalities: image ? ['text', 'image'] : ['text'],
        context: { contextWindow: p?.contextWindow ?? 200_000 },
        // Never `defaultEffort` (upstream): the host would then fill one into every call and "the
        // user chose this" could no longer be told apart. No efforts ⇒ no key (the host rejects []).
        ...(efforts === undefined || efforts.length === 0 ? {} : { reasoning: { efforts: efforts.map((e) => ({ ...e })) } }),
      }
    }

    /** The effort list learned in this process (or restored from disk) for `p`, if known. */
    #knownEfforts(p) {
      const mem = this.#efforts.get(p.id)
      if (mem !== undefined) return mem.efforts
      if (p.models) return undefined
      const disk = this.#modelStore.get(p.id, this.#fingerprint(p))
      if (disk === undefined || !Object.prototype.hasOwnProperty.call(disk, 'efforts')) return undefined
      this.#efforts.set(p.id, { configId: undefined, efforts: disk.efforts, default: disk.effortDefault })
      return disk.efforts
    }

    /**
     * Learn efforts in the background when unknown: one discovery (single-flight, honours the
     * failure backoff). Static `models` channels learn them from their first real session.
     */
    #requestEfforts(p) {
      if (this.#efforts.has(p.id) || p.models) return
      const fp = this.#fingerprint(p)
      const known = this.#models.get(p.id)
      if (known !== undefined && known.fp === fp && known.failed === true && Date.now() - known.at < backoffFor(p, known)) return
      this.#refreshModels(p, fp).catch(() => {})
    }

    /**
     * Record what a real session reported about efforts. With `baseline`, its current value becomes
     * the channel's restore point (discovery only — a conversation's value may be a user's pick).
     */
    #learnEffort(p, session, { baseline = false } = {}) {
      const opts = session?.info?.configOptions
      const o = Array.isArray(opts) ? effortOptionOf(opts) : undefined
      if (o === undefined) {
        // Discovery is the channel's answer: no usable thought_level — including no configOptions at
        // all — is a confirmed "none", so resolveModel never respawns the CLI to ask again. A
        // conversation session without configOptions (session/load may omit them) says nothing.
        if (!Array.isArray(opts) && !baseline) return
        if (!this.#efforts.has(p.id)) this.#efforts.set(p.id, { configId: undefined, efforts: [], default: undefined })
        return
      }
      const prev = this.#efforts.get(p.id)
      const keepDefault = baseline ? (o.current !== undefined && o.efforts.some((e) => e.id === o.current) ? o.current : undefined) : prev?.default
      this.#efforts.set(p.id, { configId: o.configId, efforts: o.efforts, default: keepDefault })
    }

    /**
     * The effort work for one turn (upstream #effortForTurn): host value → channel `effort` → the
     * session's baseline. The first turn reuses what opening the session did. Bounded: a CLI that
     * does not answer within 5 s is marked deaf for this session; the turn always goes on.
     */
    async #effortForTurn(p, options, session, signal) {
      const want = typeof options.reasoningEffort === 'string' && options.reasoningEffort !== '' ? options.reasoningEffort : undefined
      const first = session.firstTurn === true
      session.firstTurn = false
      if (typeof session.applyEffort !== 'function' || session.effortDeaf === true) return undefined
      // Opening the session already applied this turn's pick (or the channel default): reuse it.
      if (first && session.startupEffort !== undefined) return session.startupEffort
      if (session.effortState === undefined && session.loaded === true) {
        // session/load without configOptions: borrow the channel's list and baseline.
        const mem = this.#efforts.get(p.id)
        if (mem !== undefined && typeof mem.configId === 'string' && mem.efforts.length > 0) {
          session.effortState = { configId: mem.configId, efforts: mem.efforts, current: undefined, baseline: mem.default }
        }
      }
      if (session.effortState === undefined && want === undefined && p.effort === undefined) return undefined
      const flight = Promise.resolve(session.applyEffort(want, p.effort)).catch(() => ({ ok: false, code: 'EFFORT_REJECTED' }))
      let timer
      let onAbort
      const got = await Promise.race([
        flight,
        new Promise((r) => { timer = setTimeout(() => r('slow'), 5000) }),
        new Promise((r) => { onAbort = () => r('aborted'); signal?.addEventListener?.('abort', onAbort, { once: true }) }),
      ]).finally(() => { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort) })
      if (got === 'aborted' || signal?.aborted === true) throw abortError(signal)
      if (got === 'slow') {
        if (session.effortState !== undefined) session.effortState.current = undefined
        session.effortDeaf = true
        return { ok: false, code: 'EFFORT_TIMEOUT', ...(want === undefined ? {} : { effort: want }) }
      }
      return got
    }

    /** Whether this provider's CLI advertises image prompts. Never throws; unknown ⇒ false. */
    //
    // resolveModel runs before EVERY turn (host prepareCall), so a CLI that is down must not cost a
    // spawn per turn: discovery has its own failure backoff, and the direct probe (static `models`)
    // honours modelDiscoveryBackoffMs too. Concurrent lookups share one probe.
    async #acceptsImages(p, signal) {
      if (this.#imageCaps.has(p.id)) return this.#imageCaps.get(p.id)
      if (!p.models) {
        // Discovery opens a session anyway and records the capability; if it failed, its cached
        // failure (and backoff) is the answer — no second spawn here.
        try { await this.catalog(p.id) } catch {}
        return this.#imageCaps.get(p.id) === true
      }
      const failed = this.#imageProbeFailed.get(p.id)
      if (failed !== undefined && Date.now() - failed.at < backoffFor(p, failed)) return false
      let probe = this.#imageProbing.get(p.id)
      if (probe === undefined) {
        probe = (async () => {
          try {
            const s = await openSession(this.#spec(p, 'default', await resolveCwd(undefined), signal))
            try { this.#noteCaps(p, s) } finally { await s.dispose() }
            this.#imageProbeFailed.delete(p.id)
          } catch (e) {
            // CLI down: text-only for now. The window grows with each consecutive failure, and an
            // AUTH failure waits the longest (upstream 0.4.27).
            const f = nextFailure(this.#imageProbeFailed.get(p.id), e)
            this.#imageProbeFailed.set(p.id, f)
            log.info('probe', { provider: p.id, phase: 'backoff', code: f.code, count: f.count, ms: backoffFor(p, f) })
          }
        })().finally(() => this.#imageProbing.delete(p.id))
        this.#imageProbing.set(p.id, probe)
      }
      await probe
      return this.#imageCaps.get(p.id) === true
    }

    #noteCaps(p, session) {
      const caps = session?.capabilities
      if (caps && typeof caps === 'object') this.#imageCaps.set(p.id, caps.promptCapabilities?.image === true)
    }

    /** Models offered to the host picker: the catalog minus what the ACP console switched off. */
    async listModels(provider) {
      if (providerOff(provider)) return []
      const list = await this.catalog(provider)
      // `rate` is console metadata; the host picker gets the plain entry.
      return list.filter((m) => !modelOff(provider, m.id)).map(({ rate, ...m }) => m)
    }

    /**
     * Every model the CLI offers (cached), regardless of console switches.
     *
     * Ported from upstream 0.4.x (models cache): the last good list survives a restart
     * (lib/models-store.js, keyed by a profile fingerprint); a stale list is served at once while
     * one background discovery refreshes it; a failed or empty refresh keeps the old list and
     * backs off (backoffFor). Only a cold provider with nothing to serve waits for the CLI.
     */
    async catalog(provider) {
      const p = providers().get(provider)
      if (!p) return []
      if (p.models) return this.#render(p, p.models.map((id) => ({ id, name: id })), { rate: false })
      const fp = this.#fingerprint(p)
      let known = this.#models.get(provider)
      if (known !== undefined && known.fp !== fp) {
        // The profile changed (command / args / env): the old catalog belongs to another CLI.
        this.#models.delete(provider)
        this.#imageCaps.delete(provider)
        this.#efforts.delete(provider)
        known = undefined
      }
      if (known === undefined) {
        // First call in this process: the last good list comes from disk.
        const disk = this.#modelStore.get(provider, fp)
        if (disk !== undefined && disk.list.length > 0) {
          known = { fp, at: disk.at, list: this.#render(p, disk.list), failed: false, disk: true }
          this.#models.set(provider, known)
          if (disk.image !== undefined && !this.#imageCaps.has(provider)) this.#imageCaps.set(provider, disk.image === true)
          if (Object.prototype.hasOwnProperty.call(disk, 'efforts') && !this.#efforts.has(provider)) {
            this.#efforts.set(provider, { configId: undefined, efforts: disk.efforts, default: disk.effortDefault })
          }
          log.info('models-cache', { provider, phase: 'disk-load', count: disk.list.length })
        }
      }
      if (known !== undefined) {
        // A failed discovery is cached for its own window: respawning the CLI on every catalog
        // refresh would cost 0.6–3.2 s each time it is down. Upstream 0.4.27: the window doubles
        // with each consecutive failure, and a logged-out CLI waits modelDiscoveryMaxBackoffMs.
        const ttl = known.failed === true ? backoffFor(p, known) : p.modelCacheMs
        const age = Date.now() - known.at
        if (age >= 0 && age < ttl) return known.list // a clock step backwards counts as stale
        if (known.list.length > 1) {
          // Stale but worth serving: answer now, refresh in the background (one CLI at most).
          this.#refreshModels(p, fp).catch(() => {})
          return known.list
        }
      }
      // Nothing to serve: this caller pays the discovery, every later one joins or hits the cache.
      await this.#refreshModels(p, fp)
      return this.#models.get(provider)?.list ?? this.#baseList(provider)
    }

    /** Host catalog entries for a CLI list: "default" first, names disambiguated, rate appended. */
    #render(p, found, { rate = true } = {}) {
      const entry = (m) => ({ provider: p.id, id: m.id, name: m.name || m.id, ...(m.description ? { description: m.description } : {}), ...(m.rate ? { rate: m.rate } : {}) })
      const named = disambiguateNames(found)
      const shown = rate && p.rateInName ? withRate(named) : named
      const seen = new Set()
      return [...this.#baseList(p.id), ...shown.map(entry)].filter((m) => !seen.has(m.id) && seen.add(m.id))
    }

    /** Digest of what decides which catalog a CLI reports (env is order-insensitive). */
    #fingerprint(p) {
      const env = Object.entries(p.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      return `sha256:${createHash('sha256').update(JSON.stringify({ command: p.command, args: [...p.args, ...modelArgsFor(p, 'default')], env, modelVia: p.modelVia })).digest('hex')}`
    }

    /**
     * Run (or join) one discovery for `p`. Always resolves. A flight replaced by refreshCatalog()
     * or outlived by dispose() never writes back. Failure keeps the last good list.
     */
    #refreshModels(p, fp) {
      const running = this.#modelFlights.get(p.id)
      if (running !== undefined) return running.promise
      const flight = {}
      const live = () => !this.#disposed && this.#modelFlights.get(p.id) === flight
      const finish = log.timed('discovery', { provider: p.id })
      const t0 = Date.now()
      const backoffOf = (f) => (f === undefined ? {} : { failures: f.count, backoffMs: backoffFor(p, f) })
      const fail = (e) => {
        const prev = this.#models.get(p.id)
        const same = prev !== undefined && prev.fp === fp
        const f = nextFailure(same && prev.failed === true ? prev : undefined, e)
        this.#models.set(p.id, { fp, list: same ? prev.list : this.#baseList(p.id), failed: true, ...f })
        return f
      }
      flight.promise = this.#discover(p).then(
        (found) => {
          if (!live()) return
          const list = this.#render(p, found)
          // An empty catalog is a failure, not a new truth: keep the old list and back off.
          const f = list.length > 1 ? undefined : fail({ code: 'EMPTY_RESPONSE' })
          if (f === undefined) {
            this.#models.set(p.id, { fp, at: Date.now(), list, failed: false })
            this.#persist(p, fp, found)
          }
          finish({ ok: true, count: list.length, ...backoffOf(f) })
          this.#discovery.set(p.id, { at: Date.now(), ok: true, count: list.length, ms: Date.now() - t0, ...backoffOf(f) })
        },
        (e) => {
          if (!live()) return
          const f = fail(e)
          finish({ ok: false, code: e?.code, message: e?.message ?? String(e), ...backoffOf(f) })
          this.#discovery.set(p.id, { at: Date.now(), ok: false, ms: Date.now() - t0, code: e?.code, message: String(e?.message ?? e).slice(0, 300), ...backoffOf(f) })
        },
      ).finally(() => { if (this.#modelFlights.get(p.id) === flight) this.#modelFlights.delete(p.id) })
      this.#modelFlights.set(p.id, flight)
      return flight.promise
    }

    /** Write the last good raw list (and the image capability it taught) to disk. */
    #persist(p, fp, found) {
      const image = this.#imageCaps.get(p.id)
      const eff = this.#efforts.get(p.id)
      this.#modelStore.set(p.id, {
        fp, at: Date.now(), list: found, ...(image === undefined ? {} : { image }),
        ...(eff === undefined ? {} : { efforts: eff.efforts, ...(eff.default === undefined ? {} : { effortDefault: eff.default }) }),
      })
    }

    /** The catalog's always-present entry: let the CLI pick its own model. */
    #baseList(provider) {
      return [{ provider, id: 'default', name: `${provider} · CLI default`, description: 'Let the CLI pick its configured model' }]
    }

    /** Ask the CLI which models its session/new advertises (ACP `models` extension). */
    async #discover(p) {
      const cwd = await resolveCwd(undefined)
      const s = await openSession({ ...this.#spec(p, 'default', cwd) })
      this.#noteCaps(p, s)
      this.#learnEffort(p, s, { baseline: true })
      let found = []
      let rates = new Map()
      try {
        const list = s.info?.models?.availableModels
        if (Array.isArray(list)) {
          // Upstream 0.4.7: codebuddy carries the multiplier in _meta.credits (description as fallback);
          // a zero multiplier is shown as "0x 免费".
          if (isCodebuddyCommand(p.command, p.args)) rates = codebuddyCredits(list)
          found = list.filter((m) => typeof m?.modelId === 'string' && m.modelId !== '' && m.modelId !== 'default')
            .map((m) => ({ id: m.modelId, name: typeof m.name === 'string' ? m.name : m.modelId, description: typeof m.description === 'string' ? m.description : undefined }))
        } else {
          // Agents that have no `models` extension may still offer a `model` select configOption
          // (Claude Code, Codex). That list is the catalog as far as the host is concerned.
          const opts = Array.isArray(s.info?.configOptions) ? s.info.configOptions : []
          const opt = opts.find((o) => o?.category === 'model' || o?.id === 'model')
          found = Array.isArray(opt?.options)
            ? opt.options.filter((o) => typeof o?.value === 'string' && o.value !== '' && o.value !== 'default')
              .map((o) => ({ id: o.value, name: typeof o.name === 'string' ? o.name : o.value, description: typeof o.description === 'string' ? o.description : undefined }))
            : []
        }
      } finally { await s.dispose() }
      // Upstream 0.4.5: kiro-cli prints multipliers only in `chat --list-models`. Asked once, after a
      // good handshake; best-effort (10 s, any failure ⇒ no multipliers, never a failed discovery).
      if (isKiroCommand(p.command, p.args) && found.length > 0) {
        const kiro = await listKiroCredits({ command: p.command, args: p.args, env: p.env, cwd })
        rates = new Map([...kiro].map(([id, x]) => [id, `${x}x`]))
      }
      return rates.size === 0 ? found : found.map((m) => (rates.has(m.id) ? { ...m, rate: rates.get(m.id) } : m))
    }

    #spec(p, model, cwd, signal, loadSessionId, { effort, sessionId } = {}) {
      return {
        command: p.command, args: [...p.args, ...modelArgsFor(p, model)], env: p.env, cwd,
        permission: p.permission, readTools: p.readTools, mode: p.mode, approvalModes: p.approvalModes, approvals: p.approvals, model, modelVia: p.modelVia, closing: () => this.#disposed, startupTimeoutMs: p.startupTimeoutMs, disposeGraceMs: p.disposeGraceMs, signal, loadSessionId,
        // Reasoning effort applied at startup (upstream): the opening turn's host pick, then the
        // channel default. Later turns switch in #turn; the first turn reuses this result.
        effort: typeof effort === 'string' && effort !== '' ? effort : undefined, effortDefault: p.effort,
        // askUser: only a real conversation turn (host sessionId) on a channel that refuses things.
        // Discovery and probes pass no sessionId and never ask anyone.
        ...(p.askUser === true && p.permission !== 'allow' && typeof sessionId === 'string' && sessionId !== '' && typeof userApproval?.ask === 'function'
          ? { askUser: (q) => this.#askHost(p, sessionId, q) } : {}),
        track: (child) => { this.#children.add(child); this.#childProvider.set(child, p.id); const forget = () => { this.#children.delete(child); this.#childProvider.delete(child) }; child.once('exit', forget); return forget },
      }
    }

    /** Async iterable of host stream chunks for one call. */
    stream(options) {
      const self = this
      return { [Symbol.asyncIterator]: () => self.#run(options) }
    }

    async *#run(options) {
      if (this.#disposed) throw new AcpError('llm-acp adapter was disposed', 'DISPOSED')
      const p = this.#profile(options.provider)
      if (providerOff(p.id) || modelOff(p.id, options.model ?? 'default')) {
        throw new AcpError(`llm-acp: ${p.id}/${options.model ?? 'default'} 已在 ACP 控制台停用 (disabled in the ACP console); enable it there or pick another model`, 'ACP_MODEL_DISABLED')
      }
      const signal = options.signal
      signal?.throwIfAborted?.()
      const cwd = await resolveCwd(options.sessionId, signal)
      signal?.throwIfAborted?.()

      if (!p.reuseSessions) {
        yield* this.#runFresh(p, options, cwd, signal)
        return
      }
      // Warm path: the cache owns the child's lifetime and serializes turns per host session.
      const cache = this.#cacheFor(p)
      const key = `${cwd}\u0000${options.sessionId ?? ''}\u0000${options.model ?? ''}`
      const started = Date.now()
      // Recorded exactly once, also when the host stops iterating right after the finish chunk
      // (the code after `yield*` then never runs): the finally below falls back to what #turn saw.
      const tap = {}
      let recorded = false
      const flight = this.#beginFlight(p, options, started, cwd)
      const finish = (outcome) => { if (recorded) return; recorded = true; this.#recordTurn(p, options, started, outcome, cwd, tap); log.info('turn', {
        provider: p.id, model: options.model, session: options.sessionId, phase: 'done',
        ok: outcome.ok, ms: Date.now() - started, chars: outcome.chars,
        ...(outcome.code === undefined ? {} : { code: outcome.code }),
        ...(outcome.message === undefined ? {} : { message: outcome.message }),
        ...(outcome.aborted === true ? { aborted: true } : {}),
      }) }
      // The cache hands back an async generator so chunks keep flowing while it holds the lock.
      // It also decides reuse: anything but a clean finish (error, abort, early return) drops the CLI.
      let outcome
      try {
        const stream = await this.#withPromptRetry(p, signal, () => cache.stream(key, {
          open: () => this.#openResumable(p, options, cwd, signal, key),
          alive: (session) => !session.exited,
          replyKey: (session) => (session.historyKey === undefined ? undefined : { key: session.historyKey, count: session.historyCount }),
          turn: (session, previous) => this.#turn(p, options.model, options, session, previous ?? session.resumedMarker, signal, key, tap),
        }))
        outcome = yield* stream
      } catch (error) {
        finish({ ok: false, code: error?.code, message: error?.message })
        throw error
      } finally {
        if (!recorded && outcome === undefined) finish(tapOutcome(tap))
        this.#inflight.delete(flight)
      }
      finish({ ...outcomeFields(outcome), usage: outcome?.usage })
    }

    /** One-shot path (reuseSessions: false): a fresh child, torn down at the end of the turn. */
    async *#runFresh(p, options, cwd, signal) {
      const key = `${cwd}\u0000${options.sessionId ?? ''}\u0000${options.model ?? ''}`
      const session = await this.#openResumable(p, options, cwd, signal, key)
      this.#sessions.add(session)
      const started = Date.now()
      const tap = {}
      let recorded = false
      const flight = this.#beginFlight(p, options, started, cwd)
      try {
        const stream = await this.#withPromptRetry(p, signal, () => this.#turn(p, options.model, options, session, session.resumedMarker, signal, key, tap))
        const outcome = yield* stream
        recorded = true
        this.#recordTurn(p, options, started, { ...outcomeFields(outcome), usage: outcome?.usage }, cwd, tap)
        log.info('turn', { provider: p.id, model: options.model, session: options.sessionId, phase: 'done', ms: Date.now() - started, ...outcomeFields(outcome) })
      } catch (error) {
        recorded = true
        this.#recordTurn(p, options, started, { ok: false, code: error?.code, message: error?.message }, cwd, tap)
        log.info('turn', { provider: p.id, model: options.model, session: options.sessionId, phase: 'done', ok: false, ms: Date.now() - started, code: error?.code, message: error?.message })
        throw error
      } finally {
        if (!recorded) this.#recordTurn(p, options, started, tapOutcome(tap), cwd, tap)
        this.#inflight.delete(flight)
        this.#sessions.delete(session)
        // dispose() itself sends session/cancel when a prompt is still live, then escalates.
        await session.dispose()
      }
    }

    /**
     * Retry a turn that failed BEFORE producing output.
     *
     * Only transient provider conditions (rate limit, server, timeout, transport) qualify, and only
     * when nothing was emitted: a turn that already streamed text — and therefore may have run
     * tools — is never replayed. Returns the (unstarted) generator so the caller drives it.
     */
    async #withPromptRetry(p, signal, run) {
      const attempts = 1 + p.promptRetries
      for (let i = 0; ; i++) {
        signal?.throwIfAborted?.()
        const stream = run()
        let first
        try {
          // Peek the first chunk: #turn throws a retryable error BEFORE yielding anything, so a
          // failure here is guaranteed to have produced no output and may be retried.
          first = await stream.next()
        } catch (error) {
          if (error?.retryable !== true || signal?.aborted === true) throw error
          if (i >= attempts - 1) {
            // Out of attempts: report in-band, exactly once, like any other failed turn.
            log.warn('turn', { provider: p.id, phase: 'retry-exhausted', attempts, code: error.code })
            // Keep the original code for the console's error breakdown, but say plainly what
            // happened in the host-facing message so a rate-limited user is not left guessing.
            const hint = error.code === 'RATE_LIMIT'
              ? `模型调用触发限流（429），自动重试 ${attempts - 1} 次后仍失败`
              : `模型调用失败（${error.code ?? '未知错误'}），自动重试 ${attempts - 1} 次后仍失败`
            const shown = new AcpError(`${hint}：${error.message ?? ''}`, error.code, { cause: error })
            const terminal = createChunkMapper().fail(shown)
            return (async function* () { yield* terminal; return { failed: true, code: error.code, message: shown.message } })()
          }
          const delay = retryDelayFor(error.code, i, error.message, p.retryDelayMs)
          log.warn('turn', { provider: p.id, phase: 'retry', attempt: i + 1, of: attempts, code: error.code, delayMs: delay })
          await new Promise((r) => setTimeout(r, delay))
          continue
        }
        // yield* (not a manual next() loop) so an early return() by the host reaches #turn's finally.
        return (async function* () {
          if (first.done === true) return first.value
          yield first.value
          return yield* stream
        })()
      }
    }

    /**
     * Run ONE turn on an open session, streaming chunks as they arrive.
     *
     * `sent` is the conversation the CLI was last told about (undefined on a cold session). A warm
     * CLI already holds it, so only the new tail is sent. If the host's history no longer begins
     * with exactly that prefix — it rewound, compacted or replaced the conversation — the CLI must
     * be rebuilt instead of mixing two transcripts (STALE_SESSION, handled by the cache).
     *
     * Yields chunks INCREMENTALLY: the host's watchdog judges liveness by the first chunk, so
     * buffering a whole turn would look like a stall and get the member interrupted.
     *
     * Returns `{ chars, aborted? }` through the generator's return value.
     */
    async *#turn(p, model, options, session, sent, signal, storeKey, tap) {
      const messages = options.messages ?? []
      // A warm CLI already holds `sent`. If the host's history no longer begins with exactly that
      // prefix (rewound, compacted, replaced), sending the full transcript would give the CLI two
      // interleaved copies — rebuild the process instead.
      let fresh = messages
      if (sent !== undefined) {
        const delta = messagesSince(messages, sent)
        if (delta === undefined) throw new AcpError('llm-acp: conversation changed under a warm session; rebuilding', 'STALE_SESSION')
        // The CLI wrote its own last reply; the host echoes it back as the first new message.
        // Sending it again would store the reply twice in the CLI's context (and may read as
        // someone else's words), so it is skipped — but only when the text matches exactly.
        fresh = dropOwnReply(delta, session.lastReply)
        // Nothing new to say: re-sending the whole history would duplicate it.
        if (fresh.length === 0) throw new AcpError('llm-acp: no new messages for a warm session; rebuilding', 'STALE_SESSION')
      }
      // Images go as real ACP image blocks when the agent says it accepts them; the transcript then
      // labels each one ("attached as image N"). An image that is not sent keeps its placeholder.
      // Reasoning effort (upstream): host pick → channel `effort` → CLI baseline; never fails the turn.
      const effort = await this.#effortForTurn(p, options, session, signal)
      if (effort !== undefined && effort.ok === false) log.info('effort', { provider: p.id, code: effort.code, ...(effort.effort === undefined ? {} : { effort: effort.effort }) })
      else if (effort?.sent === true) log.info('effort', { provider: p.id, phase: 'set', effort: effort.effort })
      const images = await this.#readImages(p, session, fresh, signal)
      const label = new Map(images.map((x, i) => [x.block, i + 1]))
      const text = flattenMessages(fresh, {
        maxChars: p.maxPromptChars,
        ...(sent === undefined ? {} : { preamble: WARM_PREAMBLE }),
        imageText: (b, name) => (label.has(b) ? `[image attachment "${name}" — attached to this prompt as image ${label.get(b)} of ${images.length}]` : undefined),
      })
      const prompt = images.length === 0 ? text : [{ type: 'text', text }, ...images.map((x) => ({ type: 'image', mimeType: x.mimeType, data: x.data }))]
      const mapper = createChunkMapper({ inputChars: text.length })
      let emitted = false
      let replyText = ''
      let chunksOut = 0
      let settled // { response } | { error } | { aborted }
      let wake
      const kick = () => { const w = wake; wake = undefined; w?.() }
      const timers = []
      const arm = (ms, fn) => { const t = setTimeout(fn, ms); timers.push(t); return t }
      let idle
      // askUser: while DSH is asking a person about this session's permission request, the idle timer
      // re-arms instead of firing (the CLI is blocked on us, not stalled). The prompt timeout still applies.
      const askKey = typeof options.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : undefined
      const touch = () => {
        clearTimeout(idle)
        idle = arm(p.idleTimeoutMs, () => {
          if (askKey !== undefined && this.#asking.has(askKey)) { touch(); return }
          fail(new AcpError(`the external CLI produced no output for ${p.idleTimeoutMs} ms (idle timeout)`, 'TIMEOUT'))
        })
      }
      const fail = (error) => { if (settled) return; settled = { error }; session.cancel(); kick() }
      const onAbort = () => { if (settled) return; settled = { aborted: true }; session.cancel(); kick() }
      signal?.addEventListener?.('abort', onAbort, { once: true })
      arm(p.promptTimeoutMs, () => fail(new AcpError(`the external CLI did not finish within ${p.promptTimeoutMs} ms (prompt timeout)`, 'TIMEOUT')))
      touch()
      // When a host approval for this session ends, the idle window starts over from that moment.
      const onAskEnd = () => { if (!settled) touch() }
      if (askKey !== undefined) {
        let watchers = this.#askWatchers.get(askKey)
        if (watchers === undefined) { watchers = new Set(); this.#askWatchers.set(askKey, watchers) }
        watchers.add(onAskEnd)
      }

      // The prompt promise is ALWAYS observed here: a turn can be abandoned by an abort or by the
      // cache dropping the session, and an unobserved rejection would crash the host process.
      const onPromptSettled = (outcome) => {
        if (settled) return
        settled = outcome
        kick()
      }
      session.prompt(prompt).then(
        // Ported from upstream 0.4.26: a refusal carrying the provider's error in _meta (codebuddy's
        // rate limit / quota) is a failed turn with that error, so failover can switch; a plain
        // refusal is unchanged.
        (response) => { const refused = refusalFailure(response); onPromptSettled(refused === undefined ? { response } : { error: refused }) },
        (error) => onPromptSettled(signal?.aborted === true || error?.code === 'ABORTED' ? { aborted: true } : { error }),
      )

      // `pending` is one outstanding updates.next() shared across loop turns, so no update is
      // dropped by the race with `settled`.
      let pending
      const pull = () => (pending ??= session.updates.next().then((r) => { pending = undefined; return r }, () => { pending = undefined; return { done: true } }))
      try {
        while (true) {
          if (settled) {
            // Drain updates already delivered before the response (the SDK delivers in order).
            while (true) {
              const r = await Promise.race([pull(), new Promise((res) => setImmediate(() => res(null)))])
              if (!r || r.done) break
              for (const c of mapper.onUpdate(r.value)) { if (isDelta(c)) { emitted = true; if (tap && tap.firstAt === undefined) tap.firstAt = Date.now() } if (c.type === 'text-delta') replyText += c.text; chunksOut++; yield c }
            }
            break
          }
          const r = await Promise.race([pull(), new Promise((res) => { wake = res })])
          if (r === undefined) continue // woken by settle
          if (r.done) { if (!settled) await new Promise((res) => { wake = res; if (settled) res() }); continue }
          touch()
          for (const c of mapper.onUpdate(r.value)) { if (isDelta(c)) { emitted = true; if (tap && tap.firstAt === undefined) tap.firstAt = Date.now() } if (c.type === 'text-delta') replyText += c.text; chunksOut++; yield c }
        }
        if (settled.aborted) {
          // A cancelled turn leaves the CLI session in a state the host history does not describe.
          if (storeKey !== undefined) this.#store.delete(storeKey)
          for (const c of mapper.abort(abortError(signal).message)) yield c
          return { chars: text.length, aborted: true, usage: mapper.lastUsage() }
        }
        if (settled.error) {
          const error = settled.error
          const code = error?.code
          if (code === 'TRANSPORT' || code === 'TIMEOUT') log.warn('turn', { phase: 'stream-error', code, message: error?.message })
          // Retrying is safe only when the host has seen no output yet and the failure is transient.
          // Such an error is THROWN before any chunk is yielded, so #withPromptRetry can retry it.
          // Every other failure is reported in-band exactly once (one finish) and never thrown, so
          // the host never sees a second terminal chunk.
          if (!emitted && RETRYABLE_PROMPT_CODES.has(code) && chunksOut === 0) { error.retryable = true; throw error }
          if (storeKey !== undefined) this.#store.delete(storeKey)
          for (const c of mapper.fail(error)) yield c
          return { chars: text.length, failed: true, code, message: error?.message, usage: mapper.lastUsage() }
        }
        // stopReason "cancelled" that WE did not request is the agent giving up on its own, typically
        // because a tool it needed was refused. Telling the host "aborted" would read as a user stop.
        if (settled.response?.stopReason === 'cancelled') {
          if (storeKey !== undefined) this.#store.delete(storeKey)
          const denied = session.denied
          const error = denied.length > 0
            ? new AcpError(`the external CLI stopped because permission: ${p.permission} refused its tool use (${[...new Set(denied)].slice(0, 3).join('; ')}). Set permission: allow for this provider if it should edit files or run commands.`, 'ACP_PERMISSION')
            : new AcpError('the external CLI cancelled its own turn', 'ACP_CANCELLED')
          for (const c of mapper.fail(error)) yield c
          return { chars: text.length, failed: true, code: error.code, message: error.message, usage: mapper.lastUsage() }
        }
        // Any other non-success stop reason (refusal, unknown) is a FAILED turn as well: it must not
        // mark the warm CLI as clean, nor be remembered for a later session/load.
        const stop = mapStopReason(settled.response?.stopReason)
        if (stop.kind === 'error') {
          if (storeKey !== undefined) this.#store.delete(storeKey)
          const error = settled.response?.stopReason === 'refusal' && !emitted
            ? new AcpError(`the external CLI refused the turn without any output (stopReason: refusal). This usually means either (1) the CLI is not signed in for the site/account it is configured for — over ACP some CLIs report an HTTP 401 only as a refusal (e.g. CodeBuddy International Site needs its own login in its CODEBUDDY_CONFIG_DIR), or (2) the model "${model ?? 'default'}" is not available to this CLI version or account: the CLI accepts any --model at startup and only fails on the first prompt. Run the CLI once by hand with the same env to check the login, or pick a model from the current ${p.id} list.`, 'ACP_REFUSAL')
            : new AcpError(stop.failure.message, stop.failure.code)
          for (const c of mapper.fail(error)) yield c
          return { chars: text.length, failed: true, code: error.code, message: error.message, usage: mapper.lastUsage() }
        }
        session.historyKey = historyKeyOf(messages)
        session.historyCount = messages.length
        for (const c of mapper.finish(settled.response)) { if (c.type === 'text-delta') replyText += c.text; yield c }
        session.lastReply = replyText
        // Remember the CLI's native session so a later process (reap, eviction, DSH restart) can
        // reopen it. Only clean turns are recorded: their marker is exactly what the CLI holds.
        if (storeKey !== undefined && p.resumeSessions && options.sessionId !== undefined && session.capabilities?.loadSession === true) {
          // Only a digest of the history goes to disk: the raw fingerprint is the conversation text.
          this.#store.set(storeKey, { acpSessionId: session.sessionId, historyKey: digestKey(session.historyKey), historyCount: session.historyCount, lastReply: digestKey(replyText) })
        }
        return { chars: text.length, usage: mapper.lastUsage() }
      } finally {
        // Abandoned mid-turn (the host stopped iterating): stop the CLI's work too. The caller
        // drops/disposes the session; cancelling first keeps the CLI from finishing a half task.
        if (!settled) { settled = { aborted: true }; session.cancel() }
        // What the host was shown, for the usage log when the caller never sees our return value.
        if (tap) { tap.usage = mapper.lastUsage(); tap.reason = mapper.lastReason(); tap.chars = text.length }
        for (const t of timers) clearTimeout(t)
        clearTimeout(idle)
        signal?.removeEventListener?.('abort', onAbort)
        if (askKey !== undefined) {
          const watchers = this.#askWatchers.get(askKey)
          watchers?.delete(onAskEnd)
          if (watchers !== undefined && watchers.size === 0) this.#askWatchers.delete(askKey)
        }
      }
    }

    #cacheFor(p) {
      let cache = this.#caches.get(p.id)
      if (cache === undefined) {
        let lastEvictWarn = 0
        cache = createSessionCache({
          maxEntries: p.maxSessions,
          idleMs: p.sessionIdleMs,
          onEvict: ({ reason, size }) => {
            // Only the cap forces a still-wanted CLI out. A run of these means the Team has more
            // CLI members than maxSessions and every turn pays a cold start, so say it — but at
            // most once a minute, otherwise the warning itself becomes the noise.
            if (reason !== 'lru') return
            const at = Date.now()
            if (at - lastEvictWarn < 60_000) return
            lastEvictWarn = at
            log.warn('cache', { provider: p.id, phase: 'evict', reason, warm: size, max: p.maxSessions, hint: 'a Team with more CLI members than maxSessions cold-starts every turn; raise maxSessions' })
          },
        })
        this.#caches.set(p.id, cache)
      }
      return cache
    }

    /**
     * Open a CLI session, resuming the CLI's OWN native session when that is safe.
     *
     * Safe means: resumeSessions is on, the store knows the CLI session for this host session, and
     * the host history still begins with exactly what that CLI session was told (same prefix check
     * as the warm path). Then only the new tail is sent. Any doubt ⇒ a new session and the full
     * transcript, i.e. the pre-resume behaviour — never worse than before.
     */
    async #openResumable(p, options, cwd, signal, key) {
      const rec = p.resumeSessions && options.sessionId !== undefined ? this.#store.get(key) : undefined
      let marker
      if (rec !== undefined) {
        // The store keeps digests, so compare digest to digest; the marker handed to #turn is then
        // rebuilt from the live history (exact text), which the warm path compares as before.
        const messages = options.messages ?? []
        const n = rec.historyCount
        if (n <= messages.length && digestKey(historyKeyOf(messages.slice(0, n))) === rec.historyKey) {
          const delta = messages.slice(n)
          const first = delta[0]
          const echoesReply = first?.role === 'assistant' && digestKey(assistantText(first).trim()) === rec.lastReply
          const fresh = echoesReply && !hasToolTraffic(first) ? delta.slice(1) : delta
          if (fresh.length > 0) marker = { key: historyKeyOf(messages.slice(0, n)), count: n, lastReply: echoesReply ? assistantText(first) : undefined }
        }
        if (marker === undefined) { this.#store.delete(key); log.info('resume', { provider: p.id, session: options.sessionId, ok: false, reason: 'history moved on' }) }
      }
      const session = await this.#openWithStartupRetry(p, options.model, cwd, signal, marker === undefined ? undefined : rec.acpSessionId, { effort: options.reasoningEffort, sessionId: options.sessionId })
      if (marker !== undefined) {
        if (session.loaded) {
          session.resumedMarker = { key: marker.key, count: marker.count }
          session.lastReply = marker.lastReply
          log.info('resume', { provider: p.id, session: options.sessionId, ok: true })
        } else {
          this.#store.delete(key)
          log.info('resume', { provider: p.id, session: options.sessionId, ok: false, reason: session.loadNote })
        }
      }
      this.#noteCaps(p, session)
      this.#learnEffort(p, session)
      if (session.permissionNote !== undefined && !/^kept|no permission modes/.test(session.permissionNote)) {
        log.info('permission', { provider: p.id, permission: p.permission, mode: session.permissionNote, ...(session.modelNote === undefined ? {} : { model: session.modelNote }) })
      }
      return session
    }

    /**
     * Spawn a session, retrying ONLY startup failures (spawn / initialize / session/new).
     *
     * Safe while the host retry policy stays at 0: nothing has been prompted yet, so a fresh CLI
     * has not seen the conversation and cannot have touched a file. A prompt that fails mid-turn
     * is never replayed — it may already have had side effects.
     */
    async #openWithStartupRetry(p, model, cwd, signal, loadSessionId, extra) {
      const attempts = 1 + p.startupRetries
      let last
      for (let i = 0; i < attempts; i++) {
        try {
          const session = await openSession(this.#spec(p, model, cwd, signal, loadSessionId, extra))
          this.#noteStartupOk(p)
          return session
        } catch (error) {
          last = error
          // Upstream 0.4.27: logged out (AUTH, or a kiro-cli startup TIMEOUT): tell the background
          // paths to wait the long window, and do not start the CLI a second time for this turn.
          if (isLongFailure(p, { code: error?.code })) { this.#noteStartupLong(p, error); throw error }
          if (!STARTUP_CODES.has(error?.code) || i === attempts - 1) throw error
          signal?.throwIfAborted?.()
          log.warn('turn', { provider: p.id, phase: 'startup-retry', attempt: i + 1, of: attempts, code: error.code, delayMs: 2000 * (i + 1) })
          await new Promise((r) => setTimeout(r, 2000 * (i + 1)))
        }
      }
      throw last
    }

    /**
     * Upstream 0.4.27: a real turn that met a logged-out CLI tells the background paths (discovery,
     * the image probe) to wait the long AUTH window instead of starting that CLI again a minute
     * later. The last good model list keeps being served meanwhile.
     */
    #noteStartupLong(p, error) {
      if (p.models) {
        this.#imageProbeFailed.set(p.id, nextFailure(this.#imageProbeFailed.get(p.id), error))
      } else {
        const fp = this.#fingerprint(p)
        const hit = this.#models.get(p.id)
        const same = hit !== undefined && hit.fp === fp
        const f = nextFailure(same && hit.failed === true ? hit : undefined, error)
        // Keep serving the last good list (memory, else disk) while the CLI is logged out.
        const disk = same ? undefined : this.#modelStore.get(p.id, fp)
        const list = same ? hit.list : disk !== undefined && disk.list.length > 0 ? this.#render(p, disk.list) : this.#baseList(p.id)
        this.#models.set(p.id, { fp, list, failed: true, ...f })
      }
      log.info('models-cache', { provider: p.id, phase: 'long-backoff', code: error?.code, ms: backoffFor(p, { code: 'AUTH' }) })
    }

    /** A real turn that starts fine lifts a logged-out wait at once: someone logged in. */
    #noteStartupOk(p) {
      const hit = this.#models.get(p.id)
      // Serve the list we have and refresh it on the next read (at: 0 ⇒ stale).
      if (hit?.failed === true && isLongFailure(p, hit)) this.#models.set(p.id, { fp: hit.fp, at: 0, list: hit.list, failed: false })
      if (isLongFailure(p, this.#imageProbeFailed.get(p.id))) this.#imageProbeFailed.delete(p.id)
    }

    /** Background-start backoff in force for a provider (ACP console), or undefined. */
    #backoffView(provider) {
      const p = providers().get(provider)
      if (!p) return undefined
      const m = this.#models.get(provider)
      const f = p.models ? this.#imageProbeFailed.get(provider) : (m?.failed === true ? m : undefined)
      if (f === undefined || !Number.isFinite(f.at)) return undefined
      const until = f.at + backoffFor(p, f)
      return until > Date.now() ? { until, code: f.code, count: f.count, long: isLongFailure(p, f) } : undefined
    }

    /**
     * Image bytes for one turn: images in the NEW messages, when the agent advertises
     * promptCapabilities.image. Best-effort: an image that cannot be read is left out and keeps
     * its text placeholder. Returns [{ block, mimeType, data(base64) }] in transcript order.
     */
    async #readImages(p, session, fresh, signal) {
      const blocks = []
      if (!p.images || readImage === undefined || session.capabilities?.promptCapabilities?.image !== true) return blocks
      for (const m of fresh) for (const b of Array.isArray(m?.content) ? m.content : []) {
        if (b?.type !== 'image' || b.offloaded === true || b.attachment === undefined) continue
        try {
          const ref = b.attachment
          const target = { width: ref.width, height: ref.height, maxBytes: Math.min(p.maxImageBytes, Number.isSafeInteger(ref.bytes) && ref.bytes > 0 ? ref.bytes : p.maxImageBytes) }
          const img = await readImage(ref, target, signal)
          if (img?.data && typeof img.mediaType === 'string' && img.data.byteLength <= p.maxImageBytes) {
            blocks.push({ block: b, mimeType: img.mediaType, data: Buffer.from(img.data).toString('base64') })
          }
        } catch (e) {
          if (signal?.aborted) throw e
          log.warn('image', { provider: p.id, phase: 'read', message: e?.message })
        }
      }
      return blocks
    }

    /** One finished (or failed) turn → the ACP console's usage log. Never throws. */
    #recordTurn(p, options, started, o, cwd, tap) {
      const at = Date.now()
      const u = o?.usage
      const rec = {
        at, provider: p.id, model: options.model ?? 'default',
        ...(options.sessionId === undefined ? {} : { session: options.sessionId }),
        ...(cwd ? { cwd } : {}),
        ok: o?.ok === true, ms: at - started,
        // DISPOSED = the plugin itself was reloaded/stopped: an interruption, not a CLI failure.
        ...(o?.aborted === true || o?.code === 'DISPOSED' ? { aborted: true } : {}),
        ...(o?.code === undefined ? {} : { code: o.code }),
        ...(o?.message === undefined ? {} : { message: String(o.message).slice(0, 300) }),
        ...(Number.isFinite(o?.chars) ? { chars: o.chars } : {}),
        // First output (text or reasoning) after the turn started: TTFT, and the base of the console's
        // generation TPS (output ÷ (ms − firstMs)). Absent when nothing was emitted.
        ...(Number.isFinite(tap?.firstAt) && tap.firstAt >= started ? { firstMs: tap.firstAt - started } : {}),
        ...(u ? {
          inputTokens: u.inputTokens, outputTokens: u.outputTokens,
          ...(u.cacheReadTokens ? { cacheReadTokens: u.cacheReadTokens } : {}),
          ...(u.cacheWriteTokens ? { cacheWriteTokens: u.cacheWriteTokens } : {}),
          estimated: u.estimated === true,
        } : {}),
      }
      this.#lastTurn.set(p.id, rec)
      try { onTurn?.(rec) } catch { /* the usage log must never break a turn */ }
    }

    /** Live state of one provider for the ACP console. */
    runtime(provider) {
      let live = 0
      for (const id of this.#childProvider.values()) if (id === provider) live++
      return {
        liveChildren: live,
        warmSessions: this.#caches.get(provider)?.size() ?? 0,
        discovery: this.#discovery.get(provider),
        lastTurn: this.#lastTurn.get(provider),
        inflight: [...this.#inflight].filter((f) => f.provider === provider).map((f) => ({ ...f })),
        images: this.#imageCaps.get(provider),
        backoff: this.#backoffView(provider),
        // Model list cache (console): when the served list was discovered, and whether it came from disk.
        catalogCache: (() => { const m = this.#models.get(provider); return m && Number.isFinite(m.at) && m.at > 0 ? { at: m.at, disk: m.disk === true, count: Math.max(0, m.list.length - 1) } : undefined })(),
        // Reasoning efforts the CLI offers (console effort picker): undefined = not learned yet, [] = none.
        ...(() => {
          const p = providers().get(provider)
          const list = p === undefined ? undefined : this.#knownEfforts(p)
          if (list === undefined) return {}
          const dflt = this.#efforts.get(provider)?.default
          return { efforts: list.map((e) => ({ ...e })), ...(dflt === undefined ? {} : { effortDefault: dflt }) }
        })(),
      }
    }

    /** Host sessions seen recently → the project directory they ran in (console naming).
     *  One entry per host session: the most recent store entry wins. */
    sessionDirectory() {
      const bySession = new Map()
      for (const e of this.#store.list()) {
        const [cwd, session] = e.key.split('\u0000')
        if (!session || !cwd) continue
        const cur = bySession.get(session)
        if (!cur || e.at > cur.at) bySession.set(session, { session, cwd, at: e.at })
      }
      return [...bySession.values()].sort((a, b) => b.at - a.at)
    }

    /** Drop the cached catalog and ask the CLI again. */
    refreshCatalog(provider) {
      const p = providers().get(provider)
      this.#imageProbeFailed.delete(provider)
      if (!p || p.models) return this.catalog(provider)
      // Always a fresh discovery (console 「刷新」): an older flight no longer writes back, the
      // backoff and the disk copy are bypassed, and a failure still keeps the last good list.
      this.#modelFlights.delete(provider)
      return this.#refreshModels(p, this.#fingerprint(p)).then(() => this.#models.get(provider)?.list ?? this.#baseList(provider))
    }

    /** Number of ACP children currently alive (tests and diagnostics). */
    liveChildren() { return this.#children.size }

    /** Number of warm CLI sessions currently held. */
    warmSessions() { let n = 0; for (const c of this.#caches.values()) n += c.size(); return n }

    /** Kill every in-flight child; further calls refuse. */
    async dispose() {
      this.#disposed = true
      this.#store.flush()
      this.#modelStore.flush()
      await Promise.allSettled([...this.#caches.values()].map((c) => c.clear()))
      this.#caches.clear()
      await Promise.allSettled([...this.#sessions].map((s) => s.dispose()))
      for (const c of this.#children) { try { process.kill(-c.pid, 'SIGKILL') } catch { try { c.kill('SIGKILL') } catch {} } }
    }
  }

  return new AcpAdapter()
}

/**
 * Backoff before the next attempt of a turn that failed before producing output.
 *
 * - Rate limits (429) get exponential backoff with a small deterministic jitter (±10%) so
 *   parallel members do not retry in lockstep. A `Retry-After: N` / `retry after Ns` hint in the
 *   CLI error text is honoured (capped), since the provider knows best when to come back.
 * - Other transient failures (server / timeout / transport) keep the old linear schedule.
 *
 * @param {string} code error code of the failed attempt
 * @param {number} attempt 0-based index of the attempt that just failed
 * @param {string} [message] CLI error text, may carry a Retry-After hint
 * @param {number} [baseMs] retryDelayMs from the profile
 * @returns {number} delay in milliseconds
 */
export function retryDelayFor(code, attempt, message, baseMs) {
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 2_000
  const n = Number.isInteger(attempt) && attempt >= 0 ? attempt : 0
  const text = String(message ?? '')
  // "retry after 30s" / "Retry-After: 30" / "please retry in 5 seconds" / "retry after 500ms"
  const hint = text.match(/\bretry[\s-]?(?:after|in)[\s:=]+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)?\b/i)
  if (hint) {
    const value = Number(hint[1])
    const unit = String(hint[2] ?? 's').toLowerCase()
    const ms = /^m/.test(unit) ? value : value * 1_000
    if (Number.isFinite(ms) && ms > 0) return Math.min(Math.ceil(ms), 120_000)
  }
  if (code === 'RATE_LIMIT') {
    const exp = base * Math.pow(2, n)
    const jitter = exp * (n % 2 === 0 ? 0.1 : -0.1)
    return Math.min(Math.max(1, Math.round(exp + jitter)), 60_000)
  }
  return Math.min(base * (n + 1), 30_000)
}

/** Log fields for a turn outcome `{ chars, aborted?, failed?, code?, message? }`. */
const outcomeFields = (o) => ({
  ok: o?.aborted !== true && o?.failed !== true, chars: o?.chars,
  ...(o?.aborted === true ? { aborted: true } : {}),
  ...(o?.code === undefined ? {} : { code: o.code }),
  ...(o?.message === undefined ? {} : { message: o.message }),
})

/**
 * Make display names unique. Some CLIs give several model ids the same name (codebuddy: hy4free and
 * hy4std are both "Hy4"), which the model picker shows as indistinguishable duplicates. A name
 * shared by more than one id (case-insensitive) gets its id appended: "Hy4 (hy4free)".
 */
export function disambiguateNames(models) {
  const count = new Map()
  const norm = (m) => String(m.name || m.id).trim().toLowerCase()
  for (const m of models) count.set(norm(m), (count.get(norm(m)) ?? 0) + 1)
  return models.map((m) => {
    const name = String(m.name || m.id).trim()
    if (count.get(norm(m)) < 2 || name.toLowerCase() === m.id.toLowerCase()) return m
    return { ...m, name: `${name} (${m.id})` }
  })
}

/**
 * Credit multiplier from a CLI's model description, normalised to "0.80x".
 * codebuddy says "x0.29 credits", qodercli "Reasoning · Vision · 0.80x Credit". Undefined when absent.
 */
export function rateOf(description) {
  if (typeof description !== 'string') return undefined
  const m = description.match(/(?:\bx\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*x)\s*credits?\b/i)
  return m ? `${m[1] ?? m[2]}x` : undefined
}

/**
 * Put the credit multiplier into the display name ("GLM-5.3 · 0.80x"): the model picker shows
 * names only, so a rate kept in the description is invisible when choosing.
 */
export function withRate(models) {
  return models.map((m) => {
    // A multiplier learned at discovery (codebuddy _meta.credits, kiro-cli --list-models) wins.
    const rate = typeof m.rate === 'string' && m.rate !== '' ? m.rate : rateOf(m.description)
    const name = String(m.name || m.id).trim()
    return rate === undefined || name.endsWith(rate) ? m : { ...m, name: `${name} · ${rate}` }
  })
}

/** Outcome of a turn rebuilt from what #turn emitted, when its return value never reached us. */
function tapOutcome(tap) {
  const r = tap?.reason
  const base = { ...(Number.isFinite(tap?.chars) ? { chars: tap.chars } : {}), ...(tap?.usage ? { usage: tap.usage } : {}) }
  if (r === undefined) return { ...base, ok: false, aborted: true, code: 'ABANDONED', message: 'the host stopped reading the turn before it finished' }
  if (r.kind === 'stop' || r.kind === 'max-tokens') return { ...base, ok: true }
  if (r.kind === 'aborted') return { ...base, ok: false, aborted: true, code: r.failure?.code, message: r.failure?.message }
  return { ...base, ok: false, code: r.failure?.code ?? 'ACP_ERROR', message: r.failure?.message }
}

/** Visible text of an assistant message, as the CLI produced it. */
/** Short stable digest for what goes to disk (the raw history fingerprint is the conversation text). */
export const digestKey = (text) => (typeof text === 'string' && text !== '' ? `sha256:${createHash('sha256').update(text).digest('hex')}` : '')

const assistantText = (m) => (Array.isArray(m?.content) ? m.content : []).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')

/** Does this message carry tool traffic the CLI never saw (it cannot call harness tools)? */
const hasToolTraffic = (m) => (Array.isArray(m?.content) ? m.content : []).some((b) => b?.type === 'tool-call')

/**
 * Drop the leading assistant message when it is exactly the reply this CLI just produced.
 *
 * Any mismatch (edited, trimmed, from another route) keeps it: sending too much is safe, losing a
 * message is not. A message that also carries harness tool calls is kept even when its text
 * matches — the CLI cannot call harness tools, so those blocks describe work it never saw.
 */
export function dropOwnReply(delta, lastReply) {
  const first = delta[0]
  if (first?.role !== 'assistant' || typeof lastReply !== 'string' || lastReply.trim() === '') return delta
  if (hasToolTraffic(first)) return delta
  return assistantText(first).trim() === lastReply.trim() ? delta.slice(1) : delta
}

/** A real content delta — not a bookkeeping chunk such as usage or finish. */
const isDelta = (c) => c?.type === 'text-delta' || c?.type === 'reasoning-delta'

/** Compact fingerprint of one message (role + visible text). */
function messageKey(m) {
  const parts = (Array.isArray(m?.content) ? m.content : []).map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\u0001')
  return `${m?.role ?? ''}\u0000${parts.length}\u0000${parts}`
}

/** Fingerprint of a conversation. */
export function historyKeyOf(messages) {
  return messages.map(messageKey).join('\u0002')
}

/**
 * The tail of `messages` the CLI has NOT seen yet.
 *
 * `sent` is `{ key, count }`: the fingerprint and length of the conversation handed to the CLI on
 * the previous turn. When the host's history still begins with exactly those messages, only the new
 * tail is sent. Returns undefined when it does not (rewound, compacted, replaced) — the caller must
 * rebuild the session rather than mix two histories.
 */
export function messagesSince(messages, sent) {
  if (sent === undefined || typeof sent.key !== 'string' || sent.key === '') return undefined
  const n = sent.count
  if (!Number.isInteger(n) || n <= 0 || n > messages.length) return undefined
  if (historyKeyOf(messages.slice(0, n)) !== sent.key) return undefined
  // Nothing new to say: keep the prompt non-empty so the CLI does not reject it.
  return messages.length === n ? undefined : messages.slice(n)
}
