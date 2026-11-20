// test/credits-port.mjs — credit multipliers ported from upstream guozi058/dsh-llm-acp lib/credits.js
// (0.4.5 kiro-cli chat --list-models, 0.4.7 codebuddy _meta.credits). Fake CLIs are real executables
// named `codebuddy` / `kiro-cli` / `other` so command detection runs as in production.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAcpAdapter } from '../lib/adapter.js'
import { resolveProviders } from '../lib/config.js'
import { codebuddyCredits, isCodebuddyCommand, isKiroCommand, parseCredits } from '../lib/credits.js'

let failed = 0
let passed = 0
const ok = (cond, msg, detail) => {
  if (cond) { passed++; console.log(`ok   - ${msg}`) }
  else { failed++; console.log(`FAIL - ${msg}${detail === undefined ? '' : `\n       ↳ ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`) }
}
const names = (list) => Object.fromEntries(list.map((m) => [m.id, m.name]))

const root = mkdtempSync(join(tmpdir(), 'llm-acp-credits-'))
const body = `#!${process.execPath}
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const argv = process.argv.slice(2)
if (argv[0] === 'chat' && argv[1] === '--list-models') {
  appendFileSync(process.env.LIST_COUNT, 'list\\n')
  if (process.env.KIRO_LIST === 'fail') { process.stdout.write('boom'); process.exit(1) }
  process.stdout.write('\\x1b[1mModels\\x1b[0m\\n* gpt-5.6-terra       2.20x credits      OpenAI GPT\\n  claude-lite         0.05x credits      Anthropic\\n  garbage line\\n')
  process.exit(0)
}
const rl = createInterface({ input: process.stdin })
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
const list = JSON.parse(process.env.MODELS)
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line) } catch { return }
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } })
  else if (m.method === 'session/new') send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 's1', models: { currentModelId: list[0].modelId, availableModels: list } } })
  else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} })
})
rl.on('close', () => process.exit(0))
`
const bin = (name) => {
  const dir = join(root, `bin-${name}`)
  mkdirSync(dir, { recursive: true })
  const f = join(dir, name)
  writeFileSync(f, body)
  chmodSync(f, 0o755)
  return f
}
const CB = bin('codebuddy')
const KIRO = bin('kiro-cli')
const OTHER = bin('other')

const cbModels = [
  { modelId: 'hy4', name: 'Hy4 preview', description: 'x0.29 credits', _meta: { credits: 'x0.29 credits' } },
  { modelId: 'hy3', name: 'Hy3', _meta: { credits: 'x0' } },
  { modelId: 'k3', name: 'Kimi-K3', description: 'x1.62' },
  { modelId: 'custom', name: 'Custom', _meta: { credits: 'about x2' } },
]
const kiroModels = [{ modelId: 'gpt-5.6-terra', name: 'gpt-5.6-terra' }, { modelId: 'auto', name: 'Auto' }]

let seq = 0
function make(command, models, extra = {}, env = {}) {
  const n = ++seq
  const listCount = join(root, `list-${n}`)
  writeFileSync(listCount, '')
  const modelsFile = join(root, `models-${n}.json`)
  const build = () => {
    const providers = resolveProviders({ providers: { fake: {
      command, args: [], env: { MODELS: JSON.stringify(models), LIST_COUNT: listCount, ...env },
      startupTimeoutMs: 8000, disposeGraceMs: 300, startupRetries: 0, ...extra,
    } } })
    return createAcpAdapter({
      Base: class {}, providers: () => providers, resolveCwd: async () => root,
      stateFile: join(root, `sessions-${n}.json`), modelsFile,
      logger: { info() {}, warn() {}, error() {} },
    })
  }
  return { build, modelsFile, lists: () => readFileSync(listCount, 'utf8').split('\n').filter(Boolean).length }
}

// C-1 unit: detection and parsing (upstream behaviour kept).
ok(isCodebuddyCommand('/x/codebuddy') && isCodebuddyCommand('cbc') && !isCodebuddyCommand('/x/codebuddy-code'), 'C-1 codebuddy / cbc detected, codebuddy-code is not')
ok(isKiroCommand('/x/kiro-cli') && !isKiroCommand('/x/kiro'), 'C-1 kiro-cli detected, the IDE launcher kiro is not')
ok(isCodebuddyCommand('C:\\Program Files\\nodejs\\node.exe', ['C:\\npm\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy', '--acp'])
  && isKiroCommand('C:\\bin\\kiro-cli.exe') && !isCodebuddyCommand('C:\\Program Files\\nodejs\\node.exe', ['--acp']), 'C-1 Windows: node.exe <script> and .exe detected by CLI name')
{
  const m = parseCredits('\x1b[1mModels\x1b[0m\n* gpt-5.6-sol   4.40x credits  OpenAI\n  a  0.05x credits\nnoise')
  ok(m.get('gpt-5.6-sol') === '4.40' && m.get('a') === '0.05' && m.size === 2, 'C-1 parseCredits: ANSI stripped, default marker ignored, noise skipped', [...m])
  const c = codebuddyCredits(cbModels)
  ok(c.get('hy4') === '0.29x' && c.get('hy3') === '0x 免费' && c.get('k3') === '1.62x' && !c.has('custom'), 'C-1 codebuddyCredits: _meta first, description fallback, zero ⇒ 免费, junk skipped', [...c])
}

// C-2 codebuddy: rates from the handshake, one multiplier per name, no extra process.
{
  const w = make(CB, cbModels)
  const a = w.build()
  const cat = await a.catalog('fake')
  const n = names(cat)
  ok(n.hy4 === 'Hy4 preview · 0.29x', 'C-2 _meta.credits shown once (description has the same rate)', n.hy4)
  ok(n.hy3 === 'Hy3 · 0x 免费', 'C-2 zero multiplier ⇒ 0x 免费', n.hy3)
  ok(n.k3 === 'Kimi-K3 · 1.62x', 'C-2 description fallback', n.k3)
  ok(n.custom === 'Custom', 'C-2 no multiplier ⇒ name unchanged', n.custom)
  ok(cat.find((m) => m.id === 'hy3')?.rate === '0x 免费', 'C-2 console catalog carries rate')
  const picker = await a.listModels('fake')
  ok(picker.every((m) => !('rate' in m)) && names(picker).hy3 === 'Hy3 · 0x 免费', 'C-2 host picker gets names only, no rate field', picker)
  ok(w.lists() === 0, 'C-2 codebuddy never runs chat --list-models')
  await a.dispose()
  const disk = JSON.parse(readFileSync(w.modelsFile, 'utf8')).entries.fake.list
  ok(disk.find((m) => m.id === 'hy3')?.rate === '0x 免费' && disk.find((m) => m.id === 'hy3')?.name === 'Hy3', 'C-3 disk keeps raw name + rate', disk)
  const b = w.build()
  ok(names(await b.catalog('fake')).hy3 === 'Hy3 · 0x 免费', 'C-3 restart from disk renders the rate again')
  await b.dispose()
}

// C-4 rateInName false ⇒ names as the CLI reported them.
{
  const a = make(CB, cbModels, { rateInName: false }).build()
  const n = names(await a.catalog('fake'))
  ok(n.hy3 === 'Hy3' && n.hy4 === 'Hy4 preview', 'C-4 rateInName false ⇒ no suffix', n)
  await a.dispose()
}

// C-5 kiro-cli: one chat --list-models after the handshake; a failing command changes nothing.
{
  const w = make(KIRO, kiroModels)
  const a = w.build()
  const n = names(await a.catalog('fake'))
  ok(n['gpt-5.6-terra'] === 'gpt-5.6-terra · 2.20x' && n.auto === 'Auto', 'C-5 kiro multiplier appended from --list-models', n)
  ok(w.lists() === 1, 'C-5 --list-models asked exactly once', w.lists())
  await a.catalog('fake')
  ok(w.lists() === 1, 'C-5 cached catalog does not ask again', w.lists())
  await a.dispose()
  const f = make(KIRO, kiroModels, {}, { KIRO_LIST: 'fail' })
  const b = f.build()
  const cat = await b.catalog('fake')
  ok(names(cat)['gpt-5.6-terra'] === 'gpt-5.6-terra' && b.runtime('fake').discovery?.ok === true, 'C-6 failing --list-models ⇒ plain names, discovery still ok', { n: names(cat), d: b.runtime('fake').discovery })
  await b.dispose()
}

// C-7 any other CLI: no extra process; rate still read from the description (local behaviour).
{
  const w = make(OTHER, [{ modelId: 'g', name: 'GLM', description: 'Reasoning · 0.80x Credit' }, { modelId: 'h', name: 'H', _meta: { credits: 'x3' } }])
  const a = w.build()
  const n = names(await a.catalog('fake'))
  ok(n.g === 'GLM · 0.80x' && n.h === 'H' && w.lists() === 0, 'C-7 other CLI: description rate only, _meta ignored, no --list-models', { n, lists: w.lists() })
  await a.dispose()
}

rmSync(root, { recursive: true, force: true })
console.log(`\ncredits-port: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
