// Newest published version of this plugin, for the console's version badge and update reminder.
// Asked on the host (not in the browser) so a page origin or proxy never decides whether the check
// works. npm first, npmmirror only when npm cannot be reached; answers are cached.
import { realpathSync } from 'node:fs'
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PKG_NAME = 'dsh-llm-acp'
export const REGISTRIES = Object.freeze(['https://registry.npmjs.org/', 'https://registry.npmmirror.com/'])
export const LATEST_OK_TTL_MS = 30 * 60_000
export const LATEST_FAIL_TTL_MS = 5 * 60_000
const TIMEOUT_MS = 6_000

/** `releaseNotes` of a manifest: up to 8 non-empty strings of at most 200 characters; anything else → []. */
export function cleanNotes(v) {
  if (!Array.isArray(v)) return []
  return v.filter((s) => typeof s === 'string' && s.trim() !== '').slice(0, 8).map((s) => s.trim().slice(0, 200))
}

/** `1.2.3` / `v1.2.3-rc.1` → { n: [1, 2, 3], pre: 'rc.1' }; anything else → null. */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v ?? '').trim())
  return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' } : null
}

/** > 0 when `a` is newer than `b`, < 0 when older, 0 when equal or unparsable. A prerelease sorts before its release. */
export function compareVersions(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] > y.n[i] ? 1 : -1
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre > y.pre ? 1 : -1
}

/**
 * How this copy was installed: 'registry' when its real path lies inside a node_modules tree (npm /
 * market install, whose detail page offers「更新到 x」), 'link' for a `link:` / local checkout (no
 * update button: git pull instead), 'unknown' when the path cannot be read.
 */
export function installKind(dir = fileURLToPath(new URL('..', import.meta.url))) {
  try { return realpathSync(dir).split(sep).includes('node_modules') ? 'registry' : 'link' } catch { return 'unknown' }
}

/**
 * A cached checker: `check({ force })` → { at, latest, registry } or { at, latest: null, error }.
 * Concurrent calls share one request; force skips the cache.
 */
export function createLatestChecker({ fetchImpl = globalThis.fetch, now = () => Date.now(), registries = REGISTRIES, name = PKG_NAME, timeoutMs = TIMEOUT_MS } = {}) {
  let cache = null
  let inflight = null
  const ask = async (reg) => {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    t.unref?.()
    try {
      const r = await fetchImpl(`${reg}${name}/latest`, { headers: { accept: 'application/json' }, signal: ctl.signal })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = await r.json()
      if (!parseVersion(j?.version)) throw new Error('no version in the registry answer')
      return { version: j.version, notes: cleanNotes(j.releaseNotes) }
    } finally { clearTimeout(t) }
  }
  return function check({ force = false } = {}) {
    if (!force && cache && now() - cache.at < (cache.latest ? LATEST_OK_TTL_MS : LATEST_FAIL_TTL_MS)) return Promise.resolve(cache)
    if (inflight) return inflight
    inflight = (async () => {
      let lastError = ''
      for (const reg of registries) {
        try {
          const { version: latest, notes } = await ask(reg)
          return (cache = { at: now(), latest, notes, registry: reg })
        } catch (e) {
          let host = reg
          try { host = new URL(reg).host } catch { /* keep the raw value */ }
          lastError = `${host}: ${e?.name === 'AbortError' ? 'timeout' : e?.message ?? e}`
        }
      }
      return (cache = { at: now(), latest: null, error: lastError })
    })().finally(() => { inflight = null })
    return inflight
  }
}
