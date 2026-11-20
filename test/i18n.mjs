// UI language in client.js: tr() / zhEn() follow langStore, untranslated text stays Chinese,
// and every dictionary key is a literal the code actually uses (catches typos and dead entries).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const stubReact = new Proxy({
  createElement: () => null, Fragment: 'frag', Component: class {},
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useEffect: () => {}, useCallback: (f) => f, useRef: (v) => ({ current: v }), useMemo: (f) => f(),
}, { get: (t, k) => (k in t ? t[k] : () => undefined) })

function load() {
  const mem = {}
  const store = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v) }, removeItem: (k) => { delete mem[k] } }
  let plugin
  globalThis.window = { __ModuleLoader__: { load: (m) => { plugin = m.factory((n) => (n === 'react' ? stubReact : {})) } }, localStorage: store }
  globalThis.localStorage = store
  new Function('window', SRC)(globalThis.window)
  return plugin?.default ?? plugin
}

const tests = []
const t = (name, fn) => tests.push([name, fn])

t('Chinese by default; English after the switch; unknown text unchanged', () => {
  const p = load()
  assert.equal(p.langStore.get(), 'zh')
  assert.equal(p.tr('刷新'), '刷新')
  p.langStore.set('en')
  assert.equal(p.tr('刷新'), 'Refresh')
  assert.equal(p.tr('没有收进词典的文案'), '没有收进词典的文案')
  assert.equal(p.tr(''), '')
})

t('zhEn follows the language', () => {
  const p = load()
  assert.equal(p.zhEn('中', 'en'), '中')
  p.langStore.set('en')
  assert.equal(p.zhEn('中', 'en'), 'en')
})

t('dictionary values are non-empty strings', () => {
  const p = load()
  for (const [k, v] of Object.entries(p.EN)) assert.ok(typeof v === 'string' && v.trim() !== '', k)
})

t('every dictionary key is a literal used by the code', () => {
  const p = load()
  const code = SRC.split('\n').filter((l) => !l.includes('const EN = Object.freeze(')).join('\n')
  const unused = Object.keys(p.EN).filter((k) => !code.includes(`'${k}'`))
  assert.deepEqual(unused, [])
})

let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`) } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e?.message}`) }
}
console.log(`\ni18n: ${tests.length - failed}/${tests.length} passed`)
process.exit(failed ? 1 : 0)
