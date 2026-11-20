// Offline tests for lib/discover.js — fake executables in a temp dir and a fake ACP agent;
// no real CLI, no network, no tokens.
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  RECIPES, addProvider, duplicateOf, freeId, interpreterOf, isExec, npmShimTarget, probe, recommendModelVia, removeProvider, sanitizeSpec, scan, suggestSpec, win32Launch,
} from '../lib/discover.js'
import { cliNameOf, launchPrefix } from '../lib/config.js'

const tests = []
const t = (name, fn) => tests.push([name, fn])
// Tests that rely on POSIX execute bits and #!/bin/sh fake CLIs cannot hold on Windows.
const posix = (name, fn) => (process.platform === 'win32' ? tests.push([`${name} (skipped on Windows)`, () => {}]) : t(name, fn))

const root = mkdtempSync(join(tmpdir(), 'llm-acp-discover-'))
const bin = join(root, 'bin')
const nodeDir = join(root, 'nodebin')
mkdirSync(bin); mkdirSync(nodeDir)
const mk = (file, text) => { writeFileSync(file, text); chmodSync(file, 0o755); return file }
// A native-looking binary (no shebang), a node script, and a fake `node` for the interpreter lookup.
mk(join(bin, 'kiro-cli'), '\x7fELF fake binary\n')
mk(join(bin, 'deveco'), '#!/usr/bin/env node\nconsole.log("0.2.5")\n')
mk(join(bin, 'qodercli'), '#!/bin/sh\necho 1.1.90\n')
mk(join(nodeDir, 'node'), '#!/bin/sh\nexit 0\n')
writeFileSync(join(bin, 'codebuddy'), 'not executable\n') // present but not +x ⇒ ignored

// Fake ACP agent: answers initialize and session/new over ndjson, then waits for EOF.
const agent = join(root, 'fake-agent.mjs')
writeFileSync(agent, `
import { createInterface } from 'node:readline'
const mode = process.argv[2] ?? 'models'
const rl = createInterface({ input: process.stdin })
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line) } catch { return }
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: mode !== 'noimage' } } } })
  else if (m.method === 'session/new') {
    if (mode === 'auth') return send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'Authentication required: please login' } })
    const r = { sessionId: 'sess-1' }
    if (mode === 'models') r.models = { currentModelId: 'm1', availableModels: [{ modelId: 'm1', name: 'Model One', description: '0.50x Credit' }, { modelId: 'm2', name: 'Model Two' }] }
    r.configOptions = [{ type: 'select', id: 'mode', category: 'mode', currentValue: 'default', options: [{ value: 'default' }, { value: 'acceptEdits' }] }]
    if (mode === 'config' || mode === 'noimage') r.configOptions.push({ type: 'select', id: 'model', category: 'model', currentValue: 'a/x', options: [{ value: 'a/x', name: 'X' }, { value: 'a/y', name: 'Y' }] })
    send({ jsonrpc: '2.0', id: m.id, result: r })
  } else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} })
})
rl.on('close', () => process.exit(0))
`)
const fakeSpec = (mode) => ({ command: process.execPath, args: [agent, mode] })

t('recipes: unique ids and bins, valid args', () => {
  assert.equal(new Set(RECIPES.map((r) => r.id)).size, RECIPES.length)
  assert.equal(new Set(RECIPES.map((r) => r.bin)).size, RECIPES.length)
  for (const r of RECIPES) assert.ok(Array.isArray(r.args), r.bin)
})

t('interpreterOf: env node, sh, binary', () => {
  assert.equal(interpreterOf(join(bin, 'deveco')), 'node')
  assert.equal(interpreterOf(join(bin, 'qodercli')), 'sh')
  assert.equal(interpreterOf(join(bin, 'kiro-cli')), undefined)
  assert.equal(interpreterOf(join(bin, 'missing')), undefined)
})

t('freeId avoids taken ids', () => {
  assert.equal(freeId('kiro', new Set()), 'kiro')
  assert.equal(freeId('kiro', new Set(['kiro'])), 'kiro-2')
  assert.equal(freeId('kiro', new Set(['kiro', 'kiro-2'])), 'kiro-3')
})

t('suggestSpec: node script gets PATH, recipe env kept, allow by default', () => {
  const r = RECIPES.find((x) => x.bin === 'codebuddy')
  const s = suggestSpec(r, { path: '/x/codebuddy', dir: '/x', interpreter: 'node', interpreterDir: '/n' }, 'linux')
  assert.equal(s.env.CODEBUDDY_INTERNET_ENVIRONMENT, 'internal')
  assert.equal(s.env.PATH.split(':')[0], '/n')
  assert.ok(s.env.PATH.includes('/usr/bin'))
  assert.equal(s.permission, 'allow')
  assert.deepEqual(s.args, ['--acp'])
  const k = suggestSpec(RECIPES.find((x) => x.bin === 'kiro-cli'), { path: '/x/kiro-cli', dir: '/x' }, 'linux')
  assert.equal(k.modelVia, 'configOption')
  assert.equal(k.env, undefined)
})

t('suggestSpec win32: npm CLI runs as node.exe <script>, no PATH added', () => {
  const r = RECIPES.find((x) => x.bin === 'codebuddy')
  const s = suggestSpec(r, { path: 'C:\\npm\\codebuddy.cmd', dir: 'C:\\npm', interpreter: 'node', interpreterDir: 'C:\\node', command: 'C:\\node\\node.exe', script: 'C:\\npm\\node_modules\\cb\\bin\\codebuddy' }, 'win32')
  assert.equal(s.command, 'C:\\node\\node.exe')
  assert.deepEqual(s.args, ['C:\\npm\\node_modules\\cb\\bin\\codebuddy', '--acp'])
  assert.deepEqual(s.env, { CODEBUDDY_INTERNET_ENVIRONMENT: 'internal' })
})

t('win32: npm shims resolve to node.exe + script; missing node.exe ⇒ Windows warning', () => {
  const npm = join(root, 'npm')
  const pkgBin = join(npm, 'node_modules', '@x', 'cb', 'bin')
  mkdirSync(pkgBin, { recursive: true })
  writeFileSync(join(pkgBin, 'codebuddy'), '#!/usr/bin/env node\nconsole.log("1.2.3")\n')
  writeFileSync(join(npm, 'codebuddy.cmd'), '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@x\\cb\\bin\\codebuddy" %*\r\n')
  writeFileSync(join(npm, 'codebuddy'), '#!/bin/sh\nexec node  "$basedir/node_modules/@x/cb/bin/codebuddy" "$@"\n')
  writeFileSync(join(npm, 'tool.cmd'), '@echo off\r\nsomething.exe %*\r\n')
  const script = join(pkgBin, 'codebuddy')
  assert.equal(npmShimTarget(join(npm, 'codebuddy.cmd')), script)
  assert.equal(npmShimTarget(join(npm, 'codebuddy')), script)
  assert.equal(npmShimTarget(join(npm, 'tool.cmd')), undefined)
  const noNode = win32Launch(npm, 'codebuddy', [])
  assert.equal(noNode.script, script)
  assert.equal(noNode.interpreter, 'node')
  assert.equal(noNode.command, undefined)
  const nodeDir = join(root, 'winnode')
  mkdirSync(nodeDir)
  writeFileSync(join(nodeDir, 'node.exe'), '')
  const ok = win32Launch(npm, 'codebuddy', [nodeDir])
  assert.equal(ok.command, join(nodeDir, 'node.exe'))
  assert.equal(ok.interpreterDir, nodeDir)
  assert.equal(win32Launch(npm, 'tool').unsupported, true)
  assert.equal(win32Launch(npm, 'absent'), undefined)
  assert.equal(isExec(join(npm, 'codebuddy.cmd'), 'win32'), false)
  assert.equal(isExec(join(nodeDir, 'node.exe'), 'win32'), true)
})

t('win32 scan: shim found, configured node.exe provider matched by script name', async () => {
  const npm = join(root, 'npm')
  const nodeDir = join(root, 'winnode')
  const script = join(npm, 'node_modules', '@x', 'cb', 'bin', 'codebuddy')
  const providers = new Map([['cb', { id: 'cb', command: join(nodeDir, 'node.exe'), args: [script, '--acp'] }]])
  const r = await scan({ providers, env: { Path: `${npm};${nodeDir}` }, home: root, loginPath: [], commonDirs: [], versions: false, platform: 'win32' })
  const c = r.candidates.find((x) => x.bin === 'codebuddy')
  assert.ok(c, 'codebuddy found through its .cmd shim')
  assert.equal(c.configuredAs, 'cb')
  assert.equal(c.warning, undefined)
  assert.equal(c.spec.command, join(nodeDir, 'node.exe'))
  assert.deepEqual(c.spec.args, [script, '--acp'])
  const bare = await scan({ env: { Path: npm }, home: root, loginPath: [], commonDirs: [], versions: false, platform: 'win32' })
  assert.match(bare.candidates.find((x) => x.bin === 'codebuddy').warning, /node\.exe/)
})

t('addProvider refuses a second provider for the same local CLI', () => {
  const node = 'C:\\Program Files\\nodejs\\node.exe'
  const script = 'C:\\npm\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy'
  const cur = { providers: {
    codebuddy: { command: node, args: [script, '--acp'], permission: 'reject' },
    'codebuddy-code': { command: node, args: [script, '--acp'], env: { CODEBUDDY_INTERNET_ENVIRONMENT: 'external' } },
  } }
  // Same program + argv + env, other id, different case/slashes, extra PATH and other options ⇒ refused.
  assert.throws(() => addProvider(cur, 'codebuddy-2', { command: node.toLowerCase(), args: [script.replace(/\\/g, '/'), '--acp'], env: { PATH: 'C:\\x' }, permission: 'allow' }, { platform: 'win32' }), /已经接入为 provider "codebuddy"/)
  assert.throws(() => addProvider(cur, 'cb-intl', { command: node, args: [script, '--acp'], env: { CODEBUDDY_INTERNET_ENVIRONMENT: 'external' } }, { platform: 'win32' }), /"codebuddy-code"/)
  // Editing the provider itself is no duplicate.
  assert.equal(addProvider(cur, 'codebuddy', { command: node, args: [script, '--acp'], permission: 'allow' }, { overwrite: true, platform: 'win32' }).providers.codebuddy.permission, 'allow')
  // Another env (another account/site) is another CLI setup.
  assert.ok(addProvider(cur, 'cb-test', { command: node, args: [script, '--acp'], env: { CODEBUDDY_INTERNET_ENVIRONMENT: 'test' } }, { platform: 'win32' }).providers['cb-test'])
  // POSIX paths stay case-sensitive.
  assert.ok(addProvider({ providers: { a: { command: '/opt/Kiro', args: ['acp'] } } }, 'b', { command: '/opt/kiro', args: ['acp'] }, { platform: 'linux' }).providers.b)
  assert.equal(duplicateOf({ a: { command: '/x/kiro-cli', args: ['acp'] } }, { command: '/x/kiro-cli', args: ['acp'] }, undefined, 'linux'), 'a')
})

t('win32 scan: each configured provider matches one candidate, exact launch first', async () => {
  const npm = join(root, 'npm')
  const nodeDir = join(root, 'winnode')
  const script = join(npm, 'node_modules', '@x', 'cb', 'bin', 'codebuddy')
  writeFileSync(join(npm, 'codebuddy-code.cmd'), readFileSync(join(npm, 'codebuddy.cmd')))
  const node = join(nodeDir, 'node.exe')
  // Two providers on one script, distinguished by env, with ids that do not follow the recipes.
  const providers = new Map([
    ['cn', { id: 'cn', command: node, args: [script, '--acp'], env: { CODEBUDDY_INTERNET_ENVIRONMENT: 'internal' } }],
    ['intl', { id: 'intl', command: node, args: [script, '--acp'], env: { CODEBUDDY_INTERNET_ENVIRONMENT: 'external' } }],
  ])
  const r = await scan({ providers, env: { Path: `${npm};${nodeDir}` }, home: root, loginPath: [], commonDirs: [], versions: false, platform: 'win32' })
  const by = Object.fromEntries(r.candidates.map((c) => [c.bin, c]))
  assert.equal(by.codebuddy.configuredAs, 'cn')
  assert.equal(by['codebuddy-code'].configuredAs, 'intl')
  // Only one provider configured ⇒ the other recipe is still addable, not shown as the same provider twice.
  const one = await scan({ providers: new Map([['cn', providers.get('cn')]]), env: { Path: `${npm};${nodeDir}` }, home: root, loginPath: [], commonDirs: [], versions: false, platform: 'win32' })
  const ob = Object.fromEntries(one.candidates.map((c) => [c.bin, c]))
  assert.equal(ob.codebuddy.configuredAs, 'cn')
  assert.equal(ob['codebuddy-code'].configuredAs, undefined)
})

t('launchPrefix / cliNameOf: node.exe <script> is the script', () => {
  const p = { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\npm\\node_modules\\x\\bin\\kiro-cli', 'acp'] }
  assert.deepEqual(launchPrefix(p), ['C:\\npm\\node_modules\\x\\bin\\kiro-cli'])
  assert.equal(cliNameOf(p), 'kiro-cli')
  assert.equal(cliNameOf({ command: 'C:\\bin\\kiro-cli.exe', args: ['acp'] }), 'kiro-cli')
  assert.deepEqual(launchPrefix({ command: '/usr/bin/kiro-cli', args: ['acp'] }), [])
  assert.deepEqual(launchPrefix({ command: '/usr/bin/node', args: ['--inspect'] }), [])
})

t('suggestSpec: approvals none ⇒ permission allow', () => {
  const s = suggestSpec(RECIPES.find((x) => x.bin === 'pi-acp'), { path: '/x/pi-acp', dir: '/x' })
  assert.equal(s.approvals, 'none')
  assert.equal(s.permission, 'allow')
})

posix('scan finds executables only, marks configured, suggests free ids', async () => {
  const providers = new Map([['kiro', { id: 'kiro', command: join(bin, 'kiro-cli') }], ['qoder', { id: 'qoder', command: '/elsewhere/other' }]])
  const r = await scan({ providers, env: { PATH: '' }, home: root, loginPath: [bin, nodeDir], commonDirs: [], versions: false })
  const by = Object.fromEntries(r.candidates.map((c) => [c.bin, c]))
  assert.ok(by['kiro-cli'] && by.deveco && by.qodercli)
  assert.equal(by.codebuddy, undefined, 'non-executable file must be ignored')
  assert.equal(by['kiro-cli'].configuredAs, 'kiro')
  assert.equal(by.qodercli.configuredAs, undefined)
  assert.equal(by.qodercli.id, 'qoder-2', 'id taken by another provider ⇒ suffixed')
  assert.equal(by.deveco.interpreter, 'node')
  assert.equal(by.deveco.interpreterDir, nodeDir)
  assert.ok(by.deveco.spec.env.PATH.startsWith(nodeDir))
  assert.equal(by.deveco.inDshPath, false)
})

posix('scan: node script without node ⇒ warning', async () => {
  const r = await scan({ env: { PATH: '' }, home: root, loginPath: [bin], commonDirs: [], versions: false })
  const d = r.candidates.find((c) => c.bin === 'deveco')
  assert.match(d.warning, /node/)
})

posix('scan: versions read from --version', async () => {
  const r = await scan({ env: { PATH: `${nodeDir}:/usr/bin:/bin` }, home: root, loginPath: [bin], commonDirs: [], versions: true })
  assert.equal(r.candidates.find((c) => c.bin === 'qodercli').version, '1.1.90')
})

t('probe: models extension', async () => {
  const r = await probe(fakeSpec('models'), { timeoutMs: 15_000 })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.modelSource, 'models')
  assert.deepEqual(r.models.map((m) => m.id), ['m1', 'm2'])
  assert.equal(r.loadSession, true)
  assert.equal(r.image, true)
  assert.deepEqual(r.modes, ['default', 'acceptEdits'])
})

t('probe: model configOption with slash ids', async () => {
  const r = await probe(fakeSpec('config'), { timeoutMs: 15_000 })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.modelSource, 'configOption')
  assert.deepEqual(r.models.map((m) => m.id), ['a/x', 'a/y'])
  assert.equal(r.currentModel, 'a/x')
  assert.equal(recommendModelVia(undefined, r), 'configOption')
})

t('probe: auth failure ⇒ ok false with login hint', async () => {
  const r = await probe(fakeSpec('auth'), { timeoutMs: 15_000 })
  assert.equal(r.ok, false)
  assert.match(r.hint ?? '', /登录/)
})

t('probe: missing command ⇒ ACP_SPAWN', async () => {
  const r = await probe({ command: join(root, 'nope'), args: [] }, { timeoutMs: 5000 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'ACP_SPAWN')
})

t('recommendModelVia: recipe wins, else probe, else args', () => {
  assert.equal(recommendModelVia('args', { ok: true, modelSource: 'configOption' }), 'args')
  assert.equal(recommendModelVia(undefined, { ok: true, modelSource: 'models' }), 'args')
  assert.equal(recommendModelVia(undefined, { ok: false }), 'args')
})

posix('sanitizeSpec: absolute executable only, unknown keys dropped', () => {
  const s = sanitizeSpec({ command: join(bin, 'kiro-cli'), args: ['acp'], modelVia: 'configOption', permission: 'allow', evil: 1, env: {} })
  assert.equal(s.evil, undefined)
  assert.equal(s.env, undefined)
  assert.throws(() => sanitizeSpec({ command: 'kiro-cli' }), /绝对路径/)
  assert.throws(() => sanitizeSpec({ command: join(bin, 'codebuddy') }), /可执行/)
  assert.throws(() => sanitizeSpec({ command: join(bin, 'kiro-cli'), permission: 'yes' }), /permission/)
})

t('addProvider / removeProvider keep other providers and validate', () => {
  const cur = { providers: { kiro: { command: '/a/kiro-cli', args: ['acp'] } }, stateFile: '/tmp/s.json' }
  const next = addProvider(cur, 'qoder', { command: '/a/qodercli', args: ['--acp'] })
  assert.deepEqual(Object.keys(next.providers), ['kiro', 'qoder'])
  assert.equal(next.stateFile, '/tmp/s.json')
  assert.equal(cur.providers.qoder, undefined, 'input not mutated')
  assert.throws(() => addProvider(next, 'qoder', { command: '/a/x' }), /已经存在/)
  assert.equal(addProvider(next, 'qoder', { command: '/a/y' }, { overwrite: true }).providers.qoder.command, '/a/y')
  assert.throws(() => addProvider(cur, 'bad id', { command: '/a/x' }), /不合法/)
  assert.throws(() => addProvider(cur, 'x', { command: '' }), /command/)
  assert.deepEqual(Object.keys(removeProvider(next, 'kiro').providers), ['qoder'])
  assert.throws(() => removeProvider(cur, 'zzz'), /不在配置里/)
  assert.deepEqual(addProvider(undefined, 'k', { command: '/a/k' }).providers, { k: { command: '/a/k' } })
})

let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`) } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e?.stack?.split('\n').slice(0, 3).join('\n     ')}`) }
}
rmSync(root, { recursive: true, force: true })
console.log(`\n${tests.length - failed}/${tests.length} passed`)
process.exit(failed ? 1 : 0)
