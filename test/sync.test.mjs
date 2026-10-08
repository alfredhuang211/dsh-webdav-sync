/**
 * 端到端：本地 ⇄ 伪 WebDAV 服务器。
 * 覆盖：会话 push/pull、环境 push/pull、自指剥离、版本号（rev/generation）、
 * 三方比较、冲突策略与副本、运行中会话跳过、鉴权失败。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { encodeSegment, projectKey, scanLocalSessions } from '../lib/layout.js'
import { createService } from '../lib/sync.js'
import { WebDavClient } from '../lib/webdav.js'
import { startFakeDav } from './fake-dav.mjs'

const CWD_A = '/Users/tester/work/alpha'
const CWD_B = '/Users/tester/work/项目 beta'
const ID_A = 'session-aaaaaaaa-1111-2222-3333-444444444444'
const ID_B = 'bbbbbbbb-5555-6666-7777-888888888888'

function logLine(header, events = []) {
  return [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n'
}

function sessionLog({ id, cwd, version = 4, extra = 'x' }) {
  const header = { type: 'session', version, id, createdAt: Date.now(), cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }
  return zstdCompressSync(Buffer.from(logLine(header, [{ type: 'note', text: extra }]), 'utf8'))
}

async function buildFixture(root) {
  const dirA = join(root, projectKey(CWD_A), encodeSegment(ID_A))
  const dirB = join(root, projectKey(CWD_B), ID_B)
  await mkdir(dirA, { recursive: true })
  await mkdir(dirB, { recursive: true })
  await writeFile(join(dirA, 'session.v4.jsonl.zstd'), sessionLog({ id: ID_A, cwd: CWD_A }))
  await writeFile(join(dirA, 'session.lock'), '')
  await writeFile(join(dirB, 'session.jsonl.zstd'), sessionLog({ id: ID_B, cwd: CWD_B, extra: 'legacy-name' }))
  await writeFile(join(dirB, 'session.lock'), '')
  return { dirA, dirB }
}

const PATCH = `# profile patch
- id: webdav-sync
  name: dsh-webdav-sync
  config:
    sync:
      remoteUrl: https://dav.old-machine.example/dav/
      password: old-machine-secret
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      p1:
        apiKeyEnv: SOME_KEY
`

/** 造一个"另一个 profile"：package.json + patch + 一个已安装插件 */
async function buildProfile(root) {
  const home = join(root, 'home')
  const profileDir = join(root, 'profiles', 'dev')
  await mkdir(home, { recursive: true })
  await mkdir(join(profileDir, 'node_modules', 'dshmarket'), { recursive: true })
  await writeFile(join(home, 'cordis.patch.yml'), '- insert:\n  - id: home-thing\n    name: file:///Users/someone/local/plugin.mjs\n')
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-dev',
    dependencies: { dshmarket: '1.66.6' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dshmarket'] } }
  }, null, 2))
  await writeFile(join(profileDir, 'cordis.patch.yml'), PATCH)
  await writeFile(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  await writeFile(join(profileDir, 'node_modules', 'dshmarket', 'package.json'), JSON.stringify({ name: 'dshmarket', version: '1.66.6' }))
  return { home, profileDir }
}

function engineCfg(dav, overrides = {}) {
  const base = {
    remoteUrl: dav.url,
    username: 'u',
    password: 'p',
    basePath: 'dsh-sessions',
    timeoutMs: 5000,
    conflictPolicy: 'prefer-newer',
    conflictKeepCopy: true,
    pruneRemote: false,
    pullOverwrite: false,
    sources: { sessions: true, environment: false },
    environment: { files: [], excludeFiles: [], extraFiles: [], skipSelfConfig: true, inventory: true }
  }
  return {
    ...base,
    ...overrides,
    sources: { ...base.sources, ...(overrides.sources ?? {}) },
    environment: { ...base.environment, ...(overrides.environment ?? {}) }
  }
}

function makeService({ sessionsRoot, stateDir, dav, profile, isLive }) {
  return createService({
    WebDavClient,
    sessionsRoot,
    stateDir,
    logger: { warn() {}, info() {} },
    isLive,
    facts: () => ({
      profileDir: profile?.profileDir ?? null,
      home: profile?.home ?? null,
      profileName: profile ? 'dev' : null
    }),
    dshVersion: '0.2.0-rc.1'
  })
}

/** 读远端 manifest（v2 归一化前的原始 JSON） */
async function remoteManifest(dav) {
  const buf = dav.files.get('/dav/dsh-sessions/manifest.json')
  return buf ? JSON.parse(buf.toString('utf8')) : null
}

/** 模拟"另一台设备"改动了某个远端文件：改内容 + 提升 rev/device */
async function remoteTouch(dav, rel, newBytes, { rev, device = 'dev-other', updatedAt = new Date().toISOString() } = {}) {
  const { createHash } = await import('node:crypto')
  const digest = createHash('sha1').update(newBytes).digest('hex')
  dav.files.set(`/dav/dsh-sessions/${rel}`, newBytes)
  const manifest = await remoteManifest(dav)
  manifest.entries[rel] = { ...(manifest.entries[rel] ?? {}), sha1: digest, size: newBytes.length, rev, device, updatedAt }
  manifest.generation = (manifest.generation ?? 0) + 1
  manifest.updatedAt = updatedAt
  manifest.device = { id: device }
  dav.files.set('/dav/dsh-sessions/manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)))
}

test('projectKey 与 harness 的算法一致', () => {
  assert.equal(projectKey('/Users/alfredhuang/Documents/dsh/project-test'), '--Users-alfredhuang-Documents-dsh-project-test--')
  assert.equal(
    projectKey('/Users/alfredhuang/Library/Mobile Documents/com~apple~CloudDocs/Documents/个人工作/FT-web'),
    '--Users-alfredhuang-Library-Mobile~0020Documents-com~007Eapple~007ECloudDocs-Documents-~4E2A~4EBA~5DE5~4F5C-FT-web--'
  )
  assert.equal(encodeSegment('.'), '~002E')
})

test('会话 push → 清空本地 → pull 完整恢复（含 v1 清单兼容）', async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), 'davsync-'))
  const sessionsRoot = join(workdir, 'sessions')
  const stateDir = join(workdir, 'state')
  await buildFixture(sessionsRoot)
  const dav = await startFakeDav()
  t.after(async () => { await dav.close(); await rm(workdir, { recursive: true, force: true }) })

  const service = makeService({ sessionsRoot, stateDir, dav })
  const cfg = engineCfg(dav)

  const scanned = await scanLocalSessions(sessionsRoot)
  assert.equal(scanned.length, 2)
  assert.ok(scanned.every((e) => !e.name.endsWith('.lock')), 'session.lock 不同步')

  const pushed = await service.push(cfg)
  assert.equal(pushed.status, 'ok', JSON.stringify(pushed.errors))
  assert.equal(pushed.uploaded, 2)
  assert.equal(pushed.generation, 1)
  assert.equal(pushed.bySource.sessions.uploaded, 2)

  // manifest v2：key 带 sessions/ 前缀，带 rev/updatedAt/device
  const manifest = await remoteManifest(dav)
  assert.equal(manifest.schema, 2)
  const keyA = `sessions/${projectKey(CWD_A)}/${encodeSegment(ID_A)}/session.v4.jsonl.zstd`
  assert.ok(manifest.entries[keyA], 'v2 key 带源目录前缀')
  assert.equal(manifest.entries[keyA].rev, 1)
  assert.equal(manifest.entries[keyA].device, (await service.status(cfg)).device.id)
  assert.ok(![...dav.files.keys()].some((k) => k.endsWith('session.lock')))

  // 幂等：再推一次不重复上传、不虚增版本
  const again = await service.push(cfg)
  assert.equal(again.uploaded, 0)
  assert.equal(again.unchanged, 2)
  assert.equal(again.generation, 1, '没有变化就不产生新代号')
  assert.equal((await remoteManifest(dav)).entries[keyA].rev, 1, '内容没变 rev 不变')

  const before = {
    a: await readFile(join(sessionsRoot, projectKey(CWD_A), encodeSegment(ID_A), 'session.v4.jsonl.zstd')),
    b: await readFile(join(sessionsRoot, projectKey(CWD_B), ID_B, 'session.jsonl.zstd'))
  }
  await rm(sessionsRoot, { recursive: true, force: true })
  await mkdir(sessionsRoot, { recursive: true })

  const pulled = await service.pull(cfg)
  assert.equal(pulled.status, 'ok', JSON.stringify(pulled.errors))
  assert.equal(pulled.downloaded, 2)
  const restoredA = join(sessionsRoot, projectKey(CWD_A), encodeSegment(ID_A), 'session.v4.jsonl.zstd')
  const restoredB = join(sessionsRoot, projectKey(CWD_B), ID_B, 'session.jsonl.zstd')
  assert.ok(existsSync(restoredA), '按 header cwd 落位（含非 ASCII 项）')
  assert.ok(existsSync(restoredB))
  assert.deepEqual(await readFile(restoredA), before.a, '字节完全一致')
  assert.deepEqual(await readFile(restoredB), before.b, '字节完全一致')
})

test('版本机制：内容变了 rev +1，rev 不因同步次数虚增；代号只在有变化时 +1', async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), 'davsync-'))
  const sessionsRoot = join(workdir, 'sessions')
  const stateDir = join(workdir, 'state')
  await buildFixture(sessionsRoot)
  const dav = await startFakeDav()
  t.after(async () => { await dav.close(); await rm(workdir, { recursive: true, force: true }) })

  const service = makeService({ sessionsRoot, stateDir, dav })
  const cfg = engineCfg(dav)
  await service.push(cfg)
  const keyA = `sessions/${projectKey(CWD_A)}/${encodeSegment(ID_A)}/session.v4.jsonl.zstd`
  assert.equal((await remoteManifest(dav)).entries[keyA].rev, 1)

  // 会话"追加"了一行
  const fileA = join(sessionsRoot, projectKey(CWD_A), encodeSegment(ID_A), 'session.v4.jsonl.zstd')
  await writeFile(fileA, sessionLog({ id: ID_A, cwd: CWD_A, extra: 'appended-line' }))
  const second = await service.push(cfg)
  assert.equal(second.uploaded, 1)
  assert.equal(second.generation, 2)
  const entries = (await remoteManifest(dav)).entries
  assert.equal(entries[keyA].rev, 2, '内容变了 rev 才 +1')

  await service.push(cfg)
  assert.equal((await remoteManifest(dav)).entries[keyA].rev, 2, '再次推送（无变化）不再 +1')
})

test('环境同步：push → 清空 → pull，字节恢复；自插件配置行被剥离；清单含版本', async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), 'davsync-'))
  const sessionsRoot = join(workdir, 'sessions')
  const stateDir = join(workdir, 'state')
  const profile = await buildProfile(workdir)
  await mkdir(sessionsRoot, { recursive: true })
  const dav = await startFakeDav()
  t.after(async () => { await dav.close(); await rm(workdir, { recursive: true, force: true }) })

  const service = makeService({ sessionsRoot, stateDir, dav, profile })
  const cfg = engineCfg(dav, { sources: { sessions: false, environment: true } })

  const pushed = await service.push(cfg)
  assert.equal(pushed.status, 'ok', JSON.stringify(pushed.errors))
  assert.ok(pushed.bySource.environment.uploaded >= 4, `环境文件都传了（实际 ${pushed.bySource.environment.uploaded}）`)
  const keys = [...dav.files.keys()]
  assert.ok(keys.some((k) => k.endsWith('/environment/profile/package.json')))
  assert.ok(keys.some((k) => k.endsWith('/environment/profile/pnpm-lock.yaml')))
  assert.ok(keys.some((k) => k.endsWith('/environment/home/cordis.patch.yml')))
  assert.ok(keys.some((k) => k.endsWith('/environment/inventory.json')), '插件清单（含版本）也上传')

  // 自指剥离：远端的 patch 里不应该有本插件自己的 WebDAV 密码
  const remotePatch = dav.files.get('/dav/dsh-sessions/environment/profile/cordis.patch.yml').toString('utf8')
  assert.ok(!remotePatch.includes('old-machine-secret'), '本插件自己的配置行被剥离，避免换机后把同步目标改回去')
  assert.ok(!remotePatch.includes('webdav-sync'))
  assert.ok(remotePatch.includes('llm-pi-ai'), '其他插件配置照常同步')

  // 远端清单含版本号
  const inventory = JSON.parse(dav.files.get('/dav/dsh-sessions/environment/inventory.json').toString('utf8'))
  const dshmarket = inventory.plugins.find((p) => p.name === 'dshmarket')
  assert.equal(dshmarket.version, '1.66.6')
  assert.equal(inventory.dshVersion, '0.2.0-rc.1')

  // 破坏后恢复
  const originalPkg = await readFile(join(profile.profileDir, 'package.json'))
  const originalPatch = await readFile(join(profile.profileDir, 'cordis.patch.yml'))
  await writeFile(join(profile.profileDir, 'package.json'), '{"name":"broken"}\n')
  await rm(join(profile.profileDir, 'pnpm-lock.yaml'), { force: true })

  // package.json 是被"故意改坏"的：本机相对 base 已变，且远端没变 →
  // 三方比较判为"本机较新"，普通 pull 不会覆盖它（这是设计上的保护）。
  const guarded = await service.pull(cfg)
  assert.equal(guarded.bySource.environment.downloaded, 1, '普通恢复只补回缺失的 lockfile，被改动的文件受保护')
  assert.notDeepEqual(await readFile(join(profile.profileDir, 'package.json')), originalPkg, '普通恢复不动被改写的文件')

  // "以云端为准"（force）才是覆盖本机改动的开关
  const pulled = await service.pull({ ...cfg, force: true })
  assert.equal(pulled.status, 'ok', JSON.stringify(pulled.errors))
  assert.ok(pulled.bySource.environment.downloaded >= 1)
  assert.deepEqual(await readFile(join(profile.profileDir, 'package.json')), originalPkg, 'package.json 字节恢复')
  const restoredPatch = await readFile(join(profile.profileDir, 'cordis.patch.yml'), 'utf8')
  assert.ok(restoredPatch.includes('llm-pi-ai'), '云端 patch 的其他条目被恢复')
  assert.ok(restoredPatch.includes('webdav-sync') && restoredPatch.includes('old-machine-secret'),
    '本机自己的配置行被保留（否则换机恢复会把自己刚填的地址抹掉）')
  const { stripSelfPatchRow } = await import('../lib/env.js')
  assert.equal(stripSelfPatchRow(restoredPatch, 'webdav-sync').text,
    dav.files.get('/dav/dsh-sessions/environment/profile/cordis.patch.yml').toString('utf8').replace(/\n*$/, '\n'),
    '剥离本机自身行后与云端内容一致（比较用投影仍收敛，不会来回抖动）')
  assert.ok(existsSync(join(profile.profileDir, 'pnpm-lock.yaml')))
  assert.ok(pulled.backedUp >= 1, '覆盖前留了 .bak 备份')

  // 收敛性：恢复后立刻再推一次，不应该认为"本地有改动"（否则每次同步都会抖动重传）
  const afterRestore = await service.push(cfg)
  assert.equal(afterRestore.uploaded, 0, '恢复后再推送：剥离投影与云端一致，不产生抖动')
  assert.equal(afterRestore.conflicts.length, 0)
  const backups = (await readdir(profile.profileDir)).filter((f) => f.includes('.bak-'))
  assert.ok(backups.length >= 1, '备份文件确实落盘')
  assert.ok(backups.some((f) => f.startsWith('package.json.bak-')), '被覆盖的文件有备份')
})

test('三方比较：只有远端改过时，默认策略就能安全覆盖（本地相对 base 没变）', async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), 'davsync-'))
  const sessionsRoot = join(workdir, 'sessions')
  const stateDir = join(workdir, 'state')
  await buildFixture(sessionsRoot)
  const dav = await startFakeDav()
  t.after(async () => { await dav.close(); await rm(workdir, { recursive: true, force: true }) })

  const service = makeService({ sessionsRoot, stateDir, dav })
  const cfg = engineCfg(dav)
  await service.push(cfg)

  const fileA = join(sessionsRoot, projectKey(CWD_A), encodeSegment(ID_A), 'session.v4.jsonl.zstd')
  const keyA = `sessions/${projectKey(CWD_A)}/${encodeSegment(ID_A)}/session.v4.jsonl.zstd`
  const newer = sessionLog({ id: ID_A, cwd: CWD_A, extra: 'from-other-device' })
  await remoteTouch(dav, keyA, newer, { rev: 2 })

  const pulled = await service.pull(cfg) // pullOverwrite 默认 false
  assert.equal(pulled.downloaded, 1, '本地 == base，覆盖不丢东西，可以直接拉')
  assert.deepEqual(await readFile(fileA), newer)

  const status = await service.status(cfg)
  assert.equal(status.comparison.pull, 0)
  assert.equal(status.comparison.identical, 2)
  assert.equal(status.remote.generation, 2)
})

test('冲突：两端都改过 → 默认不覆盖、报告冲突；开启覆盖后落下并留副本', async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), 'davsync-'))
  const sessionsRoot = join(workdir, 'sessions')
  const stateDir = join(workdir, 'state')
  await buildFixture(sessionsRoot)
  const dav = await startFakeDav()
  t.after(async () => { await dav.close(); await rm(workdir, { recursive: true, force: true }) })

  const service = makeService({ sessionsRoot, stateDir, dav })
  const cfg = engineCfg(dav)
  await service.push(cfg)

  const fileA = join(sessionsRoot, projectKey(CWD_A), encodeSegment(ID_A), 'session.v4.jsonl.zstd')
  const keyA = `sessions/${projectKey(CWD_A)}/${encodeSegment(ID_A)}/session.v4.jsonl.zstd`
  const mine = sessionLog({ id: ID_A, cwd: CWD_A, extra: 'my-local-edit' })
  const theirs = sessionLog({ id: ID_A, cwd: CWD_A, extra: 'other-device-edit' })
  await writeFile(fileA, mine)
  await remoteTouch(dav, keyA, theirs, { rev: 5, updatedAt: new Date(Date.now() + 60_000).toISOString() })

  const safe = await service.pull(cfg)
  assert.equal(safe.conflicts.length, 1, '识别为冲突')
  assert.equal(safe.downloaded, 0, '默认不覆盖本地改动')
  assert.deepEqual(await readFile(fileA), mine, '本地内容原样保留')

  const plan = await service.plan(cfg)
  assert.equal(plan.conflicts.length, 1)
  assert.equal(plan.summary.pull, 1, 'prefer-newer 判给远端（rev 5 > 1）')

  const forced = await service.pull({ ...cfg, pullOverwrite: true })
  assert.equal(forced.downloaded, 1)
  assert.deepEqual(await readFile(fileA), theirs)
  const sidecars = (await readdir(join(sessionsRoot, projectKey(CWD_A), encodeSegment(ID_A)))).filter((f) => f.includes('.conflict-'))
  assert.ok(sidecars.length >= 1, '落败的一方另存副本，不丢数据')
})

test('冲突策略 keep-both：push 时保留本机并另存云端副本', async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), 'davsync-'))
  const sessionsRoot = join(workdir, 'sessions')
  const stateDir = join(workdir, 'state')
  await buildFixture(sessionsRoot)
  const dav = await startFakeDav()
  t.after(async () => { await dav.close(); await rm(workdir, { recursive: true, force: true }) })

  const service = makeService({ sessionsRoot, stateDir, dav })
  await service.push(engineCfg(dav))
  const keyA = `sessions/${projectKey(CWD_A)}/${encodeSegment(ID_A)}/session.v4.jsonl.zstd`
  const fileA = join(sessionsRoot, projectKey(CWD_A), encodeSegment(ID_A), 'session.v4.jsonl.zstd')
  const mine = sessionLog({ id: ID_A, cwd: CWD_A, extra: 'local-version' })
  await writeFile(fileA, mine)
  await remoteTouch(dav, keyA, sessionLog({ id: ID_A, cwd: CWD_A, extra: 'remote-version' }), { rev: 3 })

  const pushed = await service.push(engineCfg(dav, { conflictPolicy: 'keep-both' }))
  assert.equal(pushed.conflicts.length, 1)
  assert.equal(pushed.uploaded, 1, 'keep-both 以本机为准上传')
  assert.equal(pushed.sidecars.length, 1, '云端那份在本机另存副本')
  assert.deepEqual(await readFile(fileA), mine)
  const entries = (await remoteManifest(dav)).entries
  assert.equal(entries[keyA].rev, 4, '基于两端 rev 最大值递增（3+1）')
})

test('冲突策略 manual：只报告，两端都不动', async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), 'davsync-'))
  const sessionsRoot = join(workdir, 'sessions')
  const stateDir = join(workdir, 'state')
  await buildFixture(sessionsRoot)
  const dav = await startFakeDav()
  t.after(async () => { await dav.close(); await rm(workdir, { recursive: true, force: true }) })

  const service = makeService({ sessionsRoot, stateDir, dav })
  await service.push(engineCfg(dav))
  const keyA = `sessions/${projectKey(CWD_A)}/${encodeSegment(ID_A)}/session.v4.jsonl.zstd`
  const fileA = join(sessionsRoot, projectKey(CWD_A), encodeSegment(ID_A), 'session.v4.jsonl.zstd')
  const mine = sessionLog({ id: ID_A, cwd: CWD_A, extra: 'mine' })
  await writeFile(fileA, mine)
  await remoteTouch(dav, keyA, sessionLog({ id: ID_A, cwd: CWD_A, extra: 'theirs' }), { rev: 9 })

  const cfg = engineCfg(dav, { conflictPolicy: 'manual' })
  const pushed = await service.push(cfg)
  assert.equal(pushed.uploaded, 0)
  assert.equal(pushed.conflicts.length, 1)
  const pulled = await service.pull(cfg)
  assert.equal(pulled.downloaded, 0)
  assert.equal(pulled.conflicts.length, 1)
  assert.deepEqual(await readFile(fileA), mine, 'manual 模式下本机不被改动')
})

test('运行中的会话不参与拉取覆盖', async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), 'davsync-'))
  const sessionsRoot = join(workdir, 'sessions')
  const stateDir = join(workdir, 'state')
  await buildFixture(sessionsRoot)
  const dav = await startFakeDav()
  t.after(async () => { await dav.close(); await rm(workdir, { recursive: true, force: true }) })

  const cfg = engineCfg(dav)
  await makeService({ sessionsRoot, stateDir: join(workdir, 'state-seed'), dav }).push(cfg)
  await rm(sessionsRoot, { recursive: true, force: true })
  await mkdir(sessionsRoot, { recursive: true })

  const service = makeService({ sessionsRoot, stateDir, dav, isLive: (id) => id === ID_A })
  const pulled = await service.pull({ ...cfg, pullOverwrite: true })
  assert.equal(pulled.live, 1)
  assert.equal(pulled.downloaded, 1)
  assert.ok(!existsSync(join(sessionsRoot, projectKey(CWD_A), encodeSegment(ID_A), 'session.v4.jsonl.zstd')))
})

test('remoteUrl 指向不存在的目录：不能报"可达"，要指出目录不存在', async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), 'davsync-'))
  const sessionsRoot = join(workdir, 'sessions')
  await buildFixture(sessionsRoot)
  const dav = await startFakeDav() // 服务根是 /dav
  t.after(async () => { await dav.close(); await rm(workdir, { recursive: true, force: true }) })

  const service = makeService({ sessionsRoot, stateDir: join(workdir, 'state'), dav })
  // 把 remoteUrl 指到服务器上并不存在的路径（真实事故：baseUrl 那一级没建）
  const cfg = engineCfg(dav, { remoteUrl: `${dav.url}-missing` })

  const test = await service.testConnection(cfg)
  assert.equal(test.ok, false, '目录不存在时不能报成功')
  assert.equal(test.status, 404)
  assert.match(test.error, /目标目录不存在/, '要直接点出原因，而不是留给用户一堆 PUT 409')

  const status = await service.status(cfg)
  assert.equal(status.reachable, true, '服务器本身是活着的')
  assert.equal(status.remotePathExists, false)
  assert.match(String(status.error), /目录不存在/)

  // 推送必须报错，且错误里能看到 MKCOL 的真实失败原因
  const pushed = await service.push(cfg)
  assert.equal(pushed.uploaded, 0)
  assert.ok(pushed.errors.length > 0)
  assert.match(pushed.errors[0], /MKCOL|409/)
})

test('认证失败 / 地址不可达会明确报错，而不是静默成功', async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), 'davsync-'))
  const sessionsRoot = join(workdir, 'sessions')
  await buildFixture(sessionsRoot)
  const dav = await startFakeDav()
  t.after(async () => { await dav.close(); await rm(workdir, { recursive: true, force: true }) })

  const service = makeService({ sessionsRoot, stateDir: join(workdir, 'state'), dav })
  const bad = await service.status(engineCfg(dav, { password: 'wrong', timeoutMs: 3000 }))
  assert.equal(bad.reachable, false)
  assert.match(String(bad.error), /401/)

  const unconfigured = await service.status({ ...engineCfg(dav, {}), remoteUrl: '' })
  assert.equal(unconfigured.reachable, false)
  assert.match(String(unconfigured.error), /remoteUrl/)
})

test('状态视图：给出云端代号/时间/设备、本机设备、差异与清单对照', async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), 'davsync-'))
  const sessionsRoot = join(workdir, 'sessions')
  const stateDir = join(workdir, 'state')
  const profile = await buildProfile(workdir)
  await buildFixture(sessionsRoot)
  const dav = await startFakeDav()
  t.after(async () => { await dav.close(); await rm(workdir, { recursive: true, force: true }) })

  const service = makeService({ sessionsRoot, stateDir, dav, profile })
  const cfg = engineCfg(dav, { sources: { sessions: true, environment: true }, deviceLabel: 'my-mac' })
  await service.push(cfg)

  const status = await service.status(cfg)
  assert.equal(status.reachable, true)
  assert.equal(status.device.label, 'my-mac')
  assert.equal(status.remote.generation, 1)
  assert.ok(status.remote.updatedAt, '云端有时间戳')
  assert.equal(status.remote.device.label, 'my-mac')
  assert.equal(status.comparison.push, 0)
  assert.equal(status.comparison.conflict, 0)
  assert.ok(status.local.sessions >= 1)
  assert.ok(status.local.envFiles >= 4)
  assert.ok(status.inventory, '能看到远端清单')
  assert.deepEqual(status.inventoryDiff.changed, [])
  assert.ok(status.lastPush?.at, '记录了上次推送时间')
})

test('全新 state 面对已有云端：identical 落下 base，之后本机改动能正常推送', async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), 'davsync-'))
  const sessionsRoot = join(workdir, 'sessions')
  await buildFixture(sessionsRoot)
  const dav = await startFakeDav()
  t.after(async () => { await dav.close(); await rm(workdir, { recursive: true, force: true }) })

  // 机器 A：首次推送，云端有 2 个会话
  const stateA = join(workdir, 'state-a')
  const svcA = makeService({ sessionsRoot, stateDir: stateA, dav })
  const a = await svcA.push(engineCfg(dav))
  assert.equal(a.uploaded, 2)
  assert.equal(a.generation, 1)

  // 机器 B：全新 state，云端内容与本地相同
  const stateB = join(workdir, 'state-b')
  const svcB = makeService({ sessionsRoot, stateDir: stateB, dav })
  const b = await svcB.push(engineCfg(dav))
  assert.equal(b.uploaded, 0, '内容相同，无需上传')
  assert.equal(b.unchanged, 2)

  // identical 必须落下 base，否则 B 之后任何改动都缺三方祖先
  const stateBJson = JSON.parse(await readFile(join(stateB, 'state.json'), 'utf8'))
  assert.equal(Object.keys(stateBJson.base).length, 2, 'identical 也要记 base（否则后续改动被误判冲突）')

  // 改本机一个会话文件（内容变了、mtime 更新）→ 应正常推送且不产生冲突
  const changedRel = 'sessions/--Users-tester-work-alpha--/session-aaaaaaaa-1111-2222-3333-444444444444/session.v4.jsonl.zstd'
  const target = join(sessionsRoot, changedRel.replace(/^sessions\//, ''))
  await writeFile(target, sessionLog({ id: ID_A, cwd: CWD_A, extra: 'grown-append' }))

  const b2 = await svcB.push(engineCfg(dav))
  assert.equal(b2.uploaded, 1, '本机改动必须推上去')
  assert.equal(b2.conflicts.length, 0, '有 base 后这是普通改动，不该再报冲突')
  assert.equal(b2.generation, 2)
})
