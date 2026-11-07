/** Same-origin, session-gated transport for the native Hindsight UI; memory APIs stay in Hindsight. */
import { randomBytes } from 'node:crypto'
import { request as http, type IncomingMessage, type ServerResponse, type OutgoingHttpHeaders } from 'node:http'
import { request as https } from 'node:https'
import { MEMORY_CONSOLE_PATH } from './api.ts'

const GATE_COOKIE = 'dsh_memory_console'
const nativeCookie = (value: string) => /^(?:hindsight_cp_access|NEXT_LOCALE)=/.test(value)
const requestHeaders = ['accept', 'accept-language', 'content-type', 'content-length', 'range', 'if-none-match', 'if-modified-since',
  'rsc', 'next-router-state-tree', 'next-router-prefetch', 'next-url', 'next-action']
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
function error(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; frame-ancestors 'self'", 'x-content-type-options': 'nosniff' })
  res.end(`<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Hindsight</title><p>${message}</p></html>`)
}

/** Issues an HttpOnly capability through the protected panel API, then streams only the configured console. */
export class MemoryConsole {
  private readonly token = randomBytes(32).toString('hex')
  constructor(private readonly port: number, private readonly url: () => string) {}
  authorize(res: ServerResponse): void {
    res.setHeader('set-cookie', `${GATE_COOKIE}=${this.token}; Path=${MEMORY_CONSOLE_PATH}; HttpOnly; SameSite=Strict`)
  }
  forward(req: IncomingMessage, res: ServerResponse): void {
    const host = req.headers.host, cookies = (req.headers.cookie ?? '').split(';').map(value => value.trim())
    if ((host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`)
      || !cookies.includes(`${GATE_COOKIE}=${this.token}`) || req.headers['sec-fetch-site'] === 'cross-site'
      || (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`)) {
      error(res, 403, '请先打开 Superagent 的“设置 → 记忆”，再重新加载管理页面。'); return
    }
    const target = new URL(this.url()), incoming = new URL(req.url ?? '/', 'http://localhost')
    if (target.pathname.replace(/\/$/, '') !== MEMORY_CONSOLE_PATH) {
      error(res, 502, `Hindsight 控制台需要部署在 ${MEMORY_CONSOLE_PATH} 路径。请检查连接设置与控制台部署配置。`); return
    }
    target.pathname = incoming.pathname; target.search = incoming.search
    // Hindsight 1.2's locale matcher skips the bare base path after trailing-slash normalization.
    if (target.pathname === MEMORY_CONSOLE_PATH || target.pathname === MEMORY_CONSOLE_PATH + '/') target.pathname = MEMORY_CONSOLE_PATH + '/dashboard'
    const headers: OutgoingHttpHeaders = {}
    for (const name of requestHeaders) if (req.headers[name] !== undefined) headers[name] = req.headers[name]
    const session = cookies.filter(nativeCookie).join('; ')
    if (session) headers.cookie = session
    if (req.headers.origin) headers.origin = target.origin
    headers['x-forwarded-proto'] = target.protocol.slice(0, -1)
    const upstream = (target.protocol === 'https:' ? https : http)(target, { method: req.method, headers }, response => {
      const outgoing: OutgoingHttpHeaders = {}
      const connection = String(response.headers.connection ?? '').toLowerCase().split(',').map(value => value.trim())
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined && !hopHeaders.has(name) && !connection.includes(name) && name !== 'set-cookie' && name !== 'location') outgoing[name] = value
      }
      if (response.headers.location) {
        let location: URL
        try { location = new URL(response.headers.location, target) }
        catch { response.destroy(); error(res, 502, 'Hindsight 返回了无效跳转，请检查控制台部署配置。'); return }
        if (location.origin !== target.origin || !(location.pathname === MEMORY_CONSOLE_PATH || location.pathname.startsWith(MEMORY_CONSOLE_PATH + '/'))) {
          response.destroy(); error(res, 502, 'Hindsight 返回了不受支持的跳转，请检查控制台部署路径。'); return
        }
        outgoing.location = location.pathname + location.search + location.hash
      }
      const setCookie = (response.headers['set-cookie'] ?? []).filter(nativeCookie)
        .map(value => value.replace(/;\s*(?:Domain|Path)=[^;]*/ig, '') + `; Path=${MEMORY_CONSOLE_PATH}`)
      if (setCookie.length) outgoing['set-cookie'] = setCookie
      outgoing['cache-control'] = 'no-store'
      outgoing['x-frame-options'] = 'SAMEORIGIN'
      outgoing['content-security-policy'] = [response.headers['content-security-policy'], "frame-ancestors 'self'"].filter(Boolean).join('; ')
      res.writeHead(response.statusCode ?? 502, outgoing)
      response.on('error', () => res.destroy()); response.pipe(res)
    })
    upstream.setTimeout(30_000, () => upstream.destroy(new Error('Console timeout')))
    upstream.on('error', () => { if (!res.headersSent) error(res, 502, '无法连接 Hindsight，请检查服务状态后重新加载。'); else res.destroy() })
    req.on('aborted', () => upstream.destroy()); res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  }
}
