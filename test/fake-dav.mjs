/**
 * 进程内伪 WebDAV 服务器（仅测试用）：MKCOL / PUT / GET / PROPFIND / DELETE + Basic 认证。
 * 用它做 wire 级集成测试，不碰真实网络服务。
 */
import { createServer } from 'node:http'

export async function startFakeDav({ username = 'u', password = 'p', root = '/dav', realm = 'fake' } = {}) {
  /** @type {Map<string, Buffer>} */
  const files = new Map()
  /** @type {Set<string>} */
  // WebDAV 端点的挂载根真实存在（baseUrl 指向的那一级）。
  // 注意：baseUrl 自身的路径不在插件自动创建范围内 —— 若它不存在，
  // ping 会返回 404，前端据此给出"目标目录不存在"的明确提示。
  const dirs = new Set(['/', root])
  const expected = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')

  const norm = (p) => decodeURIComponent(p).replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/'
  const parent = (p) => norm(p).split('/').slice(0, -1).join('/') || '/'

  const server = createServer((req, res) => {
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { 'www-authenticate': `Basic realm="${realm}"` })
      res.end('unauthorized')
      return
    }
    const path = norm(new URL(req.url, 'http://127.0.0.1').pathname)
    const method = req.method.toUpperCase()
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      if (method === 'MKCOL') {
        if (dirs.has(path) || files.has(path)) return res.writeHead(405).end()
        if (!dirs.has(parent(path))) return res.writeHead(409).end()
        dirs.add(path)
        return res.writeHead(201).end()
      }
      if (method === 'PUT') {
        // 严格模式：绝不自动创建父目录。真实的 WebDAV 服务器在父集合缺失时
        // 返回 409 Conflict —— 之前这里"顺手"建目录，掩盖了客户端把目录建错位置
        // 的 bug（basePath 被拼两次），导致本地测试全绿、真实服务器全 409。
        if (!dirs.has(parent(path))) return res.writeHead(409).end()
        files.set(path, body)
        return res.writeHead(files.has(path) ? 204 : 201).end()
      }
      if (method === 'GET') {
        const buf = files.get(path)
        if (!buf) return res.writeHead(404).end()
        return res.writeHead(200, { 'content-length': String(buf.length) }).end(buf)
      }
      if (method === 'DELETE') {
        if (!files.delete(path)) return res.writeHead(404).end()
        return res.writeHead(204).end()
      }
      if (method === 'PROPFIND') {
        const depth = String(req.headers.depth ?? '1')
        const entries = []
        const emit = (href, isDir, size) => entries.push(
          `<D:response><D:href>${href}</D:href><D:propstat><D:prop><D:resourcetype>${isDir ? '<D:collection/>' : ''}</D:resourcetype>${isDir ? '' : `<D:getcontentlength>${size}</D:getcontentlength>`}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
        )
        if (path !== '/' && !dirs.has(path) && !files.has(path)) return res.writeHead(404).end()
        emit(path === '/' ? '/' : `${path}/`, dirs.has(path) || path === '/', 0)
        if (depth !== '0') {
          for (const d of dirs) if (d !== path && parent(d) === path) emit(`${d}/`, true, 0)
          for (const [f, buf] of files) if (parent(f) === path) emit(f, false, buf.length)
        }
        return res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' })
          .end(`<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${entries.join('')}</D:multistatus>`)
      }
      res.writeHead(405).end()
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    url: `http://127.0.0.1:${port}${root}`,
    files,
    dirs,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}
