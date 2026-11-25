// dsh-llm-acp — expose local ACP CLI agents (kiro-cli, codebuddy, …) as LLM provider routes.
//
// Each configured CLI becomes a provider route, so a model reference such as
// `kiro/gpt-5.6-terra` resolves like any other model in the model picker. The plugin supplies the
// model route and a usage console; it does not change DSH's own agent or team mechanisms.
//
// Turns reuse a warm CLI per host session, and reopen the CLI's own session (ACP session/load)
// after a reap or a DSH restart; see README for the limits.
//
// The "ACP 控制台" right-sidebar tab (client.js + lib/dashboard-host.js) shows every provider, its
// live state, models and per-turn usage, and switches providers/models off without a restart.
import { dirname, join } from 'node:path'
import { resolveProviders } from './lib/config.js'
import { createAcpAdapter } from './lib/adapter.js'
import { AcpAdapterBase, FallbackAdapterBase } from './lib/host.js'
import { fromHostLogger } from './lib/log.js'
import { createPrefs } from './lib/prefs.js'
import { createUsageLog } from './lib/usage.js'
import { registerDashboardRoutes } from './lib/dashboard-host.js'
import { createRanker, intervalOf } from './lib/rank.js'

const withTimeout = (p, ms) => {
  let t
  return Promise.race([Promise.resolve(p), new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms) })]).finally(() => clearTimeout(t))
}

export const name = 'llm-acp'
export const inject = ['llm']

export function apply(ctx, rawConfig) {
  const providers = resolveProviders(rawConfig ?? {}) // throws on bad config: fail loudly at load
  // 模型性价比排行: collect every N ms (default 5 min, 0 = only on 「立即重新采集」).
  const rankIntervalMs = intervalOf(rawConfig ?? {})
  // No provider yet: register no model routes, but keep the console up so its "扫描本机 ACP CLI"
  // card can add the first provider without hand-written YAML.
  if (providers.size === 0) ctx.logger?.warn?.('llm-acp: no provider configured under `providers`; console only (scan to add one)')

  // The CLI must work in the SAME directory as the session that called it (an agent that edits
  // files somewhere else is worse than useless). options.sessionId is the agent/session id;
  // agents.get(id) is the live Agent, workingDirectory.ensure(agent) its validated cwd.
  const resolveCwd = async (sessionId, signal) => {
    let agent
    try { agent = sessionId === undefined ? undefined : ctx.get('agents')?.get(sessionId) } catch {}
    try { agent ??= ctx.get('agents')?.currentInitiator() } catch {}
    let wd
    try { wd = ctx.get('workingDirectory') } catch {}
    if (agent !== undefined && wd !== undefined) {
      try {
        if (typeof wd.ensure === 'function') {
          const c = await withTimeout(wd.ensure(agent, signal), 5000)
          if (typeof c === 'string' && c !== '') return c
        }
      } catch {}
      try { const c = wd.get?.(agent.session); if (typeof c === 'string' && c !== '') return c } catch {}
    }
    if (sessionId !== undefined) ctx.logger?.warn?.(`llm-acp: no working directory for session ${sessionId}; using ${process.cwd()}`)
    return process.cwd()
  }

  // CLI-native session ids survive a DSH restart here (same DSH_HOME convention as other plugins).
  const stateFile = (() => {
    if (typeof rawConfig?.stateFile === 'string' && rawConfig.stateFile !== '') return rawConfig.stateFile
    const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : `${process.env.HOME || '.'}/.dsh`
    return `${home.replace(/\/+$/, '')}/llm-acp/sessions.json`
  })()
  // Console switches and the usage log live next to it; '' disables either file (memory only).
  const sideFile = (key, file) => (typeof rawConfig?.[key] === 'string' ? rawConfig[key] : join(dirname(stateFile), file))
  // Wrap the host logger so every line is structured (and secrets are redacted).
  const log = fromHostLogger(ctx.logger)
  const prefs = createPrefs({ file: sideFile('prefsFile', 'prefs.json'), warn: (e, f) => log.warn(e, f) })
  const usage = createUsageLog({ file: sideFile('usageFile', 'usage.jsonl'), warn: (e, f) => log.warn(e, f) })

  // Image bytes come from the host attachment store, projected to the requested size/byte budget.
  // Optional: without an attachments service images stay text placeholders.
  const readImage = (ref, target, signal) => {
    const store = ctx.get('attachments')
    if (typeof store?.readImageRequest !== 'function') return Promise.reject(new Error('no attachments service'))
    return store.readImageRequest(ref, target, signal)
  }

  const rawProviders = rawConfig?.providers && typeof rawConfig.providers === 'object' ? rawConfig.providers : {}
  // Tell the host (and through it every open model picker) that a provider's advertised models
  // changed, so a console switch, delete, or a CLI discovery result (failure ⇄ recovery, models
  // added/removed) shows up at once instead of after the picker's cache expires. Same event
  // DSH's own DeepSeek adapter emits.
  const notifyModels = (id) => {
    try { ctx.emit('llm/models-updated', id) } catch (e) { log.warn(e, { msg: 'llm-acp: models-updated emit failed' }) }
  }
  const adapter = createAcpAdapter({
    // askUser (upstream 0.4.19): DSH's waitable approval service. Only 'allowed-once' lets the CLI go
    // ahead; no service / no live agent ⇒ 'unavailable' ⇒ refused exactly as before. callId is not
    // passed: the CLI's toolCallId is not a host tool call id.
    userApproval: {
      ask: async ({ sessionId, providerId, title, signal }) => {
        let approval
        try { approval = ctx.get('approval') } catch {}
        if (typeof approval?.request !== 'function') return 'unavailable'
        let agent
        try { agent = ctx.get('agents')?.get(sessionId) } catch {}
        if (agent === undefined) return 'unavailable'
        const toolName = String(title ?? 'a tool').slice(0, 120)
        return approval.request({ agent, toolName, reason: `${providerId} 的 CLI 请求使用工具：${toolName}`, signal })
      },
    },
    Base: AcpAdapterBase ?? FallbackAdapterBase,
    providers: () => providers,
    resolveCwd,
    stateFile,
    // Last discovered model list per provider (lib/models-store.js); '' ⇒ memory only.
    modelsFile: sideFile('modelsFile', 'models.cache.json'),
    readImage,
    logger: log,
    prefs,
    onTurn: (rec) => usage.append(rec),
    onModelsChanged: notifyModels,
  })

  const release = providers.size > 0 ? ctx.llm.registerAdapter([...providers.keys()], adapter) : () => {}
  // Model price ranking (lib/rank.js): reuses the adapter's discovery; history in rank.json.
  const ranker = createRanker({ adapter, providers: () => providers, prefs, usage, file: sideFile('rankFile', 'rank.json'), log, intervalMs: rankIntervalMs })
  if (providers.size > 0) ranker.start()
  ctx.effect(() => () => {
    try { ranker.stop() } catch {}
    try { release() } catch {}
    return adapter.dispose()
  }, 'llm-acp.dispose()')
  // Console "添加 provider": the profile's config editor validates the whole next config, writes the
  // profile patch atomically and restarts this plugin with it. The patch is never edited by hand.
  const saveConfig = async (change) => {
    let editor
    try { editor = ctx.get('configEditor') } catch {}
    const entry = ctx.fiber?.entry
    if (typeof editor?.edit !== 'function' || entry === undefined) throw new Error('当前 profile 不支持在界面里保存配置（没有 configEditor），请改 cordis.patch.yml')
    await editor.edit(entry, (current) => change(current))
  }
  registerDashboardRoutes(ctx, { adapter, providers, prefs, usage, stateFile, saveConfig, rawProviders, notifyModels, ranker })
  ctx.logger?.info?.(`llm-acp: registered ${[...providers.keys()].join(', ') || '(no provider)'}`)
}
