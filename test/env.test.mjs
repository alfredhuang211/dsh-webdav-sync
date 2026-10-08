/**
 * 环境侧测试：哪些文件算环境、插件清单能不能读出版本、patch 解析与自指剥离。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  ENV_FILES,
  buildInventory,
  diffInventory,
  discoverEnvFiles,
  parseDisabledIds,
  readEnvEntry,
  scanEnvWarnings,
  stripSelfPatchRow
} from '../lib/env.js'
import { sha1 } from '../lib/sync.js'

const PATCH = `# profile patch
- id: webdav-sync
  name: dsh-webdav-sync
  config:
    sync:
      remoteUrl: https://dav.example.com/dav/
      password: super-secret
- id: dsh-opencode-session
  name: dsh-opencode-session
  disabled: true
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      p1:
        apiKeyEnv: SOME_KEY
`

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'davsync-env-'))
  const home = join(root, 'home')
  const profileDir = join(root, 'profiles', 'dev')
  await mkdir(join(home), { recursive: true })
  await mkdir(join(profileDir, 'node_modules', 'dshmarket'), { recursive: true })
  await mkdir(join(profileDir, '.dsh-market'), { recursive: true })
  await writeFile(join(home, 'cordis.patch.yml'), '- insert:\n  - id: home-thing\n    name: file:///Users/someone/local/plugin.mjs\n')
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-dev',
    private: true,
    dependencies: { dshmarket: '1.66.6', 'dsh-opencode-session': '^0.1.1' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dshmarket', 'dsh-opencode-session'] } }
  }, null, 2))
  await writeFile(join(profileDir, 'cordis.patch.yml'), PATCH)
  await writeFile(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  await writeFile(join(profileDir, 'pnpm-workspace.yaml'), 'nodeLinker: hoisted\n')
  await writeFile(join(profileDir, '.dsh-market', 'state.json'), '{"groups":{}}\n')
  await writeFile(join(profileDir, 'node_modules', 'dshmarket', 'package.json'), JSON.stringify({ name: 'dshmarket', version: '1.66.6' }))
  return { root, home, profileDir, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('discoverEnvFiles：默认集不含 node_modules / cordis.yml，且可增删', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)

  const all = await discoverEnvFiles({ profileDir: f.profileDir, home: f.home })
  const keys = all.map((x) => x.key)
  assert.deepEqual(keys, ENV_FILES.map((x) => x.key), '默认包含全部声明文件')
  assert.ok(all.every((x) => !x.absPath.includes('node_modules')), '绝不包含 node_modules')
  assert.ok(all.every((x) => !x.absPath.endsWith('cordis.yml')), '组合产物 cordis.yml 不同步')

  const trimmed = await discoverEnvFiles({ profileDir: f.profileDir, home: f.home, exclude: ['homePatch', 'marketState'] })
  assert.deepEqual(trimmed.map((x) => x.key), ['profilePackage', 'profilePatch', 'profileLock', 'profileWorkspace'])

  const only = await discoverEnvFiles({ profileDir: f.profileDir, home: f.home, include: ['profilePatch'] })
  assert.equal(only.length, 1)
  assert.equal(only[0].key, 'profilePatch')

  const extra = await discoverEnvFiles({ profileDir: f.profileDir, home: f.home, include: ['profilePatch'], extraFiles: ['extra/notes.md', '/tmp/absolute.txt'] })
  assert.equal(extra.length, 3)
  assert.equal(extra[1].absPath, join(f.profileDir, 'extra/notes.md'))
  assert.equal(extra[2].absPath, '/tmp/absolute.txt')
})

test('readEnvEntry：算 sha1、缺失返回 null、能识别明文凭据', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const specs = await discoverEnvFiles({ profileDir: f.profileDir, home: f.home })
  const patchSpec = specs.find((s) => s.key === 'profilePatch')
  const entry = await readEnvEntry(patchSpec, { sha1Of: sha1 })
  assert.equal(entry.rel, 'environment/profile/cordis.patch.yml')
  assert.equal(entry.sha1, sha1(Buffer.from(PATCH)))
  assert.equal(entry.kind, 'env')
  assert.ok(entry.warnings.includes('可能含明文凭据'), 'password 行被识别')

  const missing = await readEnvEntry({ ...patchSpec, absPath: join(f.profileDir, 'nope.yml') }, { sha1Of: sha1 })
  assert.equal(missing, null)
})

test('buildInventory：读得出插件版本与启用状态（宿主的清单 API 不含版本，必须自己读）', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const inv = await buildInventory({ profileDir: f.profileDir, home: f.home, profileName: 'dev', device: { id: 'dev-1' }, dshVersion: '0.2.0-rc.1' })
  const byName = new Map(inv.plugins.map((p) => [p.name, p]))
  assert.equal(byName.get('dshmarket').version, '1.66.6')
  assert.equal(byName.get('dshmarket').role, 'bundle+dependency')
  assert.equal(byName.get('dsh-opencode-session').version, null, '未安装到 profile 的依赖版本为 null')
  assert.equal(byName.get('dsh-opencode-session').enabled, false, 'patch 里 disabled: true')
  assert.equal(byName.get('@deepseek-ai/dsh-base').version, null, '宿主自带 bundle 无独立版本')
  assert.equal(inv.profile, 'dev')
  assert.equal(inv.dshVersion, '0.2.0-rc.1')
  assert.deepEqual(inv.disabledEntryIds, ['dsh-opencode-session'])
})

test('parseDisabledIds：只认 disabled: true 的顶层条目', () => {
  const disabled = parseDisabledIds(PATCH)
  assert.deepEqual([...disabled], ['dsh-opencode-session'])
  assert.equal(parseDisabledIds('- id: a\n  disabled: false\n').size, 0)
  assert.equal(parseDisabledIds('').size, 0)
})

test('stripSelfPatchRow：剥掉本插件自身的配置行，保留其他条目', () => {
  const { text, stripped } = stripSelfPatchRow(PATCH, 'webdav-sync')
  assert.equal(stripped, true)
  assert.ok(!text.includes('super-secret'), '插件自己的 WebDAV 密码不会跟着环境走（避免换机后自指）')
  assert.ok(!text.includes('webdav-sync'))
  assert.ok(text.includes('dsh-opencode-session'), '其他条目原样保留')
  assert.ok(text.includes('llm-pi-ai'))
  assert.equal(stripSelfPatchRow(PATCH, 'something-else').stripped, false)
})

test('scanEnvWarnings：机器相关路径与 !!js 表达式', () => {
  assert.ok(scanEnvWarnings({}, '- insert:\n  - name: file:///Users/x/plugin.mjs\n').some((w) => w.includes('绝对路径')))
  assert.ok(scanEnvWarnings({}, 'config:\n  x: !!js ctx.get("a")\n').some((w) => w.includes('!!js')))
  assert.equal(scanEnvWarnings({}, 'plain: 1\n').length, 0)
})

test('diffInventory：谁多了、谁少了、版本变了什么', () => {
  const mine = { plugins: [{ name: 'a', version: '1.0.0', enabled: true }, { name: 'b', version: '2.0.0', enabled: true }] }
  const theirs = { plugins: [{ name: 'a', version: '1.1.0', enabled: true }, { name: 'c', version: '3.0.0', enabled: true }, { name: 'b', version: '2.0.0', enabled: false }] }
  const d = diffInventory(mine, theirs)
  assert.deepEqual(d.added.map((x) => x.name), ['c'])
  assert.deepEqual(d.removed.map((x) => x.name), [])
  assert.deepEqual(d.changed, [{ name: 'a', from: '1.0.0', to: '1.1.0' }])
  assert.deepEqual(d.toggled, [{ name: 'b', from: true, to: false }])
  assert.deepEqual(diffInventory(mine, mine).changed, [])
})
