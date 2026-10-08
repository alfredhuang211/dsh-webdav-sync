/**
 * dsh-webdav-sync —— host 插件入口。
 *
 * 形态要点：
 *  - `export const inject = ['settings']` 是**硬依赖**：缺服务则这一行不激活；
 *    其他服务（webServer / connection / commands / sessions / profileContext）走 ctx.inject 动态接；
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

  // ── 会话内命令：/webdav-sync push|pull|plan|status|test|install ──
  ctx.inject(['commands'], (s) => {
    if (!s?.commands) return
    ctx.effect(() => s.commands.register({
      name: 'webdav-sync',
      description: '同步会话与插件环境到 WebDAV',
      input: { hint: 'push|pull|plan|status|test|install' },
      handler: async ({ rawInput }) => {
        const verb = String(rawInput ?? '').trim().split(/\s+/)[0] || 'status'
        const cfg = readConfig()
        try {
          if (verb === 'status') {
            const r = await service.status(cfg)
            const cmp = r.comparison ?? { push: 0, pull: 0, conflict: 0 }
            return {
              kind: 'success',
              text: [
                `WebDAV ${r.reachable ? '可达' : '不可达'}${r.error ? ` (${r.error})` : ''}`,
                `云端：第 ${r.remote.generation ?? 0} 代${r.remote.updatedAt ? ` @ ${r.remote.updatedAt}` : ''}${r.remote.device?.label ? ` by ${r.remote.device.label}` : ''}，${r.remote.files} 个文件`,
                `本机：${r.local.sessions} 个会话 / ${r.local.envFiles} 个环境文件（设备 ${r.device.label ?? r.device.id}）`,
                `差异：待上传 ${cmp.push}，待恢复 ${cmp.pull}，冲突 ${cmp.conflict ?? 0}`
              ].join('\n')
            }
          }
          if (verb === 'test') {
            const r = await service.testConnection(cfg)
            return { kind: 'success', text: `连接成功：${r.url} (HTTP ${r.status})` }
          }
          if (verb === 'plan') {
            const r = await service.plan(cfg)
            return { kind: 'success', text: `待上传 ${r.toUpload.length}，待恢复 ${r.toPull.length}，冲突 ${r.conflicts.length}（策略 ${r.policy}）` }
          }
          if (verb === 'push') {
            const r = await service.push(cfg)
            return {
              kind: r.errors.length ? 'error' : 'success',
              text: `推送 ${r.status}：上传 ${r.uploaded}（会话 ${r.bySource.sessions.uploaded}，环境 ${r.bySource.environment.uploaded}），未变 ${r.unchanged}，第 ${r.generation} 代${r.conflicts.length ? `，冲突 ${r.conflicts.length}` : ''}${r.errors.length ? `\n${r.errors.slice(0, 5).join('\n')}` : ''}`
            }
          }
          if (verb === 'pull') {
            const force = /\bforce\b/.test(String(rawInput ?? ''))
            const r = await service.pull({ ...cfg, force })
            return {
              kind: r.errors.length ? 'error' : 'success',
              text: `恢复 ${r.status}：下载 ${r.downloaded}（会话 ${r.bySource.sessions.downloaded}，环境 ${r.bySource.environment.downloaded}），跳过 ${r.skipped}，运行中 ${r.live}，备份 ${r.backedUp}${r.conflicts.length ? `，冲突 ${r.conflicts.length}` : ''}${r.errors.length ? `\n${r.errors.slice(0, 5).join('\n')}` : ''}`
            }
          }
          if (verb === 'install') {
            const r = await runInstall()
            return {
              kind: r.ok ? 'success' : 'error',
              text: r.ok ? `依赖安装完成\n${r.output.slice(-800)}` : `依赖安装失败：${r.error}\n${(r.output ?? '').slice(-800)}`
            }
          }
          return { kind: 'error', text: `未知动作 ${verb}，可用：push|pull|plan|status|test|install` }
        } catch (err) {
          return { kind: 'error', text: err?.message ?? String(err) }
        }
      }
    }), 'webdav-sync: command')
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
