// lib/usage-probe.js — dynamically ask each configured ACP CLI for whatever usage/account info
// it can report non-interactively, and normalise the answer into one shape for the ACP insights card.
//
// IMPORTANT: no ACP CLI exposes an "account remaining balance" command. What a CLI can actually
// tell us is limited: deveco prints local cumulative token/cost stats, cursor prints the
// subscription tier, qoder prints the account type. This module reports exactly that and labels
// the source honestly — it never fabricates a "remaining quota" number. It also never throws and
// never prints credentials (emails are masked; only a sanitised excerpt is returned).

import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { cliNameOf, launchPrefix } from './config.js'

const TTL_MS = 5 * 60_000
const EXEC_TIMEOUT_MS = 10_000

/** command basename → probe recipe. A provider may override argv with `usageCommand`. */
export const PROBES = Object.freeze({
  deveco: Object.freeze({ args: Object.freeze(['stats']), source: '本地累计统计（非账户余额）' }),
  'cursor-agent': Object.freeze({ args: Object.freeze(['about']), source: '账号信息（非账户余额）' }),
  qodercli: Object.freeze({ args: Object.freeze(['status']), source: '账号信息（非账户余额）' }),
})

// command → { at, promise } of the normalised result. Shared by every caller; cleared by refresh.
const cache = new Map()

/** Clear the probe cache so the next dashboard load re-runs every command. */
export function clearUsageCache() { cache.clear() }

const stripAnsi = (s) => String(s ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

function maskEmail(s) {
  return String(s ?? '').replace(/([\w.+-]+)@([\w.-]+\.[\w.-]+)/g, (_, local, domain) => {
    const head = local.slice(0, 1) || '*'
    return `${head}***@${domain}`
  })
}

/**
 * Parse `Label  value` / `Label: value` lines (with or without box-drawing chars) into a map.
 * Exported for unit tests.
 */
export function parseKeyValue(text) {
  const out = {}
  for (const raw of stripAnsi(text).split(/\r?\n/)) {
    const line = raw.replace(/[│┃┌┐└┘├┤┬┴┼─═║╔╗╚╝╭╮╰╯]/g, ' ').trim()
    if (!line) continue
    let m = line.match(/^([A-Za-z][\w /()·.+\-]{0,40}?)\s*[:：]\s*(.+)$/)
    if (m) { out[norm(m[1])] = m[2].trim(); continue }
    m = line.match(/^([A-Za-z][\w /()·.+\-]{0,40}?)\s{2,}(.+)$/)
    if (m) out[norm(m[1])] = m[2].trim()
  }
  return out
}

const pick = (kv, aliases) => {
  for (const a of aliases) if (kv[a] !== undefined && kv[a] !== '') return kv[a]
  return undefined
}

/** Build the normalised fields from a probe's output. Exported for unit tests. */
export function parseProbeOutput(name, text) {
  const kv = parseKeyValue(text)
  const tier = pick(kv, ['subscription tier', 'user type', 'tier', 'plan'])
  const identity = pick(kv, ['user email', 'email', 'username'])
  const model = pick(kv, ['model', 'cli version', 'version'])
  const cost = pick(kv, ['total cost'])
  const sessions = pick(kv, ['sessions'])
  const tokens = {
    input: pick(kv, ['input', 'total input tokens']),
    output: pick(kv, ['output', 'total output tokens']),
    cacheRead: pick(kv, ['cache read', 'cache read input tokens']),
  }
  const hasTokens = Object.values(tokens).some((v) => v !== undefined)
  let note = ''
  if (name === 'deveco') {
    const parts = []
    if (sessions !== undefined) parts.push(`${sessions} 会话`)
    if (cost !== undefined) parts.push(`花费 ${cost}`)
    if (hasTokens) parts.push(`输入 ${tokens.input ?? '-'} / 输出 ${tokens.output ?? '-'} / 缓存读 ${tokens.cacheRead ?? '-'}`)
    note = parts.length ? `本地累计 · ${parts.join(' · ')}` : ''
  } else if (tier !== undefined) {
    note = `账号类型 ${tier}${model ? ` · ${model}` : ''}`
  }
  return {
    tier, identity: identity ? maskEmail(identity) : undefined, model,
    cost, tokens: hasTokens ? tokens : undefined, sessions, note,
  }
}

function resolveRecipe(p) {
  // Explicit per-provider override wins; otherwise match the CLI by its executable name.
  if (Array.isArray(p.usageCommand) && p.usageCommand.length > 0 && p.usageCommand.every((a) => typeof a === 'string')) {
    return { args: p.usageCommand, source: '自定义探测命令（非账户余额）' }
  }
  const name = cliNameOf(p).toLowerCase()
  const built = PROBES[name]
  return built ? { args: [...launchPrefix(p), ...built.args], source: built.source, name } : null
}

/**
 * Probe one provider. Always resolves (never rejects). Result shape:
 * { supported, provider, probedAt, source, tier, identity, model, cost, tokens, sessions, note, excerpt, error }
 */
export function probeUsage(p, { now = Date.now() } = {}) {
  const recipe = resolveRecipe(p)
  if (!recipe) return Promise.resolve({
    supported: false, provider: p.id, probedAt: now,
    note: '该 CLI 不提供非交互用量查询',
  })
  const args = [...recipe.args]
  const key = `${p.command}\u0000${args.join('\u0000')}\u0000${p.id}`
  const hit = cache.get(key)
  if (hit && now - hit.at < TTL_MS) return hit.promise

  const promise = new Promise((resolve) => {
    let done = false
    const finish = (result) => { if (!done) { done = true; resolve({ provider: p.id, probedAt: now, source: recipe.source, ...result }) } }
    const timer = setTimeout(() => finish({ supported: true, error: '探测超时', args }), EXEC_TIMEOUT_MS + 2000)
    timer.unref?.()
    execFile(p.command, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 256 * 1024, env: { ...process.env, ...(p.env ?? {}) }, windowsHide: true }, (err, stdout, stderr) => {
      clearTimeout(timer)
      const text = `${stdout ?? ''}\n${stderr ?? ''}`
      const parsed = parseProbeOutput(recipe.name ?? basename(String(p.command)), text)
      const hasData = Object.values(parsed).some((v) => v !== undefined && (typeof v !== 'object' || Object.values(v ?? {}).some((x) => x !== undefined)))
      if (hasData) {
        const excerpt = maskEmail(stripAnsi(text).trim().split(/\r?\n/).filter(Boolean).slice(0, 6).join(' · ')).slice(0, 400)
        finish({ supported: true, ...parsed, excerpt })
      } else if (err) {
        finish({ supported: true, error: /ENOENT/.test(String(err.code)) ? '找不到 CLI' : String(err.message ?? err).slice(0, 200), args })
      } else {
        finish({ supported: true, error: 'CLI 未返回可识别的用量信息', args })
      }
    })
  })
  cache.set(key, { at: now, promise })
  return promise
}
