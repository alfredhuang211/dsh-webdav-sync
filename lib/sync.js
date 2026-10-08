/**
 * 同步引擎 v2：**会话** + **插件环境** 两个源，带版本/时间/设备溯源与冲突检测。
 *
 * 版本机制（回答"哪一份最新"）：
 *   - 每个文件在远端 manifest 里带 `rev`（逻辑版本）、`updatedAt`（内容时间）、`device`（最后写入者）；
 *   - 本机 state.json 记录 `base`（上次同步的共同祖先），用于区分"一端改了"和"两端都改了"；
 *   - 冲突策略默认 `prefer-newer`：先比 rev，再比时间，最后用 device 字典序确定性收敛；
 *     落败一方默认另存为 `.conflict-<设备>-r<版本>` 副本，绝不静默丢弃。
 *
 * 安全红线（延续 v1 并加强）：
 *   - push 永不删本地；pull 永不删本地；
 *   - pull 覆盖的前提是"本地相对 base 没改过"（local == base 时覆盖不丢任何东西），
 *     否则必须显式打开 pullOverwrite；
 *   - 环境文件覆盖前先写 `.bak-<时间戳>`，且**永不触碰** node_modules；
 *   - 运行中的会话不参与覆盖。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { buildInventory, diffInventory, discoverEnvFiles, mergeSelfPatchRow, readEnvEntry, stripSelfPatchRow } from './env.js'
import { scanLocalSessions, targetDirFor } from './layout.js'
import { baseFor, loadState, pruneBase, saveState, setBase } from './state.js'
import { buildEntry, decide, describeSide, emptyManifest, nextRev, normalizeManifest, sameContent, summarize } from './versioning.js'

export const MANIFEST_NAME = 'manifest.json'
export const REMOTE_SESSIONS_DIR = 'sessions'
export const REMOTE_ENV_DIR = 'environment'
export const INVENTORY_REL = 'environment/inventory.json'
export const SELF_ENTRY_ID = 'webdav-sync'

export const sha1 = (buf) => createHash('sha1').update(buf).digest('hex')

const sourceOf = (rel) => (rel.startsWith(`${REMOTE_SESSIONS_DIR}/`) ? 'sessions' : 'environment')

export function createService({
  WebDavClient,
  sessionsRoot,
  logger = console,
  isLive = () => false,
  facts = () => ({}),
  stateDir = null,
  dshVersion = null
}) {
  const root = typeof sessionsRoot === 'function' ? sessionsRoot : () => sessionsRoot
  // profileContext 可能晚于插件装载出现，所以每次调用都重新取，不能在构造时固化。
  const env = () => facts() ?? {}

  const clientFor = (cfg) => {
    if (!cfg?.remoteUrl) throw new Error('未配置 remoteUrl（WebDAV 地址）')
    return new WebDavClient({
      baseUrl: cfg.remoteUrl,
      username: cfg.username,
      password: cfg.password,
      basePath: cfg.basePath,
      timeoutMs: cfg.timeoutMs
    })
  }

  const identity = (cfg) => ({
    label: cfg?.deviceLabel || null,
    platform: process.platform,
    dshVersion,
    profile: env().profileName
  })

  async function readManifest(client) {
    const buf = await client.getFile(MANIFEST_NAME)
    if (!buf) return emptyManifest()
    try {
      return normalizeManifest(JSON.parse(buf.toString('utf8')))
    } catch {
      logger.warn?.('[webdav-sync] 远端 manifest.json 无法解析，按空清单处理')
      return emptyManifest()
    }
  }

  // home 也可能迟到，所以 stateDir 允许传函数
  const stateDirOf = () => (typeof stateDir === 'function' ? stateDir() : stateDir)

  /** sha1 缓存：会话日志只追加，size+mtime 命中即可跳过重复哈希 */
  async function hashCached(state, absPath, size, mtimeMs) {
    const cache = (state.hashes ??= {})
    const hit = cache[absPath]
    if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.sha1
    const buf = await readFile(absPath)
    const digest = sha1(buf)
    cache[absPath] = { size, mtimeMs, sha1: digest }
    return digest
  }

  /** 采集本地两个源，产出统一的待同步条目 */
  async function collectLocal(cfg, state) {
    const entries = []
    const warnings = []
    const envTargets = new Map()

    if (cfg.sources?.sessions !== false) {
      for (const item of await scanLocalSessions(root())) {
        let digest
        try {
          digest = await hashCached(state, item.absPath, item.size, item.mtimeMs)
        } catch {
          continue
        }
        entries.push({
          rel: `${REMOTE_SESSIONS_DIR}/${item.relPath}`,
          kind: 'session',
          absPath: item.absPath,
          size: item.size,
          sha1: digest,
          mtimeMs: item.mtimeMs,
          pullable: true,
          meta: {
            session: {
              id: item.sessionId,
              cwd: item.cwd,
              version: item.version,
              projectDir: item.projectDir,
              name: item.name
            }
          }
        })
      }
    }

    const { profileDir, home, profileName } = env()
    if (cfg.sources?.environment !== false && profileDir && home) {
      const specs = await discoverEnvFiles({
        profileDir,
        home,
        include: cfg.environment?.files ?? [],
        exclude: cfg.environment?.excludeFiles ?? [],
        extraFiles: cfg.environment?.extraFiles ?? []
      })
      for (const spec of specs) {
        envTargets.set(spec.rel, spec.absPath)
        const entry = await readEnvEntry(spec, { sha1Of: sha1 })
        if (!entry) continue
        let bytes = entry.bytes
        const envWarnings = [...entry.warnings]
        if (entry.key === 'profilePatch' && cfg.environment?.skipSelfConfig !== false) {
          const stripped = stripSelfPatchRow(bytes.toString('utf8'), SELF_ENTRY_ID)
          if (stripped.stripped) {
            bytes = Buffer.from(stripped.text, 'utf8')
            envWarnings.push('已剥离本插件自身配置行（避免跨机自指）')
          }
        }
        const digest = sha1(bytes)
        entries.push({
          rel: spec.rel,
          kind: 'env',
          absPath: entry.absPath,
          size: bytes.length,
          sha1: digest,
          mtimeMs: entry.mtimeMs,
          bytes,
          pullable: true,
          meta: { env: { key: entry.key, label: entry.label, warnings: envWarnings } }
        })
        if (envWarnings.length) warnings.push({ rel: spec.rel, label: entry.label, warnings: envWarnings })
      }

      if (cfg.environment?.inventory !== false) {
        const inventory = await buildInventory({ profileDir, profileName, dshVersion })
        const bytes = Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`, 'utf8')
        entries.push({
          rel: INVENTORY_REL,
          kind: 'env',
          generated: true,
          pullable: false,
          size: bytes.length,
          sha1: sha1(bytes),
          mtimeMs: Date.now(),
          bytes,
          meta: { env: { key: 'inventory', label: '插件清单（含版本）', generated: true } }
        })
      }
    }

    return { entries, warnings, envTargets }
  }

  function planDecisions(localEntries, remote, state, cfg) {
    const localByRel = new Map(localEntries.map((e) => [e.rel, e]))
    const policy = cfg.conflictPolicy ?? 'prefer-newer'
    const rels = new Set([...localByRel.keys(), ...Object.keys(remote.entries)])
    const decisions = []
    for (const rel of rels) {
      decisions.push(decide({
        rel,
        local: localByRel.get(rel) ?? null,
        remote: remote.entries[rel] ?? null,
        base: baseFor(state, rel),
        policy
      }))
    }
    return { localByRel, decisions }
  }

  const brief = (d) => ({
    rel: d.rel,
    source: sourceOf(d.rel),
    reason: d.reason,
    conflict: d.conflict,
    winner: d.winner,
    resolvedBy: d.resolvedBy,
    local: d.local ? { sha1: d.local.sha1, size: d.local.size, rev: d.remote?.rev ?? 0 } : null,
    remote: d.remote ? { sha1: d.remote.sha1, size: d.remote.size, rev: d.remote.rev, updatedAt: d.remote.updatedAt, device: d.remote.device } : null
  })

  const conflictRecord = (d) => ({
    rel: d.rel,
    source: sourceOf(d.rel),
    reason: d.reason,
    resolvedBy: d.resolvedBy,
    winner: d.winner,
    localSide: describeSide(d.local),
    remoteSide: describeSide(d.remote)
  })

  /** 冲突落败方另存副本（默认开启），返回副本相对路径 */
  async function saveSidecar(absPath, bytes, tag) {
    const target = `${absPath}.conflict-${tag}`
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
    return target
  }

  async function push(cfg) {
    const started = Date.now()
    const client = clientFor(cfg)
    const state = await loadState(stateDirOf(), identity(cfg))
    const { entries: localEntries, warnings } = await collectLocal(cfg, state)
    const remote = await readManifest(client)
    const { localByRel, decisions } = planDecisions(localEntries, remote, state, cfg)

    const nextEntries = { ...remote.entries }
    const errors = []
    const conflicts = []
    const needsPull = []
    const sidecars = []
    const bySource = { sessions: { uploaded: 0, unchanged: 0 }, environment: { uploaded: 0, unchanged: 0 } }
    let uploaded = 0
    let unchanged = 0
    let pruned = 0

    for (const d of decisions) {
      const src = sourceOf(d.rel)
      // 冲突必须无条件记录：无论最终判给哪一端，用户都需要知道"两端都改过"
      if (d.conflict) conflicts.push(conflictRecord(d))
      if (d.action === 'identical') {
        unchanged++
        bySource[src].unchanged++
        // 内容相同 ⇒ 云端条目就是可信的三方祖先，落下 base。
        // 不落的话，全新 state 面对已有云端时所有文件都缺 base，之后本机
        // 任何改动都会被误报成"冲突"（reason=no-base-differs）而走不到正常推送。
        if (d.remote && !baseFor(state, d.rel)) setBase(state, d.rel, d.remote)
        continue
      }
      if (d.action === 'drop') continue
      if (d.action !== 'push') {
        // 'pull' = 云端较新；'conflict' = manual 策略下不动
        if (d.action === 'pull') needsPull.push(brief(d))
        continue
      }
      if (d.conflict && cfg.conflictKeepCopy !== false && d.remote && localByRel.get(d.rel)?.absPath) {
        try {
          const remoteBuf = await client.getFile(d.rel)
          if (remoteBuf) {
            const tag = `${String(d.remote.device ?? 'remote').slice(0, 8)}-r${d.remote.rev}`
            sidecars.push(await saveSidecar(localByRel.get(d.rel).absPath, remoteBuf, tag))
          }
        } catch (err) {
          errors.push(`冲突副本 ${d.rel}: ${err.message}`)
        }
      }

      const local = localByRel.get(d.rel)
      try {
        const buf = local.bytes ?? (await readFile(local.absPath))
        if (sha1(buf) !== local.sha1) {
          errors.push(`${d.rel}: 扫描后文件已变化，本次跳过`)
          continue
        }
        await client.putFile(d.rel, buf)
        uploaded++
        bySource[src].uploaded++
        const entry = buildEntry(local, {
          rev: nextRev({ local, remote: remote.entries[d.rel] ?? null, base: baseFor(state, d.rel) }),
          device: state.device.id,
          updatedAt: new Date(local.mtimeMs).toISOString(),
          meta: local.meta
        })
        nextEntries[d.rel] = entry
        setBase(state, d.rel, entry)
      } catch (err) {
        errors.push(`${d.rel}: ${err.message}`)
      }
    }

    // 清理远端孤儿（默认关闭；只删会话/环境目录下的文件，不删 manifest）
    if (cfg.pruneRemote) {
      for (const rel of Object.keys(remote.entries)) {
        if (localByRel.has(rel)) continue
        try {
          await client.remove(rel)
          delete nextEntries[rel]
          pruned++
        } catch (err) {
          errors.push(`prune ${rel}: ${err.message}`)
        }
      }
    }

    const changed = uploaded > 0 || pruned > 0
    const generation = changed ? (remote.generation || 0) + 1 : remote.generation || 0
    const manifest = {
      schema: 2,
      generation,
      updatedAt: changed ? new Date().toISOString() : (remote.updatedAt ?? new Date().toISOString()),
      device: { id: state.device.id, label: state.device.label, platform: state.device.platform },
      devices: mergeDevices(remote, state),
      entries: nextEntries
    }
    if (changed) await client.putFile(MANIFEST_NAME, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'))

    pruneBase(state, Object.keys(nextEntries))
    state.generation = generation
    state.lastPush = { at: new Date().toISOString(), uploaded, pruned, generation, conflicts: conflicts.length }
    await saveState(stateDirOf(), state)

    return {
      direction: 'push',
      status: errors.length ? 'partial' : 'ok',
      uploaded,
      unchanged,
      pruned,
      generation,
      changed,
      bySource,
      conflicts,
      sidecars,
      needsPull,
      summary: summarize(decisions),
      remoteUpdatedAt: manifest.updatedAt,
      warnings,
      errors,
      elapsedMs: Date.now() - started
    }
  }

  async function pull(cfg) {
    const started = Date.now()
    // force = 以云端为准：忽略"本机相对 base 已改动"，用它来做"这台机器就是照云端重建"。
    // 仍然遵守两条红线：运行中的会话不动、生成文件不回写。
    const force = Boolean(cfg.force)
    const client = clientFor(cfg)
    const state = await loadState(stateDirOf(), identity(cfg))
    const { entries: localEntries, warnings, envTargets } = await collectLocal(cfg, state)
    const remote = await readManifest(client)
    const { localByRel, decisions } = planDecisions(localEntries, remote, state, cfg)

    let downloaded = 0
    let skipped = 0
    let live = 0
    let backedUp = 0
    const errors = []
    const skippedReasons = []
    const conflicts = []
    const needsPush = []
    const bySource = { sessions: { downloaded: 0 }, environment: { downloaded: 0 } }

    for (const d of decisions) {
      const src = sourceOf(d.rel)
      if (d.conflict) conflicts.push(conflictRecord(d))
      // force 只用来覆盖"有差异"的项：内容相同的就不必重写（重写运行中的会话日志尤其没必要）
      const forcedRestore = force && Boolean(d.remote) && !d.remote.generated && d.action !== 'identical'
      if (d.action !== 'pull' && !forcedRestore) {
        // 内容相同 ⇒ 云端条目可作为三方祖先（见 push 中同一处理）
        if (d.action === 'identical' && d.remote && !baseFor(state, d.rel)) setBase(state, d.rel, d.remote)
        // 'push' = 本机较新；'identical'/'drop' 无事可做；'conflict' = manual 策略下不动
        if (d.action === 'push') {
          needsPush.push(brief(d))
          const local = localByRel.get(d.rel)
          if (d.conflict && cfg.conflictKeepCopy !== false && local?.absPath && local.bytes) {
            try {
              const file = await readFile(local.absPath)
              const tag = `local-${String(state.device.id).slice(0, 8)}-r${d.remote?.rev ?? 0}`
              skippedReasons.push(`冲突副本：${await saveSidecar(local.absPath, file, tag)}`)
            } catch (err) {
              errors.push(`冲突副本 ${d.rel}: ${err.message}`)
            }
          }
        }
        continue
      }

      const meta = d.remote
      const local = localByRel.get(d.rel)
      const base = baseFor(state, d.rel)
      // 覆盖安全判定：本地不存在，或本地相对 base 没改过（覆盖不丢任何东西）
      const safeToOverwrite = !local || (base && sameContent(local, base))
      if (local && !safeToOverwrite && !cfg.pullOverwrite && !force) {
        skipped++
        skippedReasons.push(`${d.rel}: 本机也改过（${describeSide(d.local?.sha1 ? { sha1: local.sha1, updatedAt: new Date(local.mtimeMs).toISOString(), rev: base?.rev ?? 0, device: state.device.id } : null)} vs ${describeSide(meta)}），未开启覆盖`)
        continue
      }
      if (meta.generated || local?.pullable === false) {
        skipped++
        skippedReasons.push(`${d.rel}: 生成文件，不回写本机`)
        continue
      }
      const sessionId = meta.meta?.session?.id ?? null
      if (src === 'sessions' && isLive(sessionId)) {
        live++
        skippedReasons.push(`${d.rel}: 会话正在运行，跳过`)
        continue
      }

      const target = targetFor(d, meta, localByRel, envTargets)
      if (!target) {
        errors.push(`${d.rel}: 无法解析本机落点`)
        continue
      }
      try {
        const buf = await client.getFile(d.rel)
        if (!buf) {
          errors.push(`${d.rel}: 远端文件缺失`)
          continue
        }
        if (meta.sha1 && sha1(buf) !== meta.sha1) {
          errors.push(`${d.rel}: sha1 与清单不符（远端被改动？）`)
          continue
        }
        // 冲突且判给云端：本机那份先另存副本，再落远端版本
        if (d.conflict && cfg.conflictKeepCopy !== false && local?.absPath) {
          try {
            const file = await readFile(local.absPath)
            const tag = `local-${String(state.device.id).slice(0, 8)}-r${base?.rev ?? 0}`
            skippedReasons.push(`冲突副本：${await saveSidecar(local.absPath, file, tag)}`)
          } catch (err) {
            errors.push(`冲突副本 ${d.rel}: ${err.message}`)
          }
        }
        // patch 文件特殊处理：本机自己那一行不能被云端的剥离版覆盖掉
        let payload = buf
        const envMeta = meta.meta?.env
        if (envMeta?.key === 'profilePatch' && cfg.environment?.skipSelfConfig !== false && await exists(target)) {
          try {
            const merged = mergeSelfPatchRow(buf.toString('utf8'), await readFile(target, 'utf8'), SELF_ENTRY_ID)
            if (merged.merged) payload = Buffer.from(merged.text, 'utf8')
          } catch (err) {
            errors.push(`保留本机配置行 ${d.rel}: ${err.message}`)
          }
        }
        await mkdir(dirname(target), { recursive: true })
        if (src === 'environment' && await exists(target)) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          await writeFile(`${target}.bak-${stamp}`, await readFile(target))
          backedUp++
        }
        const tmp = `${target}.tmp-${process.pid}`
        await writeFile(tmp, payload)
        await rename(tmp, target)
        downloaded++
        bySource[src].downloaded++
        setBase(state, d.rel, meta)
        if (state.hashes) delete state.hashes[target]
      } catch (err) {
        errors.push(`${d.rel}: ${err.message}`)
      }
    }

    state.generation = remote.generation || state.generation
    state.lastPull = { at: new Date().toISOString(), downloaded, skipped, conflicts: conflicts.length, generation: state.generation }
    await saveState(stateDirOf(), state)

    return {
      direction: 'pull',
      status: errors.length ? 'partial' : 'ok',
      downloaded,
      skipped,
      live,
      backedUp,
      bySource,
      conflicts,
      needsPush,
      summary: summarize(decisions),
      generation: state.generation,
      warnings,
      errors,
      skippedReasons,
      elapsedMs: Date.now() - started
    }
  }

  function targetFor(d, meta, localByRel, envTargets) {
    if (d.rel === INVENTORY_REL) return null
    if (d.rel.startsWith(`${REMOTE_SESSIONS_DIR}/`)) {
      const session = meta.meta?.session ?? {}
      const dir = targetDirFor(root(), {
        cwd: session.cwd,
        projectDir: session.projectDir,
        sessionId: session.id ?? basename(dirname(d.rel))
      })
      return join(dir, session.name ?? basename(d.rel))
    }
    return localByRel.get(d.rel)?.absPath ?? envTargets.get(d.rel) ?? null
  }

  /** 只读预演：列出会传什么、会落什么、有没有冲突，含每项的版本与时间 */
  async function plan(cfg) {
    const client = clientFor(cfg)
    const state = await loadState(stateDirOf(), identity(cfg))
    const { entries, warnings } = await collectLocal(cfg, state)
    const remote = await readManifest(client)
    const { decisions } = planDecisions(entries, remote, state, cfg)
    return {
      device: { id: state.device.id, label: state.device.label },
      local: {
        sessionsRoot: root(),
        sessionFiles: entries.filter((e) => e.kind === 'session').length,
        sessions: new Set(entries.filter((e) => e.kind === 'session').map((e) => e.meta.session.id)).size,
        envFiles: entries.filter((e) => e.kind === 'env' && !e.generated).length
      },
      remote: {
        generation: remote.generation,
        updatedAt: remote.updatedAt,
        device: remote.device,
        devices: remote.devices,
        files: Object.keys(remote.entries).length
      },
      summary: summarize(decisions),
      toUpload: decisions.filter((d) => d.action === 'push').map(brief),
      toPull: decisions.filter((d) => d.action === 'pull').map(brief),
      conflicts: decisions.filter((d) => d.conflict).map(conflictRecord),
      policy: cfg.conflictPolicy ?? 'prefer-newer',
      warnings
    }
  }

  async function status(cfg) {
    const state = await loadState(stateDirOf(), identity(cfg))
    const { entries, warnings } = await collectLocal(cfg, state).catch(() => ({ entries: [], warnings: [] }))
    const base = {
      configured: Boolean(cfg?.remoteUrl),
      reachable: false,
      error: null,
      device: { id: state.device.id, label: state.device.label },
      sessionsRoot: root(),
      remoteUrl: cfg?.remoteUrl ?? '',
      local: {
        sessionFiles: entries.filter((e) => e.kind === 'session').length,
        sessions: new Set(entries.filter((e) => e.kind === 'session').map((e) => e.meta.session.id)).size,
        envFiles: entries.filter((e) => e.kind === 'env' && !e.generated).length
      },
      remote: { generation: null, updatedAt: null, device: null, devices: {}, files: 0 },
      comparison: null,
      conflicts: [],
      inventory: null,
      inventoryDiff: null,
      warnings,
      lastPush: state.lastPush,
      lastPull: state.lastPull
    }
    let client
    try {
      client = clientFor(cfg)
    } catch (err) {
      return { ...base, error: err.message }
    }
    try {
      const code = await client.ping()
      base.reachable = true
      base.remotePathExists = code === 207
      if (code === 404) {
        base.error = `目标目录不存在（PROPFIND ${client.url('')} → 404）：服务器可达，但该路径不是 collection，写入会全部失败。请先在服务器上创建它，或改用已存在的父目录。`
      }
    } catch (err) {
      return { ...base, error: err.message }
    }
    try {
      const remote = await readManifest(client)
      base.remote = {
        generation: remote.generation,
        updatedAt: remote.updatedAt,
        device: remote.device,
        devices: remote.devices,
        files: Object.keys(remote.entries).length
      }
      const { decisions } = planDecisions(entries, remote, state, cfg)
      base.comparison = summarize(decisions)
      base.conflicts = decisions.filter((d) => d.conflict).map(conflictRecord)
      base.changes = {
        push: decisions.filter((d) => d.action === 'push').map(brief).slice(0, 50),
        pull: decisions.filter((d) => d.action === 'pull').map(brief).slice(0, 50)
      }
      // 远端插件清单（含版本）——这是"谁装了什么版本"的对照
      const remoteInventory = await client.getFile(INVENTORY_REL).catch(() => null)
      if (remoteInventory) {
        try {
          const parsed = JSON.parse(remoteInventory.toString('utf8'))
          const localInventory = await buildInventory({ ...env(), dshVersion })
          const invEntry = remote.entries[INVENTORY_REL] ?? null
          base.inventory = {
            remote: {
              generatedAt: parsed.generatedAt ?? invEntry?.updatedAt ?? null,
              device: invEntry?.device ?? null,
              profile: parsed.profile,
              plugins: parsed.plugins?.length ?? 0
            },
            local: { profile: localInventory.profile, plugins: localInventory.plugins.length }
          }
          base.inventoryDiff = diffInventory(localInventory, parsed)
        } catch { /* 清单坏了不影响状态 */ }
      }
    } catch (err) {
      base.error = err.message
    }
    return base
  }

  async function testConnection(cfg) {
    const client = clientFor(cfg)
    const code = await client.ping()
    const url = client.url('')
    // 404 说明服务器活着但这个路径下没有 collection。
    // 以前这里无条件返回 ok:true，于是界面显示"可达"，把"目录不存在"这个
    // 真正的原因藏起来了（随后的 PUT 会全部 409）。
    if (code === 404) {
      return {
        ok: false,
        status: code,
        url,
        error: `服务器可达，但目标目录不存在：PROPFIND ${url} → 404。请先在服务器上创建该目录，或把"服务器子目录"改成已存在的父目录。`
      }
    }
    return { ok: code === 207, status: code, url }
  }

  return { push, pull, plan, status, testConnection, collectLocal, readManifest }
}

function mergeDevices(remote, state) {
  const devices = { ...(remote.devices ?? {}) }
  devices[state.device.id] = {
    label: state.device.label,
    platform: state.device.platform,
    profile: state.device.profile,
    lastSeen: new Date().toISOString()
  }
  return devices
}

async function exists(path) {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}
