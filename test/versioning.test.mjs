/**
 * 版本与冲突的核心逻辑测试。
 * 这些是"哪一份是最新的"这个问题的判定规则，必须可验证。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildEntry,
  compareVersion,
  decide,
  emptyManifest,
  nextRev,
  normalizeManifest,
  sameContent,
  summarize
} from '../lib/versioning.js'

const entry = (sha1, rev, updatedAt, device = 'dev-a') => ({ sha1, rev, updatedAt, device, size: 10, kind: 'env' })
const local = (sha1, rev = 0) => ({ rel: 'environment/profile/package.json', sha1, rev, size: 10, kind: 'env', mtimeMs: 1000 })

test('compareVersion：先比 rev，再比时间，最后用 device 确定性收敛', () => {
  assert.ok(compareVersion(entry('a', 3, '2026-01-01T00:00:00Z'), entry('b', 2, '2026-09-01T00:00:00Z')) > 0, 'rev 优先于时间')
  assert.ok(compareVersion(entry('a', 2, '2026-09-01T00:00:00Z'), entry('b', 2, '2026-01-01T00:00:00Z')) > 0, '同 rev 比时间')
  const x = compareVersion(entry('a', 2, '2026-01-01T00:00:00Z', 'dev-a'), entry('b', 2, '2026-01-01T00:00:00Z', 'dev-b'))
  const y = compareVersion(entry('b', 2, '2026-01-01T00:00:00Z', 'dev-b'), entry('a', 2, '2026-01-01T00:00:00Z', 'dev-a'))
  assert.equal(x, y * -1, '两端各自算出的胜负必须相反（可收敛，不会来回覆盖）')
  assert.equal(compareVersion(entry('a', 1, null, 'd'), entry('a', 1, null, 'd')), 0)
})

test('decide：单端改动可直接推进，不产生冲突', () => {
  const base = { sha1: 'base', rev: 1 }
  const onlyLocal = decide({ local: local('local'), remote: entry('base', 1, null), base, policy: 'prefer-newer' })
  assert.equal(onlyLocal.action, 'push')
  assert.equal(onlyLocal.reason, 'local-changed')
  assert.equal(onlyLocal.conflict, false)

  const onlyRemote = decide({ local: local('base'), remote: entry('remote', 2, null), base, policy: 'prefer-newer' })
  assert.equal(onlyRemote.action, 'pull')
  assert.equal(onlyRemote.reason, 'remote-changed')
  assert.equal(onlyRemote.conflict, false)
})

test('decide：两端都改 = 冲突，按策略取舍并记录胜负', () => {
  const base = { sha1: 'base', rev: 1 }
  const args = {
    local: local('local'),
    remote: entry('remote', 5, '2026-09-30T00:00:00Z', 'dev-remote'),
    base
  }
  const preferNewer = decide({ ...args, policy: 'prefer-newer' })
  assert.equal(preferNewer.conflict, true)
  assert.equal(preferNewer.reason, 'both-changed')
  // prefer-newer 比的是"谁写得更晚"（本机 mtime vs 云端 updatedAt），
  // 不比 rev —— 本机条目不在 manifest 里，rev 恒为 0，比 rev 等于本机必输
  assert.equal(preferNewer.winner, 'remote', '云端 2026-09-30 晚于本机 mtime(1000ms)')
  assert.equal(preferNewer.action, 'pull')
  assert.equal(preferNewer.resolvedBy, 'prefer-newer')

  assert.equal(decide({ ...args, policy: 'keep-local' }).action, 'push')
  assert.equal(decide({ ...args, policy: 'keep-remote' }).action, 'pull')
  assert.equal(decide({ ...args, policy: 'keep-both' }).action, 'push', 'keep-both 保留本机为准')
  assert.equal(decide({ ...args, policy: 'keep-both' }).winner, 'local')
  assert.equal(decide({ ...args, policy: 'manual' }).action, 'conflict', 'manual 不动任何一端')
})

test('decide：本机写得更晚时 prefer-newer 判给本机（比时间，不比 rev）', () => {
  // 真实情况下本机条目来自磁盘扫描，rev 恒为 0（它不在 manifest 里），
  // 所以这里不能构造 rev>0 的本机条目来"证明本机更新"——那是走不到的分支。
  // prefer-newer 的真实依据是时间：本机 mtime vs 云端 updatedAt。
  const d = decide({
    local: { ...local('local'), rev: 0, mtimeMs: Date.parse('2026-10-01T00:00:00Z') },
    remote: entry('remote', 4, '2026-09-30T00:00:00Z', 'dev-remote'),
    base: { sha1: 'base', rev: 3 },
    policy: 'prefer-newer'
  })
  assert.equal(d.conflict, true)
  assert.equal(d.winner, 'local')
  assert.equal(d.action, 'push', '本机写得更晚 → 推上去（旧行为按 rev 比：0 < 4 → 永远判云端，本机改动永远推不上去）')
  // 同样的冲突、rev 更小但时间更晚，结论不变 —— 证明 rev 不参与本机⇄云端比较
  const d2 = decide({
    local: { ...local('local'), rev: 0, mtimeMs: Date.parse('2026-10-01T00:00:00Z') },
    remote: entry('remote', 99, '2026-09-30T00:00:00Z', 'dev-remote'),
    base: { sha1: 'base', rev: 3 },
    policy: 'prefer-newer'
  })
  assert.equal(d2.action, 'push')
})

test('decide：首次同步（无 base）内容不同也算冲突，不盲目覆盖', () => {
  const d = decide({ local: local('local'), remote: entry('remote', 9, null, 'dev-x'), base: null, policy: 'manual' })
  assert.equal(d.conflict, true)
  assert.equal(d.reason, 'no-base-differs')
  assert.equal(d.action, 'conflict')
})

test('decide：新增/删除', () => {
  assert.equal(decide({ local: local('x'), remote: null, base: null }).action, 'push')
  assert.equal(decide({ local: null, remote: entry('x', 1, null), base: null }).action, 'pull')
  assert.equal(decide({ local: local('same'), remote: entry('same', 3, null), base: null }).action, 'identical')
})

test('nextRev：内容没变不虚增版本，变了才 +1 并取两端最大值', () => {
  const base = { sha1: 'base', rev: 4 }
  assert.equal(nextRev({ local: local('base'), remote: entry('base', 4, null), base }), 4, '没变保持原版本')
  assert.equal(nextRev({ local: local('new'), remote: entry('base', 4, null), base }), 5, '变了 → max(4,4)+1')
  assert.equal(nextRev({ local: local('new'), remote: entry('other', 9, null), base: { sha1: 'base', rev: 2 } }), 10, '远端领先时以远端为基准')
  assert.equal(nextRev({ local: local('new'), remote: null, base: null }), 1, '新文件从 1 开始')
})

test('normalizeManifest：v1 清单补上 sessions/ 前缀并升级为 v2', () => {
  const v1 = {
    version: 1,
    updatedAt: '2026-09-01T00:00:00Z',
    files: {
      '--proj--/sess1/session.v4.jsonl.zstd': { sha1: 'abc', size: 5, sessionId: 'sess1', cwd: '/tmp/x', name: 'session.v4.jsonl.zstd' }
    }
  }
  const m = normalizeManifest(v1)
  assert.equal(m.schema, 2)
  const key = 'sessions/--proj--/sess1/session.v4.jsonl.zstd'
  assert.ok(m.entries[key], 'v1 的 key 被补上前缀，远端文件位置不变')
  assert.equal(m.entries[key].rev, 0, 'v1 没有版本号，按最旧处理')
  assert.equal(m.entries[key].meta.session.id, 'sess1')
  assert.equal(m.entries[key].meta.session.cwd, '/tmp/x')
  assert.equal(m.updatedAt, '2026-09-01T00:00:00Z')
})

test('buildEntry / summarize', () => {
  const e = buildEntry({ rel: 'environment/x', kind: 'env', size: 3, sha1: 'abc', mtimeMs: Date.parse('2026-01-02T00:00:00Z') }, { rev: 2, device: 'dev-1' })
  assert.equal(e.rev, 2)
  assert.equal(e.device, 'dev-1')
  assert.equal(e.updatedAt, '2026-01-02T00:00:00.000Z')
  const s = summarize([
    { action: 'push' }, { action: 'push' }, { action: 'pull' }, { action: 'identical' }, { action: 'conflict' }, { action: 'drop' }
  ])
  assert.deepEqual(s, { push: 2, pull: 1, identical: 1, conflict: 1, drop: 1 })
})

test('sameContent / emptyManifest', () => {
  assert.equal(sameContent({ sha1: 'a' }, { sha1: 'a' }), true)
  assert.equal(sameContent({ sha1: 'a' }, { sha1: 'b' }), false)
  assert.equal(sameContent(null, { sha1: 'a' }), false)
  assert.deepEqual(emptyManifest().entries, {})
  assert.equal(emptyManifest().generation, 0)
})

test('decide：没有 base 时按时间判断谁更新，而不是按 rev（本机没有 rev）', () => {
  const remote = { sha1: 'r', size: 10, rev: 7, updatedAt: '2026-10-08T03:00:00.000Z', device: 'dev-remote' }

  // 本机文件更新（mtime 晚于云端写入时间）→ 必须能推上去。
  // 修这个 bug 之前，compareVersion 先比 rev：本机 rev 视为 0 < 云端 7，
  // 永远判云端更新，本机后改的内容永远推不上去，只显示"待恢复"。
  const localNewer = { sha1: 'l', size: 20, mtimeMs: Date.parse('2026-10-08T03:30:00.000Z') }
  const up = decide({ local: localNewer, remote, base: null, policy: 'prefer-newer', rel: 'x' })
  assert.equal(up.action, 'push', '本机更新时必须推送，rev 不能压过时间')
  assert.equal(up.winner, 'local')

  // 本机文件更旧 → 拉取云端
  const localOlder = { sha1: 'l', size: 20, mtimeMs: Date.parse('2026-10-08T02:00:00.000Z') }
  const down = decide({ local: localOlder, remote, base: null, policy: 'prefer-newer', rel: 'x' })
  assert.equal(down.action, 'pull')
  assert.equal(down.winner, 'remote')

  // 有 base 时 rev 仍然是权威：时间再新也不能越过 rev
  const base = { sha1: 'b', size: 5, rev: 5, updatedAt: '2026-10-08T01:00:00.000Z', device: 'dev-x' }
  const withBase = decide({
    local: { sha1: 'l2', size: 20, mtimeMs: Date.parse('2026-10-08T09:00:00.000Z') },
    remote: { sha1: 'r2', size: 10, rev: 6, updatedAt: '2026-10-08T02:00:00.000Z', device: 'dev-remote' },
    base,
    policy: 'prefer-newer',
    rel: 'x'
  })
  assert.equal(withBase.action, 'push', '两端都改过时仍是冲突，只是按时间收敛')
  assert.equal(withBase.conflict, true)
})
