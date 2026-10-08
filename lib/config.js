/**
 * 插件配置 schema。
 *
 * 关键规则（DSH 0.2.x）：
 *  1. 模块顶层导出 `Config`，宿主会自动为它生成设置投影（settings.describe() 的 ns = patch 行 id）；
 *  2. **只有 `.volatile()` 子树里的字段可写**。没有 volatile 字段时，
 *     用户一保存就会抛 `Plugin entry "..." has no volatile fields`；
 *  3. `role('secret')` 的字段在 `describe({redactSecrets:true})` 里被剥掉值，
 *     所以不要拿这个投影回写（会静默清空密码）——本插件只读它、不回写。
 */
import Schema from '@deepseek-ai/schemastery'

/** patch 行 id，同时也是设置命名空间 */
export const NS = 'webdav-sync'

/** 冲突策略，与 lib/versioning.js 的 POLICIES 保持一致 */
export const CONFLICT_POLICIES = ['prefer-newer', 'keep-local', 'keep-remote', 'keep-both', 'manual']

export const Config = Schema.object({
  sync: Schema.object({
    enabled: Schema.boolean().default(false).description('总开关（关闭时不注册命令与自动同步）'),
    remoteUrl: Schema.string()
      .default('')
      .description('WebDAV 根地址，例如 https://dav.jianguoyun.com/dav/（坚果云需用应用专用密码）'),
    username: Schema.string().default('').description('WebDAV 用户名'),
    password: Schema.string().default('').role('secret').description('WebDAV 密码（只写不读）'),
    basePath: Schema.string().default('dsh-sessions').description('服务器上的子目录'),
    sessionsRoot: Schema.string().default('').description('本机会话根目录；留空 = $DSH_HOME/sessions'),
    deviceLabel: Schema.string().default('').description('本机名称（写入清单用于区分设备；留空则用主机名）'),

    // ── 同步内容 ───────────────────────────────────────────────────────────
    syncSessions: Schema.boolean().default(true).description('同步会话日志（字节级）'),
    syncEnvironment: Schema.boolean().default(true).description('同步插件环境（依赖声明、版本锁定、插件配置）'),
    envIncludeHomePatch: Schema.boolean().default(true).description('环境同步是否包含全局补丁层 $DSH_HOME/cordis.patch.yml'),
    envIncludeMarketState: Schema.boolean().default(false).description('环境同步是否包含插件市场的分组/禁用状态'),
    envExtraFiles: Schema.array(Schema.string()).default([]).description('额外要同步的文件（profile 相对路径或绝对路径）'),
    skipSelfConfig: Schema.boolean()
      .default(true)
      .description('两侧都剥离本插件自身的配置行，避免换机恢复后把同步目标改回旧机器'),

    // ── 版本与冲突 ─────────────────────────────────────────────────────────
    conflictPolicy: Schema.union(CONFLICT_POLICIES)
      .default('prefer-newer')
      .description('两端都改动时的取舍：prefer-newer(比版本/时间) / keep-local / keep-remote / keep-both / manual'),
    conflictKeepCopy: Schema.boolean().default(true).description('冲突落败的一方另存为 .conflict-* 副本，绝不静默丢弃'),

    // ── 行为 ───────────────────────────────────────────────────────────────
    automaticIntervalMinutes: Schema.number().min(0).default(0).description('自动推送间隔（分钟），0 = 关闭'),
    pruneRemote: Schema.boolean().default(false).description('推送时删除云端已被本地删除的文件（默认关闭）'),
    pullOverwrite: Schema.boolean()
      .default(false)
      .description('恢复时覆盖“本机也改过”的文件；本机自上次同步未改动时始终可安全覆盖'),
    timeoutMs: Schema.number().min(1000).default(30000).description('单次 WebDAV 请求超时（毫秒）')
  }).volatile()
})

/** 从 schema 取一份纯 JS 默认值，作为 describe() 不可用时的兜底 */
export function defaults() {
  // 注意：不能写 `Config({}).sync` —— schemastery 不会在那一步填默认值，
  // 实测返回的是空对象，于是 basePath/timeoutMs 全变 undefined
  // （basePath 变空串会把文件传到错误的目录）。默认值直接从 schema 的 dict 取。
  const out = {}
  for (const [key, schema] of Object.entries(Config.dict?.sync?.dict ?? {})) {
    const value = schema?.meta?.default
    out[key] = Array.isArray(value) ? [...value] : value
  }
  return out
}

/** 把插件配置映射成引擎要的 cfg（含默认值与 include/exclude 的展开） */
export function toEngineConfig(raw = {}) {
  const cfg = { ...defaults(), ...raw }
  return {
    ...cfg,
    sources: { sessions: cfg.syncSessions !== false, environment: cfg.syncEnvironment !== false },
    environment: {
      files: [],
      excludeFiles: [
        ...(cfg.envIncludeHomePatch === false ? ['homePatch'] : []),
        ...(cfg.envIncludeMarketState === false ? ['marketState'] : [])
      ],
      extraFiles: Array.isArray(cfg.envExtraFiles) ? cfg.envExtraFiles : [],
      skipSelfConfig: cfg.skipSelfConfig !== false,
      inventory: true
    }
  }
}
