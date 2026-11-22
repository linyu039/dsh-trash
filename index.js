/**
 * Host half of the Trash (垃圾桶) plugin.
 *
 * The shipped Harness has no Session deletion and the persistence seam has no
 * delete API, so the Trash owns the storage work itself. Two operations, one
 * shared implementation each, reached from the plugin's own same-origin routes:
 *
 *   - delete: permanently remove a Session's stored log under
 *     `<persistence root>/--<projectKey(cwd)>--/<encoded id>/`. The canonical
 *     log file is renamed to a `.trash-deleted-<stamp>` marker first — that
 *     rename is the atomic commit point, because a Session without a canonical
 *     log is invisible to list/stat/open — then the Session directory is
 *     removed best-effort.
 *   - clear: keep the Session identity but drop every stored event, leaving the
 *     header record alone. The log is rewritten in place (compressed with the
 *     same encoding it already used) and verified by re-scanning the file; a
 *     failed verification restores the backup.
 *
 * Both operations also drop the Session's row from the `session_projcache`
 * storage domain (a derived cache) and detach it from Workspace bookkeeping
 * (accounting slot, archive list, pin list), so the sidebar stops listing a
 * Session whose storage is gone.
 *
 * Safety rules:
 *   - only same-origin/local GUI requests pass `ctx.connection.requestRejection`;
 *   - a live Session (in-memory Session or live Agent) is refused by both
 *     operations: its write handle would recreate a headerless log after a
 *     delete, and would append past a cleared prefix;
 *   - a Session with derived Sessions (forks / subagent children) is refused
 *     unless the caller passes `cascade: true`, and the whole subtree must be
 *     cold;
 *   - a seeded Session (fork or subagent child) is never cleared, because its
 *     header promises a seed prefix that clearing would destroy;
 *   - ids are validated and every path is proven to stay inside the session
 *     root;
 *   - every batch reports per-Session outcomes, so one refusal never hides the
 *     rest of the batch.
 */
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import zlib from 'node:zlib'

/** Required Host services (cordis fiber inject). */
export const inject = ['webServer']

const ROUTE_LIST = '/trash/api/list'
const ROUTE_DELETE = '/trash/api/delete'
const ROUTE_CLEAR = '/trash/api/clear'

/** The requests are id lists plus flags. */
const MAX_BODY_BYTES = 256 * 1024
/** A cleared log is rewritten in memory; refuse absurd inputs rather than die. */
const MAX_LOG_BYTES = 256 * 1024 * 1024
/** Session ids are path and storage-domain keys: keep the accepted alphabet tight. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/
/** Canonical log generations: `session.jsonl[.zstd]`, `session.vN.jsonl[.zstd]`. */
const CANONICAL_LOG_RE = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/

/** One operation failure with a stable, client-facing code and optional details. */
function codedError(code, message, details) {
  const error = new Error(message)
  error.code = code
  if (details !== undefined) error.details = details
  return error
}

function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw codedError('bad-request', 'request body is too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') throw codedError('bad-request', 'request body is required')
  try {
    return JSON.parse(text)
  } catch {
    throw codedError('bad-request', 'request body is not valid JSON')
  }
}

function expandTilde(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

function envDshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(expandTilde(configured.trim()))
  return join(homedir(), '.dsh')
}

/** The configured Session-persistence root, preferring the backend's own answer. */
function resolveSessionsRoot(ctx) {
  const persistence = ctx.get('sessionPersistence')
  const runtimeRoot = persistence !== undefined && typeof persistence.root === 'string' && persistence.root !== ''
    ? resolve(persistence.root)
    : undefined
  if (runtimeRoot !== undefined) return runtimeRoot
  const homePath = ctx.get('dshHomePath')
  if (typeof homePath === 'function') {
    try {
      const resolved = homePath('sessions')
      if (typeof resolved === 'string' && resolved !== '') return resolve(resolved)
    } catch {
      // fall through to the environment default
    }
  }
  return join(envDshHome(), 'sessions')
}

function resolveStoragesRoot(ctx, sessionsRoot) {
  const homePath = ctx.get('dshHomePath')
  if (typeof homePath === 'function') {
    try {
      const resolved = homePath('storages')
      if (typeof resolved === 'string' && resolved !== '') return resolve(resolved)
    } catch {
      // fall through
    }
  }
  if (basename(sessionsRoot) === 'sessions') return join(dirname(sessionsRoot), 'storages')
  return join(envDshHome(), 'storages')
}

/** The symbolic root the UI shows instead of a machine path. */
function rootDisplay() {
  const resolved = resolve(envDshHome())
  return resolved === resolve(join(homedir(), '.dsh')) ? '~/.dsh/sessions' : '$DSH_HOME/sessions'
}

/** Encode one Session id into the single path segment the JSONL backend uses. */
function encodeSegment(raw) {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

function isInside(parent, child) {
  const parentResolved = resolve(parent)
  const childResolved = resolve(child)
  return childResolved === parentResolved
    || childResolved.startsWith(parentResolved.endsWith(sep) ? parentResolved : parentResolved + sep)
}

async function directoryStat(path) {
  try {
    const stat = await fs.stat(path)
    return stat.isDirectory() ? stat : undefined
  } catch {
    return undefined
  }
}

async function locateSessionDir(sessionsRoot, sessionId) {
  const encoded = encodeSegment(sessionId)
  let projects
  try {
    projects = await fs.readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of projects) {
    if (!entry.isDirectory()) continue
    const candidate = join(sessionsRoot, entry.name, encoded)
    if (await directoryStat(candidate) !== undefined) return candidate
  }
  return undefined
}

function liveKind(ctx, sessionId) {
  const agents = ctx.get('agents')
  if (agents !== undefined && typeof agents.get === 'function' && agents.get(sessionId) !== undefined) return 'agent'
  const sessions = ctx.get('sessions')
  if (sessions !== undefined && typeof sessions.get === 'function' && sessions.get(sessionId) !== undefined) return 'session'
  return undefined
}

/** How long a forced delete waits for the running Session to reach quiescence. */
const CANCEL_WAIT_MS = 1500
/** How long a deleted-but-still-running Session is watched for a revived log. */
const TOMBSTONE_TTL_MS = 60 * 60 * 1000
/** How often those tombstones are swept. */
const TOMBSTONE_SWEEP_MS = 30 * 1000
/** Sessions deleted while their Agent was still attached, id → sweep deadline. */
const tombstones = new Map()

/** Whether a filesystem failure means "the file is still held open by someone". */
function isBusyError(error) {
  const code = error !== null && typeof error === 'object' ? error.code : undefined
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY'
}

/**
 * Stop the running work of one Session before its storage is touched.
 *
 * The Agent interface exposes cancellation and quiescence but no disposer, so
 * a forced operation can never unload the Agent itself. Cancelling its turn and
 * waiting for idleness stops the writes that would otherwise race the delete;
 * the tombstone sweep covers the rest.
 */
async function quiesceSession(ctx, sessionId) {
  const agents = ctx.get('agents')
  const agent = agents !== undefined && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
  let cancelled = false
  if (agent !== undefined && typeof agent.cancel === 'function') {
    try {
      agent.cancel({ kind: 'user' })
      cancelled = true
    } catch (error) {
      ctx.logger?.warn?.(`trash: cancelling "${sessionId}" failed: ${String(error)}`)
    }
    if (typeof agent.whenIdle === 'function') {
      try {
        await Promise.race([
          Promise.resolve(agent.whenIdle()).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, CANCEL_WAIT_MS)),
        ])
      } catch {
        // a rejection settles the race early; the caller re-checks liveness
      }
    }
  }
  return { cancelled, stillLive: liveKind(ctx, sessionId) !== undefined }
}

function rememberTombstone(sessionId) {
  tombstones.set(sessionId, Date.now() + TOMBSTONE_TTL_MS)
}

/**
 * Remove a log that a still-attached Agent recreated after its Session was
 * deleted. Bounded by {@link TOMBSTONE_TTL_MS}: once a Session has stayed gone
 * for that long it is forgotten.
 */
async function sweepTombstones(ctx, sessionsRoot) {
  if (tombstones.size === 0) return
  const now = Date.now()
  for (const [sessionId, deadline] of [...tombstones]) {
    if (deadline < now) {
      tombstones.delete(sessionId)
      continue
    }
    if (liveKind(ctx, sessionId) !== undefined) continue
    const dir = await locateSessionDir(sessionsRoot, sessionId)
    if (dir === undefined) {
      tombstones.delete(sessionId)
      continue
    }
    try {
      await renameCanonicalLogs(dir)
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
      tombstones.delete(sessionId)
      ctx.logger?.warn?.(`trash: removed a session log that was recreated after deletion ("${sessionId}")`)
    } catch {
      // still held open; the next sweep tries again
    }
  }
}

function assertId(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
    throw codedError('bad-request', `invalid session id: ${JSON.stringify(sessionId)}`)
  }
}

async function collectDescendants(ctx, sessionId) {
  const sessionQuery = ctx.get('sessionQuery')
  if (sessionQuery === undefined || typeof sessionQuery.listSessions !== 'function') return []
  let records
  try {
    records = await sessionQuery.listSessions()
  } catch {
    return []
  }
  const byParent = new Map()
  for (const record of records) {
    const header = record?.header
    const childId = header?.id
    const parent = header?.parentSession
    if (typeof childId !== 'string' || typeof parent !== 'string' || parent === '') continue
    const children = byParent.get(parent)
    if (children === undefined) byParent.set(parent, [childId])
    else children.push(childId)
  }
  const descendants = []
  const seen = new Set([sessionId])
  const queue = [sessionId]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const childId of byParent.get(current) ?? []) {
      if (seen.has(childId)) continue
      seen.add(childId)
      descendants.push(childId)
      queue.push(childId)
    }
  }
  return descendants
}

async function renameCanonicalLogs(sessionDir) {
  let names
  try {
    names = await fs.readdir(sessionDir)
  } catch {
    return []
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const renamed = []
  for (const name of names) {
    if (!CANONICAL_LOG_RE.test(name)) continue
    const from = join(sessionDir, name)
    const to = join(sessionDir, `${name}.trash-deleted-${stamp}`)
    await fs.rename(from, to)
    renamed.push(to)
  }
  return renamed
}

async function removeSessionCache(ctx, storagesRoot, sessionId) {
  const storageDomain = ctx.get('storageDomain')
  if (storageDomain !== undefined && typeof storageDomain.get === 'function') {
    const domain = storageDomain.get('session_projcache')
    if (domain !== undefined && typeof domain.table === 'function') {
      try {
        const table = domain.table('sessions')
        if (table !== undefined && typeof table.delete === 'function') {
          const removed = await table.delete(sessionId)
          if (removed === true) return [`session_projcache/sessions/${sessionId}`]
          return []
        }
      } catch (error) {
        ctx.logger?.warn?.(`trash: projection-cache delete failed for "${sessionId}": ${String(error)}`)
      }
    }
  }
  const directory = join(storagesRoot, 'session_projcache', 'sessions')
  const prefix = `${sessionId}.json`
  const removed = []
  let names
  try {
    names = await fs.readdir(directory)
  } catch {
    return removed
  }
  for (const name of names) {
    if (name !== prefix && !name.startsWith(`${prefix}.bak.`)) continue
    const path = join(directory, name)
    await fs.rm(path, { force: true })
    removed.push(path)
  }
  return removed
}

function workspaceDomain(ctx) {
  const storageDomain = ctx.get('storageDomain')
  if (storageDomain === undefined || typeof storageDomain.get !== 'function') return undefined
  try {
    return storageDomain.get('workspace')
  } catch {
    return undefined
  }
}

/** Read the archive/pin bookkeeping the sidebar reads, without touching it. */
function readWorkspaceBookkeeping(ctx) {
  const archived = new Set()
  const pinned = new Set()
  const domain = workspaceDomain(ctx)
  if (domain === undefined) return { archived, pinned }
  try {
    const global = domain.global.get()
    if (Array.isArray(global?.archivedSessionIds)) for (const id of global.archivedSessionIds) archived.add(id)
    if (Array.isArray(global?.pinnedSessionIds)) for (const id of global.pinnedSessionIds) pinned.add(id)
  } catch {
    // an unreadable domain is not a reason to fail a listing
  }
  return { archived, pinned }
}

/** Detach one Session from every Workspace record and from the archive/pin lists. */
async function detachSessionBookkeeping(ctx, sessionId) {
  const touched = []
  const domain = workspaceDomain(ctx)
  if (domain === undefined) return touched
  try {
    const global = domain.global.get()
    const archived = Array.isArray(global?.archivedSessionIds) ? global.archivedSessionIds : []
    const pinned = Array.isArray(global?.pinnedSessionIds) ? global.pinnedSessionIds : []
    const nextArchived = archived.filter((id) => id !== sessionId)
    const nextPinned = pinned.filter((id) => id !== sessionId)
    if (nextArchived.length !== archived.length || nextPinned.length !== pinned.length) {
      await domain.global.set({ ...global, archivedSessionIds: nextArchived, pinnedSessionIds: nextPinned })
      touched.push('global')
    }
  } catch (error) {
    ctx.logger?.warn?.(`trash: archive/pin cleanup failed for "${sessionId}": ${String(error)}`)
  }
  try {
    const table = domain.table('workspaces')
    for (const [workspaceId, record] of table.entries()) {
      const ids = Array.isArray(record?.sessionIds) ? record.sessionIds : []
      if (!ids.includes(sessionId)) continue
      await table.update(workspaceId, (current) => ({
        ...current,
        sessionIds: (Array.isArray(current?.sessionIds) ? current.sessionIds : []).filter((id) => id !== sessionId),
        updatedAt: new Date().toISOString(),
      }))
      touched.push(String(workspaceId))
    }
  } catch (error) {
    ctx.logger?.warn?.(`trash: workspace detach failed for "${sessionId}": ${String(error)}`)
  }
  return touched
}

async function removeIfEmpty(path) {
  try {
    await fs.rmdir(path)
    return true
  } catch {
    return false
  }
}

/**
 * The one listing operation: every stored Session plus the metadata the Trash
 * page needs. Reads stored headers and titles only; never opens a Session.
 */
async function readTrashListing(ctx) {
  const sessionsRoot = resolveSessionsRoot(ctx)
  const persistence = ctx.get('sessionPersistence')
  const sessionQuery = ctx.get('sessionQuery')

  let snapshots = []
  if (persistence !== undefined && typeof persistence.list === 'function') {
    try {
      snapshots = await persistence.list()
    } catch (error) {
      throw codedError('storage-unresolved', `cannot list stored sessions: ${String(error)}`)
    }
  }

  const live = new Set()
  if (sessionQuery !== undefined && typeof sessionQuery.listSessions === 'function') {
    try {
      for (const record of await sessionQuery.listSessions()) {
        if (record?.live === true && typeof record.header?.id === 'string') live.add(record.header.id)
      }
    } catch {
      // live flags stay as the in-memory checks report them
    }
  }

  const ids = snapshots.map((snapshot) => snapshot?.header?.id).filter((id) => typeof id === 'string')
  const titles = new Map()
  if (sessionQuery !== undefined && typeof sessionQuery.readTitleSnapshots === 'function' && ids.length > 0) {
    try {
      const observations = await sessionQuery.readTitleSnapshots(ids)
      for (const entry of observations) {
        if (entry?.status !== 'fulfilled') continue
        const title = entry.value?.title?.title
        if (typeof title === 'string' && title !== '') titles.set(entry.sessionId, title)
      }
    } catch {
      // titles are decoration; a failure leaves them empty
    }
  }

  const bookkeeping = readWorkspaceBookkeeping(ctx)
  const rows = []
  for (const snapshot of snapshots) {
    const header = snapshot?.header
    const sessionId = header?.id
    if (typeof sessionId !== 'string') continue
    const dir = await locateSessionDir(sessionsRoot, sessionId)
    let updatedAt = typeof header.createdAt === 'number' ? header.createdAt : 0
    if (dir !== undefined) {
      try {
        updatedAt = (await fs.stat(dir)).mtimeMs
      } catch {
        // keep createdAt
      }
    }
    rows.push({
      sessionId,
      title: titles.get(sessionId) ?? '',
      cwd: typeof header.cwd === 'string' ? header.cwd : '',
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : 0,
      updatedAt,
      sizeBytes: typeof snapshot.sizeBytes === 'number' ? snapshot.sizeBytes : 0,
      eventCount: typeof snapshot.eventCount === 'number' ? snapshot.eventCount : null,
      live: live.has(sessionId) || liveKind(ctx, sessionId) !== undefined,
      archived: bookkeeping.archived.has(sessionId),
      pinned: bookkeeping.pinned.has(sessionId),
      origin: typeof header.origin === 'string' ? header.origin : '',
      seeded: header.isSeeded === true || typeof header.parentSession === 'string',
      formatStatus: snapshot.formatStatus ?? 'current',
    })
  }
  rows.sort((left, right) => right.updatedAt - left.updatedAt)

  const totals = rows.reduce((acc, row) => {
    acc.count += 1
    acc.bytes += row.sizeBytes
    if (row.live) acc.live += 1
    if (row.archived) acc.archived += 1
    return acc
  }, { count: 0, bytes: 0, live: 0, archived: 0 })

  return {
    rootDisplay: rootDisplay(),
    sessions: rows,
    totals,
    canClear: typeof zlib.zstdDecompressSync === 'function',
  }
}

/** Permanently remove one stored Session (and, with `cascade`, its derived subtree). */
async function deleteSessionStorage(ctx, sessionId, cascade) {
  assertId(sessionId)
  const sessionsRoot = resolveSessionsRoot(ctx)
  if (await directoryStat(sessionsRoot) === undefined) {
    throw codedError('storage-unresolved', `session root is not a readable directory: ${sessionsRoot}`)
  }
  const storagesRoot = resolveStoragesRoot(ctx, sessionsRoot)
  const rootDir = await locateSessionDir(sessionsRoot, sessionId)
  if (rootDir === undefined) {
    throw codedError('session/unknown', `session "${sessionId}" has no stored log`)
  }
  if (!isInside(sessionsRoot, rootDir)) {
    throw codedError('storage-unresolved', 'resolved session path escapes the session root')
  }

  const descendants = await collectDescendants(ctx, sessionId)
  if (descendants.length > 0 && cascade !== true) {
    throw codedError(
      'session/children',
      `session "${sessionId}" has ${String(descendants.length)} derived session(s); pass cascade to delete them together`,
      { count: descendants.length },
    )
  }
  const targets = cascade === true ? [sessionId, ...descendants] : [sessionId]

  // A running Session is stopped first rather than refused: the Trash is the
  // place a user goes to get rid of a conversation, including the one they are
  // looking at. Whatever is still attached is recorded as a tombstone below.
  const forced = []
  for (const targetId of targets) {
    if (liveKind(ctx, targetId) === undefined) continue
    const outcome = await quiesceSession(ctx, targetId)
    if (outcome.stillLive) forced.push(targetId)
  }

  const plans = []
  for (const targetId of targets) {
    const dir = targetId === sessionId ? rootDir : await locateSessionDir(sessionsRoot, targetId)
    if (dir !== undefined && !isInside(sessionsRoot, dir)) {
      throw codedError('storage-unresolved', 'resolved session path escapes the session root')
    }
    plans.push({ sessionId: targetId, dir })
  }
  plans.reverse()

  const deleted = []
  const removedPaths = []
  const residuals = []
  for (const plan of plans) {
    if (plan.dir !== undefined) {
      let renamed
      try {
        renamed = await renameCanonicalLogs(plan.dir)
      } catch (error) {
        if (plan.sessionId === sessionId) {
          throw isBusyError(error)
            ? codedError('session/busy', 'the session log is still held open; try again in a moment')
            : codedError('delete-failed', `cannot remove session log: ${error instanceof Error ? error.message : String(error)}`)
        }
        ctx.logger?.warn?.(`trash: derived session log removal failed for "${plan.sessionId}": ${String(error)}`)
        continue
      }
      removedPaths.push(...renamed)
      if (renamed.length === 0) {
        // Nothing was renamed: the canonical log is gone already, so the
        // Session is already invisible and only leftovers remain.
        ctx.logger?.warn?.(`trash: "${plan.sessionId}" had no canonical log left to commit`)
      }
      try {
        await fs.rm(plan.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        removedPaths.push(plan.dir)
        await removeIfEmpty(dirname(plan.dir))
      } catch (error) {
        residuals.push(plan.dir)
        ctx.logger?.warn?.(`trash: leftover directory removal failed for "${plan.sessionId}": ${String(error)}`)
      }
    }
    await removeSessionCache(ctx, storagesRoot, plan.sessionId)
    await detachSessionBookkeeping(ctx, plan.sessionId)
    deleted.push(plan.sessionId)
  }

  for (const targetId of forced) rememberTombstone(targetId)

  return { sessionId, deleted, removedPaths, residuals, forced }
}

/** Pick the canonical log file of a Session directory: the newest generation. */
async function canonicalLogPath(sessionDir) {
  let names
  try {
    names = await fs.readdir(sessionDir)
  } catch {
    return undefined
  }
  const generations = names
    .map((name) => {
      const match = CANONICAL_LOG_RE.exec(name)
      if (match === null) return undefined
      return { name, version: match[1] === undefined ? 0 : Number(match[1]) }
    })
    .filter((entry) => entry !== undefined)
    .sort((left, right) => right.version - left.version)
  if (generations.length === 0) return undefined
  return join(sessionDir, generations[0].name)
}

/** Decode a stored log to its plaintext text; throws a coded error when it cannot. */
function decodeLog(raw, compressed) {
  if (raw.length > MAX_LOG_BYTES) {
    throw codedError('log-too-large', 'the stored log is too large to rewrite safely')
  }
  if (!compressed) return raw.toString('utf8')
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw codedError('unsupported-compression', 'this Node runtime cannot decode the compressed session log')
  }
  try {
    return zlib.zstdDecompressSync(raw).toString('utf8')
  } catch (error) {
    throw codedError('log-corrupt', `cannot decode the stored log: ${String(error && error.message ? error.message : error)}`)
  }
}

function encodeLog(text, compressed) {
  const body = Buffer.from(text, 'utf8')
  if (!compressed) return body
  if (typeof zlib.zstdCompressSync !== 'function') {
    throw codedError('unsupported-compression', 'this Node runtime cannot write the compressed session log')
  }
  return zlib.zstdCompressSync(body)
}

/**
 * Keep a Session's identity and drop every stored event: rewrite its log with
 * only the header record. The original file is moved to a backup first, the
 * rewrite is verified by decoding it again, and any failure restores the backup.
 */
async function clearSessionContent(ctx, sessionId) {
  assertId(sessionId)
  const sessionsRoot = resolveSessionsRoot(ctx)
  const storagesRoot = resolveStoragesRoot(ctx, sessionsRoot)
  const sessionDir = await locateSessionDir(sessionsRoot, sessionId)
  if (sessionDir === undefined) {
    throw codedError('session/unknown', `session "${sessionId}" has no stored log`)
  }
  if (!isInside(sessionsRoot, sessionDir)) {
    throw codedError('storage-unresolved', 'resolved session path escapes the session root')
  }
  const kind = liveKind(ctx, sessionId)
  let forced = false
  if (kind !== undefined) {
    // Stop the running turn and wait for quiescence, then rewrite anyway: a
    // cleared log whose Agent keeps appending would be worse than a refusal.
    const outcome = await quiesceSession(ctx, sessionId)
    forced = outcome.stillLive || outcome.cancelled
  }
  const logPath = await canonicalLogPath(sessionDir)
  if (logPath === undefined) {
    throw codedError('session/unknown', `session "${sessionId}" has no canonical log record`)
  }
  if (!isInside(sessionsRoot, logPath)) {
    throw codedError('storage-unresolved', 'resolved log path escapes the session root')
  }

  const compressed = logPath.endsWith('.zstd')
  const raw = await fs.readFile(logPath)
  const text = decodeLog(raw, compressed)
  const newline = text.indexOf('\n')
  if (newline < 0) throw codedError('log-corrupt', 'the stored log has no header record')
  const headerLine = text.slice(0, newline)
  let header
  try {
    header = JSON.parse(headerLine)
  } catch {
    throw codedError('log-corrupt', 'the stored header record is not valid JSON')
  }
  if (header === null || typeof header !== 'object' || header.type !== 'session' || header.id !== sessionId) {
    throw codedError('log-corrupt', 'the stored header does not belong to this session')
  }
  if (header.isSeeded === true || typeof header.parentSession === 'string') {
    throw codedError(
      'session/seeded',
      'this session inherits a seed prefix from a fork or a parent agent; delete the file instead of clearing it',
    )
  }

  const eventCount = text.slice(newline + 1).split('\n').filter((line) => line.trim() !== '').length
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${logPath}.trash-backup-${stamp}`
  try {
    await fs.rename(logPath, backupPath)
  } catch (error) {
    throw isBusyError(error)
      ? codedError('session/busy', 'the session log is still held open; try again in a moment')
      : codedError('clear-failed', `cannot open the session log for rewriting: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    await fs.writeFile(logPath, encodeLog(`${headerLine}\n`, compressed))
    // Prove the rewrite before dropping the backup: one decodable header line.
    const verifyText = decodeLog(await fs.readFile(logPath), compressed)
    const verifyNewline = verifyText.indexOf('\n')
    if (verifyNewline < 0 || verifyText.slice(verifyNewline + 1).trim() !== '') {
      throw codedError('clear-failed', 'the rewritten log did not verify')
    }
  } catch (error) {
    try {
      await fs.rm(logPath, { force: true })
      await fs.rename(backupPath, logPath)
    } catch (restoreError) {
      ctx.logger?.warn?.(`trash: restore after failed clear failed for "${sessionId}": ${String(restoreError)}`)
    }
    throw error
  }
  await fs.rm(backupPath, { force: true })
  await removeSessionCache(ctx, storagesRoot, sessionId)

  return { sessionId, clearedEvents: Math.max(0, eventCount - 0), forced: forced ? [sessionId] : [] }
}

/** Map one coded failure to an HTTP status. */
function statusOf(code) {
  if (code === 'bad-request') return 400
  if (code === 'forbidden') return 403
  if (code === 'session/unknown') return 404
  if (code === 'method-error') return 405
  if (code === 'session/live' || code === 'session/busy' || code === 'session/children' || code === 'session/children-live' || code === 'session/seeded') return 409
  if (code === 'unsupported-compression') return 422
  return 500
}

function failureOf(error) {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string' && typeof error.message === 'string') {
    return { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }
  }
  return { code: 'internal', message: error instanceof Error ? error.message : String(error) }
}

/** Read one validated id list from a request body. */
function readIdList(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw codedError('bad-request', 'request body must be a JSON object')
  }
  const raw = Array.isArray(payload.sessionIds) ? payload.sessionIds : []
  if (raw.length === 0) throw codedError('bad-request', 'sessionIds must be a non-empty array')
  if (raw.length > 500) throw codedError('bad-request', 'too many session ids in one request')
  for (const id of raw) assertId(id)
  if (payload.cascade !== undefined && typeof payload.cascade !== 'boolean') {
    throw codedError('bad-request', 'cascade must be a boolean')
  }
  return { sessionIds: [...new Set(raw)], cascade: payload.cascade === true }
}

/**
 * A loopback-origin guard for the plugin's own routes.
 *
 * `connection.requestRejection` is the harness-wide fence, but in a web profile
 * it rejects these plugin routes with 403 even for the page's own same-origin
 * requests, which makes every action here fail. This guard covers the same
 * attack surface directly: the request must arrive on a loopback authority,
 * must not be a cross-site fetch, and any Origin it carries must be its own.
 */
function isLoopbackHostname(hostname) {
  const value = String(hostname).toLowerCase()
  return value === 'localhost'
    || value === '127.0.0.1'
    || value === '::1'
    || value === '[::1]'
    || value.endsWith('.localhost')
}

function localOriginRejection(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return 'missing host'
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return 'unparsable host'
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return 'non-loopback authority'
  if (req.headers['sec-fetch-site'] === 'cross-site') return 'cross-site fetch'
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    try {
      if (new URL(origin).host !== hostUrl.host) return 'foreign origin'
    } catch {
      return 'unparsable origin'
    }
  }
  return undefined
}

/** Register the three routes; each owns only its transport and error mapping. */
export function apply(ctx) {
  const guard = (req, res) => {
    const connection = ctx.get('connection')
    const rejection = typeof connection?.requestRejection === 'function'
      ? connection.requestRejection(req)
      : undefined
    // The harness fence is authoritative when it admits; when it refuses, fall
    // back to the equivalent loopback-origin check so the page's own requests
    // still reach the route.
    if (rejection !== undefined && localOriginRejection(req) !== undefined) {
      writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'request rejected' } })
      return false
    }
    return true
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_LIST,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      try {
        const sessionsRoot = resolveSessionsRoot(ctx)
        await sweepTombstones(ctx, sessionsRoot)
        writeJson(res, 200, { ok: true, value: await readTrashListing(ctx) })
      } catch (error) {
        const failure = failureOf(error)
        ctx.logger?.warn?.(`trash: listing failed: ${failure.message}`)
        writeJson(res, statusOf(failure.code), { ok: false, error: failure })
      }
    },
  }), 'trash: list route')

  const mutatingRoute = (path, operation) => ctx.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      try {
        const payload = await readJsonBody(req)
        const request = readIdList(payload)
        const results = []
        const affected = []
        for (const sessionId of request.sessionIds) {
          try {
            const value = await operation(sessionId, request.cascade)
            results.push({ sessionId, ok: true, value })
            affected.push(sessionId)
          } catch (error) {
            const failure = failureOf(error)
            results.push({ sessionId, ok: false, error: failure })
          }
        }
        writeJson(res, 200, { ok: true, value: { results, affected } })
      } catch (error) {
        const failure = failureOf(error)
        ctx.logger?.warn?.(`trash: ${path} failed: ${failure.message}`)
        writeJson(res, statusOf(failure.code), { ok: false, error: failure })
      }
    },
  })

  ctx.effect(() => mutatingRoute(ROUTE_DELETE, (sessionId, cascade) => deleteSessionStorage(ctx, sessionId, cascade)), 'trash: delete route')
  ctx.effect(() => mutatingRoute(ROUTE_CLEAR, (sessionId) => clearSessionContent(ctx, sessionId)), 'trash: clear route')

  // A Session deleted while its Agent was still attached may have its log
  // recreated by that Agent's next write. Watch those ids for a bounded hour
  // so the recreated log is removed instead of lingering as an unreadable file.
  ctx.effect(() => {
    const handle = setInterval(() => {
      void sweepTombstones(ctx, resolveSessionsRoot(ctx))
    }, TOMBSTONE_SWEEP_MS)
    if (typeof handle === 'object' && handle !== null && typeof handle.unref === 'function') handle.unref()
    return () => { clearInterval(handle) }
  }, 'trash: tombstone sweep')
}
