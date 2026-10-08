/**
 * WebDAV 客户端单测：路径拼装、逐级 MKCOL、错误是否可见。
 *
 * 这些用例锁死一个真实事故：ensureDir 曾经用 `${this.basePath}/${rel}` 拼 prefix
 * 再交给会自动补 basePath 的 url()，于是 basePath 被补两次 —— 目录建到
 * `dsh-sessions/dsh-sessions/…`，PUT 去 `dsh-sessions/…`，父集合不存在，
 * **每个文件都 409 Conflict**。当时之所以没被发现，是因为测试用的假服务器
 * 在 PUT 时会自动创建父目录，把这个类别的错误整个掩盖了。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { WebDavClient, WebDavError } from '../lib/webdav.js'

/** 记录请求并按规则应答的假 fetch */
function recorder(handler = () => ({ status: 201 })) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase()
    calls.push({ method, url, path: new URL(url).pathname })
    const { status = 201, body = '' } = handler(method, url) ?? {}
    return new Response(body, { status })
  }
  return { calls, fetchImpl }
}

test('url()：basePath 只补一次，路径片段逐段编码', () => {
  const c = new WebDavClient({ baseUrl: 'https://dav.example.com/dav/', basePath: 'dsh-sessions' })
  assert.equal(c.url(''), 'https://dav.example.com/dav/dsh-sessions')
  assert.equal(c.url('sessions/a b/c.txt'), 'https://dav.example.com/dav/dsh-sessions/sessions/a%20b/c.txt')

  // 无 basePath 时，url('') 指向 baseUrl 这个集合本身（带尾斜杠，符合集合 URL 惯例）
  const bare = new WebDavClient({ baseUrl: 'https://dav.example.com/dav', basePath: '' })
  assert.equal(bare.url(''), 'https://dav.example.com/dav/')
  assert.equal(bare.url('x'), 'https://dav.example.com/dav/x')
})

test('ensureDir：逐级 MKCOL，且 basePath 绝不出现两次', async () => {
  const { calls, fetchImpl } = recorder(() => ({ status: 201 }))
  const c = new WebDavClient({ baseUrl: 'https://h/dav', basePath: 'backup', fetchImpl })
  const err = await c.ensureDir('sessions/proj/id')

  assert.equal(err, null, '全部 201 时不该有错误')
  assert.deepEqual(calls.map((x) => x.method), ['MKCOL', 'MKCOL', 'MKCOL', 'MKCOL'])
  assert.deepEqual(calls.map((x) => x.path), [
    '/dav/backup',
    '/dav/backup/sessions',
    '/dav/backup/sessions/proj',
    '/dav/backup/sessions/proj/id'
  ])
  for (const call of calls) {
    assert.ok(!call.path.includes('/backup/backup'), `basePath 被拼了两次: ${call.path}`)
    assert.equal(call.path.split('/').filter((s) => s === 'backup').length, 1, `backup 出现多次: ${call.path}`)
  }
})

test('ensureDir：已存在的目录（405）视为成功', async () => {
  const { fetchImpl } = recorder(() => ({ status: 405 }))
  const c = new WebDavClient({ baseUrl: 'https://h/dav', basePath: 'backup', fetchImpl })
  assert.equal(await c.ensureDir('sessions'), null)
})

test('putFile：父目录建不出来时，409 必须带上 MKCOL 的真实原因', async () => {
  const { fetchImpl } = recorder((method) => (method === 'MKCOL' ? { status: 409, body: 'Conflict' } : { status: 409, body: 'Conflict' }))
  const c = new WebDavClient({ baseUrl: 'https://h/dav', basePath: 'backup', fetchImpl })
  await assert.rejects(
    () => c.putFile('sessions/a/b.txt', Buffer.from('x')),
    (err) => {
      assert.ok(err instanceof WebDavError)
      assert.equal(err.status, 409)
      assert.match(err.message, /父目录不存在/)
      assert.match(err.message, /逐级 MKCOL 失败/, '不能把建目录失败静默吞掉')
      assert.match(err.message, /MKCOL/, '要指出是 MKCOL 失败')
      return true
    }
  )
})

test('putFile：先建目录再 PUT，顺序与目标路径正确', async () => {
  const { calls, fetchImpl } = recorder(() => ({ status: 201 }))
  const c = new WebDavClient({ baseUrl: 'https://h/dav', basePath: 'backup', fetchImpl })
  await c.putFile('sessions/a/b.txt', Buffer.from('hello'))
  assert.equal(calls.at(-1).method, 'PUT')
  assert.equal(calls.at(-1).path, '/dav/backup/sessions/a/b.txt')
  assert.deepEqual(calls.slice(0, -1).map((x) => x.method), ['MKCOL', 'MKCOL', 'MKCOL'])
})

test('ping：207 表示存在，404 表示不存在，都算"服务器可达"', async () => {
  const ok = new WebDavClient({ baseUrl: 'https://h/dav', basePath: 'backup', fetchImpl: recorder(() => ({ status: 207 })).fetchImpl })
  assert.equal(await ok.ping(), 207)
  const missing = new WebDavClient({ baseUrl: 'https://h/dav', basePath: 'backup', fetchImpl: recorder(() => ({ status: 404 })).fetchImpl })
  assert.equal(await missing.ping(), 404)
})

test('认证头与超时：只有给了用户名/密码才带 Basic', async () => {
  const seen = []
  const fetchImpl = async (url, init = {}) => { seen.push(init.headers); return new Response('', { status: 207 }) }
  await new WebDavClient({ baseUrl: 'https://h', fetchImpl }).ping()
  assert.equal(seen[0].authorization, undefined)
  await new WebDavClient({ baseUrl: 'https://h', username: 'u', password: 'p', fetchImpl }).ping()
  assert.equal(seen[1].authorization, 'Basic ' + Buffer.from('u:p').toString('base64'))
})

test('非法 timeoutMs 回落到 30000（不能变成 0 而立刻超时）', () => {
  assert.equal(new WebDavClient({ baseUrl: 'https://h', timeoutMs: undefined }).timeoutMs, 30000)
  assert.equal(new WebDavClient({ baseUrl: 'https://h', timeoutMs: 0 }).timeoutMs, 30000)
  assert.equal(new WebDavClient({ baseUrl: 'https://h', timeoutMs: 5000 }).timeoutMs, 5000)
})

test('list()：解析 PROPFIND multistatus（识别目录/文件、跳过自身）', async () => {
  const resp = (href, isDir, size = 0) => `<D:response><D:href>${href}</D:href><D:propstat><D:prop><D:resourcetype>${isDir ? '<D:collection/>' : ''}</D:resourcetype><D:getcontentlength>${size}</D:getcontentlength></D:prop></D:propstat></D:response>`
  const multistatus = (...items) => `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  ${items.join('\n  ')}
</D:multistatus>`

  const xml = multistatus(resp('/dav/backup/sessions/', true), resp('/dav/backup/sessions/a.txt', false, 12))
  const { fetchImpl } = recorder(() => ({ status: 207, body: xml }))
  const c = new WebDavClient({ baseUrl: 'https://h/dav', basePath: 'backup', fetchImpl })

  const items = await c.list('sessions')
  // 第一条 href 就是 list 的入参目录本身，必须跳过
  assert.equal(items.length, 1)
  assert.equal(items[0].name, 'a.txt')
  assert.equal(items[0].isDir, false)
  assert.equal(items[0].size, 12)
  assert.equal(items[0].path, '/dav/backup/sessions/a.txt')

  // 列 basePath 这一层：目录/文件都能识别
  const xml2 = multistatus(resp('/dav/backup/', true), resp('/dav/backup/sub/', true), resp('/dav/backup/f.txt', false, 3))
  const c2 = new WebDavClient({ baseUrl: 'https://h/dav', basePath: 'backup', fetchImpl: recorder(() => ({ status: 207, body: xml2 })).fetchImpl })
  const root = await c2.list('')
  assert.deepEqual(root.map((x) => [x.name, x.isDir]), [['sub', true], ['f.txt', false]])

  // 404 当空目录处理，不抛
  const missing = new WebDavClient({ baseUrl: 'https://h/dav', basePath: 'backup', fetchImpl: recorder(() => ({ status: 404 })).fetchImpl })
  assert.deepEqual(await missing.list('nope'), [])
})
