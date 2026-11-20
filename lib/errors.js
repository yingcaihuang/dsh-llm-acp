// lib/errors.js — error type the host's LLM boundary understands without importing it.
//
// The host normalises adapter failures by reading an own data property `failure`
// ({message, code}) and an own `code` (see dsh-llm normalizeLlmFailure). Matching that shape
// lets us classify errors (AUTH / TIMEOUT / TRANSPORT…) even when `@deepseek-ai/dsh-llm`
// cannot be imported from the plugin directory.

export class AcpError extends Error {
  /**
   * @param {string} message non-empty human-readable summary
   * @param {string} code stable machine code (AUTH, TIMEOUT, TRANSPORT, ACP_ERROR, …)
   * @param {{cause?: unknown}} [options]
   */
  constructor(message, code, options) {
    super(message || 'ACP adapter failed', options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AcpError'
    Object.defineProperty(this, 'code', { value: code, enumerable: true, writable: false, configurable: true })
    Object.defineProperty(this, 'failure', {
      value: Object.freeze({ message: this.message, code }),
      enumerable: false, writable: false, configurable: true,
    })
  }
}

// Ported from upstream guozi058/dsh-llm-acp 0.4.23 (3d431bd): a quota word must stand alone.
// `_`, digits and punctuation count as separators (insufficient_quota, quota_exceeded); a
// following letter does not (quotation), except the camelCase forms quotaExceeded /
// quotaExhausted / quotaLimit / quotaReached. Local additions (out of credit, billing / credit
// limit) get the same word boundaries.
// No `g` flag on the test regexes: .test() on a global regex carries lastIndex between calls.
const QUOTA_RE = /(?<![a-z])(?:quotas?(?![a-z])|quota(?=exceeded|exhausted|limit|reached)|insufficient[_ ]credits?(?![a-z])|out of credits?(?![a-z])|(?:usage|billing|credit) limits?(?![a-z]))/i
// camelCase inside an identifier (insufficientQuota, userQuotaExceeded, APIQuotaExceeded).
// Case-sensitive on purpose: the capital Q marks the word start; missingQuotation stays out.
const QUOTA_CAMEL_RE = /(?<=[A-Za-z0-9])Quotas?(?![a-z])/
// A LOCAL disk quota (EDQUOT) is not a provider quota and must not trip a channel switch. It is
// removed before the test. Linux strerror says "Disk", macOS says "Disc". Only used with replace.
const LOCAL_QUOTA_RE = /dis[ck] quota exceeded|\bEDQUOT\b/gi

/**
 * Classify a provider-side error message into a host error code.
 * Retry decisions key off these codes, so only clearly-recognised texts get a retryable class.
 * @param {string} message
 * @returns {string}
 */
export function classifyMessage(message) {
  const m = String(message ?? '')
  // Permanent failures first: retrying these only burns time and quota.
  const q = m.replace(LOCAL_QUOTA_RE, ' ')
  if (QUOTA_RE.test(q) || QUOTA_CAMEL_RE.test(q)) return 'QUOTA_EXCEEDED'
  if (/\b(401|403)\b|unauthori[sz]ed|authenticat|not logged in|log ?in required|please log ?in|forbidden/i.test(m)) return 'AUTH'
  // Transient provider conditions. CLIs word rate limits and overloads in many ways; classify
  // them as RATE_LIMIT so the prompt retry path backs off exponentially (see retryDelayFor).
  if (/\b429\b|rate.?limit|too many requests|request limit|overloaded|overload|capacity|throttl|slow down/i.test(m)) return 'RATE_LIMIT'
  if (/\b5\d{2}\b|server error|internal error|service unavailable|temporarily unavailable|bad gateway|gateway timeout|upstream (?:error|failure)|error streaming response/i.test(m)) return 'SERVER'
  return 'ACP_ERROR'
}

/** JSON-RPC code of ACP `auth_required` (SDK RequestError.authRequired). */
export const AUTH_REQUIRED_CODE = -32000

/**
 * Ported from upstream (classifyError): classify an error from the agent, reading its numeric
 * JSON-RPC code and `data` as well as its text.
 *
 * -32000 is ACP's auth_required, but it is also the first code of JSON-RPC's "server error"
 * range, so it counts as AUTH only when the agent advertised authMethods at initialize. A message
 * that already names a class (quota, rate limit, auth, server) keeps that class.
 * @param {unknown} err
 * @param {{ authMethods?: unknown[] }} [ctx]
 * @returns {string}
 */
export function classifyError(err, { authMethods } = {}) {
  const e = /** @type {any} */ (err)
  const data = e?.data
  const detail = typeof data === 'string' ? data : data?.message ?? data?.details
  const byText = classifyMessage(`${e?.message ?? String(err ?? '')}${detail ? ` ${detail}` : ''}`)
  if (byText !== 'ACP_ERROR') return byText
  if (e?.code === AUTH_REQUIRED_CODE && Array.isArray(authMethods) && authMethods.length > 0) return 'AUTH'
  return 'ACP_ERROR'
}

/** Failure record for an in-band `finish` chunk. */
export const failure = (message, code) => Object.freeze({ message: message || code, code })

// Ported from upstream 0.4.26 (616ee45): a `_meta` key naming the provider's error for this turn
// (codebuddy: "codebuddy.ai/errorMessage").
const META_ERROR_KEY_RE = /(?:^|[/.])errorMessage$/
const META_ERROR_MAX = 600

/**
 * A `refusal` that is really a provider failure.
 *
 * codebuddy (2.176) answers a rate-limited / quota-exhausted turn with stopReason "refusal", no
 * JSON-RPC error and no text, and puts the provider's error in result._meta["codebuddy.ai/errorMessage"]
 * (a JSON string `{code, message, data}`). Reported as ACP_REFUSAL it reads as "the agent chose not
 * to answer", which a Team failover never switches on. With such an error text the turn is a failed
 * turn carrying the provider's own words, classified like any other agent error.
 *
 * Anything else — another stop reason, a refusal without that key, an empty or non-string value —
 * returns undefined and the turn is handled exactly as before.
 * @param {unknown} response the settled session/prompt result
 * @returns {AcpError | undefined}
 */
export function refusalFailure(response) {
  const r = /** @type {any} */ (response)
  if (r?.stopReason !== 'refusal') return undefined
  const meta = r._meta
  if (meta === null || typeof meta !== 'object') return undefined
  let raw
  for (const [k, v] of Object.entries(meta)) {
    if (META_ERROR_KEY_RE.test(k) && typeof v === 'string' && v.trim() !== '') { raw = v.trim(); break }
  }
  if (raw === undefined) return undefined
  let message = raw
  let data
  try {
    const j = JSON.parse(raw)
    if (typeof j === 'string' && j.trim() !== '') message = j.trim()
    else if (j !== null && typeof j === 'object') {
      if (typeof j.message === 'string' && j.message.trim() !== '') message = j.message.trim()
      data = j.data
    }
  } catch {}
  if (message.length > META_ERROR_MAX) message = `${message.slice(0, META_ERROR_MAX)}…`
  return new AcpError(`the agent refused the turn because its provider failed: ${message}`, classifyError({ message, data }))
}
