// Ported from upstream guozi058/dsh-llm-acp lib/credits.js (MIT), unchanged apart from this line.
// lib/credits.js — per-model credit multipliers shown next to the model name (0.4.5 Kiro, 0.4.7 CodeBuddy).
//
// 0.4.7: `codebuddy --acp` already carries the multiplier in session/new
// (availableModels[]._meta.credits, e.g. "x0.29 credits" or just "x1.62", mirrored in the
// description). It is read from the discovery handshake itself — no extra process — and shown as
// "Hy4 preview 0.29x". CodeBuddy reports no free flag; a zero multiplier is shown as "0x 免费"
// (user decision 2026-11-01). Anything that is not exactly such a multiplier adds nothing.
//
// Kiro's ACP handshake (session/new `models.availableModels`) carries only modelId / name /
// description; the multiplier the Kiro UI shows ("2.20x credits") exists only in the output of
// `kiro-cli chat --list-models`. Discovery asks that command once, alongside the handshake, and
// appends the multiplier to the display name: "gpt-5.6-terra 2.20x". Ids and descriptions are
// never changed. Best-effort throughout: another CLI, a non-zero exit, a timeout or unparseable
// output all mean "no multipliers", never a failed discovery.
//
// This module starts no process itself: the command runs through acp-session.js (K-6 keeps
// child_process in acp-session.js and detect.js only).
import { runCliOutput } from './acp-session.js'
import { cliNameOf, launchPrefix } from './config.js'

export const CREDITS_TIMEOUT_MS = 10_000
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
// "* gpt-5.6-sol         4.40x credits      OpenAI GPT ..."   ("*" marks the CLI default)
const ROW = /^(?:\*\s+)?(\S{1,200})\s+(\d{1,4}(?:\.\d{1,4})?)x\s+credits\b/i
const MAX_ROWS = 500

/** Only the Kiro CLI prints multipliers; the IDE launcher `kiro` is a different program. */
export function isKiroCommand(command, args) {
  if (typeof command !== 'string' || command.trim() === '') return false
  return cliNameOf({ command: command.trim(), args }) === 'kiro-cli'
}

/** `kiro-cli chat --list-models` stdout → Map(modelId → multiplier exactly as printed, e.g. "2.20"). */
export function parseCredits(stdout) {
  const out = new Map()
  for (const raw of String(stdout ?? '').replace(ANSI, '').split('\n')) {
    if (out.size >= MAX_ROWS) break
    const m = ROW.exec(raw.trim())
    if (m !== null && !out.has(m[1])) out.set(m[1], m[2])
  }
  return out
}

/** "gpt-5.6-terra" + "2.20" → "gpt-5.6-terra 2.20x"; no multiplier ⇒ the name unchanged. */
export function withCredits(name, credits) {
  if (typeof credits !== 'string' || credits === '') return name
  const suffix = ` ${credits}x`
  return name.endsWith(suffix) ? name : `${name}${suffix}`
}

/** "Hy3" + "0x 免费" → "Hy3 0x 免费"; no suffix ⇒ the name unchanged; never doubled. */
export function withSuffix(name, suffix) {
  if (typeof name !== 'string' || typeof suffix !== 'string' || suffix === '') return name
  return name.endsWith(` ${suffix}`) ? name : `${name} ${suffix}`
}

/** The CodeBuddy CLI (`codebuddy`, alias `cbc`); the desktop apps and other CLIs are not. */
export function isCodebuddyCommand(command, args) {
  if (typeof command !== 'string' || command.trim() === '') return false
  const b = cliNameOf({ command: command.trim(), args })
  return b === 'codebuddy' || b === 'cbc'
}

// "x0.29 credits" / "x1.62" — the whole string, nothing before or after.
const CB_CREDITS = /^x(\d{1,4}(?:\.\d{1,4})?)(?:\s+credits)?$/i

/**
 * codebuddy session/new availableModels → Map(modelId → suffix): "0.29x", "1.62x", "0x 免费".
 * `_meta.credits` first, the description as fallback. Junk skipped; the first entry of an id wins.
 */
export function codebuddyCredits(list) {
  const out = new Map()
  if (!Array.isArray(list)) return out
  for (const m of list.slice(0, MAX_ROWS)) {
    if (m === null || typeof m !== 'object' || typeof m.modelId !== 'string' || m.modelId === '' || out.has(m.modelId)) continue
    const raw = typeof m._meta?.credits === 'string' ? m._meta.credits : m.description
    if (typeof raw !== 'string') continue
    const x = CB_CREDITS.exec(raw.trim())
    if (x === null) continue
    out.set(m.modelId, Number(x[1]) === 0 ? '0x 免费' : `${x[1]}x`)
  }
  return out
}

/** Run `<kiro-cli> chat --list-models`. Never rejects; any failure resolves to an empty Map. */
export function listKiroCredits({ command, args, env, cwd, timeoutMs = CREDITS_TIMEOUT_MS }) {
  return runCliOutput(command, [...launchPrefix({ command, args }), 'chat', '--list-models'], { env, cwd, timeoutMs })
    .then((out) => (out === undefined ? new Map() : parseCredits(out)), () => new Map())
}
