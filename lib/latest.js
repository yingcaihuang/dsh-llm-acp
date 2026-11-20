// Newest published version of this plugin, for the console's version badge and update reminder.
// Asked on the host (not in the browser) so a page origin or proxy never decides whether the check
// works. npm and npmmirror are asked together: DSH's plugin manager installs from whichever registry
// answers its ping first (npmmirror in mainland China), and npmmirror trails npm for a few minutes
// after a release. Only a version every reachable registry already has is offered as the update, so
//「更新到 x」never fails on a mirror that has not synced yet.
import { realpathSync } from 'node:fs'
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PKG_NAME = 'dsh-llm-acp'
export const REGISTRIES = Object.freeze(['https://registry.npmjs.org/', 'https://registry.npmmirror.com/'])
export const LATEST_OK_TTL_MS = 30 * 60_000
export const LATEST_FAIL_TTL_MS = 5 * 60_000
/** While a registry lags behind, ask again soon so the reminder appears once the mirror has synced. */
export const LATEST_LAG_TTL_MS = 2 * 60_000
/** At most one「sync now」request to npmmirror per this window. */
export const MIRROR_SYNC_EVERY_MS = 10 * 60_000
const TIMEOUT_MS = 6_000

const hostOf = (reg) => { try { return new URL(reg).host } catch { return String(reg) } }
/** npmmirror's public endpoint that queues a sync of one package from npm. */
export const mirrorSyncUrl = (name) => `https://registry-direct.npmmirror.com/-/package/${name}/syncs`

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
 * A cached checker: `check({ force })` →
 *   { at, latest, notes, registry, newest, lagging } — latest = the newest version every answering
 *     registry has (safe to install), newest = the newest any registry has, lagging = hosts behind it;
 *   or { at, latest: null, newest: null, lagging: [], error } when no registry answered.
 * Concurrent calls share one round; force skips the cache.
 */
export function createLatestChecker({ fetchImpl = globalThis.fetch, now = () => Date.now(), registries = REGISTRIES, name = PKG_NAME, timeoutMs = TIMEOUT_MS, syncMirror = true } = {}) {
  let cache = null
  let inflight = null
  let lastSync = -Infinity
  const withTimeout = async (url, init) => {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    t.unref?.()
    try { return await fetchImpl(url, { ...init, signal: ctl.signal }) } finally { clearTimeout(t) }
  }
  const ask = async (reg) => {
    const r = await withTimeout(`${reg}${name}/latest`, { headers: { accept: 'application/json' } })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const j = await r.json()
    if (!parseVersion(j?.version)) throw new Error('no version in the registry answer')
    return { version: j.version, notes: cleanNotes(j.releaseNotes) }
  }
  // Fire and forget: the next check (LATEST_LAG_TTL_MS later) sees whether the mirror caught up.
  const nudgeMirror = () => {
    if (!syncMirror || now() - lastSync < MIRROR_SYNC_EVERY_MS) return
    lastSync = now()
    withTimeout(mirrorSyncUrl(name), { method: 'PUT' }).catch(() => {})
  }
  const ttl = (c) => (!c.latest ? LATEST_FAIL_TTL_MS : c.lagging.length ? LATEST_LAG_TTL_MS : LATEST_OK_TTL_MS)
  return function check({ force = false } = {}) {
    if (!force && cache && now() - cache.at < ttl(cache)) return Promise.resolve(cache)
    if (inflight) return inflight
    inflight = (async () => {
      const answers = await Promise.all(registries.map(async (reg) => {
        try { return { reg, ...(await ask(reg)) } }
        catch (e) { return { reg, error: `${hostOf(reg)}: ${e?.name === 'AbortError' ? 'timeout' : e?.message ?? e}` } }
      }))
      const ok = answers.filter((a) => a.version)
      if (ok.length === 0) return (cache = { at: now(), latest: null, newest: null, lagging: [], error: answers.map((a) => a.error).join('; ') })
      const sorted = [...ok].sort((a, b) => compareVersions(a.version, b.version))
      const low = sorted[0]
      const high = sorted[sorted.length - 1]
      const lagging = ok.filter((a) => compareVersions(a.version, high.version) < 0).map((a) => hostOf(a.reg))
      if (lagging.some((h) => h.includes('npmmirror'))) nudgeMirror()
      return (cache = { at: now(), latest: low.version, notes: low.notes, registry: low.reg, newest: high.version, lagging })
    })().finally(() => { inflight = null })
    return inflight
  }
}
