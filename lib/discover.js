// lib/discover.js — find ACP CLIs already installed on this machine and turn them into provider
// configs, so the ACP console can add a provider with one click instead of hand-written YAML.
//
//   scan()   looks for every known CLI (RECIPES) in DSH's PATH, the login shell's PATH and the
//            usual install directories; it never starts an ACP session.
//   probe()  runs one real ACP handshake (initialize → session/new, no prompt, no tokens) and
//            reports models, capabilities and how the CLI selects a model.
//   addProvider() merges a provider into the plugin's raw config and validates the result with
//            the same resolver the plugin uses at load time.
//
// Recipes only say what is known about each CLI; probe() is what proves a recipe on this machine.
import { execFile } from 'node:child_process'
import { accessSync, closeSync, constants, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { openSession } from './acp-session.js'
import { DEFAULTS, cliNameOf, cliPathOf, launchPrefix, resolveProviders } from './config.js'

/**
 * Known ACP CLIs. `bin` is the command name an install puts on PATH (not the npm package name).
 * verified: launched over ACP by this plugin on a real machine.
 */
export const RECIPES = Object.freeze([
  { bin: 'kiro-cli', id: 'kiro', displayName: 'Kiro', args: ['acp'], modelVia: 'configOption', verified: true,
    note: 'v3 引擎在 ACP 里用 model 配置项报模型；--model 只适用于 v2 引擎' },
  { bin: 'codebuddy', id: 'codebuddy', displayName: 'CodeBuddy', args: ['--acp'], modelVia: 'args', verified: true,
    env: { CODEBUDDY_INTERNET_ENVIRONMENT: 'internal' }, note: '中国站（codebuddy.cn）' },
  { bin: 'codebuddy-code', id: 'codebuddy-code', displayName: 'CodeBuddy Code (Intl)', args: ['--acp'], modelVia: 'args', verified: true,
    env: { CODEBUDDY_INTERNET_ENVIRONMENT: 'external' }, note: '国际站，需要单独登录一次；与 codebuddy 是同一个程序' },
  { bin: 'qodercli', id: 'qoder', displayName: 'Qoder', args: ['--acp'], modelVia: 'configOption', verified: true,
    note: 'ACP 模型 id 是内部代号，--model 要的是显示名，所以走 ACP 切换' },
  { bin: 'deveco', id: 'deveco', displayName: 'DevEco', args: ['acp'], modelVia: 'configOption', verified: true,
    note: 'npm 包 @deveco/deveco-code 装出的命令叫 deveco' },
  { bin: 'opencode', id: 'opencode', displayName: 'OpenCode', args: ['acp'], verified: true },
  { bin: 'cursor-agent', id: 'cursor', displayName: 'Cursor', args: ['acp'], modelVia: 'args', models: ['default'], verified: true,
    note: '先运行 cursor-agent login；Free 账号只有 Auto 可用' },
  { bin: 'pi-acp', id: 'pi', displayName: 'Pi', args: [], approvals: 'none', verified: true,
    note: '从不询问权限，只能用 permission: allow' },
  // From upstream guozi058/dsh-llm-acp known-agents (0.4.12 MiniMax Code, 0.4.8 Kilo): handshake and
  // model selection were observed there, not yet through this fork, so they stay unverified here.
  { bin: 'mcode', id: 'mcode', displayName: 'MiniMax Code', args: ['acp'], modelVia: 'configOption', verified: false,
    note: 'npm 包 @minimax-ai/code；工作区内写文件、跑命令不询问（permission: reject 只拦工作区外），不回报 token 用量' },
  { bin: 'kilo', id: 'kilo', displayName: 'Kilo', args: ['acp'], modelVia: 'configOption', verified: false,
    note: '先运行 kilo auth login；默认装在 ~/.kilo/bin' },
  { bin: 'claude-agent-acp', id: 'claude', displayName: 'Claude Code', args: [], modelVia: 'configOption', verified: false },
  { bin: 'codex-acp', id: 'codex', displayName: 'Codex', args: [], modelVia: 'configOption', verified: false },
  { bin: 'gemini', id: 'gemini', displayName: 'Gemini CLI', args: ['--experimental-acp'], verified: false },
])

const COMMON_DIRS = ['~/.local/bin', '~/.npm-global/bin', '~/bin', '~/.bun/bin', '~/.cargo/bin', '~/.opencode/bin', '~/.kilo/bin', '~/.volta/bin', '/opt/homebrew/bin', '/usr/local/bin']
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
const PROVIDER_ID = /^[A-Za-z0-9][\w.-]{0,63}$/
// Every provider key lib/config.js reads; the console form may set any of them.
const SPEC_KEYS = ['displayName', 'command', 'args', 'modelArgs', 'env', 'modelVia', 'permission', 'models', 'approvals', 'approvalModes', 'mode',
  'readTools', 'usageCommand', 'startupTimeoutMs', 'promptTimeoutMs', 'idleTimeoutMs', 'cancelGraceMs', 'disposeGraceMs', 'maxRetries', 'startupRetries',
  'reuseSessions', 'sessionIdleMs', 'maxSessions', 'modelDiscoveryBackoffMs', 'modelDiscoveryMaxBackoffMs', 'promptRetries', 'retryDelayMs', 'maxPromptChars', 'resumeSessions',
  'images', 'maxImageBytes', 'contextWindow', 'modelCacheMs', 'rateInName', 'effort', 'askUser']

/** Defaults the console form starts from (same values lib/config.js applies). */
export const FORM_DEFAULTS = Object.freeze({
  modelArgs: [...DEFAULTS.modelArgs], permission: DEFAULTS.permission, modelVia: DEFAULTS.modelVia,
  startupTimeoutMs: DEFAULTS.startupTimeoutMs, promptTimeoutMs: DEFAULTS.promptTimeoutMs, idleTimeoutMs: DEFAULTS.idleTimeoutMs,
  reuseSessions: DEFAULTS.reuseSessions, maxSessions: DEFAULTS.maxSessions, resumeSessions: DEFAULTS.resumeSessions,
  images: DEFAULTS.images, promptRetries: DEFAULTS.promptRetries, contextWindow: DEFAULTS.contextWindow,
  modelDiscoveryBackoffMs: DEFAULTS.modelDiscoveryBackoffMs, modelDiscoveryMaxBackoffMs: DEFAULTS.modelDiscoveryMaxBackoffMs,
  rateInName: DEFAULTS.rateInName, askUser: false,
})

const uniq = (xs) => [...new Set(xs.filter((x) => typeof x === 'string' && x !== ''))]
const expand = (p, home) => (p.startsWith('~/') ? join(home, p.slice(2)) : p)
const isDir = (d) => { try { return statSync(d).isDirectory() } catch { return false } }
const isFile = (f) => { try { return statSync(f).isFile() } catch { return false } }
/**
 * Whether `file` can be started by spawn() without a shell. On Windows X_OK is meaningless (every
 * existing file passes), and spawn() without a shell only starts .exe/.com: an npm `.cmd` shim
 * fails with EINVAL and the extensionless `#!/bin/sh` shim next to it with ENOENT.
 */
export function isExec(file, platform = process.platform) {
  if (platform === 'win32') return isFile(file) && /\.(?:exe|com)$/i.test(file)
  try { if (!statSync(file).isFile()) return false; accessSync(file, constants.X_OK); return true } catch { return false }
}

/**
 * The script an npm/pnpm shim (`foo.cmd`, or the extensionless `#!/bin/sh` `foo` that npm writes
 * beside it on Windows) runs with node, as an absolute path; undefined when `file` is no such shim.
 *   .cmd: … "%_prog%"  "%dp0%\node_modules\pkg\bin\foo" %*     (older: "%~dp0\…" %*)
 *   sh:   exec node  "$basedir/node_modules/pkg/bin/foo" "$@"
 */
export function npmShimTarget(file) {
  let text
  try { text = readFileSync(file, 'utf8').slice(0, 8192) } catch { return undefined }
  const m = text.match(/"%~?dp0%?\\([^"%]+)"\s*%\*/) ?? text.match(/"\$basedir\/([^"$]+)"\s*"\$@"/)
  if (!m) return undefined
  // Only node shims: the script must be JS (by extension or by a node shebang).
  const target = resolvePath(dirname(file), m[1].replace(/[\\/]+/g, '/'))
  if (!isFile(target)) return undefined
  if (/\.(?:c|m)?js$/i.test(target) || interpreterOf(target) === 'node') return target
  return undefined
}

/**
 * How to start CLI `bin` found in `dir` on Windows, or undefined when it is not there.
 *   { path, command, script?, interpreter?, interpreterDir?, unsupported? }
 * `command` (+ `script` as first argument) is what spawn() can run without a shell.
 */
export function win32Launch(dir, bin, nodeDirs = []) {
  for (const ext of ['.exe', '.com']) {
    const p = join(dir, bin + ext)
    if (isFile(p)) return { path: p, command: p }
  }
  for (const shim of [join(dir, `${bin}.cmd`), join(dir, bin)]) {
    if (!isFile(shim)) continue
    const script = npmShimTarget(shim)
    if (script) {
      // Same lookup as the shim itself: node.exe beside it first, then PATH.
      const node = [dir, ...nodeDirs].map((d) => join(d, 'node.exe')).find(isFile)
      return { path: shim, command: node, script, interpreter: 'node', interpreterDir: node ? dirname(node) : undefined }
    }
  }
  for (const p of [join(dir, `${bin}.cmd`), join(dir, `${bin}.bat`), join(dir, `${bin}.ps1`), join(dir, bin)]) {
    if (isFile(p)) return { path: p, unsupported: true, interpreter: interpreterOf(p) }
  }
  return undefined
}

/** Win32 directories CLIs are commonly installed into (npm global, user bins, nodejs). */
function win32Dirs(env, home) {
  const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming')
  const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
  return [
    join(appData, 'npm'), join(local, 'pnpm'), join(home, '.local', 'bin'), join(home, '.bun', 'bin'), join(home, '.cargo', 'bin'),
    join(home, '.volta', 'bin'), join(home, '.opencode', 'bin'), join(home, '.kilo', 'bin'), join(home, 'bin'),
    join(local, 'Programs', 'nodejs'), join(env.ProgramFiles ?? 'C:\\Program Files', 'nodejs'),
  ]
}


/** Interpreter named by a `#!` line (`node`, `bun`, …), or undefined for a native binary. */
export function interpreterOf(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(160)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const head = buf.subarray(0, n).toString('utf8')
    if (!head.startsWith('#!')) return undefined
    const line = head.split('\n')[0].slice(2).trim().split(/\s+/)
    const prog = basename(line[0] === '/usr/bin/env' || basename(line[0]) === 'env' ? (line.find((w, i) => i > 0 && !w.startsWith('-')) ?? '') : line[0])
    return prog || undefined
  } catch { return undefined } finally { if (fd !== undefined) try { closeSync(fd) } catch {} }
}

let loginCache
/** PATH of the user's login shell: a Dock-launched DSH usually lacks what ~/.zprofile adds. */
export function loginShellPath({ env = process.env, timeoutMs = 5000 } = {}) {
  if (process.platform === 'win32') return Promise.resolve([])
  if (loginCache && Date.now() - loginCache.at < 600_000) return loginCache.promise
  const shell = typeof env.SHELL === 'string' && isAbsolute(env.SHELL) ? env.SHELL : '/bin/zsh'
  const promise = new Promise((resolve) => {
    try {
      execFile(shell, ['-lic', 'printf "\\n__DSH_PATH__%s\\n" "$PATH"'], {
        timeout: timeoutMs, maxBuffer: 256 * 1024,
        env: { HOME: env.HOME ?? homedir(), USER: env.USER ?? '', SHELL: shell, TERM: 'dumb' },
      }, (_err, stdout) => {
        const m = String(stdout ?? '').match(/__DSH_PATH__(.*)/)
        resolve(m ? m[1].split(':').filter(Boolean) : [])
      })
    } catch { resolve([]) }
  })
  loginCache = { at: Date.now(), promise }
  return promise
}

/** `bin --version`, best effort. `pre` is argv before `--version` (the script for `node <script>`). */
export function versionOf(command, env, timeoutMs = 8000, pre = []) {
  return new Promise((resolve) => {
    try {
      execFile(command, [...pre, '--version'], { timeout: timeoutMs, maxBuffer: 256 * 1024, env: { ...process.env, ...env }, windowsHide: true }, (err, stdout, stderr) => {
        const text = `${stdout ?? ''}\n${stderr ?? ''}`.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
        const m = text.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?\b/)
        resolve(m ? { version: m[0] } : { error: err ? String(err.message ?? err).split('\n')[0].slice(0, 160) : 'no version in output' })
      })
    } catch (e) { resolve({ error: String(e?.message ?? e).slice(0, 160) }) }
  })
}

function resolveCommand(command, dirs, platform = process.platform) {
  if (isAbsolute(command)) return command
  const names = platform === 'win32' && !/\.[A-Za-z0-9]+$/.test(command) ? [`${command}.exe`, `${command}.com`] : [command]
  for (const d of dirs) for (const n of names) if (isExec(join(d, n), platform)) return join(d, n)
  return undefined
}
const real = (p) => { try { return realpathSync(p) } catch { return p } }

/**
 * What makes two providers the same local CLI: the program, its argv and its env (PATH aside, which
 * only helps find node). Model selection, permission and timeouts do not make a second CLI.
 * codebuddy and codebuddy-code run one script but differ in CODEBUDDY_INTERNET_ENVIRONMENT, so
 * they stay two providers. Windows paths compare case-insensitively.
 */
export function launchKey(spec, platform = process.platform) {
  const win = platform === 'win32'
  const norm = (s) => {
    const t = String(s ?? '').trim()
    return win ? t.replace(/\//g, '\\').toLowerCase() : t
  }
  const env = Object.entries(spec?.env ?? {})
    .filter(([k]) => k.toUpperCase() !== 'PATH')
    .map(([k, v]) => [win ? k.toUpperCase() : k, String(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify([norm(spec?.command), (Array.isArray(spec?.args) ? spec.args : []).map((a, i) => (i === 0 && launchPrefix(spec).length ? norm(a) : String(a))), env])
}

/** Id of a provider in `providers` (raw config object or Map of profiles) that runs the same CLI as `spec`, other than `exceptId`. */
export function duplicateOf(providers, spec, exceptId, platform = process.platform) {
  const key = launchKey(spec, platform)
  const entries = providers instanceof Map ? [...providers.entries()] : Object.entries(providers ?? {})
  for (const [id, p] of entries) {
    if (id === exceptId || p === null || typeof p !== 'object') continue
    if (launchKey(p, platform) === key) return id
  }
  return undefined
}

/** A provider id not yet taken by `taken`. */
export function freeId(base, taken) {
  if (!taken.has(base)) return base
  for (let i = 2; i < 100; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
  return `${base}-${Date.now()}`
}

/**
 * The provider config a recipe suggests for a CLI found at `path`.
 * A `#!/usr/bin/env node` script gets an explicit PATH, or a Dock-launched DSH fails with
 * "env: node: No such file or directory".
 * On Windows a node CLI installed by npm is started as `node.exe <script> …`: spawn() without a
 * shell can run neither its `.cmd` shim nor the `#!/bin/sh` one. `command`/`script` say so.
 */
export function suggestSpec(recipe, { path, dir, interpreter, interpreterDir, command, script }, platform = process.platform) {
  const env = { ...(recipe.env ?? {}) }
  // Windows: node.exe is started by absolute path, so PATH needs no help (and a PATH key next to the
  // inherited Path would give the child two of them).
  if (platform !== 'win32' && interpreter) env.PATH = uniq([interpreterDir, dir, ...SYSTEM_PATH]).join(':')
  return {
    displayName: recipe.displayName,
    command: command ?? path,
    args: [...(script ? [script] : []), ...recipe.args],
    ...(recipe.modelVia === 'configOption' ? { modelVia: 'configOption' } : {}),
    ...(Object.keys(env).length ? { env } : {}),
    ...(recipe.models ? { models: [...recipe.models] } : {}),
    ...(recipe.approvals ? { approvals: recipe.approvals } : {}),
    // allow is the plugin default, so a CLI added from the scan is ready to use right away.
    permission: 'allow',
  }
}

/** Where CLI `bin` is in `dirs` and how to start it; undefined when absent. */
function locate(bin, dirs, platform) {
  if (platform === 'win32') {
    const nodeDirs = dirs.filter((d) => isFile(join(d, 'node.exe')))
    for (const dir of dirs) {
      const l = win32Launch(dir, bin, nodeDirs)
      if (l) return { dir, ...l }
    }
    return undefined
  }
  const dir = dirs.find((d) => isExec(join(d, bin), platform))
  if (!dir) return undefined
  const path = join(dir, bin)
  const interpreter = interpreterOf(real(path))
  const interpreterDir = interpreter ? dirs.find((d) => isExec(join(d, interpreter), platform)) : undefined
  return { dir, path, command: path, interpreter, interpreterDir }
}

function warningOf(l, platform) {
  if (l.unsupported) {
    return `找到了 ${basename(l.path)}，但它不是 npm 生成的 node 启动脚本，也不是 .exe：无法不经 shell 直接启动，请手动填写真正的可执行文件`
  }
  if (!l.interpreter || l.interpreterDir) return undefined
  if (platform === 'win32') return `这是 node 脚本，但没找到 node.exe（在 PATH 和 ${l.dir} 里都没有）：先安装 Node.js，或在配置里把可执行文件改成 node.exe 的完整路径`
  return `这是 ${l.interpreter} 脚本，但没找到 ${l.interpreter}`
}

/**
 * Find installed ACP CLIs. Never spawns an ACP session; runs `--version` only.
 * @param {{ providers?: Map<string, {id:string, command:string, args?:string[]}>, env?: object, home?: string, loginPath?: string[], extraDirs?: string[], versions?: boolean, platform?: string }} [o]
 */
export async function scan({ providers = new Map(), env = process.env, home = homedir(), loginPath, commonDirs, extraDirs = [], versions = true, platform = process.platform } = {}) {
  const win = platform === 'win32'
  const sep = win ? ';' : delimiter
  // Windows: the PATH variable may be spelled Path; process.env is case-insensitive there, a copy is not.
  const rawPath = win ? (Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '') : (env.PATH ?? '')
  const dshPath = String(rawPath).split(sep).map((d) => (win ? d.replace(/^"(.*)"$/, '$1') : d))
  const login = loginPath ?? await loginShellPath({ env })
  const common = commonDirs ?? (win ? win32Dirs(env, home) : COMMON_DIRS)
  const dirs = uniq([...dshPath, ...login, ...common.map((d) => expand(d, home)), ...extraDirs]).filter(isDir)
  const same = (a, b) => (a !== undefined && b !== undefined && (win ? a.toLowerCase() === b.toLowerCase() : a === b))
  const configured = [...providers.values()].map((p) => {
    // `node.exe <script> …` is the script, not node.
    const cli = cliPathOf(p)
    const resolved = cli === p.command ? resolveCommand(p.command, dirs, platform) : cli
    return { id: p.id, base: cliNameOf(p), path: resolved, real: resolved ? real(resolved) : undefined, key: launchKey(p, platform) }
  })
  // A provider counts for one candidate only, so two recipes for one program (codebuddy and
  // codebuddy-code) are not both shown as that one provider.
  const claimed = new Set()
  const taken = new Set(providers.keys())
  const candidates = []
  for (const r of RECIPES) {
    const l = locate(r.bin, dirs, platform)
    if (!l) continue
    const { dir, path } = l
    const spec = suggestSpec(r, l, platform)
    // Already configured? Strongest evidence first: the very launch this recipe would add (same
    // program, argv and env), then the recipe's own id on this CLI, then the CLI name or path.
    const key = launchKey(spec, platform)
    const free = configured.filter((c) => !claimed.has(c.id))
    const match = free.find((c) => c.key === key)
      ?? free.find((c) => c.id === r.id && (c.base === r.bin || same(c.path, path) || same(c.real, real(l.script ?? path))))
      ?? free.find((c) => c.base === r.bin || same(c.path, path))
    if (match) claimed.add(match.id)
    const id = match ? match.id : freeId(r.id, taken)
    if (!match) taken.add(id)
    candidates.push({
      bin: r.bin, id, displayName: r.displayName, note: r.note ?? '', verified: r.verified === true,
      recipeModelVia: r.modelVia, path, real: real(l.script ?? path), dir,
      inDshPath: dshPath.some((d) => same(d, dir)),
      interpreter: l.interpreter, interpreterDir: l.interpreterDir,
      warning: warningOf(l, platform),
      configuredAs: match?.id,
      spec,
    })
  }
  if (versions) {
    await Promise.all(candidates.map(async (c) => {
      if (!c.spec.command || c.warning) return
      Object.assign(c, await versionOf(c.spec.command, c.spec.env, 8000, launchPrefix(c.spec)))
    }))
  }
  return { dirs, candidates }
}

const AUTH_HINT = '看起来没有登录：先在终端里运行一次这个 CLI 完成登录，再回来检测'
function hintFor(code, message) {
  if (code === 'AUTH' || /auth|login|unauthor|401|403/i.test(message)) return AUTH_HINT
  if (code === 'ACP_SPAWN') return '启动失败：检查路径是否正确、文件是否可执行'
  if (/EINVAL/.test(message)) return 'Windows 不经 shell 不能直接启动 .cmd/.bat：把可执行文件改成 node.exe，参数第一项写 CLI 脚本路径（重新扫描会自动填好）'
  if (/node: No such file|env: node/i.test(message)) return '找不到 node：在配置的 env.PATH 里加上 node 所在目录'
  if (code === 'TIMEOUT') return 'ACP 握手超时：这个参数可能不是它的 ACP 模式，或 CLI 在等交互输入'
  if (code === 'TRANSPORT') return 'CLI 提前退出：参数可能不对（不是 ACP 模式），看下面的错误输出'
  return undefined
}

/**
 * One ACP handshake against a provider spec; no prompt is sent, so no tokens are spent.
 * Always resolves.
 */
export async function probe(spec, { cwd = tmpdir(), timeoutMs = 45_000 } = {}) {
  const t0 = Date.now()
  let s
  try {
    s = await openSession({
      // model 'default' ⇒ no modelArgs: the probe lets the CLI pick, and never switches models.
      command: spec.command, args: [...(spec.args ?? [])], env: spec.env ?? {}, cwd,
      // allow: a probe never prompts, and alignment must not refuse an agent that never asks.
      permission: 'allow', readTools: [], approvals: spec.approvals ?? 'modes',
      model: 'default', modelVia: spec.modelVia ?? 'args', startupTimeoutMs: timeoutMs, disposeGraceMs: 2000,
    })
  } catch (e) {
    const code = e?.code ?? 'ERROR'
    const message = String(e?.message ?? e).slice(0, 500)
    return { ok: false, ms: Date.now() - t0, code, message, hint: hintFor(code, message) }
  }
  try {
    const info = s.info ?? {}
    const opts = Array.isArray(info.configOptions) ? info.configOptions : []
    const modelOpt = opts.find((o) => o?.category === 'model' || o?.id === 'model')
    const list = Array.isArray(info.models?.availableModels) ? info.models.availableModels : undefined
    let models = []
    let modelSource = 'none'
    if (list && list.length) {
      modelSource = 'models'
      models = list.filter((m) => typeof m?.modelId === 'string' && m.modelId !== '')
        .map((m) => ({ id: m.modelId, name: typeof m.name === 'string' ? m.name : m.modelId, description: typeof m.description === 'string' ? m.description : undefined }))
    } else if (Array.isArray(modelOpt?.options)) {
      modelSource = 'configOption'
      models = modelOpt.options.filter((o) => typeof o?.value === 'string' && o.value !== '')
        .map((o) => ({ id: o.value, name: typeof o.name === 'string' ? o.name : o.value, description: typeof o.description === 'string' ? o.description : undefined }))
    }
    const modeOpt = opts.find((o) => o?.category === 'mode' || o?.id === 'mode')
    const modes = Array.isArray(modeOpt?.options) ? modeOpt.options.map((o) => o?.value).filter((v) => typeof v === 'string')
      : Array.isArray(info.modes?.availableModes) ? info.modes.availableModes.map((m) => m?.id).filter((v) => typeof v === 'string') : []
    return {
      ok: true, ms: Date.now() - t0,
      loadSession: s.capabilities?.loadSession === true,
      image: s.capabilities?.promptCapabilities?.image === true,
      modelSource, hasModelOption: Array.isArray(modelOpt?.options),
      currentModel: info.models?.currentModelId ?? modelOpt?.currentValue,
      models: models.slice(0, 200), modes,
    }
  } finally { await s.dispose().catch(() => {}) }
}

/** How a provider should select models, given its recipe (if any) and a probe result. */
export function recommendModelVia(recipeModelVia, result) {
  if (recipeModelVia === 'args' || recipeModelVia === 'configOption') return recipeModelVia
  if (result?.ok && result.modelSource === 'configOption') return 'configOption'
  return 'args'
}

/**
 * Validate a provider spec coming from the console. Only known keys survive; the command must be
 * an absolute path to an executable file (the console never runs a bare name or a shell string).
 */
export function sanitizeSpec(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('spec must be an object')
  const spec = {}
  for (const k of SPEC_KEYS) if (input[k] !== undefined && input[k] !== null && input[k] !== '') spec[k] = structuredClone(input[k])
  if (typeof spec.command !== 'string' || !isAbsolute(spec.command)) throw new Error('command 必须是绝对路径')
  if (!isExec(spec.command)) throw new Error(process.platform === 'win32'
    ? `不是可执行文件（Windows 下要 .exe；npm 装的 CLI 用 node.exe + 脚本路径）：${spec.command}`
    : `不是可执行文件：${spec.command}`)
  if (spec.args === undefined) spec.args = []
  if (typeof spec.displayName === 'string') spec.displayName = spec.displayName.trim().slice(0, 64)
  if (spec.env !== undefined && (spec.env === null || typeof spec.env !== 'object' || Array.isArray(spec.env))) throw new Error('env 必须是对象')
  if (spec.env && Object.keys(spec.env).length === 0) delete spec.env
  // Same rules as plugin load: throws with the plugin's own message on any bad field.
  resolveProviders({ providers: { probe: spec } })
  return spec
}

/**
 * Next raw plugin config with provider `id` set to `spec`; validated like a load.
 * A spec that launches the same local CLI as another provider (see launchKey) is refused: the
 * second entry would only start the same program, under another name, a second time.
 */
export function addProvider(current, id, spec, { overwrite = false, platform = process.platform } = {}) {
  if (typeof id !== 'string' || !PROVIDER_ID.test(id)) throw new Error(`provider 名不合法：${JSON.stringify(id)}（字母、数字、. _ -）`)
  const next = structuredClone(current ?? {})
  const providers = next.providers && typeof next.providers === 'object' && !Array.isArray(next.providers) ? { ...next.providers } : {}
  if (providers[id] !== undefined && !overwrite) throw new Error(`provider "${id}" 已经存在`)
  const dup = duplicateOf(providers, spec, id, platform)
  if (dup !== undefined) throw new Error(`这个本地 CLI 已经接入为 provider "${dup}"（同一程序、参数和环境变量）：请编辑 "${dup}"，不要重复添加`)
  providers[id] = spec
  next.providers = providers
  resolveProviders(next)
  return next
}

/** Next raw plugin config without provider `id`. */
export function removeProvider(current, id) {
  const next = structuredClone(current ?? {})
  const providers = next.providers && typeof next.providers === 'object' && !Array.isArray(next.providers) ? { ...next.providers } : {}
  if (providers[id] === undefined) throw new Error(`provider "${id}" 不在配置里`)
  delete providers[id]
  next.providers = providers
  resolveProviders(next)
  return next
}
