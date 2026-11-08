/** Same-origin, session-gated transport for the native Hindsight UI; memory APIs stay in Hindsight. */
import { createHash } from 'node:crypto'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { request as http, type IncomingMessage, type ServerResponse, type OutgoingHttpHeaders } from 'node:http'
import { request as https } from 'node:https'
import { MEMORY_CONSOLE_PATH } from './api.ts'

const nativeCookie = (value: string) => /^(?:hindsight_cp_access|NEXT_LOCALE)=/.test(value)
const requestHeaders = ['accept', 'accept-language', 'content-type', 'content-length', 'range', 'if-none-match', 'if-modified-since',
  'rsc', 'next-router-state-tree', 'next-router-prefetch', 'next-url', 'next-action']
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
function error(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; frame-ancestors 'self'", 'x-content-type-options': 'nosniff' })
  res.end(`<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Hindsight</title><p>${message}</p></html>`)
}
function remember(cookies: Map<string, string>, values: string[]): void {
  for (const cookie of values.filter(nativeCookie)) {
    const pair = cookie.split(';')[0]!, at = pair.indexOf('='), name = pair.slice(0, at), value = pair.slice(at + 1)
    if (!value || /;\s*max-age=0(?:;|$)/i.test(cookie)) cookies.delete(name)
    else cookies.set(name, value)
  }
}

/** Authenticates through DSH and keeps native cookies server-side because the desktop bridge strips browser cookies. */
export class MemoryConsole {
  private readonly sessions = new Map<string, { cookies: Map<string, string>; login: Promise<void> | undefined }>()
  constructor(private readonly url: () => string, private readonly connection: Pick<HostConnectionHandle, 'admit'>, private readonly key: () => string) {}
  private async signIn(target: URL, key: string, cookies: Map<string, string>): Promise<void> {
    const response = await fetch(new URL(MEMORY_CONSOLE_PATH + '/api/auth/login', target), { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }), signal: AbortSignal.timeout(10_000) })
    if (response.ok) remember(cookies, response.headers.getSetCookie())
    await response.body?.cancel()
  }
  async forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const admission = this.connection.admit(req)
    if ('rejection' in admission) {
      error(res, admission.rejection, 'DSH 连接认证已失效，请重新连接 DSH 后加载管理页面。'); return
    }
    const target = new URL(this.url()), incoming = new URL(req.url ?? '/', 'http://localhost')
    if (![MEMORY_CONSOLE_PATH, MEMORY_CONSOLE_PATH + '/dashboard'].includes(target.pathname.replace(/\/$/, ''))) {
      error(res, 502, `Hindsight 控制台需要部署在 ${MEMORY_CONSOLE_PATH} 路径。请检查连接设置与控制台部署配置。`); return
    }
    const identity = (req.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith('dsh-auth-')).sort().join(';')
    if (!identity) { error(res, 401, '请通过已登录的 DSH 连接打开管理页面。'); return }
    const key = this.key(), id = createHash('sha256').update(identity + '\0' + target.href + '\0' + key).digest('hex')
    let session = this.sessions.get(id)
    if (!session) {
      // Bound transient sessions; native access keys and memory content are never stored here.
      if (this.sessions.size >= 64) this.sessions.delete(this.sessions.keys().next().value!)
      session = { cookies: new Map(), login: undefined }; this.sessions.set(id, session)
    }
    const current = session, sessionCookies = current.cookies
    if (key && req.method === 'GET' && [MEMORY_CONSOLE_PATH, MEMORY_CONSOLE_PATH + '/'].includes(incoming.pathname)) {
      // A refused automatic sign-in falls back to the native login page; native logout remains manual until this entry is reopened.
      current.login ??= this.signIn(target, key, sessionCookies).catch(() => {}).finally(() => { current.login = undefined })
      await current.login
      if (res.destroyed) return
    }
    target.pathname = incoming.pathname; target.search = incoming.search
    // Hindsight 1.2's locale matcher skips the bare base path after trailing-slash normalization.
    if (target.pathname === MEMORY_CONSOLE_PATH || target.pathname === MEMORY_CONSOLE_PATH + '/') target.pathname = MEMORY_CONSOLE_PATH + '/dashboard'
    const headers: OutgoingHttpHeaders = {}
    for (const name of requestHeaders) if (req.headers[name] !== undefined) headers[name] = req.headers[name]
    const cookie = [...sessionCookies].map(([name, value]) => `${name}=${value}`).join('; ')
    if (cookie) headers.cookie = cookie
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
      remember(sessionCookies, response.headers['set-cookie'] ?? [])
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
