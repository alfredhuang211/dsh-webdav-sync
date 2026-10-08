/**
 * 环境侧采集。
 *
 * 哪些文件才算"当前的插件环境"？实测 `~/.dsh/profiles/<p>/` 的构成后，结论是：
 *   - `package.json`          —— 声明了装了什么（dependencies + dsh.profile.bundles）
 *   - `cordis.patch.yml`      —— 插件的配置覆盖与 enabled/disabled 开关（**官方编辑入口**）
 *   - `pnpm-lock.yaml`        —— 每个包的精确版本（"哪一份更新"要靠它）
 *   - `pnpm-workspace.yaml`   —— nodeLinker 等安装设置
 *   - `<home>/cordis.patch.yml` —— 全局补丁层（会覆盖 profile 层）
 *   - `<profile>/.dsh-market/state.json` —— 市场分组/禁用状态（可选）
 *
 * 明确**不**同步：
 *   - `node_modules/`：体积大、可重装、含平台相关二进制；它是产物不是声明。
 *   - `cordis.yml`：文件里自带注释 "Edit cordis.patch.yml, not this file"，是组合产物。
 *   - `.dsh-market/discovery-compatibility-v1.json`：120KB 的缓存。
 */
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** 默认环境文件集。`key` 用于配置里的包含/排除开关。 */
export const ENV_FILES = [
  { key: 'profilePackage', rel: 'environment/profile/package.json', label: '插件依赖声明', from: 'profile', sub: 'package.json' },
  { key: 'profilePatch', rel: 'environment/profile/cordis.patch.yml', label: '插件配置与启用状态', from: 'profile', sub: 'cordis.patch.yml', mayContainSecrets: true },
  { key: 'profileLock', rel: 'environment/profile/pnpm-lock.yaml', label: '精确版本锁定', from: 'profile', sub: 'pnpm-lock.yaml' },
  { key: 'profileWorkspace', rel: 'environment/profile/pnpm-workspace.yaml', label: '包管理器设置', from: 'profile', sub: 'pnpm-workspace.yaml' },
  { key: 'homePatch', rel: 'environment/home/cordis.patch.yml', label: '全局补丁层', from: 'home', sub: 'cordis.patch.yml', mayContainSecrets: true, mayBeMachineSpecific: true },
  { key: 'marketState', rel: 'environment/market/state.json', label: '插件市场分组/禁用', from: 'profile', sub: '.dsh-market/state.json', defaultOff: true }
]

function resolveRoot(profileDir, home, from) {
  if (from === 'home') return home
  return profileDir
}

/**
 * 发现本次要同步的环境文件。
 * @param {object} input
 * @param {string} input.profileDir profile 目录（`ctx.profileContext.dir`）
 * @param {string} input.home `$DSH_HOME`（`ctx.profileContext.home`）
 * @param {string[]} [input.include] 只保留这些 key（空 = 默认集）
 * @param {string[]} [input.exclude] 排除这些 key
 * @param {string[]} [input.extraFiles] 额外文件：绝对路径，或 profile 相对路径
 */
export async function discoverEnvFiles({ profileDir, home, include = [], exclude = [], extraFiles = [] }) {
  const found = []
  for (const spec of ENV_FILES) {
    if (include.length > 0 && !include.includes(spec.key)) continue
    if (exclude.includes(spec.key)) continue
    const root = resolveRoot(profileDir, home, spec.from)
    if (!root) continue
    const absPath = join(root, spec.sub)
    found.push({ ...spec, absPath })
  }
  for (const extra of extraFiles) {
    const absPath = extra.startsWith('/') ? extra : join(profileDir, extra)
    found.push({
      key: `extra:${extra}`,
      rel: `environment/extra/${extra.replace(/^\/+/, '').replace(/\//g, '__')}`,
      label: `额外文件 ${extra}`,
      absPath,
      mayContainSecrets: true
    })
  }
  return found
}

/** 读取一个环境文件的元数据；不存在则返回 null */
export async function readEnvEntry(spec, { sha1Of }) {
  let info
  try {
    info = await stat(spec.absPath)
  } catch (err) {
    if (err?.code === 'ENOENT') return null
    throw err
  }
  if (!info.isFile()) return null
  const bytes = await readFile(spec.absPath)
  return {
    rel: spec.rel,
    kind: 'env',
    absPath: spec.absPath,
    label: spec.label,
    key: spec.key,
    size: bytes.length,
    sha1: sha1Of(bytes),
    bytes,
    mtimeMs: info.mtimeMs,
    warnings: scanEnvWarnings(spec, bytes.toString('utf8'))
  }
}

/** 静态告警：密钥、机器相关路径、表达式 */
export function scanEnvWarnings(spec, text) {
  const warnings = []
  if (/^[\s-]*(password|apiKey|api_key|token|secret)\s*:\s*\S+/im.test(text)) warnings.push('可能含明文凭据')
  if (/file:\/\/\//.test(text)) warnings.push('含本机绝对路径（换机后可能失效）')
  if (/!!js\b/.test(text)) warnings.push('含 !!js 表达式（本地求值，不保证可移植）')
  if (spec.mayContainSecrets && warnings.length === 0) warnings.push('建议确认是否含凭据')
  return warnings
}

/**
 * 生成插件清单（"环境里装了什么、什么版本、开没开"）。
 * 注意：宿主自己的插件清单 API（`PluginInventoryEntry`）**不含版本号**，
 * 所以版本要自己从 profile 的 package.json + node_modules 里读。
 */
export async function buildInventory({ profileDir, home = null, profileName, device = null, dshVersion = null, now = null, sourceMtimeMs = null }) {
  const pkg = await readJson(join(profileDir, 'package.json'))
  const deps = pkg?.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
  const patchText = await readText(join(profileDir, 'cordis.patch.yml'))
  const disabled = parseDisabledIds(patchText)

  const plugins = []
  const seen = new Set()
  for (const [name, declared] of Object.entries(deps)) {
    seen.add(name)
    plugins.push({
      name,
      declaredRange: declared,
      version: await installedVersion(profileDir, name),
      role: bundles.includes(name) ? 'bundle+dependency' : 'dependency',
      enabled: !disabled.has(name)
    })
  }
  for (const name of bundles) {
    if (seen.has(name)) continue
    seen.add(name)
    plugins.push({
      name,
      declaredRange: null,
      version: await installedVersion(profileDir, name),
      role: 'bundle',
      enabled: !disabled.has(name)
    })
  }

  // 载荷刻意保持"确定性"：不含本机 home、不含设备 id（这些属于溯源信息，
  // 放在 manifest 条目上）。否则两台机器会因为这个字段不同而永远互相判为"有改动"。
  return {
    schema: 1,
    profile: profileName,
    dshVersion,
    plugins: plugins.sort((a, b) => a.name.localeCompare(b.name)),
    disabledEntryIds: [...disabled].sort()
  }
}

/** 从 patch 文本里挑出 `- id: X` + `disabled: true` 的条目（用于"哪些插件被关了"） */
export function parseDisabledIds(patchText) {
  const disabled = new Set()
  if (!patchText) return disabled
  let currentId = null
  let currentDisabled = false
  const flush = () => { if (currentId && currentDisabled) disabled.add(currentId) }
  for (const line of patchText.split('\n')) {
    const idMatch = /^\s*-\s*id:\s*['"]?([^'"\s#]+)['"]?\s*$/.exec(line)
    if (idMatch) {
      flush()
      currentId = idMatch[1]
      currentDisabled = false
      continue
    }
    if (/^\s*-\s+/.test(line)) {
      flush()
      currentId = null
      currentDisabled = false
      continue
    }
    if (currentId && /^\s*disabled:\s*true\s*$/i.test(line)) currentDisabled = true
  }
  flush()
  return disabled
}

async function installedVersion(profileDir, name) {
  const manifest = await readJson(join(profileDir, 'node_modules', name, 'package.json'))
  return manifest?.version ?? null
}

async function readJson(path) {
  const text = await readText(path)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return null
    throw err
  }
}

/** 两端插件清单差异：谁多了、谁少了、版本变了什么 */
export function diffInventory(mine, theirs) {
  const index = (inv) => new Map((inv?.plugins ?? []).map((p) => [p.name, p]))
  const a = index(mine)
  const b = index(theirs)
  const added = []
  const removed = []
  const changed = []
  const toggled = []
  for (const [name, remote] of b) {
    const local = a.get(name)
    if (!local) { added.push({ name, version: remote.version }); continue }
    if ((local.version ?? null) !== (remote.version ?? null)) changed.push({ name, from: local.version ?? '未安装', to: remote.version ?? '未安装' })
    if (local.enabled !== remote.enabled) toggled.push({ name, from: local.enabled, to: remote.enabled })
  }
  for (const [name, local] of a) if (!b.has(name)) removed.push({ name, version: local.version })
  return { added, removed, changed, toggled }
}

export function inventoryExists(home, profileDir) {
  return existsSync(join(profileDir, 'package.json')) && Boolean(home)
}

/**
 * 把本机 patch 里属于本插件自己的那一块，接回"从云端恢复来的" patch 文本。
 *
 * 为什么需要：推送时我们剥离了自己的配置行（避免自指），所以云端的 patch 里没有它。
 * 如果恢复时直接覆盖，用户刚在本机填好的 WebDAV 地址/密码就没了——换机恢复恰恰
 * 是为了重新配置，所以必须把本机那一行保留下来。
 *
 * 注意这只影响"落盘内容"：比较用的 sha1 仍是剥离后的投影，因此两端不会来回抖动。
 */
export function mergeSelfPatchRow(remoteText, localText, entryId) {
  const block = extractPatchRow(localText, entryId)
  if (!block) return { text: remoteText, merged: false }
  const head = remoteText.replace(/\n*$/, '\n')
  return { text: `${head}${block}`, merged: true }
}

/** 取出某个 id 的整块 patch 行（含其后缩进行），没有则返回 null */
export function extractPatchRow(text, entryId) {
  if (!text) return null
  const lines = text.split('\n')
  const out = []
  let taking = false
  for (const line of lines) {
    const isTopLevel = /^\s*-\s/.test(line)
    if (isTopLevel) {
      if (taking) break
      const idMatch = /^\s*-\s*id:\s*['"]?([^'"\s#]+)['"]?\s*$/.exec(line)
      taking = Boolean(idMatch && idMatch[1] === entryId)
    }
    if (taking) out.push(line)
  }
  if (out.length === 0) return null
  return `${out.join('\n').replace(/\n*$/, '')}\n`
}

/**
 * 从 patch 文本里剥掉指定 id 的整块条目。
 *
 * 为什么要剥掉本插件自己的那一行：插件自己的配置里存着 WebDAV 地址和密码。
 * 如果把它也同步走，换机恢复后「同步目标」会被悄悄改写成旧机器的地址，
 * 而用户恰恰是为了在新机器上重新配置才恢复的——会形成自指。
 * 两侧对称剥离，远端就不会有这个自指行。
 */
export function stripSelfPatchRow(text, entryId) {
  if (!text) return { text, stripped: false }
  const lines = text.split('\n')
  const out = []
  let skipping = false
  let stripped = false
  for (const line of lines) {
    const isTopLevel = /^\s*-\s/.test(line)
    if (isTopLevel) {
      const idMatch = /^\s*-\s*id:\s*['"]?([^'"\s#]+)['"]?\s*$/.exec(line)
      skipping = Boolean(idMatch && idMatch[1] === entryId)
      if (skipping) {
        stripped = true
        continue
      }
    }
    if (skipping) continue
    out.push(line)
  }
  let result = out.join('\n')
  // 被剥掉的块若在文件末尾，会连带吃掉结尾空行——那会让"剥离后的投影"与云端字节
  // 不一致，进而每次同步都误判"本地已改动"，反复重传。这里把结尾换行还原。
  if (stripped && text.endsWith('\n') && result.length > 0 && !result.endsWith('\n')) result += '\n'
  return { text: result, stripped }
}
