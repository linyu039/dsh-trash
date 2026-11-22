/**
 * Render smoke test for the Trash Client half.
 *
 * Calls the real page component (and the rows and the dialog it produces)
 * with a minimal React stub, so a crash on first paint — the failure that
 * leaves a slot entry blank — surfaces here instead of in the browser.
 */
const registered = []
const injected = []

globalThis.window = {
  __ModuleLoader__: { load: (definition) => { globalThis.__definition = definition } },
  addEventListener: () => {},
  removeEventListener: () => {},
}

globalThis.document = {
  baseURI: 'http://127.0.0.1:3080/',
  querySelectorAll: () => [],
  head: { appendChild: () => {} },
  createElement: () => ({ dataset: {}, textContent: '' }),
}

await import('../client.js')

const hooks = []
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  useEffect: (fn, deps) => { hooks.push({ fn, deps }) },
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useSyncExternalStore: (subscribe, snapshot) => snapshot(),
  Component: class { constructor(props) { this.props = props; this.state = {} } },
}

const module = globalThis.__definition.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected import ${name}`)
})

const t = (key, params) => {
  if (params === undefined) return key
  return `${key}(${Object.entries(params).map(([k, v]) => `${k}=${String(v)}`).join(',')})`
}

const ctx = {
  slots: {
    inject: (key, callback) => { injected.push(key); const d = callback(); return typeof d === 'function' ? d : () => {} },
    register: (options, component) => { registered.push({ options, component }); return () => {} },
  },
  locale: { register: () => () => {}, bind: () => t },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  get: () => undefined,
}

module.apply(ctx)

const row = (id, overrides = {}) => ({
  sessionId: id,
  title: `Title ${id}`,
  cwd: 'E:\\projects\\demo',
  createdAt: 1,
  updatedAt: Date.now(),
  sizeBytes: 128695,
  eventCount: 68,
  live: false,
  archived: false,
  pinned: false,
  origin: '',
  seeded: false,
  formatStatus: 'current',
  ...overrides,
})

const makeStore = (state) => ({
  subscribe: () => () => {},
  getSnapshot: () => state,
})

const baseState = {
  sessions: [row('s1'), row('s2', { live: true }), row('s3', { seeded: true, archived: true })],
  totals: { count: 3, bytes: 300, live: 1, archived: 1 },
  rootDisplay: '~/.dsh/sessions',
  canClear: true,
  loading: false,
  loaded: true,
  error: null,
  filter: '',
  selected: { s1: true },
  pending: null,
  pendingFailure: null,
  cascadeCount: 0,
  busy: false,
  notice: { kind: 'ok', text: 'done' },
}

const api = new Proxy({}, { get: () => () => {} })

/** Render one node tree, calling function components, and collect markup. */
function render(node, path = 'root') {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child, index) => render(child, `${path}.${index}`)).join('')
  if (typeof node.type === 'function') {
    const source = Function.prototype.toString.call(node.type)
    const isClass = /^class[\s{]/.test(source) || Boolean(node.type.prototype && node.type.prototype.isReactComponent)
    if (isClass) {
      const instance = new node.type({ ...node.props, children: node.children })
      if (instance.state === undefined) instance.state = {}
      return render(instance.render(), `${path}<${node.type.name || 'anon'}>`)
    }
    const produced = node.type({ ...node.props, children: node.children })
    return render(produced, `${path}<${node.type.name || 'anon'}>`)
  }
  const inner = (node.children ?? []).map((child, index) => render(child, `${path}.${index}`)).join('')
  return `<${String(node.type)}>${inner}</${String(node.type)}>`
}

const pageEntry = registered.find((entry) => entry.options.name === 'main')
if (pageEntry === undefined) throw new Error('the Trash page was not registered')

const scenarios = [
  { name: 'loaded list with notice', state: baseState },
  { name: 'empty', state: { ...baseState, sessions: [], totals: { count: 0, bytes: 0, live: 0, archived: 0 }, notice: null, selected: {} } },
  { name: 'error', state: { ...baseState, error: 'boom', loaded: true, loading: false, sessions: [] } },
  { name: 'loading', state: { ...baseState, loading: true, loaded: false, sessions: [] } },
  { name: 'pending delete', state: { ...baseState, pending: { kind: 'delete', ids: ['s1', 's2'], cascade: false } } },
  { name: 'pending clear with cascade hint', state: { ...baseState, cascadeCount: 2, pendingFailure: 'partial', pending: { kind: 'clear', ids: ['s1'], cascade: false } } },
  { name: 'filtered', state: { ...baseState, filter: 'zzz' } },
]

for (const scenario of scenarios) {
  hooks.length = 0
  const props = { hooks: { trash: makeStore(scenario.state) }, api, t }
  let html = ''
  try {
    html = render(pageEntry.component(props))
  } catch (error) {
    console.error(`FAILED to render "${scenario.name}":`, error)
    throw error
  }
  if (html.trim() === '') throw new Error(`"${scenario.name}" rendered nothing`)
  console.log(`ok — "${scenario.name}" rendered ${String(html.length)} chars of text`)
  for (const hook of hooks) {
    if (typeof hook.fn !== 'function') continue
    try {
      hook.fn()
    } catch (error) {
      throw new Error(`an effect in "${scenario.name}" threw on mount: ${String(error)}`)
    }
  }
}

// The row control and the menu item are outside the page; render them too.
for (const slot of ['sidebar.workspaces.session.row.action', 'sidebar.workspaces.session.menu.item', 'sidebar.panellist']) {
  const entry = registered.find((candidate) => candidate.options.name === slot)
  if (entry === undefined) throw new Error(`${slot} was not registered`)
  const props = {
    sessionId: 's1',
    displayTitle: 'Title s1',
    size: 16,
    api,
    t,
    useMenuOpenState: () => [false, () => {}],
  }
  const html = render(entry.component(props))
  if (html.trim() === '') throw new Error(`${slot} rendered nothing`)
  console.log(`ok — ${slot} rendered`)
}

console.log('RENDER SMOKE OK')
