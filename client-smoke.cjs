/**
 * 浏览器半身的离线冒烟测试：不启 DSH，用假的 `window.__ModuleLoader__` 和
 * 假 React 把 client.js 跑一遍，验证：
 *   1. 工厂函数能执行、导出的 apply / inject / name 形状正确；
 *   2. apply 真的往 `settings.section` 槽位注册了分区（id / order / label）；
 *   3. 分区组件渲染出 iframe，src 指向宿主同源面板 `/bilibili-kit`。
 *
 * 用法：node client-smoke.cjs ./client.js
 */
const path = require('node:path')

const clientPath = path.resolve(process.argv[2] ?? './client.js')

let loaded = null
global.window = {
  __ModuleLoader__: {
    load(registration) {
      loaded = registration
    },
  },
}

const reactStub = {
  createElement(tag, props, ...children) {
    return { type: tag, props: { ...props, children } }
  },
}

// client.js 用 factory(require)；这里直接调用并替换 require
const factoryRequire = (spec) => {
  if (spec === 'react') return reactStub
  throw new Error(`unexpected require: ${spec}`)
}

require(`${clientPath}`)

if (loaded === null) {
  console.log('FAIL 未调用 __ModuleLoader__.load')
  process.exit(1)
}

let failed = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed += 1
}

check('模块 id 等于包名', loaded.id === 'dsh-bilibili-kit', loaded.id)

const exported = loaded.factory(factoryRequire)
check('导出 apply', typeof exported.apply === 'function')
check('导出 inject', Array.isArray(exported.inject) && exported.inject.includes('slots'), JSON.stringify(exported.inject))

let registered = null
const ctx = {
  slots: {
    inject(name, run) {
      run()
      return () => {}
    },
    register(definition, component) {
      registered = { definition, component }
      return () => {}
    },
  },
}
exported.apply(ctx)

check('注册到 settings.section', registered !== null && registered.definition.name === 'settings.section')
if (registered !== null) {
  check('分区 id', registered.definition.id === 'bilibili-kit', registered.definition.id)
  check('导航标签', registered.definition.label() === 'B 站字幕工具', registered.definition.label())
  const tree = registered.component({})
  const iframe = (tree.props.children || []).find((child) => child && child.type === 'iframe')
  check('分区渲染 iframe', iframe !== undefined, iframe ? 'ok' : JSON.stringify(tree.type))
  if (iframe !== undefined) {
    check('iframe 指向面板路径', iframe.props.src === '/bilibili-kit', iframe.props.src)
  }
}

console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' CHECK(S) FAILED'}`)
process.exitCode = failed === 0 ? 0 : 1
