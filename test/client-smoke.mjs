/**
 * Wiring smoke test for the Trash Client half.
 *
 * It loads `client.js` in a stubbed browser module loader, then runs `apply()`
 * against a stub Cordis context and asserts every registration the page needs.
 * It proves the bundle's module shape, its slot registrations, its locale
 * dictionaries, and its style injection — not how the page looks.
 */
const registered = []
const injected = []
const dictionaries = []
const styles = []

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      globalThis.__definition = definition
    },
  },
}

globalThis.document = {
  baseURI: 'http://127.0.0.1:3080/',
  querySelectorAll: () => [],
  head: { appendChild: (tag) => { styles.push(tag) } },
  createElement: () => ({ dataset: {}, textContent: '' }),
}

await import('../client.js')

const definition = globalThis.__definition
if (definition === undefined) throw new Error('client.js did not call the module loader')
console.log('module id:', definition.id)

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useSyncExternalStore: (subscribe, snapshot) => snapshot(),
  Component: class { constructor(props) { this.props = props; this.state = {} } },
}

const module = definition.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error(`unexpected module import: ${name}`)
})

if (typeof module.apply !== 'function') throw new Error('the factory did not export apply()')
console.log('inject:', module.inject.join(', '))

const t = (key, params) => (params === undefined ? key : `${key}(${Object.keys(params).join(',')})`)

const ctx = {
  slots: {
    inject(key, callback) {
      injected.push(key)
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    register(options, component) {
      registered.push({ options, component })
      return () => {}
    },
  },
  locale: {
    register: (namespace, dicts) => {
      dictionaries.push({ namespace, dicts })
      return () => {}
    },
    bind: () => t,
  },
  effect: (factory) => {
    const disposer = factory()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  get: (name) => (name === 'layout' ? { selectPanel: (id) => { globalThis.__selectedPanel = id } } : undefined),
}

module.apply(ctx)

const bySlot = (name) => registered.filter((entry) => entry.options.name === name)
const expectations = [
  ['main', 1],
  ['sidebar.panellist', 1],
  ['sidebar.workspaces.session.row.action', 1],
  ['sidebar.workspaces.session.menu.item', 1],
]
for (const [slot, count] of expectations) {
  const found = bySlot(slot)
  if (found.length !== count) throw new Error(`${slot}: expected ${String(count)} registration, found ${String(found.length)}`)
  console.log(`ok — ${slot} registered ${String(count)} (id=${String(found[0].options.id ?? found[0].options.key)})`)
}

if (bySlot('main')[0].options.key !== 'trash') throw new Error('the main panel key must be `trash`')
if (bySlot('sidebar.panellist')[0].options.id !== 'trash') throw new Error('the sidebar panel id must be `trash`')
if (dictionaries.length !== 1 || dictionaries[0].namespace !== 'trash') throw new Error('locale dictionary not registered')
const zhKeys = Object.keys(dictionaries[0].dicts.zh).sort()
const enKeys = Object.keys(dictionaries[0].dicts.en).sort()
if (zhKeys.length !== enKeys.length || zhKeys.some((key, index) => key !== enKeys[index])) {
  throw new Error(`zh/en dictionaries disagree:\nzh-only=${zhKeys.filter((k) => !enKeys.includes(k)).join(',')}\nen-only=${enKeys.filter((k) => !zhKeys.includes(k)).join(',')}`)
}
console.log(`ok — ${String(zhKeys.length)} locale keys, zh and en in step`)

if (styles.length !== 1 || styles[0].dataset.plugin !== 'dsh-trash') throw new Error('stylesheet was not injected')
if (!styles[0].textContent.includes('.dtr-page')) throw new Error('stylesheet content looks empty')
console.log(`ok — stylesheet injected (${String(styles[0].textContent.length)} chars)`)

console.log('CLIENT WIRING OK')
