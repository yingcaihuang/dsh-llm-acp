// lib/config.js — resolve the plugin config into one profile per provider route.
//
// One adapter serves many CLIs: every key under `providers` becomes a provider route
// ("kiro", "codebuddy", …). Adding a CLI is one more config entry, no code.

const PROVIDER_ID = /^[A-Za-z0-9][\w.-]{0,63}$/

const baseOf = (p) => String(p ?? '').split(/[\\/]/).pop() ?? ''

/**
 * Leading argv that belongs to the program rather than to the CLI. On Windows an npm-installed
 * CLI is started as `node.exe <script> --acp` (spawn() without a shell cannot run its .cmd shim),
 * so one-off commands such as `--version` must go after the script, not straight to node.
 */
export function launchPrefix(p) {
  const first = Array.isArray(p?.args) ? p.args[0] : undefined
  return /^node(?:\.exe)?$/i.test(baseOf(p?.command)) && typeof first === 'string' && first !== '' && !first.startsWith('-') ? [first] : []
}

/** The CLI a provider runs: the script for `node <script> …`, otherwise the command itself. */
export function cliPathOf(p) {
  const pre = launchPrefix(p)
  return pre.length ? pre[0] : String(p?.command ?? '')
}

/** CLI name without directory and Windows launcher extension: `…\kiro-cli.exe` ⇒ `kiro-cli`. */
export function cliNameOf(p) {
  return baseOf(cliPathOf(p).trim()).replace(/\.(?:exe|cmd|bat|com|ps1|c?js|mjs)$/i, '')
}

export const DEFAULTS = Object.freeze({
  args: Object.freeze([]),
  modelArgs: Object.freeze(['--model', '{model}']),
  permission: 'allow',
  startupTimeoutMs: 60_000,     // spawn → initialize → session/new
  promptTimeoutMs: 1_800_000,   // whole session/prompt, 30 min (a CLI agent may do real work)
  idleTimeoutMs: 600_000,       // no session/update at all for this long ⇒ give up
  cancelGraceMs: 5_000,         // after session/cancel, wait this long for the prompt to settle
  disposeGraceMs: 3_000,        // after stdin EOF / SIGTERM, wait this long before SIGKILL
  maxRetries: 0,
  startupRetries: 1,            // startup-only retry: no prompt has been sent yet ⇒ no side effects
  reuseSessions: true,          // keep one CLI alive per host session instead of paying cold start each turn
  sessionIdleMs: 1_800_000,     // reap a warm CLI after 30 min idle: a user coming back later keeps its CLI context
  maxSessions: 8,               // LRU cap on warm CLI processes, per provider
  modelDiscoveryBackoffMs: 60_000, // after a failed discovery, do not respawn the CLI for this long
  modelDiscoveryMaxBackoffMs: 1_800_000, // upstream 0.4.27: consecutive failures double the window up to this; AUTH (logged out) waits this long at once
  promptRetries: 1,             // retry a turn ONLY when it failed before producing any output
  retryDelayMs: 2_000,          // base delay between prompt retries
  maxPromptChars: 400_000,
  resumeSessions: true,         // reopen the CLI's own session (ACP session/load) instead of re-sending a transcript
  images: true,                 // send host images as ACP image blocks when the agent advertises promptCapabilities.image
  maxImageBytes: 4_000_000,     // per image, after the host's request projection
  contextWindow: 200_000,
  modelCacheMs: 600_000,
  modelVia: 'args',           // how to select a model: CLI argv ('args') or an ACP model configOption
  approvals: 'modes',         // 'modes': align the agent's own permission modes; 'none': it never asks
  // permission: read approves tools of ACP kind read/search, plus these tool names (first word of
  // the tool title) that some CLIs report with kind "other" although they only look at things.
  readTools: Object.freeze(['ViewImage']),
  rateInName: true,           // append the credit multiplier from the model description to its name
})

const VALID_RETRY_CODES = ['TIMEOUT', 'TRANSPORT', 'RATE_LIMIT', 'SERVER', 'EMPTY_RESPONSE', 'ACP_ERROR']

function posInt(v, key, path) {
  if (v === undefined) return DEFAULTS[key]
  if (!Number.isSafeInteger(v) || v <= 0) throw new Error(`${path}.${key} must be a positive integer (got ${JSON.stringify(v)})`)
  return v
}
/** Like posInt, but 0 is allowed (0 = no backoff window). */
function nonNegInt(v, key, path) {
  if (v === undefined) return DEFAULTS[key]
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${path}.${key} must be an integer >= 0 (got ${JSON.stringify(v)})`)
  return v
}
function strArray(v, key, path, dflt) {
  if (v === undefined) return dflt
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) throw new Error(`${path}.${key} must be an array of strings`)
  return Object.freeze([...v])
}

/**
 * @param {unknown} raw plugin config: `{ providers: { [id]: ProfileInput } }`
 * @returns {Map<string, Readonly<Profile>>} in declaration order
 */
export function resolveProviders(raw) {
  const out = new Map()
  const providers = raw?.providers
  if (providers === undefined || providers === null) return out
  if (typeof providers !== 'object' || Array.isArray(providers)) throw new Error('llm-acp: providers must be an object keyed by provider id')
  for (const [id, p] of Object.entries(providers)) {
    const path = `llm-acp: providers.${id}`
    if (!PROVIDER_ID.test(id)) throw new Error(`llm-acp: invalid provider id ${JSON.stringify(id)} (letters, digits, . _ -)`)
    if (p === null || typeof p !== 'object') throw new Error(`${path} must be an object`)
    if (typeof p.command !== 'string' || p.command.trim() === '') throw new Error(`${path}.command is required (path of the ACP CLI)`)
    const permission = p.permission ?? DEFAULTS.permission
    if (permission !== 'allow' && permission !== 'reject' && permission !== 'read') throw new Error(`${path}.permission must be "allow", "read" (approve read/search tools only) or "reject"`)
    let env = {}
    if (p.env !== undefined) {
      if (p.env === null || typeof p.env !== 'object' || Object.values(p.env).some((v) => typeof v !== 'string')) throw new Error(`${path}.env must map names to strings`)
      env = { ...p.env }
    }
    const models = p.models === undefined ? undefined : strArray(p.models, 'models', path)
    // Optional non-interactive command to probe usage/account info for the insights quota card.
    // Overrides the built-in recipe for this CLI when present.
    const usageCommand = p.usageCommand === undefined ? undefined : strArray(p.usageCommand, 'usageCommand', path)
    const maxRetries = p.maxRetries ?? DEFAULTS.maxRetries
    const startupRetries = p.startupRetries ?? DEFAULTS.startupRetries
    if (!Number.isSafeInteger(startupRetries) || startupRetries < 0 || startupRetries > 3) throw new Error(`${path}.startupRetries must be an integer 0..3`)
    const reuseSessions = p.reuseSessions ?? DEFAULTS.reuseSessions
    if (typeof reuseSessions !== 'boolean') throw new Error(`${path}.reuseSessions must be a boolean`)
    const maxSessions = p.maxSessions ?? DEFAULTS.maxSessions
    const promptRetries = p.promptRetries ?? DEFAULTS.promptRetries
    if (!Number.isSafeInteger(promptRetries) || promptRetries < 0 || promptRetries > 3) throw new Error(`${path}.promptRetries must be an integer 0..3`)
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 64) throw new Error(`${path}.maxSessions must be an integer 1..64`)
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) throw new Error(`${path}.maxRetries must be an integer 0..5`)
    const resumeSessions = p.resumeSessions ?? DEFAULTS.resumeSessions
    if (typeof resumeSessions !== 'boolean') throw new Error(`${path}.resumeSessions must be a boolean`)
    const rateInName = p.rateInName ?? DEFAULTS.rateInName
    if (typeof rateInName !== 'boolean') throw new Error(`${path}.rateInName must be a boolean`)
    const images = p.images ?? DEFAULTS.images
    if (typeof images !== 'boolean') throw new Error(`${path}.images must be a boolean`)
    // askUser (upstream 0.4.19): a request the channel would refuse is first put to DSH's approval.
    const askUser = p.askUser ?? false
    if (typeof askUser !== 'boolean') throw new Error(`${path}.askUser must be a boolean`)
    if (p.mode !== undefined && (typeof p.mode !== 'string' || p.mode.trim() === '')) throw new Error(`${path}.mode must be a non-empty string (an ACP mode id the CLI offers)`)
    // Channel default reasoning effort (upstream): one of the ids the CLI offers (thought_level).
    // Whether the CLI really offers it is only known at runtime; a wrong value never fails a turn.
    let effort
    if (p.effort !== undefined) {
      if (typeof p.effort !== 'string') throw new Error(`${path}.effort must be a string (an effort id the CLI offers)`)
      effort = p.effort.trim()
      if (effort === '') throw new Error(`${path}.effort must be a non-empty string (an effort id the CLI offers)`)
      if (effort.length > 64) throw new Error(`${path}.effort must be at most 64 characters`)
      if (/[\u0000-\u001f\u007f]/.test(effort)) throw new Error(`${path}.effort must not contain control characters`)
    }
    const modelVia = p.modelVia ?? DEFAULTS.modelVia
    if (modelVia !== 'args' && modelVia !== 'configOption') throw new Error(`${path}.modelVia must be "args" (pass modelArgs on the command line) or "configOption" (ACP session/set_config_option)`)
    let approvalModes
    if (p.approvalModes !== undefined) {
      const am = p.approvalModes
      if (am === null || typeof am !== 'object' || Array.isArray(am)) throw new Error(`${path}.approvalModes must be an object { ask, edit, bypass } of mode-id lists`)
      for (const k of Object.keys(am)) if (!['ask', 'edit', 'bypass'].includes(k)) throw new Error(`${path}.approvalModes.${k} is unknown (use ask, edit, bypass)`)
      const list = (k) => {
        const v = am[k] === undefined ? [] : typeof am[k] === 'string' ? [am[k]] : am[k]
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.trim() === '')) throw new Error(`${path}.approvalModes.${k} must be a mode id or a list of mode ids`)
        return Object.freeze(v.map((x) => x.trim()))
      }
      approvalModes = Object.freeze({ ask: list('ask'), edit: list('edit'), bypass: list('bypass') })
      const all = [...approvalModes.ask, ...approvalModes.edit, ...approvalModes.bypass]
      if (new Set(all).size !== all.length) throw new Error(`${path}.approvalModes: a mode id may appear in only one of ask / edit / bypass`)
      if (approvalModes.ask.length === 0) throw new Error(`${path}.approvalModes.ask is required (the mode that asks before every tool use)`)
    }
    const label = typeof p.displayName === 'string' && p.displayName.trim() ? p.displayName.trim() : id
    // Some ACP agents have no permission mode at all: their `modes` are something else entirely
    // (pi-acp publishes THINKING levels there) and they never send session/request_permission.
    // The built-in heuristic calls an unrecognised mode id "asking", so such an agent would be
    // treated as safe under `permission: reject` while it edits files. `approvals: 'none'` is how
    // a config says so out loud; `permission: reject` then refuses to start instead of pretending.
    const approvals = p.approvals ?? DEFAULTS.approvals
    if (approvals !== 'modes' && approvals !== 'none') throw new Error(`${path}.approvals must be "modes" (align the agent's own permission modes, the default) or "none" (the agent never asks, so permission: reject is refused)`)
    if (approvals === 'none' && approvalModes !== undefined) throw new Error(`${path}.approvals: "none" and approvalModes cannot both be set: approvalModes names modes that ask, "none" says no mode ever asks`)
    out.set(id, Object.freeze({
      id,
      command: p.command,
      args: strArray(p.args, 'args', path, DEFAULTS.args),
      modelArgs: strArray(p.modelArgs, 'modelArgs', path, DEFAULTS.modelArgs),
      env: Object.freeze(env),
      permission,
      readTools: strArray(p.readTools, 'readTools', path, DEFAULTS.readTools),
      models,
      usageCommand,
      // The UI must not suggest this is an ordinary model API.
      displayName: /CLI/.test(label) ? label : `${label} (外部 CLI · external CLI)`,
      startupTimeoutMs: posInt(p.startupTimeoutMs, 'startupTimeoutMs', path),
      promptTimeoutMs: posInt(p.promptTimeoutMs, 'promptTimeoutMs', path),
      idleTimeoutMs: posInt(p.idleTimeoutMs, 'idleTimeoutMs', path),
      cancelGraceMs: posInt(p.cancelGraceMs, 'cancelGraceMs', path),
      disposeGraceMs: posInt(p.disposeGraceMs, 'disposeGraceMs', path),
      maxPromptChars: posInt(p.maxPromptChars, 'maxPromptChars', path),
      contextWindow: posInt(p.contextWindow, 'contextWindow', path),
      modelCacheMs: posInt(p.modelCacheMs, 'modelCacheMs', path),
      maxRetries,
      startupRetries,
      reuseSessions,
      maxSessions,
      sessionIdleMs: posInt(p.sessionIdleMs, 'sessionIdleMs', path),
      modelDiscoveryBackoffMs: nonNegInt(p.modelDiscoveryBackoffMs, 'modelDiscoveryBackoffMs', path),
      modelDiscoveryMaxBackoffMs: posInt(p.modelDiscoveryMaxBackoffMs, 'modelDiscoveryMaxBackoffMs', path),
      promptRetries,
      resumeSessions,
      rateInName,
      images,
      maxImageBytes: posInt(p.maxImageBytes, 'maxImageBytes', path),
      mode: p.mode === undefined ? undefined : p.mode.trim(),
      effort,
      askUser,
      modelVia,
      approvalModes,
      approvals,
      retryDelayMs: posInt(p.retryDelayMs, 'retryDelayMs', path),
    }))
  }
  return out
}

/**
 * CLI arguments that select `model`. The pseudo-model "default" lets the CLI choose.
 * @returns {string[]}
 */
export function modelArgsFor(profile, model) {
  // modelVia: 'configOption' selects the model over ACP after the session exists, so the CLI must
  // not also get a (meaningless, possibly rejected) --model on its command line.
  if (profile.modelVia === 'configOption') return []
  if (!model || model === 'default' || profile.modelArgs.length === 0) return []
  return profile.modelArgs.map((a) => a.replaceAll('{model}', model))
}

/** Host retry policy (dsh-llm RetryPolicy shape). Default 0 retries: a CLI agent has side effects. */
export function retryPolicyFor(profile) {
  return Object.freeze({
    mode: 'normal',
    maxRetries: profile.maxRetries,
    retryableCodes: Object.freeze([...VALID_RETRY_CODES]),
    initialDelayMs: 1000,
    maxDelayMs: 10_000,
    jitterRatio: 0.1,
  })
}
