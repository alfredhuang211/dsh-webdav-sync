/**
 * 客户端产物结构测试：不需要浏览器，也能验证
 *  - 它是 classic script（挂 window.__ModuleLoader__ 自注册）；
 *  - factory 只依赖注入的 require，能导出 { inject, apply }；
 *  - apply(ctx) 会把设置页注册进 settings.section 槽位；
 *  - 拿不到 slots 服务时不会把宿主搞崩（fail-soft）。
 * 真正的渲染效果仍需在 Desktop 里实机确认。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'client', 'bundle.js')

function loadBundle(sandboxWindow) {
  runInNewContext(readFileSync(bundlePath, 'utf8'), { window: sandboxWindow, console })
}

function fakeReact() {
  const h = (type, props, ...kids) => ({ type, props: props ?? {}, kids })
  return {
    createElement: h,
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (v = null) => ({ current: v })
  }
}

test('client bundle 自注册并导出可用的 apply', async () => {
  const loaded = []
  const sandboxWindow = { __ModuleLoader__: { load: (entry) => loaded.push(entry) } }
  loadBundle(sandboxWindow)

  assert.equal(loaded.length, 1)
  const entry = loaded[0]
  assert.equal(entry.id, 'dsh-webdav-sync')
  assert.equal(typeof entry.factory, 'function')

  const mod = entry.factory((specifier) => {
    if (specifier === 'react') return fakeReact()
    throw new Error(`unexpected require: ${specifier}`)
  })
  // vm 里创建的数组与宿主 realm 的 Array 原型不同，跨 realm 不能用 deepStrictEqual
  assert.equal(Array.from(mod.inject).join(','), 'slots')
  assert.equal(typeof mod.apply, 'function')

  // apply：把设置页注册进 settings.section
  const registered = []
  const effects = []
  const ctx = {
    effect: (fn, label) => { effects.push(label); return fn() },
    slots: {
      inject: (name, fn) => { assert.equal(name, 'settings.section'); return fn() },
      register: (options, component) => { registered.push({ options, component }); return () => {} }
    }
  }
  mod.apply(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.name, 'settings.section')
  assert.equal(registered[0].options.id, 'webdav-sync')
  assert.equal(registered[0].options.label(), 'WebDAV 同步')
  assert.equal(typeof registered[0].component, 'function')
  assert.match(effects[0], /settings section/)
})

test('slots 服务缺失时 apply 不抛（fail-soft）', () => {
  const loaded = []
  loadBundle({ __ModuleLoader__: { load: (e) => loaded.push(e) } })
  const mod = loaded[0].factory((s) => (s === 'react' ? fakeReact() : null))
  assert.doesNotThrow(() => mod.apply({ effect: (fn) => fn() }))
})

test('源码里没有 ESM 顶层语法（必须是 classic script）', async () => {
  const source = await readFile(bundlePath, 'utf8')
  assert.ok(!/^\s*(import|export)\s/m.test(source), '产物不能出现顶层 import/export')
  assert.ok(source.includes('window.__ModuleLoader__.load('))
  assert.ok(source.includes("require('react')"))

  // 修复回归：可达 ≠ 能用。remoteUrl 指向的目录不存在时服务器照样可达，
  // 界面必须在"可达"后面把原因显示出来，否则用户只看到一句"可达"，
  // 完全不知道点备份为什么全部失败（真实事故现场就是这样）。
  assert.ok(source.includes('但目标目录不存在'), '要显示"可达（但目标目录不存在）"')
  assert.ok(source.includes('remotePathExists'), '要依据 remotePathExists，而不是只看 reachable')
  assert.ok(source.includes('if (s.error) connText'), 'error 非空时必须拼到连接行上')
})
