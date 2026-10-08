/**
 * 版本机制：回答"哪一份是最新的"。
 *
 * 三层信息，各司其职：
 *  1. `sha1`       —— 内容身份。相同即相同，不参与排序。
 *  2. `rev`        —— 逻辑版本号（每文件计数器）。两端共享 lineage，所以可直接比较；
 *                     不受机器时钟偏差影响，是**主判据**。
 *  3. `updatedAt`  —— 人类可读时间（取源文件 mtime）。用于展示，也作为 rev 平手时的次判据。
 *  4. `device`     —— 最后写入者。用于溯源，以及最后的确定性平手判据。
 *
 * 三方比较：base（本机记录的"上次同步时的共同祖先"）决定「谁改了」，
 * 只有 base 存在时才能区分「一端改了」和「两端都改了」。后者就是冲突。
 */

export const MANIFEST_SCHEMA = 2

/** 冲突解决策略 */
export const POLICIES = ['prefer-newer', 'keep-local', 'keep-remote', 'keep-both', 'manual']

/**
 * 把任意版本的远端 manifest 归一化成 v2 形状。
 * v1 只有 `files: {rel: {size, sha1, ...}}`，升级时按 rev=0 对待（视为"未知版本，最旧"）。
 */
export function normalizeManifest(raw) {
  const manifest = raw && typeof raw === 'object' ? raw : {}
  const entries = {}
  const legacy = !manifest.entries && Boolean(manifest.files)
  const source = manifest.entries && typeof manifest.entries === 'object' ? manifest.entries : manifest.files
  for (const [rawRel, value] of Object.entries(source ?? {})) {
    if (!value || typeof value !== 'object') continue
    // v1 清单的 key 是会话相对路径（没有 `sessions/` 前缀），这里补上前缀，
    // 让 v2 的 key 统一是「<源目录>/<相对路径>」，远端文件位置不变。
    const rel = legacy && !rawRel.startsWith('sessions/') ? `sessions/${rawRel}` : rawRel
    const session = value.session ?? (value.sessionId || value.cwd
      ? { id: value.sessionId, cwd: value.cwd ?? null, version: value.version ?? null, projectDir: value.projectDir ?? null, name: value.name ?? null }
      : undefined)
    entries[rel] = {
      kind: value.kind ?? (rel.startsWith('sessions/') ? 'session' : 'env'),
      size: Number(value.size) || 0,
      sha1: String(value.sha1 ?? ''),
      rev: Number(value.rev) || 0,
      updatedAt: value.updatedAt ?? manifest.updatedAt ?? null,
      device: value.device ?? manifest.device?.id ?? null,
      ...(value.meta ?? session ? { meta: value.meta ?? { session } } : {})
    }
  }
  return {
    schema: MANIFEST_SCHEMA,
    revision: manifest.revision ?? null,
    generation: Number(manifest.generation) || 0,
    updatedAt: manifest.updatedAt ?? null,
    device: manifest.device ?? null,
    devices: manifest.devices ?? {},
    entries
  }
}

export function emptyManifest() {
  return { schema: MANIFEST_SCHEMA, revision: null, generation: 0, updatedAt: null, device: null, devices: {}, entries: {} }
}

function inferKind(rel) {
  return rel.startsWith('sessions/') ? 'session' : 'env'
}
/**
 * 排序：a 比 b 新返回正数，旧返回负数，无法区分返回 0。
 * rev 为主判据；时间只作次判据（允许时钟偏差）；device 作确定性平手判据。
 */
export function compareVersion(a, b) {
  const ra = Number(a?.rev) || 0
  const rb = Number(b?.rev) || 0
  if (ra !== rb) return ra > rb ? 1 : -1
  const ta = timeOf(a)
  const tb = timeOf(b)
  if (ta !== tb) return ta > tb ? 1 : -1
  const da = String(a?.device ?? '')
  const db = String(b?.device ?? '')
  if (da === db) return 0
  // 平手时用 device 字典序，保证两端各自算出同一结果（确定性收敛）
  return da < db ? 1 : -1
}

function timeOf(entry) {
  const value = entry?.updatedAt
  if (!value) return 0
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : 0
}

/** 只比较内容身份 */
export function sameContent(a, b) {
  return Boolean(a?.sha1) && a.sha1 === b?.sha1
}

/**
 * 三方比较，得出这一项该 push / pull / 不动 / 冲突。
 *
 * @param {object} input
 * @param {{rel:string,sha1:string,size?:number,kind?:string}|null} input.local  本地现状
 * @param {object|null} input.remote  远端 manifest 里的条目
 * @param {{sha1:string,rev?:number}|null} input.base  上次同步时的共同祖先
 * @param {string} input.policy
 */
/** 本机条目只有 mtimeMs，补成与远端 updatedAt 可直接比较的时间戳 */
function withLocalStamp(entry) {
  if (!entry) return entry
  if (entry.updatedAt || !entry.mtimeMs) return entry
  return { ...entry, updatedAt: new Date(entry.mtimeMs).toISOString() }
}

/**
 * 比较"本机文件"与"云端条目"谁更晚。
 *
 * 刻意不走 compareVersion 的 rev 优先：本机条目不在 manifest 里，rev 恒为 0，
 * 按 rev 比等于永远判定"云端更新"——于是 prefer-newer 退化成 keep-remote，
 * 本机后改的内容永远推不上去（备份悄悄变旧，界面上永远显示"待恢复"）。
 * 本机文件只有 mtimeMs，云端只有 updatedAt，所以只能比时间；
 * 借用 compareVersion 的余下规则（时间 → device 字典序）保证两端收敛到同一结果。
 */
export function compareLocalRemote(local, remote) {
  return compareVersion({ ...withLocalStamp(local), rev: 0 }, { ...remote, rev: 0 })
}

/** @deprecated 用 compareLocalRemote（名字更准确） */
export const compareWithoutBase = compareLocalRemote

export function decide({ local, remote, base = null, policy = 'prefer-newer', rel = null }) {
  // rel 必须显式传：远端条目与 base 条目里都没有 rel 字段，
  // 靠对象推断会在"本地不存在"（=纯拉取）时退化成空串。
  const key = rel ?? local?.rel ?? remote?.rel ?? base?.rel ?? ''
  const out = { rel: key, action: 'identical', reason: '', conflict: false, winner: null, resolvedBy: null, local: local ?? null, remote: remote ?? null, base: base ?? null }

  if (!local && !remote) return { ...out, action: 'drop', reason: 'missing-both' }
  if (!local) return { ...out, action: 'pull', reason: 'new-remote', winner: 'remote' }
  if (!remote) return { ...out, action: 'push', reason: 'new-local', winner: 'local' }
  if (sameContent(local, remote)) return { ...out, action: 'identical', reason: 'content-equal' }

  // 内容不同。有 base 才能区分"一端改了"和"两端都改了"。
  const localChanged = !base || !sameContent(local, base)
  const remoteChanged = !base || !sameContent(remote, base)

  if (base && localChanged && !remoteChanged) return { ...out, action: 'push', reason: 'local-changed', winner: 'local' }
  if (base && !localChanged && remoteChanged) return { ...out, action: 'pull', reason: 'remote-changed', winner: 'remote' }

  // 冲突：两端相对 base 都变了（或本机没有 base 无从判断）
  const conflict = { ...out, conflict: true, reason: base ? 'both-changed' : 'no-base-differs' }
  if (policy === 'manual') return { ...conflict, action: 'conflict', resolvedBy: 'manual' }
  if (policy === 'keep-local') return { ...conflict, action: 'push', winner: 'local', resolvedBy: 'keep-local' }
  if (policy === 'keep-remote') return { ...conflict, action: 'pull', winner: 'remote', resolvedBy: 'keep-remote' }

  // 冲突（含无 base）一律按"谁写得更晚"收敛，理由见 compareLocalRemote
  const newer = compareLocalRemote(local, remote)
  if (policy === 'keep-both' || newer === 0) {
    // keep-both：保留本地为准，同时把远端另存为副本（不丢任何一边）
    return { ...conflict, action: 'push', winner: 'local', resolvedBy: 'keep-both' }
  }
  return newer > 0
    ? { ...conflict, action: 'push', winner: 'local', resolvedBy: 'prefer-newer' }
    : { ...conflict, action: 'pull', winner: 'remote', resolvedBy: 'prefer-newer' }
}

/** 冲突双方的可读描述，用于状态展示与副本命名 */
export function describeSide(entry) {
  if (!entry) return '（无）'
  const when = entry.updatedAt ? new Date(entry.updatedAt).toISOString() : '未知时间'
  const who = entry.device ? String(entry.device).slice(0, 8) : '未知设备'
  return `r${entry.rev ?? 0} @ ${when} by ${who}`
}

/**
 * 本次 push 后这个文件应有的 rev。
 * 只有内容相对 base 变了才递增：这样"没变"不会虚增版本，两端才能收敛到同一个 rev。
 */
export function nextRev({ local, remote, base }) {
  const remoteRev = Number(remote?.rev) || 0
  const baseRev = Number(base?.rev) || 0
  const changed = !base || !sameContent(local, base)
  if (!changed) return remoteRev || 1
  return Math.max(remoteRev, baseRev) + 1
}

/** 构造写进 manifest 的条目 */
export function buildEntry(local, { rev, device, updatedAt, meta }) {
  return {
    kind: local.kind ?? 'env',
    size: local.size ?? 0,
    sha1: local.sha1,
    rev,
    updatedAt: updatedAt ?? new Date(local.mtimeMs ?? Date.now()).toISOString(),
    device,
    ...(meta ? { meta } : {})
  }
}

/** 汇总决策，给状态/预演用 */
export function summarize(decisions) {
  const out = { push: 0, pull: 0, identical: 0, conflict: 0, drop: 0 }
  for (const d of decisions) out[d.action === 'conflict' ? 'conflict' : d.action] = (out[d.action === 'conflict' ? 'conflict' : d.action] ?? 0) + 1
  return out
}
