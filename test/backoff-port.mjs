// test/backoff-port.mjs — background-start backoff ported from upstream guozi058/dsh-llm-acp 0.4.27
// (660af30): a logged-out CLI (AUTH) is not started again every minute; other failures double the
// window from modelDiscoveryBackoffMs up to modelDiscoveryMaxBackoffMs; refreshCatalog (the
// console's 「刷新」) still retries at once, and a working discovery lifts the wait.
// A fake ACP agent counts its own starts; its mode is read from a file on every start.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backoffFor, createAcpAdapter, isLongFailure, nextFailure } from '../lib/adapter.js'
import { resolveProviders } from '../lib/config.js'

let failed = 0
let passed = 0
const ok = (cond, msg, detail) => {
  if (cond) { passed++; console.log(`ok   - ${msg}`) }
  else { failed++; console.log(`FAIL - ${msg}${detail === undefined ? '' : `\n       ↳ ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── pure: backoffFor / isLongFailure ─────────────────────────────────────────────────────────
{
  const p = { command: '/x/codebuddy', modelDiscoveryBackoffMs: 60_000, modelDiscoveryMaxBackoffMs: 1_800_000 }
  ok(backoffFor(p, undefined) === 0, 'P-1 no failure ⇒ 0')
  ok(backoffFor(p, { code: 'TRANSPORT', count: 1 }) === 60_000, 'P-2 first failure ⇒ base')
  ok(backoffFor(p, { code: 'TRANSPORT', count: 2 }) === 120_000, 'P-3 second ⇒ doubled')
  ok(backoffFor(p, { code: 'TRANSPORT', count: 4 }) === 480_000, 'P-4 fourth ⇒ 8× base')
  ok(backoffFor(p, { code: 'TRANSPORT', count: 99 }) === 1_800_000, 'P-5 capped at max')
  ok(backoffFor(p, { code: 'AUTH', count: 1 }) === 1_800_000, 'P-6 AUTH ⇒ max at once')
  ok(backoffFor(p, { code: 'TIMEOUT', count: 1 }) === 60_000, 'P-7 TIMEOUT of a normal CLI ⇒ base')
  const kiro = { ...p, command: '/Users/x/.local/bin/kiro-cli' }
  ok(isLongFailure(kiro, { code: 'TIMEOUT' }) && backoffFor(kiro, { code: 'TIMEOUT', count: 1 }) === 1_800_000, 'P-8 kiro-cli startup TIMEOUT ⇒ treated as logged out')
  ok(backoffFor({ ...p, modelDiscoveryBackoffMs: 0 }, { code: 'AUTH', count: 3 }) === 0, 'P-9 base 0 keeps meaning "no backoff"')
  ok(backoffFor({ ...p, modelDiscoveryMaxBackoffMs: 1000 }, { code: 'AUTH' }) === 60_000, 'P-10 max below base ⇒ base')
  const f1 = nextFailure(undefined, { code: 'AUTH' }); const f2 = nextFailure(f1, new Error('x'))
  ok(f1.count === 1 && f1.code === 'AUTH' && f2.count === 2 && f2.code === undefined && Number.isFinite(f2.at), 'P-11 nextFailure counts in a row')
  ok(resolveProviders({ providers: { a: { command: '/x' } } }).get('a').modelDiscoveryMaxBackoffMs === 1_800_000, 'P-12 config default 30 min')
  let threw = false; try { resolveProviders({ providers: { a: { command: '/x', modelDiscoveryMaxBackoffMs: 0 } } }) } catch { threw = true }
  ok(threw, 'P-13 modelDiscoveryMaxBackoffMs must be positive')
}

// ── through the adapter, with a real child process ───────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'llm-acp-backoff-'))
const agent = join(root, 'fake-agent.mjs')
writeFileSync(agent, `
import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
appendFileSync(process.env.COUNT_FILE, 'start\\n')
const mode = readFileSync(process.env.MODE_FILE, 'utf8').trim()
const rl = createInterface({ input: process.stdin })
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line) } catch { return }
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: 'login', name: 'Login' }] } })
  else if (m.method === 'session/new') {
    if (mode === 'auth') return send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'something went wrong' } })
    if (mode === 'fail') return send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'backend exploded' } })
    send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 's1', models: { currentModelId: 'm1', availableModels: [{ modelId: 'm1', name: 'M1' }, { modelId: 'm2', name: 'M2' }] } } })
  } else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} })
})
rl.on('close', () => process.exit(0))
`)

let seq = 0
function setup(mode, extra = {}) {
  const n = ++seq
  const modeFile = join(root, `mode-${n}`)
  const countFile = join(root, `count-${n}`)
  writeFileSync(modeFile, mode)
  writeFileSync(countFile, '')
  const providers = resolveProviders({ providers: { fake: {
    command: process.execPath, args: [agent], env: { MODE_FILE: modeFile, COUNT_FILE: countFile },
    startupTimeoutMs: 8000, disposeGraceMs: 300, startupRetries: 0,
    ...extra,
  } } })
  const adapter = createAcpAdapter({
    Base: class {},
    providers: () => providers,
    resolveCwd: async () => root,
    stateFile: join(root, `sessions-${n}.json`),
    logger: { info() {}, warn() {}, error() {} },
  })
  return {
    adapter,
    starts: () => (existsSync(countFile) ? readFileSync(countFile, 'utf8').split('\n').filter(Boolean).length : 0),
    setMode: (m) => writeFileSync(modeFile, m),
  }
}

// A-1 logged out (-32000 + authMethods ⇒ AUTH): one start, then the long wait.
{
  const { adapter, starts } = setup('auth')
  const l1 = await adapter.catalog('fake')
  const l2 = await adapter.catalog('fake')
  const l3 = await adapter.listModels('fake')
  ok(l1.length === 1 && l1[0].id === 'default' && l2.length === 1, 'A-1 logged-out CLI ⇒ catalog keeps the default entry')
  ok(l3.length === 0, 'A-1 logged-out CLI ⇒ listModels hides the group from the picker', l3)
  ok(starts() === 1, 'A-1 three catalog reads ⇒ the CLI started once', starts())
  const rt = adapter.runtime('fake')
  ok(rt.discovery?.ok === false && rt.discovery?.code === 'AUTH', 'A-1 discovery recorded as AUTH', rt.discovery)
  ok(rt.backoff?.long === true && rt.backoff.until - Date.now() > 29 * 60_000, 'A-1 runtime shows a ~30 min logged-out backoff', rt.backoff)
  ok(rt.discovery?.backoffMs === 1_800_000, 'A-1 discovery carries the window', rt.discovery)
  // The console's 「刷新」 always asks again.
  await adapter.refreshCatalog('fake')
  ok(starts() === 2, 'A-2 refreshCatalog bypasses the backoff', starts())
  await adapter.dispose()
}

// A-3 other failures double the window: base 80 ms ⇒ 80, 160, 320 …
{
  const { adapter, starts } = setup('fail', { modelDiscoveryBackoffMs: 80, modelDiscoveryMaxBackoffMs: 10_000 })
  await adapter.catalog('fake')
  ok(adapter.runtime('fake').discovery?.backoffMs === 80 && adapter.runtime('fake').backoff?.long === false, 'A-3 first failure ⇒ base window, not the long one', adapter.runtime('fake').discovery)
  await adapter.catalog('fake')
  ok(starts() === 1, 'A-3 inside the window ⇒ no second start', starts())
  await sleep(120)
  await adapter.catalog('fake')
  ok(starts() === 2 && adapter.runtime('fake').discovery?.backoffMs === 160, 'A-4 after it ⇒ one start, window doubled', { starts: starts(), d: adapter.runtime('fake').discovery })
  await sleep(100)
  await adapter.catalog('fake')
  ok(starts() === 2, 'A-4 100 ms < 160 ms ⇒ still waiting', starts())
  await sleep(120)
  await adapter.catalog('fake')
  ok(starts() === 3 && adapter.runtime('fake').discovery?.backoffMs === 320, 'A-5 third failure ⇒ 320 ms', { starts: starts(), d: adapter.runtime('fake').discovery })
  await adapter.dispose()
}

// A-6 a working discovery lifts the wait and the failure count starts over.
{
  const { adapter, starts, setMode } = setup('fail', { modelDiscoveryBackoffMs: 60, modelDiscoveryMaxBackoffMs: 10_000 })
  await adapter.catalog('fake')
  await sleep(80)
  await adapter.catalog('fake') // 2nd failure ⇒ 120 ms
  setMode('models')
  await sleep(140)
  const list = await adapter.catalog('fake')
  ok(list.length === 3 && list.some((m) => m.id === 'm2'), 'A-6 logged in again ⇒ the real catalog', list.map((m) => m.id))
  ok(adapter.runtime('fake').backoff === undefined && adapter.runtime('fake').discovery?.ok === true, 'A-6 no backoff after a good discovery', adapter.runtime('fake'))
  const before = starts()
  await adapter.catalog('fake')
  ok(starts() === before, 'A-6 good catalog is cached (modelCacheMs)', starts())
  setMode('fail')
  await adapter.refreshCatalog('fake')
  ok(adapter.runtime('fake').discovery?.backoffMs === 60, 'A-7 the next failure counts from 1 again', adapter.runtime('fake').discovery)
  await adapter.dispose()
}

// A-8 modelDiscoveryBackoffMs: 0 ⇒ every read asks again (old meaning kept).
{
  const { adapter, starts } = setup('auth', { modelDiscoveryBackoffMs: 0 })
  await adapter.catalog('fake'); await adapter.catalog('fake')
  ok(starts() === 2 && adapter.runtime('fake').backoff === undefined, 'A-8 base 0 ⇒ no backoff at all', starts())
  await adapter.dispose()
}

rmSync(root, { recursive: true, force: true })
console.log(`\nbackoff-port: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
