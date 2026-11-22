/**
 * Manual end-to-end check for the Trash Host half, run outside the Harness.
 *
 * It mounts `apply()` on a stub context whose persistence root points at a
 * throwaway copy of real Session directories, then drives the three routes
 * through their real handlers: list → clear (cold and live) → delete → the
 * tombstone sweep. Real session data is only read, never touched.
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import zlib from 'node:zlib'
import { apply } from '../index.js'

/** The harness home, resolved the same way the plugin resolves it. */
const DSH_HOME = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : join(homedir(), '.dsh')
const SOURCE_ROOT = join(DSH_HOME, 'sessions')

const assert = (condition, message) => {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`)
  console.log(`  ok — ${message}`)
}

async function findSampleLog() {
  const buckets = await fs.readdir(SOURCE_ROOT, { withFileTypes: true })
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue
    const bucketPath = join(SOURCE_ROOT, bucket.name)
    for (const session of await fs.readdir(bucketPath, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const dir = join(bucketPath, session.name)
      for (const name of await fs.readdir(dir)) {
        if (/^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(name)) {
          return { dir, file: join(dir, name), name, id: session.name }
        }
      }
    }
  }
  throw new Error('no stored session log found to sample')
}

async function readLog(path) {
  const raw = await fs.readFile(path)
  return path.endsWith('.zstd') ? zlib.zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8')
}

function makeRes() {
  const chunks = []
  const res = {
    statusCode: 0,
    headers: {},
    writeHead(code, headers) {
      res.statusCode = code
      res.headers = headers
    },
    end(body) {
      chunks.push(body)
    },
    bodyText: () => chunks.join(''),
  }
  return res
}

function makeReq(method, body) {
  return {
    method,
    async *[Symbol.asyncIterator]() {
      if (typeof body === 'string' && body !== '') yield Buffer.from(body, 'utf8')
    },
  }
}

let sample
try {
  sample = await findSampleLog()
} catch {
  console.log(`SKIP — no stored session sample under ${SOURCE_ROOT}; nothing to copy.`)
  process.exit(0)
}
const sampleText = await readLog(sample.file)
const headerLine = sampleText.slice(0, sampleText.indexOf('\n'))
const header = JSON.parse(headerLine)
const eventCount = sampleText.slice(sampleText.indexOf('\n') + 1).split('\n').filter((line) => line.trim() !== '').length
console.log('sample:', sample.file)
console.log('events in sample:', eventCount)
assert(header.type === 'session', 'the first record is a session header')
assert(header.isSeeded !== true, 'the sample is not a seeded session')

const work = await fs.mkdtemp(join(tmpdir(), 'dsh-trash-e2e-'))
const root = join(work, 'sessions')
const bucket = join(root, '--E-work~0020deepseek--')
const plainId = sample.id
const seededId = 'session-seeded-sample'
for (const id of [plainId, seededId]) {
  const dir = join(bucket, id)
  await fs.mkdir(dir, { recursive: true })
  await fs.copyFile(sample.file, join(dir, sample.name))
}
const seededFile = join(bucket, seededId, sample.name)
const seededHeaderLine = JSON.stringify({ ...header, id: seededId, isSeeded: true, parentSession: 'session-parent' })
const rest = sampleText.slice(sampleText.indexOf('\n') + 1)
await fs.writeFile(seededFile, zlib.zstdCompressSync(Buffer.from(`${seededHeaderLine}\n${rest}`, 'utf8')))

async function listStored() {
  const rows = []
  for (const bucketEntry of await fs.readdir(root, { withFileTypes: true })) {
    if (!bucketEntry.isDirectory()) continue
    const bucketPath = join(root, bucketEntry.name)
    for (const sessionEntry of await fs.readdir(bucketPath, { withFileTypes: true })) {
      if (!sessionEntry.isDirectory()) continue
      const dir = join(bucketPath, sessionEntry.name)
      const names = await fs.readdir(dir)
      const logName = names.find((name) => /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(name))
      if (logName === undefined) continue
      const path = join(dir, logName)
      const text = await readLog(path)
      const firstNewline = text.indexOf('\n')
      const parsed = JSON.parse(text.slice(0, firstNewline))
      const count = text.slice(firstNewline + 1).split('\n').filter((line) => line.trim() !== '').length
      const stat = await fs.stat(path)
      rows.push({ header: parsed, sizeBytes: stat.size, eventCount: count, formatStatus: 'current', revision: String(stat.mtimeMs) })
    }
  }
  return rows
}

const routes = new Map()
const liveIds = new Set()
const cancelled = []
const idleWaiters = []
const ctx = {
  get: (name) => {
    if (name === 'sessionPersistence') return { root, list: listStored }
    if (name === 'sessionQuery') return { listSessions: async () => [], readTitleSnapshots: async () => [] }
    if (name === 'agents') {
      return {
        get: (id) => (liveIds.has(id)
          ? {
            id,
            cancel: (cause) => { cancelled.push({ id, cause }) },
            whenIdle: async () => { idleWaiters.push(id) },
          }
          : undefined),
      }
    }
    return undefined
  },
  webServer: {
    register: (route) => {
      routes.set(route.path, route)
      return () => { routes.delete(route.path) }
    },
  },
  effect: (fn) => fn(),
  logger: { warn: (message) => console.log('  [host warn]', message) },
}

apply(ctx)
assert(routes.size === 3, 'three routes registered')

async function call(path, method, body) {
  const route = routes.get(path)
  assert(route !== undefined, `route ${path} exists`)
  const res = makeRes()
  await route.handler(makeReq(method, body), res)
  return { status: res.statusCode, json: JSON.parse(res.bodyText()) }
}

console.log('\n— list —')
let response = await call('/trash/api/list', 'GET')
assert(response.status === 200 && response.json.ok === true, 'list answers ok')
assert(response.json.value.sessions.length === 2, 'list reports both stored sessions')
const listed = response.json.value.sessions.find((row) => row.sessionId === plainId)
assert(listed !== undefined && listed.sizeBytes > 0, 'the listed row carries a size')
assert(listed.eventCount === eventCount, 'the listed row carries the event count')

console.log('\n— clearing a seeded session is refused —')
response = await call('/trash/api/clear', 'POST', JSON.stringify({ sessionIds: [seededId] }))
assert(response.status === 200, 'clear answers 200 with per-item results')
assert(response.json.value.results[0].ok === false, 'the seeded session is refused')
assert(response.json.value.results[0].error.code === 'session/seeded', 'the refusal is session/seeded')
assert(await readLog(seededFile) === `${seededHeaderLine}\n${rest}`, 'the seeded log is untouched')

console.log('\n— clearing a live session stops it first —')
liveIds.add(plainId)
response = await call('/trash/api/clear', 'POST', JSON.stringify({ sessionIds: [plainId] }))
assert(response.json.value.results[0].ok === true, 'a live session can be cleared directly')
assert(Array.isArray(response.json.value.results[0].value.forced)
  && response.json.value.results[0].value.forced.includes(plainId), 'the result records the forced Session')
assert(cancelled.some((entry) => entry.id === plainId), 'the running Agent was cancelled')
assert(idleWaiters.includes(plainId), 'quiescence was awaited')
liveIds.delete(plainId)

const clearedPath = join(bucket, plainId, sample.name)
const clearedLines = (await readLog(clearedPath)).split('\n').filter((line) => line.trim() !== '')
assert(clearedLines.length === 1, 'the cleared log holds exactly one record')
assert(JSON.parse(clearedLines[0]).id === plainId, 'the surviving record is the header')

console.log('\n— list after clear —')
response = await call('/trash/api/list', 'GET')
assert(response.json.value.sessions.find((row) => row.sessionId === plainId).eventCount === 0, 'the cleared session reports zero events')

console.log('\n— delete the seeded sample —')
response = await call('/trash/api/delete', 'POST', JSON.stringify({ sessionIds: [seededId] }))
assert(response.json.value.results[0].ok === true, 'delete succeeded')

console.log('\n— deleting a live session directly —')
liveIds.add(plainId)
response = await call('/trash/api/delete', 'POST', JSON.stringify({ sessionIds: [plainId] }))
assert(response.json.value.results[0].ok === true, 'a live session can be deleted directly')
assert(response.json.value.results[0].value.forced.includes(plainId), 'the result records the forced Session')
let gone = true
try {
  await fs.stat(join(bucket, plainId))
} catch {
  gone = false
}
assert(gone === false, 'the session directory is gone')

console.log('\n— the tombstone sweep removes a log the Agent recreates —')
const revivedDir = join(bucket, plainId)
await fs.mkdir(revivedDir, { recursive: true })
await fs.writeFile(join(revivedDir, sample.name), zlib.zstdCompressSync(Buffer.from(`${headerLine}\n`, 'utf8')))
response = await call('/trash/api/list', 'GET')
let stillPresent = true
try {
  await fs.stat(revivedDir)
} catch {
  stillPresent = false
}
assert(stillPresent === true, 'while the Agent is still attached the recreated log is left alone')
liveIds.delete(plainId)
await call('/trash/api/list', 'GET')
stillPresent = true
try {
  await fs.stat(revivedDir)
} catch {
  stillPresent = false
}
assert(stillPresent === false, 'once the Agent is gone the sweep removes the recreated log')

response = await call('/trash/api/list', 'GET')
assert(response.json.value.sessions.length === 0, 'the listing is empty afterwards')

console.log('\n— method guard —')
response = await call('/trash/api/delete', 'GET')
assert(response.status === 405, 'GET on a mutating route is refused')

await fs.rm(work, { recursive: true, force: true })
console.log('\nALL CHECKS PASSED')
