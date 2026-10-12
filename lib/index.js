/**
 * dsh-webdav-sync —— host 插件入口。
 *
 * 形态要点：
 *  - `export const inject = ['settings']` 是**硬依赖**：缺服务则这一行不激活；
 *    其他服务（webServer / connection / sessions / profileContext）走 ctx.inject 动态接；
 *  - `export { Config }` 让宿主生成设置投影（但**表单由 client/bundle.js 提供**，
 *    宿主自身不渲染投影，见 dsh-settings README 的 "no shipped client does so yet"）；
 *  - 所有外部资源都用 ctx.effect 包住，fiber 卸载时自动回收；
 *  - 所有 settings 调用都先判函数存在再 try/catch，坏插件不能拖垮宿主启动。
 *
 * 同步两个源：
 *  - **会话**：$DSH_HOME/sessions 下的 zstd JSONL，字节级备份/恢复；
 *  - **插件环境**：profile 的 package.json / cordis.patch.yml / pnpm-lock.yaml 等声明文件
 *    与一份带版本号的插件清单（`ctx.profileContext` 给出 profile 目录与 home）。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { Config, NS, toEngineConfig } from './config.js'
import { registerRoutes } from './routes.js'
import { createService } from './sync.js'
import { WebDavClient } from './webdav.js'

export const name = 'webdav-sync'
export const inject = ['settings']
export { Config }

/** 会话根目录：配置 > $DSH_HOME/sessions > ~/.dsh/sessions */
export function resolveSessionsRoot(cfg, home) {
  if (cfg?.sessionsRoot) return cfg.sessionsRoot
  const base = home ?? (process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(process.env.HOME ?? '.', '.dsh'))
  return join(base, 'sessions')
}

/**
 * 尽力探测宿主版本（写进清单，便于跨机对照）。探不到就返回 null——
 * 这不是关键信息，不值得为它引入依赖或抛错。
 */
export function detectDshVersion() {
  try {
    let entry = process.argv[1] ?? ''
    // dsh 常常是符号链接（nvm/.bin），必须先解开真实路径才找得到宿主 package.json
    try { entry = realpathSync(entry) } catch { /* 保留原路径 */ }
    let dir = dirname(entry)
    for (let i = 0; i < 6; i += 1) {
      const pkgPath = join(dir, 'package.json')
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        if (pkg?.name === '@deepseek-ai/dsh' && typeof pkg.version === 'string') return pkg.version
        if (typeof pkg?.name === 'string' && pkg.name.startsWith('dsh-profile-')) break
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* 探测失败不影响功能 */ }
  return null
}

export function apply(ctx, config = {}) {
  const log = ctx.logger ?? console
  const warn = (...args) => { try { (log.warn ?? console.warn)(...args) } catch { /* ignore */ } }

  // ── 环境事实（profile 目录 / home / 包管理器）────────────────────────────
  let profileContext = null
  ctx.inject(['profileContext'], (s) => { profileContext = s?.profileContext ?? null })
  const facts = () => ({
    profileDir: profileContext?.dir ?? null,
    home: profileContext?.home ?? null,
    profileName: profileContext?.name ?? null,
    packageManager: profileContext?.packageManager ?? null
  })

  /** 活配置：优先读设置投影（含密钥明文），退化到装载时传入的 config */
  const readConfig = () => {
    let raw
    try {
      if (ctx.settings && typeof ctx.settings.describe === 'function') {
        const entry = ctx.settings.describe().find((x) => x.ns === NS)
        if (entry?.value?.sync) raw = entry.value.sync
      }
    } catch (err) {
      warn('[webdav-sync] settings.describe 失败，使用装载时配置: %s', err?.message ?? err)
    }
    return toEngineConfig(raw ?? config?.sync ?? {})
  }

  /** 写回配置：只有 .volatile() 子树可写，落进 profile 的 cordis.patch.yml */
  const writeConfig = async (patch) => {
    if (!ctx.settings || typeof ctx.settings.update !== 'function') {
      throw new Error('settings 服务不可用，无法写入配置')
    }
    await ctx.settings.update(NS, { sync: patch })
  }

  const currentRoot = () => resolveSessionsRoot(readConfig(), facts().home)
  const stateDir = () => join(
    facts().home ?? process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh'),
    'webdav-sync'
  )

  let sessionsSvc = null
  ctx.inject(['sessions'], (svcs) => { sessionsSvc = svcs?.sessions ?? null })
  const isLive = (sessionId) => {
    try {
      return Boolean(sessionId && sessionsSvc && typeof sessionsSvc.get === 'function' && sessionsSvc.get(sessionId))
    } catch {
      return false
    }
  }

  // profileContext 可能晚于 apply 出现，所以传函数而不是值：引擎每次调用时重新取。
  const service = createService({
    WebDavClient,
    sessionsRoot: currentRoot,
    logger: log,
    isLive,
    stateDir: stateDir,
    dshVersion: detectDshVersion(),
    facts
  })

  // ── HTTP 路由（浏览器 / 集成用）──────────────────────────────────────────
  // 坑点：必须把**注入后的作用域 s** 传下去。cordis 里访问未 inject 的服务属性会直接抛
  // "cannot get property X without inject"——把外层 ctx 传进 registerRoutes 就踩这个坑，
  // 表现为路由静默 404（插件看起来挂上了，但 handler 从没注册成功）。
  ctx.inject(['webServer', 'connection'], (s) => {
    if (!s?.webServer) return
    ctx.effect(
      () => registerRoutes(s, service, readConfig, writeConfig, { runInstall, facts }),
      'webdav-sync: routes'
    )
  })

  /**
   * 恢复环境后要把依赖装回来。用 profile 自己的包管理器（`ctx.profileContext.packageManager`）：
   * 打包版应用用内置 pnpm、开发版用 PATH 里的 pnpm，插件不需要自己猜。
   */
  async function runInstall() {
    const { profileDir, packageManager } = facts()
    if (!profileDir) return { ok: false, error: 'profileContext 不可用，无法定位 profile 目录' }
    const command = packageManager?.command ?? 'pnpm'
    const args = [...(packageManager?.args ?? []), 'install']
    return await new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: profileDir,
        env: { ...process.env, ...(packageManager?.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let output = ''
      const collect = (chunk) => {
        output += chunk.toString()
        if (output.length > 200_000) output = output.slice(-100_000)
      }
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)
      const timer = setTimeout(() => { try { child.kill('SIGTERM') } catch { /* ignore */ } }, 5 * 60_000)
      child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err.message, output }) })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve(code === 0 ? { ok: true, code, output } : { ok: false, error: `pnpm 退出码 ${code}`, output })
      })
    })
  }

  // ── 自动推送（可关；定时器必须 unref + ctx.effect 回收）─────────────────
  ctx.effect(() => {
    const cfg = readConfig()
    const minutes = Number(cfg.automaticIntervalMinutes) || 0
    if (!cfg.enabled || minutes <= 0) return () => {}
    const timer = setInterval(() => {
      const live = readConfig()
      if (!live.enabled) return
      service.push(live).then((r) => {
        if (r.uploaded > 0 || r.errors.length > 0) {
          log.info?.('[webdav-sync] 自动推送 uploaded=%d errors=%d', r.uploaded, r.errors.length)
        }
      }).catch((err) => warn('[webdav-sync] 自动推送失败: %s', err?.message ?? err))
    }, minutes * 60_000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'webdav-sync: auto push timer')

  log.info?.('[webdav-sync] mounted; sessionsRoot=%s device=%s', currentRoot(), hostname())
  try {
    const namespaces = ctx.settings?.describe?.().map((x) => x.ns) ?? []
    log.info?.('[webdav-sync] settings namespaces: %s', namespaces.join(', '))
  } catch (err) {
    warn('[webdav-sync] describe 自检失败: %s', err?.message ?? err)
  }
}
