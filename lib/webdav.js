/**
 * 零依赖 WebDAV 客户端（Node 22 自带 fetch）。
 * 只用到同步会话必需的最小动词：MKCOL / PUT / GET / PROPFIND / DELETE。
 * 认证走 HTTP Basic；超时走 AbortSignal。
 */

export class WebDavError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'WebDavError'
    this.status = status
  }
}

const splitSegments = (p) => String(p ?? '').split('/').map((s) => s.trim()).filter(Boolean)
const encodeSegments = (segments) => segments.map((s) => encodeURIComponent(s)).join('/')

export class WebDavClient {
  constructor({ baseUrl, username = '', password = '', basePath = '', timeoutMs = 30000, fetchImpl = fetch }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '')
    this.basePath = splitSegments(basePath).join('/')
    this.auth = username || password ? 'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64') : null
    this.timeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 30000
    this.fetchImpl = fetchImpl
  }

  /** basePath + rel 的路径片段。basePath 只在这一处补，别的路径拼装必须走它。 */
  pathSegments(rel = '') {
    return [...splitSegments(this.basePath), ...splitSegments(rel)]
  }

  /** 相对 basePath 的 rel → 完整 URL */
  url(rel = '') {
    const p = encodeSegments(this.pathSegments(rel))
    return p ? `${this.baseUrl}/${p}` : `${this.baseUrl}/`
  }

  async send(method, url, { body, headers = {}, expect = [] } = {}) {
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        ...(this.auth ? { authorization: this.auth } : {}),
        ...headers
      },
      body,
      signal: AbortSignal.timeout(this.timeoutMs)
    })
    if (!res.ok && !expect.includes(res.status)) {
      const text = await res.text().catch(() => '')
      throw new WebDavError(`${method} ${url} -> ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`, res.status)
    }
    return res
  }

  /** 相对 basePath 的请求 */
  async request(method, rel, opts) {
    return this.send(method, this.url(rel), opts)
  }

  /**
   * 逐级 MKCOL（WebDAV 不允许一次建多层）。
   * 返回第一个"非预期"错误，没有则 null —— 调用方据此在 PUT 失败时给出可诊断的原因，
   * 而不是把所有建目录失败都静默吞掉。
   *
   * 这里刻意用 pathSegments() 自己拼 URL，而不是 request()：
   * 一旦写成 `request('MKCOL', `${this.basePath}/${rel}`)`，basePath 会被补两次，
   * 目录会被建到 `dsh-sessions/dsh-sessions/…` 而 PUT 去 `dsh-sessions/…`，
   * 表现为"每个文件都 409 Conflict"，极难定位。
   */
  async ensureDir(rel) {
    let firstError = null
    const segments = this.pathSegments(rel)
    for (let i = 1; i <= segments.length; i++) {
      const target = `${this.baseUrl}/${encodeSegments(segments.slice(0, i))}`
      try {
        // 已存在的目录：标准服务器 405，部分服务器 301/200/403
        await this.send('MKCOL', target, { expect: [200, 201, 301, 403, 405] })
      } catch (err) {
        firstError ??= err
      }
    }
    return firstError
  }

  async putFile(rel, data) {
    const dir = splitSegments(rel).slice(0, -1).join('/')
    const mkcolError = dir ? await this.ensureDir(dir) : null
    try {
      await this.request('PUT', rel, { body: data, headers: { 'content-type': 'application/octet-stream' } })
    } catch (err) {
      // 409 = 父集合不存在。把"建目录为什么失败"一并带出来，否则只剩一个裸 409。
      if (mkcolError && (err?.status === 409 || err?.status === 404)) {
        throw new WebDavError(`${err.message}（父目录不存在，且逐级 MKCOL 失败：${mkcolError.message}）`, err.status)
      }
      throw err
    }
  }

  /** @returns {Promise<Buffer|null>} 不存在返回 null */
  async getFile(rel) {
    const res = await this.request('GET', rel, { expect: [404] })
    if (res.status === 404) return null
    return Buffer.from(await res.arrayBuffer())
  }

  /** PROPFIND Depth:1 → [{name, isDir, size}]（不含自身） */
  async list(rel) {
    const res = await this.request('PROPFIND', rel, { headers: { depth: '1', 'content-type': 'application/xml' }, body: '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/><getcontentlength/></prop></propfind>', expect: [404, 207] })
    if (res.status === 404) return []
    const xml = await res.text()
    const self = decodeURIComponent(new URL(this.url(rel)).pathname).replace(/\/+$/, '')
    const out = []
    for (const block of xml.match(/<[^>]*response\b[^>]*>[\s\S]*?<\/[^>]*response>/gi) ?? []) {
      const href = /<[^>]*href\b[^>]*>([\s\S]*?)<\/[^>]*href>/i.exec(block)?.[1]?.trim()
      if (!href) continue
      let path = href
      if (path.includes('://')) {
        try { path = new URL(path).pathname } catch { /* keep */ }
      }
      path = decodeURIComponent(path).replace(/\/+$/, '')
      if (path === self) continue
      const isDir = /<[^>]*collection\b/i.test(block)
      const size = Number(/<[^>]*getcontentlength\b[^>]*>(\d+)</i.exec(block)?.[1] ?? 0)
      out.push({ name: path.split('/').filter(Boolean).pop() ?? '', path, isDir, size })
    }
    return out
  }

  async remove(rel) {
    await this.request('DELETE', rel, { expect: [404] })
  }

  /** PROPFIND Depth:0 → 207（存在）/ 404（不存在）/ 其他状态码 */
  async ping() {
    const res = await this.request('PROPFIND', '', { headers: { depth: '0' }, expect: [207, 404] })
    return res.status
  }
}
