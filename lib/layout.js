/**
 * 会话落盘布局。
 *
 * 这是从 harness 的 jsonl 后端**逐字复刻**的算法：
 *   @deepseek-ai/dsh-session-persistence-jsonl/lib/index.js（encodeSegment / projectKey / projectDir）
 * 该包根只 export { JsonlCompressionSchema, default }，**拿不到这两个函数**，
 * 所以第三方插件只能自己复刻。别改这里的规则，否则恢复时位置对不上。
 */
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { createZstdDecompress } from 'node:zlib'

const SAFE_SEGMENT = /^[A-Za-z0-9._-]$/

/** 文件名/目录名编码：不安全字符 → ~XXXX（UTF-16 code unit 十六进制，大写，补足 4 位） */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && SAFE_SEGMENT.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/** 项目目录名：路径分隔符连续段 → 单个 `-`，其余不安全字符 → ~XXXX，两端加 `--`，最长 251 */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && SAFE_SEGMENT.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** session.v4.jsonl.zstd / session.jsonl.zstd / *.jsonl 都认（v0 没有 .vN） */
export function classifyLogFile(name) {
  const m = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/.exec(name)
  if (!m) return null
  return { version: m[1] === undefined ? 0 : Number(m[1]), compression: m[2] ? 'zstd' : 'none' }
}

/** 只解出日志首行（session header），不把整份日志读进内存 */
export async function readSessionHeader(absPath) {
  const stream = createReadStream(absPath).pipe(createZstdDecompress())
  try {
    let buf = Buffer.alloc(0)
    for await (const chunk of stream) {
      buf = Buffer.concat([buf, chunk])
      const nl = buf.indexOf(0x0a)
      if (nl >= 0) return JSON.parse(buf.subarray(0, nl).toString('utf8'))
      if (buf.length > 4 * 1024 * 1024) break
    }
    const nl = buf.indexOf(0x0a)
    const line = nl >= 0 ? buf.subarray(0, nl) : buf
    return line.length ? JSON.parse(line.toString('utf8')) : null
  } catch {
    return null
  } finally {
    stream.destroy()
  }
}

/**
 * 扫描本机会话根目录。
 * @returns {Promise<Array<{relPath:string,absPath:string,name:string,size:number,mtimeMs:number,
 *   projectDir:string,sessionId:string,cwd:string|null,id:string|null,version:number}>>}
 */
export async function scanLocalSessions(sessionsRoot) {
  const out = []
  let projectDirs
  try {
    projectDirs = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return out
  }
  for (const project of projectDirs) {
    if (!project.isDirectory()) continue
    const projectPath = join(sessionsRoot, project.name)
    let sessionDirs
    try {
      sessionDirs = await readdir(projectPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessionDirs) {
      if (!session.isDirectory()) continue
      const sessionPath = join(projectPath, session.name)
      let files
      try {
        files = await readdir(sessionPath, { withFileTypes: true })
      } catch {
        continue
      }
      for (const file of files) {
        if (!file.isFile()) continue
        const kind = classifyLogFile(file.name)
        if (!kind) continue // session.lock 等一律不同步
        const absPath = join(sessionPath, file.name)
        let st
        try {
          st = await stat(absPath)
        } catch {
          continue
        }
        const header = kind.compression === 'zstd' ? await readSessionHeader(absPath) : null
        const cwd = typeof header?.cwd === 'string' ? header.cwd : null
        out.push({
          relPath: posix.join(project.name, session.name, file.name),
          absPath,
          name: file.name,
          size: st.size,
          mtimeMs: st.mtimeMs,
          projectDir: project.name,
          sessionId: typeof header?.id === 'string' ? header.id : session.name,
          cwd,
          id: typeof header?.id === 'string' ? header.id : null,
          version: kind.version
        })
      }
    }
  }
  return out
}

/** 恢复时的目标目录：以**日志头部里的 cwd** 为准重算，保证 harness 的身份校验通过 */
export function targetDirFor(sessionsRoot, entry) {
  const cwd = typeof entry?.cwd === 'string' && entry.cwd.length > 0 ? entry.cwd : null
  const projectDir = cwd ? projectKey(cwd) : String(entry?.projectDir ?? '')
  const sessionDir = encodeSegment(String(entry?.sessionId ?? ''))
  return join(sessionsRoot, projectDir, sessionDir)
}
