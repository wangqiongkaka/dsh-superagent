import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { registerHttp } from '../src/app/http.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { Memories } from '../src/app/memory.ts'
import { Store } from '../src/app/store.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') {
  let handler: Handler = async () => {}
  const ctx = { webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}

it('validates a main Session rebuild request before passing the expected Session ID to the runtime', async () => {
  const rebuildMaster = vi.fn(async () => ({ masterId: 'new-main' }))
  const call = serve({ rebuildMaster })
  for (const body of [{}, { masterId: '' }, { masterId: 'old-main', extra: true }]) {
    expect(await call('POST', 'master/rebuild', body)).toMatchObject({ status: 400 })
  }
  expect(rebuildMaster).not.toHaveBeenCalled()
  expect(await call('POST', 'master/rebuild', { masterId: 'old-main' })).toEqual({ status: 200, body: { masterId: 'new-main' } })
  expect(rebuildMaster).toHaveBeenCalledExactlyOnceWith('old-main')
})

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'disk full' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // Management routes require a loopback Web server.
  expect(() => serve({}, '0.0.0.0')).toThrow('Orchestrator management requires a loopback Web server')
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})

it('routes cleanup only after resolving the ticket', async () => {
  const ids: string[] = []
  const call = serve({ store: { tickets: { get: (id: string) => id === 't1' ? { id } : undefined } },
    executor: { cleanupWorktrees: async (id: string) => { ids.push(id); return [{ repository: 'repo', removed: true }] } } })
  expect((await call('POST', 'tickets/missing/cleanup-worktrees')).status).toBe(404)
  expect((await call('POST', 'tickets/t1/cleanup-worktrees', {})).body).toEqual([{ repository: 'repo', removed: true }])
  expect(ids).toEqual(['t1'])
})


it('validates and forwards ignored-file confirmation', async () => {
  const requests: unknown[] = []
  const call = serve({ store: { tickets: { get: () => ({ id: 't1' }) } },
    executor: { cleanupWorktrees: async (...args: unknown[]) => { requests.push(args); return [] } } })
  expect((await call('POST', 'tickets/t1/cleanup-worktrees', { ignored: { repository: 'repo', token: 'invalid' } })).status).toBe(400)
  expect(requests).toEqual([])
  const ignored = { repository: 'repo', token: 'a'.repeat(64) }
  expect((await call('POST', 'tickets/t1/cleanup-worktrees', { ignored })).status).toBe(200)
  expect(requests).toEqual([['t1', ignored]])
})

it('validates memory settings and filters, excludes credentials and reports revision conflicts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'memory-http-'))
  const store = new Store(join(directory, 'state.sqlite'))
  try {
    const memory = new Memories(store, new AbortController().signal)
    const call = serve({ memory })
    expect((await call('PUT', 'memory/config', { ...memory.config(), enabled: true, apiKey: 'test-only-private' })).status).toBe(200)
    const result = await call('GET', 'memory')
    expect(result.body.config).toMatchObject({ enabled: true, configured: true, revision: 1 })
    expect(JSON.stringify(result)).not.toContain('test-only-private')
    expect((await call('GET', 'memory?status=unknown')).status).toBe(400)
    expect((await call('PUT', 'memory/config', { ...memory.config(), revision: 0 })).status).toBe(409)
    expect((await call('PUT', 'memory/config', { ...memory.config(), threshold: 2 })).status).toBe(400)
    expect((await call('PUT', 'memory/missing', { revision: 1, text: '', scope: 'x', status: 'active' })).status).toBe(400)
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})
