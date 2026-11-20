// Update-reminder state in client.js: the one-time「已升级到 vX」notice and skip / snooze.
// Loads the real client.js with a stub React (the state logic needs no rendering).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const CV = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const stubReact = new Proxy({
  createElement: () => null, Fragment: 'frag', Component: class {},
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useEffect: () => {}, useCallback: (f) => f, useRef: (v) => ({ current: v }), useMemo: (f) => f(),
}, { get: (t, k) => (k in t ? t[k] : () => undefined) })

/** Fresh plugin instance over a fake localStorage seeded with `seed`. */
function load(seed = {}) {
  const mem = { ...seed }
  const store = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v) }, removeItem: (k) => { delete mem[k] } }
  let plugin
  globalThis.window = { __ModuleLoader__: { load: (m) => { plugin = m.factory((n) => (n === 'react' ? stubReact : {})) } }, localStorage: store }
  globalThis.localStorage = store
  new Function('window', SRC)(globalThis.window)
  return { p: plugin?.default ?? plugin, mem }
}

const tests = []
const t = (name, fn) => tests.push([name, fn])

t('exports the state helpers', () => {
  const { p } = load()
  for (const k of ['initVer', 'verStore', 'saveVer', 'quietFor', 'VER_KEY', 'LS_KEY']) assert.ok(p[k] !== undefined, k)
})

t('first install (nothing stored): no upgrade notice, version recorded', () => {
  const { p, mem } = load()
  p.initVer()
  assert.equal(p.verStore.get().upgraded, null)
  assert.equal(JSON.parse(mem[p.VER_KEY]).seen, CV)
})

t('0.2.5-style upgrade (console prefs, no version record): notice without from', () => {
  const { p } = load({ 'dsh-llm-acp.console.v1': '{}' })
  p.initVer()
  assert.deepEqual(p.verStore.get().upgraded, { from: '', to: CV })
})

t('upgrade from a recorded older version: notice names it', () => {
  const { p } = load({ 'dsh-llm-acp.version-state': JSON.stringify({ seen: '0.0.1' }) })
  p.initVer()
  assert.deepEqual(p.verStore.get().upgraded, { from: '0.0.1', to: CV })
})

t('same version again: no notice; initVer runs once per load', () => {
  const { p } = load({ 'dsh-llm-acp.version-state': JSON.stringify({ seen: CV }) })
  p.initVer(); p.initVer()
  assert.equal(p.verStore.get().upgraded, null)
})

t('downgrade: no notice, record follows the running version', () => {
  const { p, mem } = load({ 'dsh-llm-acp.version-state': JSON.stringify({ seen: '99.0.0' }) })
  p.initVer()
  assert.equal(p.verStore.get().upgraded, null)
  assert.equal(JSON.parse(mem[p.VER_KEY]).seen, CV)
})

t('the notice is never persisted', () => {
  const { p, mem } = load({ 'dsh-llm-acp.console.v1': '{}' })
  p.initVer()
  p.saveVer({ skip: '9.9.9' })
  const kept = JSON.parse(mem[p.VER_KEY])
  assert.equal(kept.upgraded, undefined)
  assert.equal(kept.skip, '9.9.9')
})

t('quietFor: skip holds for that version only; snooze expires', () => {
  const { p } = load()
  assert.equal(p.quietFor({ skip: '0.3.0' }, '0.3.0'), true)
  assert.equal(p.quietFor({ skip: '0.3.0' }, '0.3.1'), false, 'the next version reminds again')
  assert.equal(p.quietFor({ snooze: { v: '0.3.0', until: Date.now() + 60_000 } }, '0.3.0'), true)
  assert.equal(p.quietFor({ snooze: { v: '0.3.0', until: Date.now() - 1 } }, '0.3.0'), false, 'snooze expired')
  assert.equal(p.quietFor({ snooze: { v: '0.3.0', until: Date.now() + 60_000 } }, '0.3.1'), false)
  assert.equal(p.quietFor({}, '0.3.0'), false)
})

let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`) } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e?.stack?.split('\n').slice(0, 3).join(' | ')}`) }
}
console.log(`\nversion-state: ${tests.length - failed}/${tests.length} passed`)
process.exit(failed ? 1 : 0)
