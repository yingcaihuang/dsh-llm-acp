// client.js carries CLIENT_VERSION so the console can tell a stale host half (DSH not fully
// restarted after an update) from a fresh one. It must always equal package.json "version".
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const m = client.match(/const CLIENT_VERSION = '([^']+)'/)
let failed = 0
try {
  assert.ok(m, 'client.js declares CLIENT_VERSION')
  assert.equal(m[1], pkg.version, 'CLIENT_VERSION in client.js must equal package.json version (bump both on release)')
  console.log(`ok   CLIENT_VERSION ${m[1]} = package.json ${pkg.version}`)
} catch (e) { failed++; console.log(`FAIL ${e.message}`) }
console.log(`\nversion-sync: ${1 - failed}/1 passed`)
process.exit(failed ? 1 : 0)
