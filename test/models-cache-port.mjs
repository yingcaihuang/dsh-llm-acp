// test/models-cache-port.mjs — model list cache ported from upstream guozi058/dsh-llm-acp
// (lib/models-store.js + catalog stale-while-refresh). A fake ACP agent counts its own starts and
// reads its mode (models | models2 | fail | auth) from a file on every start.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAcpAdapter } from '../lib/adapter.js'
import { resolveProviders } from '../lib/config.js'
import { createModelsStore } from '../lib/models-store.js'

let failed = 0
let passed = 0
const ok = (cond, msg, detail) => {
  if (cond) { passed++; console.log(`ok   - ${msg}`) }
  else { failed++; console.log(`FAIL - ${msg}${detail === undefined ? '' : `\n       ↳ ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ids = (list) => list.map((m) => m.id).join(',')

const root = mkdtempSync(join(tmpdir(), 'llm-acp-mcache-'))
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
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } }, authMethods: [{ id: 'login', name: 'Login' }] } })
  else if (m.method === 'session/new') {
    if (mode === 'auth') return send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'login first' } })
    if (mode === 'fail') return send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'backend exploded' } })
    const list = mode === 'models2' ? [{ modelId: 'm3', name: 'M3' }] : [{ modelId: 'm1', name: 'M1', description: 'x0.5 credits' }, { modelId: 'm2', name: 'M2' }]
    send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 's1', models: { currentModelId: list[0].modelId, availableModels: list } } })
  } else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} })
})
rl.on('close', () => process.exit(0))
`)

let seq = 0
function world(mode) {
  const n = ++seq
  const files = { mode: join(root, `mode-${n}`), count: join(root, `count-${n}`), models: join(root, `models-${n}.json`) }
  writeFileSync(files.mode, mode)
  writeFileSync(files.count, '')
  const make = (extra = {}, modelsFile = files.models) => {
    const providers = resolveProviders({ providers: { fake: {
      command: process.execPath, args: [agent], env: { MODE_FILE: files.mode, COUNT_FILE: files.count },
      startupTimeoutMs: 8000, disposeGraceMs: 300, startupRetries: 0, ...extra,
    } } })
    return createAcpAdapter({
      Base: class {}, providers: () => providers, resolveCwd: async () => root,
      stateFile: join(root, `sessions-${n}.json`), modelsFile,
      logger: { info() {}, warn() {}, error() {} },
    })
  }
  return {
    files, make,
    starts: () => readFileSync(files.count, 'utf8').split('\n').filter(Boolean).length,
    setMode: (m) => writeFileSync(files.mode, m),
  }
}

// M-1 a good discovery is written to disk (0600, no env / argv) and survives a restart.
{
  const w = world('models')
  const a1 = w.make()
  const l1 = await a1.catalog('fake')
  ok(ids(l1) === 'default,m1,m2', 'M-1 first catalog comes from the CLI', ids(l1))
  ok(l1.find((m) => m.id === 'm1')?.name.includes('0.5x'), 'M-1 rate shown in the name', l1)
  await a1.dispose()
  ok(existsSync(w.files.models), 'M-1 cache file written on dispose')
  const text = readFileSync(w.files.models, 'utf8')
  ok((statSync(w.files.models).mode & 0o777) === 0o600, 'M-1 cache file is 0600', (statSync(w.files.models).mode & 0o777).toString(8))
  ok(!text.includes('MODE_FILE') && !text.includes(agent) && !text.includes('0.5x'), 'M-1 only raw model metadata on disk (no env, argv, rendered names)', text)
  ok(JSON.parse(text).entries.fake.image === true, 'M-1 image capability stored')
  const a2 = w.make()
  const before = w.starts()
  const l2 = await a2.catalog('fake')
  ok(ids(l2) === 'default,m1,m2' && w.starts() === before, 'M-2 after a restart the list comes from disk, no CLI start', { list: ids(l2), starts: w.starts() - before })
  ok(l2.find((m) => m.id === 'm1')?.name.includes('0.5x'), 'M-2 disk list is rendered the same way')
  await a2.dispose()
}

// M-3 stale: the old list is served at once and one background discovery refreshes it.
{
  const w = world('models')
  const a = w.make({ modelCacheMs: 60 })
  await a.catalog('fake')
  w.setMode('models2')
  await sleep(90)
  const t0 = Date.now()
  const stale = await a.catalog('fake')
  const again = await a.catalog('fake') // joins the same flight: no second start
  ok(ids(stale) === 'default,m1,m2' && ids(again) === 'default,m1,m2', 'M-3 stale list served immediately', ids(stale))
  ok(Date.now() - t0 < 300, 'M-3 the stale answer does not wait for the CLI', Date.now() - t0)
  await sleep(600)
  ok(w.starts() === 2, 'M-3 exactly one background refresh', w.starts())
  const fresh = await a.catalog('fake')
  ok(ids(fresh) === 'default,m3', 'M-3 refreshed list served next', ids(fresh))
  await a.dispose()
}

// M-4 a failed refresh keeps the last good list (it used to fall back to "default" only).
{
  const w = world('models')
  const a = w.make({ modelCacheMs: 50, modelDiscoveryBackoffMs: 10_000 })
  await a.catalog('fake')
  w.setMode('fail')
  await sleep(70)
  await a.catalog('fake'); await sleep(500)
  const l = await a.catalog('fake')
  ok(ids(l) === 'default,m1,m2', 'M-4 failed refresh ⇒ old list kept', ids(l))
  ok(a.runtime('fake').discovery?.ok === false && a.runtime('fake').backoff !== undefined, 'M-4 failure + backoff recorded', a.runtime('fake'))
  ok((await a.listModels('fake')).length === 0, 'M-4 failed refresh ⇒ listModels hides the group from the picker')
  // M-5 logged out with a disk copy: the list is still served.
  w.setMode('auth')
  await a.refreshCatalog('fake')
  const l2 = await a.catalog('fake')
  ok(ids(l2) === 'default,m1,m2' && a.runtime('fake').backoff?.long === true, 'M-5 logged out ⇒ list kept, long backoff', { list: ids(l2), b: a.runtime('fake').backoff })
  ok((await a.listModels('fake')).length === 0, 'M-5 logged out ⇒ listModels hides the group from the picker')
  // M-5b recovery: a working CLI comes straight back to the picker.
  w.setMode('models2')
  await a.refreshCatalog('fake')
  ok((await a.listModels('fake')).length > 0, 'M-5b recovered CLI ⇒ listModels shows the group again')
  await a.dispose()
}

// M-6 a changed profile (env) never gets the old CLI's catalog.
{
  const w = world('models')
  const a1 = w.make(); await a1.catalog('fake'); await a1.dispose()
  w.setMode('models2')
  const a2 = w.make({ env: { MODE_FILE: w.files.mode, COUNT_FILE: w.files.count, EXTRA: '1' } })
  const l = await a2.catalog('fake')
  ok(ids(l) === 'default,m3' && w.starts() === 2, 'M-6 fingerprint mismatch ⇒ fresh discovery', { list: ids(l), starts: w.starts() })
  await a2.dispose()
}

// M-7 refreshCatalog (console 「刷新」) ignores a fresh cache; M-8 modelsFile '' ⇒ memory only.
{
  const w = world('models')
  const a = w.make()
  await a.catalog('fake')
  w.setMode('models2')
  const l = await a.refreshCatalog('fake')
  ok(ids(l) === 'default,m3' && w.starts() === 2, 'M-7 refresh asks the CLI even with a fresh cache', { list: ids(l), starts: w.starts() })
  await a.dispose()
  const w2 = world('models')
  const b = w2.make({}, '')
  await b.catalog('fake'); await b.dispose()
  ok(!existsSync(w2.files.models), 'M-8 modelsFile "" ⇒ no file')
}

// M-10 onModelsChanged announces only a changed advertised list (first load, models changed,
// failure, recovery); an unchanged refresh stays silent.
{
  const w = world('models')
  const events = []
  const providers = resolveProviders({ providers: { fake: {
    command: process.execPath, args: [agent], env: { MODE_FILE: w.files.mode, COUNT_FILE: w.files.count },
    startupTimeoutMs: 8000, disposeGraceMs: 300, startupRetries: 0, modelCacheMs: 60,
  } } })
  const a = createAcpAdapter({
    Base: class {}, providers: () => providers, resolveCwd: async () => root,
    stateFile: join(root, 'sessions-m10.json'), modelsFile: w.files.models,
    logger: { info() {}, warn() {}, error() {} },
    onModelsChanged: (id) => events.push(id),
  })
  await a.catalog('fake')
  ok(events.join() === 'fake', 'M-10 first discovery announces the list', events)
  await sleep(120); await a.catalog('fake'); await sleep(300)
  ok(events.length === 1, 'M-10 unchanged refresh ⇒ no extra announce', events)
  w.setMode('models2')
  await sleep(120); await a.catalog('fake'); await sleep(300)
  ok(events.length === 2, 'M-10 changed models ⇒ one announce', events)
  w.setMode('fail')
  await sleep(120); await a.catalog('fake'); await sleep(300)
  ok(events.length === 3, 'M-10 failed discovery ⇒ one announce', events)
  w.setMode('models')
  await a.refreshCatalog('fake')
  ok(events.length === 4, 'M-10 recovery via refreshCatalog ⇒ one announce', events)
  await a.dispose()
}

// M-9 the store rejects malformed files and junk entries (upstream validation kept).
{
  const f = join(root, 'bad.json')
  const warns = []
  writeFileSync(f, '{not json')
  ok(createModelsStore({ file: f, warn: (e, x) => warns.push(x) }).get('a', 'sha256:' + '0'.repeat(64)) === undefined && warns.length === 1, 'M-9 broken JSON ⇒ empty store + one warning')
  writeFileSync(f, JSON.stringify({ version: 1, entries: { a: { fp: 'sha256:' + '1'.repeat(64), at: Date.now(), list: [{ id: 'default' }, { id: 'x\u0007y', name: 'X' }, { id: 'x\u0007y' }, { nope: 1 }] }, b: { fp: 'md5', at: 1, list: [] } } }))
  const s = createModelsStore({ file: f })
  const a = s.get('a', 'sha256:' + '1'.repeat(64))
  ok(a?.list.length === 1 && a.list[0].id === 'xy', 'M-9 pseudo "default", duplicates, control chars dropped', a)
  ok(s.get('b', 'md5') === undefined, 'M-9 entry with a bad fingerprint ignored')
}

rmSync(root, { recursive: true, force: true })
console.log(`\nmodels-cache-port: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
