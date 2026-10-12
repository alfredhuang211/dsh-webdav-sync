/**
 * 插件形态测试：本插件**不注册斜杠命令**。
 *
 * 背景（2026-10 实测，见 DSH 侧 `@deepseek-ai/dsh-client-ui-commands` 与
 * `@deepseek-ai/dsh-commands`）：
 *  - composer 的 `+` 按钮与键入的 `/` 打开的是**同一个菜单**，条目来自会话命令目录
 *    （客户端调 `commands.list`）；
 *  - `commands.register({name, description, input, handler})` 只有这些字段，
 *    **没有任何隐藏/可见性开关**（在 dsh-commands 的 lib/ 里搜 hidden/isHidden/
 *    hideFrom/notListed 均无命中）。
 *
 * 因此"`+` 里不要出现 webdav-sync"等价于"不请求 commands 服务、不调用 register"。
 * 本文件把这条约定钉成断言：即使注入作用域**主动提供**一个 commands 间谍，
 * 也要求它一次都没被碰过——防止以后被无意改回去。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, inject, name } from '../lib/index.js'

function fakeCtx() {
  const requested = []
  const registrations = []
  const described = []
  return {
    requested,
    registrations,
    /** 每个注入作用域都假装"命令服务可用"，看插件会不会伸手 */
    scope: { commands: { register: (...args) => registrations.push(args), list: () => [] } },
    described,
    logger: { info() {}, warn() {}, error() {} },
    inject(deps, cb) {
      requested.push(...[].concat(deps))
      return cb(this.scope)
    },
    effect(fn, label) {
      try { return fn() } catch { return undefined }
    },
    settings: {
      describe: () => { described.push(1); return [] },
      update: async () => {}
    }
  }
}

test('不请求 commands 服务，也从不调用 register —— 因此 +／/ 菜单里没有入口', () => {
  const ctx = fakeCtx()
  apply(ctx, { sync: { enabled: false } })
  const uniq = [...new Set(ctx.requested)]
  assert.equal(
    ctx.requested.includes('commands'),
    false,
    `不应注入 commands；实际注入的服务：${uniq.join(', ')}`
  )
  assert.deepEqual(
    ctx.registrations,
    [],
    `不应注册任何斜杠命令，实际注册了 ${ctx.registrations.length} 个`
  )
})

test('注入面就是这四个服务（新增服务时请一并确认不会进菜单）', () => {
  const ctx = fakeCtx()
  apply(ctx, { sync: { enabled: false } })
  assert.deepEqual(
    [...new Set(ctx.requested)].sort(),
    ['connection', 'profileContext', 'sessions', 'webServer']
  )
})

test('插件形态：name 与硬依赖', () => {
  assert.equal(name, 'webdav-sync')
  assert.deepEqual(inject, ['settings'], 'settings 是硬依赖，其余服务必须动态注入')
})
