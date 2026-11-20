// Prompt-retry backoff (lib/adapter.js retryDelayFor) and the default retry count (lib/config.js).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { retryDelayFor } from '../lib/adapter.js'

const tests = []
const t = (name, fn) => tests.push([name, fn])

t('SERVER grows ×3 per attempt with ±10% jitter (2.2 s, 5.4 s, 19.8 s)', () => {
  assert.equal(retryDelayFor('SERVER', 0, '', 2000), 2200)
  assert.equal(retryDelayFor('SERVER', 1, '', 2000), 5400)
  assert.equal(retryDelayFor('SERVER', 2, '', 2000), 19800)
})

t('TRANSPORT / TIMEOUT use the same growing schedule, capped at 30 s', () => {
  for (const code of ['TRANSPORT', 'TIMEOUT']) {
    const d = [0, 1, 2].map((n) => retryDelayFor(code, n, '', 2000))
    assert.ok(d[0] < d[1] && d[1] < d[2], `${code} grows`)
  }
  assert.equal(retryDelayFor('SERVER', 5, '', 2000), 30_000)
})

t('Retry-After in the CLI text still wins', () => {
  assert.equal(retryDelayFor('SERVER', 0, 'upstream busy, retry after 7s', 2000), 7000)
})

t('RATE_LIMIT keeps exponential ×2 backoff', () => {
  assert.equal(retryDelayFor('RATE_LIMIT', 0, '', 2000), 2200)
  assert.equal(retryDelayFor('RATE_LIMIT', 1, '', 2000), 3600)
})

t('default promptRetries is 2', () => {
  const src = readFileSync(new URL('../lib/config.js', import.meta.url), 'utf8')
  assert.match(src, /promptRetries: 2,/)
})

let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`) } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e?.message}`) }
}
console.log(`\nretry-delay: ${tests.length - failed}/${tests.length} passed`)
process.exit(failed ? 1 : 0)
