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
async function panel(upstream: string) {
  let handle = async (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(404); res.end() }
  const url = await listen((req, res) => { void handle(req, res) })
  const ctx = { webServer: { host: '127.0.0.1', port: Number(new URL(url).port),
    register: (route: { handler: typeof handle }) => { handle = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), memory: {
    config: () => ({ consoleUrl: upstream + prefix }), view: () => ({ configured: true }), scopes: () => [],
  } } as unknown as HttpHost)
  const response = await fetch(url + '/orchestrator/api/memory', { headers: { 'x-orchestrator-request': '1' } })
  const cookie = response.headers.getSetCookie()[0]?.split(';')[0] ?? ''
  return { url, cookie, response }
}

it('lets a remote browser reach the native login through the panel origin, guarded by a panel-only cookie', async () => {
  const seen: string[] = []
  const upstream = await listen((req, res) => { seen.push(req.url!); res.end('<input type="password" aria-label="管理密钥">') })
  const { url, cookie, response } = await panel(upstream)
  expect(response.status).toBe(200)
  expect(cookie).not.toBe('')
  expect(response.headers.get('set-cookie')).toContain('HttpOnly')
  expect(response.headers.get('set-cookie')).toContain('SameSite=Strict')
  expect((await fetch(url + '/orchestrator/api/memory')).headers.get('set-cookie')).toBeNull()
  expect((await fetch(url + prefix + '/')).status).toBe(403)
  expect((await fetch(url + prefix + '/', { headers: { cookie: 'dsh_memory_console=invalid' } })).status).toBe(403)
  expect((await fetch(url + prefix + '/', { headers: { cookie, 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
  const login = await fetch(url + prefix + '/', { headers: { cookie } })
  expect(login.status).toBe(200); expect(await login.text()).toContain('type="password"')
  expect(seen).toEqual([prefix + '/dashboard'])
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
  expect(received).toEqual({ path, cookie: 'hindsight_cp_access=native-session', authorization: undefined, body: '{"key":"ui-key"}' })
})

it('keeps redirects and cookies within the proxy path, including native logout, and reports upstream failure', async () => {
  const upstream = await listen((_req, res) => {
    res.setHeader('set-cookie', ['hindsight_cp_access=; Max-Age=0; Path=/; HttpOnly', 'dsh_auth=bad; Path=/'])
    res.writeHead(307, { location: upstream + prefix + '/login?returnTo=%2F' }); res.end()
  })
  const { url, cookie } = await panel(upstream)
  const response = await fetch(url + prefix + '/', { headers: { cookie }, redirect: 'manual' })
  expect(response.headers.get('location')).toBe(prefix + '/login?returnTo=%2F')
  expect(response.headers.getSetCookie()).toEqual([`hindsight_cp_access=; Max-Age=0; HttpOnly; Path=${prefix}`])
  const unavailable = await panel('http://127.0.0.1:1')
  const failure = await fetch(unavailable.url + prefix + '/', { headers: { cookie: unavailable.cookie } })
  expect(failure.status).toBe(502); expect(await failure.text()).toContain('无法连接 Hindsight')
})
