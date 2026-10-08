/**
 * 同源 HTTP 路由。第三方插件无法往 harness 的 RPC 表里加方法，
 * 但 webServer seam 是公开的：注册自己的路径，浏览器端用普通 fetch 调。
 *
 * 安全要点：**必须**先过 `ctx.connection.requestRejection(req)` 信任栅栏，
 * 否则任意网页都能借用户浏览器打本机（CSRF / DNS rebinding）。
 * 注意：插件自注册的路由不吃 /api 前缀那套 Host/Origin fence，必须自己挡。
 */

const PREFIX = '/webdav-sync'

/** 允许客户端写入的字段白名单（永远不含只读/派生字段） */
const WRITABLE = new Set([
  'enabled', 'remoteUrl', 'username', 'password', 'basePath', 'sessionsRoot', 'deviceLabel',
  'syncSessions', 'syncEnvironment', 'envIncludeHomePatch', 'envIncludeMarketState',
  'envExtraFiles', 'skipSelfConfig', 'conflictPolicy', 'conflictKeepCopy',
  'automaticIntervalMinutes', 'pruneRemote', 'pullOverwrite', 'timeoutMs'
])

const FIELDS = [
  { key: 'enabled', label: '启用插件', type: 'boolean', group: '连接' },
  { key: 'remoteUrl', label: 'WebDAV 地址', type: 'text', placeholder: 'https://dav.jianguoyun.com/dav/', group: '连接' },
  { key: 'username', label: '用户名', type: 'text', group: '连接' },
  { key: 'password', label: '密码 / 应用专用密码', type: 'password', group: '连接' },
  { key: 'basePath', label: '服务器子目录', type: 'text', group: '连接' },
  { key: 'timeoutMs', label: '请求超时（毫秒）', type: 'number', group: '连接' },
  { key: 'deviceLabel', label: '本机名称（写进清单用于区分设备）', type: 'text', group: '连接' },

  { key: 'syncSessions', label: '同步会话日志', type: 'boolean', group: '同步内容' },
  { key: 'syncEnvironment', label: '同步插件环境（依赖声明 / 版本锁定 / 插件配置）', type: 'boolean', group: '同步内容' },
  { key: 'sessionsRoot', label: '本机会话根目录（留空 = $DSH_HOME/sessions）', type: 'text', group: '同步内容' },
  { key: 'envIncludeHomePatch', label: '环境同步包含全局补丁层 $DSH_HOME/cordis.patch.yml', type: 'boolean', group: '同步内容' },
  { key: 'envIncludeMarketState', label: '环境同步包含插件市场分组/禁用状态', type: 'boolean', group: '同步内容' },
  { key: 'envExtraFiles', label: '额外同步文件（每行一个，profile 相对或绝对路径）', type: 'list', group: '同步内容' },
  { key: 'skipSelfConfig', label: '剥离本插件自身配置行（避免换机后把同步目标改回旧机器）', type: 'boolean', group: '同步内容' },

  { key: 'conflictPolicy', label: '两端都改动时', type: 'select', group: '版本与冲突', options: [
    { value: 'prefer-newer', label: '取较新的一份（先比版本号，再比时间）' },
    { value: 'keep-local', label: '总是保留本机' },
    { value: 'keep-remote', label: '总是采用云端' },
    { value: 'keep-both', label: '保留本机并另存云端副本' },
    { value: 'manual', label: '不自动处理，只报告冲突' }
  ] },
  { key: 'conflictKeepCopy', label: '冲突落败一方另存为 .conflict-* 副本', type: 'boolean', group: '版本与冲突' },
  { key: 'pullOverwrite', label: '恢复时覆盖"本机也改过"的文件', type: 'boolean', group: '版本与冲突' },
  { key: 'pruneRemote', label: '推送时清理云端已被本地删除的文件', type: 'boolean', group: '版本与冲突' },
  { key: 'automaticIntervalMinutes', label: '自动推送间隔（分钟，0=关闭）', type: 'number', group: '版本与冲突' }
]

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** 公开投影：明文密码永不回浏览器，只回 hasPassword */
function publicConfig(cfg) {
  const clone = { ...cfg }
  const hasPassword = Boolean(clone.password)
  delete clone.password
  return { values: clone, fields: FIELDS, hasPassword }
}

/**
 * @param {object} ctx cordis 上下文
 * @param {object} service 同步引擎
 * @param {() => object} getConfig 读活配置（含密钥）
 * @param {(patch: object) => Promise<void>} writeConfig 写回配置（走 ctx.settings.update）
 * @param {{runInstall?: () => Promise<object>, facts?: () => object}} [hooks]
 */
export function registerRoutes(ctx, service, getConfig, writeConfig, hooks = {}) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: async (req, res) => {
      const rejection = ctx.connection?.requestRejection?.(req)
      if (rejection !== undefined) {
        res.writeHead(rejection)
        res.end()
        return
      }
      const route = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.slice(PREFIX.length) || '/'
      const method = (req.method ?? 'GET').toUpperCase()
      try {
        if (method === 'GET' && route === '/config') return send(res, 200, { ok: true, value: publicConfig(getConfig()) })
        if (method === 'POST' && route === '/config') {
          const body = await readBody(req)
          const patch = {}
          for (const [key, value] of Object.entries(body?.patch ?? {})) {
            if (WRITABLE.has(key)) patch[key] = value
          }
          if (body?.clearPassword === true) patch.password = ''
          if (Object.keys(patch).length === 0) return send(res, 400, { ok: false, error: { code: 'empty-patch', message: '没有可写入的字段' } })
          await writeConfig(patch)
          return send(res, 200, { ok: true, value: publicConfig(getConfig()) })
        }
        const cfg = getConfig()
        if (method === 'GET' && route === '/status') return send(res, 200, { ok: true, value: await service.status(cfg) })
        if (method === 'GET' && route === '/plan') return send(res, 200, { ok: true, value: await service.plan(cfg) })
        if (method === 'POST' && route === '/test') return send(res, 200, { ok: true, value: await service.testConnection(cfg) })
        if (method === 'POST' && route === '/push') return send(res, 200, { ok: true, value: await service.push(cfg) })
        if (method === 'POST' && route === '/pull') {
          const wantForce = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('force') === '1'
          let forced = wantForce
          if (!forced) {
            try { forced = Boolean((await readBody(req, 4096))?.force) } catch { forced = false }
          }
          return send(res, 200, { ok: true, value: await service.pull({ ...cfg, force: forced }) })
        }
        if (method === 'POST' && route === '/install') {
          if (typeof hooks.runInstall !== 'function') return send(res, 501, { ok: false, error: { code: 'unsupported', message: '当前宿主未提供包管理器' } })
          return send(res, 200, { ok: true, value: await hooks.runInstall() })
        }
        return send(res, 404, { ok: false, error: { code: 'not-found', message: `${method} ${route}` } })
      } catch (err) {
        return send(res, 500, { ok: false, error: { code: 'internal', message: err?.message ?? String(err) } })
      }
    }
  })
}
