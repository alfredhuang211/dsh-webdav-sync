/**
 * 本机同步状态。它的存在是为了回答一个三方比较问题：
 * 「本地这份、远端那份、上次同步时的那份」——没有第三个就没法区分
 * "只有一端改了"（可直接覆盖）和"两端都改了"（冲突，不能默默覆盖）。
 *
 * 位置：`<$DSH_HOME>/webdav-sync/state.json`（本机私有，不上传）
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MANIFEST_SCHEMA } from './versioning.js'

export function stateFile(stateDir) {
  return join(stateDir, 'state.json')
}

function newDeviceId() {
  return `dev-${randomBytes(6).toString('hex')}`
}

export async function loadState(stateDir, identity = {}) {
  let raw = null
  if (stateDir) {
    try {
      raw = JSON.parse(await readFile(stateFile(stateDir), 'utf8'))
    } catch (err) {
      if (err?.code !== 'ENOENT') raw = null
    }
  }
  const state = {
    schema: MANIFEST_SCHEMA,
    device: {
      id: raw?.device?.id ?? newDeviceId(),
      label: identity.label ?? raw?.device?.label ?? null,
      platform: identity.platform ?? raw?.device?.platform ?? null,
      dshVersion: identity.dshVersion ?? raw?.device?.dshVersion ?? null,
      profile: identity.profile ?? raw?.device?.profile ?? null,
      createdAt: raw?.device?.createdAt ?? new Date().toISOString()
    },
    base: raw?.base && typeof raw.base === 'object' ? { ...raw.base } : {},
    generation: Number(raw?.generation) || 0,
    lastPush: raw?.lastPush ?? null,
    lastPull: raw?.lastPull ?? null
  }
  // 身份信息可能变了（改标签 / 升级宿主 / 换 profile），顺手刷新
  for (const key of ['label', 'platform', 'dshVersion', 'profile']) {
    if (identity[key]) state.device[key] = identity[key]
  }
  return state
}

export async function saveState(stateDir, state) {
  // 没给状态目录（例如纯会话用法）时退化为进程内状态，不影响同步正确性，只是丢掉三方基准
  if (!stateDir) return state
  await mkdir(stateDir, { recursive: true })
  const target = stateFile(stateDir)
  const tmp = `${target}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(tmp, target)
  return state
}

/** 记录一项已同步到共同祖先 */
export function setBase(state, rel, entry) {
  state.base[rel] = {
    sha1: entry.sha1,
    rev: Number(entry.rev) || 0,
    updatedAt: entry.updatedAt ?? null,
    device: entry.device ?? null
  }
}

export function dropBase(state, rel) {
  delete state.base[rel]
}

/** 远端已不存在的条目，base 也要清掉，否则会永久视为冲突 */
export function pruneBase(state, liveRels) {
  const keep = new Set(liveRels)
  for (const rel of Object.keys(state.base)) if (!keep.has(rel)) delete state.base[rel]
}

export function baseFor(state, rel) {
  return state.base[rel] ?? null
}
