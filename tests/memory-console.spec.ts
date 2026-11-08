import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { registerHttp, type HttpHost } from '../src/app/http.ts'

const prefix = '/orchestrator/hindsight'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
async function panel(upstream: string, consoleKey = '') {
  let handle = async (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(404); res.end() }
  const url = await listen((req, res) => { void handle(req, res) })
  const ctx = { webServer: { host: '127.0.0.1', port: Number(new URL(url).port),
    register: (route: { handler: typeof handle }) => { handle = route.handler; return () => {} } },
    connection: { admit: (req: IncomingMessage) => {
      if (req.headers.origin && req.headers.origin !== url || req.headers['sec-fetch-site'] === 'cross-site') return { rejection: 403 }
      return /(?:^|;\s*)dsh-auth-test=owner-[ab](?:;|$)/.test(req.headers.cookie ?? '') ? { peer: { id: 'owner' } } : { rejection: 401 }
    } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), memory: {
    config: () => ({ consoleUrl: upstream + prefix }), consoleKey: () => consoleKey, view: () => ({ configured: true }), scopes: () => [],
  } } as unknown as HttpHost)
  const response = await fetch(url + '/orchestrator/api/memory', { headers: { 'x-orchestrator-request': '1' } })
  const cookie = 'dsh-auth-test=owner-a'
  return { url, cookie, response }
}

it('lets an authenticated DSH connection reach the native login without relying on browser cookies', async () => {
  const seen: string[] = []
  const upstream = await listen((req, res) => { seen.push(req.url!); res.end('<input type="password" aria-label="管理密钥">') })
  const { url, cookie, response } = await panel(upstream)
  expect(response.status).toBe(200)
  expect(cookie).not.toBe('')
  expect(response.headers.get('set-cookie')).toBeNull()
  expect((await fetch(url + '/orchestrator/api/memory')).headers.get('set-cookie')).toBeNull()
  expect((await fetch(url + prefix + '/')).status).toBe(401)
  expect((await fetch(url + prefix + '/', { headers: { cookie: 'dsh_memory_console=invalid' } })).status).toBe(401)
  expect((await fetch(url + prefix + '/', { headers: { cookie, 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
  const login = await fetch(url + prefix + '/', { headers: { cookie } })
  expect(login.status).toBe(200); expect(await login.text()).toContain('type="password"')
  expect(seen).toEqual([prefix + '/dashboard'])
})

it('automatically signs in only an authenticated DSH entry and shares one handshake across concurrent loads', async () => {
  let logins = 0
  const upstream = await listen(async (req, res) => {
    if (req.url!.endsWith('/api/auth/login')) {
      logins++; let body = ''; for await (const chunk of req) body += chunk
      expect(JSON.parse(body)).toEqual({ key: 'private-ui-key' }); expect(req.headers.cookie).toBeUndefined()
      res.setHeader('set-cookie', 'hindsight_cp_access=auto-session; Path=/; HttpOnly'); res.end('{}'); return
    }
    if (req.url!.endsWith('/api/auth/logout')) { res.setHeader('set-cookie', 'hindsight_cp_access=; Max-Age=0; Path=/; HttpOnly'); res.end('{}'); return }
    res.writeHead(req.headers.cookie === 'hindsight_cp_access=auto-session' ? 200 : 401)
    res.end(req.headers.cookie ? 'native dashboard' : 'manual login')
  })
  const { url, cookie } = await panel(upstream, 'private-ui-key')
  expect((await fetch(url + prefix + '/')).status).toBe(401); expect(logins).toBe(0)
  const pages = await Promise.all([1, 2].map(() => fetch(url + prefix + '/', { headers: { cookie } })))
  expect(pages.map(page => page.status)).toEqual([200, 200]); expect(logins).toBe(1)
  for (const page of pages) { expect(await page.text()).not.toContain('private-ui-key'); expect(page.headers.get('set-cookie')).toBeNull() }
  await fetch(url + prefix + '/api/auth/logout', { method: 'POST', headers: { cookie } })
  expect((await fetch(url + prefix + '/login', { headers: { cookie } })).status).toBe(401)
  expect(logins).toBe(1)
  expect((await fetch(url + prefix + '/', { headers: { cookie } })).status).toBe(200); expect(logins).toBe(2)
})

it('falls back to native manual login when the configured automatic-login key is refused', async () => {
  let attempts = 0
  const upstream = await listen((req, res) => {
    if (req.url!.endsWith('/api/auth/login')) { attempts++; res.writeHead(401); res.end('refused'); return }
    res.end('native manual login')
  })
  const { url, cookie } = await panel(upstream, 'wrong-ui-key')
  const page = await fetch(url + prefix + '/', { headers: { cookie } })
  expect(await page.text()).toBe('native manual login'); expect(attempts).toBe(1)
})

it('never follows a login redirect carrying the configured console key to another service', async () => {
  let leaked = 0
  const other = await listen((_req, res) => { leaked++; res.end('unexpected') })
  const upstream = await listen((req, res) => {
    if (req.url!.endsWith('/api/auth/login')) { res.writeHead(307, { location: other + '/login' }); res.end(); return }
    res.end('native manual login')
  })
  const { url, cookie } = await panel(upstream, 'private-ui-key')
  const page = await fetch(url + prefix + '/', { headers: { cookie } })
  expect(await page.text()).toBe('native manual login'); expect(leaked).toBe(0)
})

it('keeps native login and logout working through the DSH desktop bridge that strips all browser cookies', async () => {
  const upstream = await listen(async (req, res) => {
    if (req.url!.endsWith('/api/auth/login')) { res.setHeader('set-cookie', 'hindsight_cp_access=logged-in; Path=/; HttpOnly'); res.end('signed in'); return }
    if (req.url!.endsWith('/api/auth/logout')) { res.setHeader('set-cookie', 'hindsight_cp_access=; Max-Age=0; Path=/; HttpOnly'); res.end('signed out'); return }
    res.writeHead(req.headers.cookie === 'hindsight_cp_access=logged-in' ? 200 : 401); res.end('native page')
  })
  const { url } = await panel(upstream)
  const desktop = async (path: string, method = 'GET', identity = 'owner-a') => {
    // DSH forwardWebRequest replaces Cookie and withholds every Set-Cookie from the renderer.
    const response = await fetch(url + prefix + path, { method, headers: { cookie: `dsh-auth-test=${identity}` } })
    const headers = new Headers(response.headers); headers.delete('set-cookie')
    return new Response(await response.arrayBuffer(), { status: response.status, headers })
  }
  expect((await desktop('/api/auth/login', 'POST')).status).toBe(200)
  expect((await desktop('/dashboard')).status).toBe(200)
  expect((await desktop('/dashboard', 'GET', 'owner-b')).status).toBe(401)
  expect((await desktop('/api/auth/logout', 'POST')).status).toBe(200)
  expect((await desktop('/dashboard')).status).toBe(401)
})

it('streams native requests and assets without forwarding panel credentials or allowing cross-site requests', async () => {
  let received: { path?: string; cookie?: string; authorization?: string; body?: string } = {}
  const upstream = await listen(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    received = { path: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization, body }
    res.setHeader('content-type', 'application/json'); res.end('{"success":true}')
  })
  const { url, cookie } = await panel(upstream)
  const path = prefix + '/api/auth/login?returnTo=%2Fbanks'
  expect((await fetch(url + path, { method: 'POST', headers: { cookie, origin: 'https://evil.test' }, body: 'key' })).status).toBe(403)
  const response = await fetch(url + path, { method: 'POST', headers: { origin: url, 'content-type': 'application/json',
    cookie: cookie + '; hindsight_cp_access=native-session; dsh_auth=private', authorization: 'Bearer panel-secret' }, body: '{"key":"ui-key"}' })
  expect(response.status).toBe(200)
  expect(received).toEqual({ path, cookie: undefined, authorization: undefined, body: '{"key":"ui-key"}' })
})

it('keeps redirects and cookies within the proxy path, including native logout, and reports upstream failure', async () => {
  const upstream = await listen((_req, res) => {
    res.setHeader('set-cookie', ['hindsight_cp_access=; Max-Age=0; Path=/; HttpOnly', 'dsh_auth=bad; Path=/'])
    res.writeHead(307, { location: upstream + prefix + '/login?returnTo=%2F' }); res.end()
  })
  const { url, cookie } = await panel(upstream)
  const response = await fetch(url + prefix + '/', { headers: { cookie }, redirect: 'manual' })
  expect(response.headers.get('location')).toBe(prefix + '/login?returnTo=%2F')
  expect(response.headers.getSetCookie()).toEqual([])
  const unavailable = await panel('http://127.0.0.1:1')
  const failure = await fetch(unavailable.url + prefix + '/', { headers: { cookie: unavailable.cookie } })
  expect(failure.status).toBe(502); expect(await failure.text()).toContain('无法连接 Hindsight')
})
