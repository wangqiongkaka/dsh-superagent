import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { memoryTools } from '../src/app/tools/memory.ts'
import { Memories, MemoryConflict } from '../src/app/memory.ts'
import { Store } from '../src/app/store.ts'
import { SettingsSchema } from '../src/policy.ts'
import { KV } from '../src/kv.ts'
import { key, type Ticket, type Trigger } from '../src/core/index.ts'

let directory: string, store: Store, memory: Memories
interface Document { document_id: string; content: string; metadata: Record<string, string> }
const documents = new Map<string, Document>()
const facts = (bank?: string) => [...documents.entries()].filter(([id]) => !bank || id.startsWith(bank + '/')).map(([, doc]) => ({
  id: `fact-${doc.document_id}`, document_id: doc.document_id, text: doc.content, metadata: doc.metadata, type: 'world',
}))
const defaultRequest: typeof fetch = async (url, init) => {
  if (!String(url).startsWith('http://127.0.0.1:8888/')) throw new Error('Unexpected non-Hindsight request')
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  const [, , , , bank, ...path] = new URL(String(url)).pathname.split('/')
  if (init?.method === 'POST' && path.join('/') === 'memories') {
    for (const doc of body.items as Document[]) documents.set(`${bank}/${doc.document_id}`, doc)
    return Response.json({ success: true, async: false })
  }
  if (init?.method === 'DELETE' && path[0] === 'documents') {
    documents.delete(`${bank}/${decodeURIComponent(path[1]!)}`)
    return Response.json({ success: true })
  }
  if (path.join('/') === 'memories/recall') return Response.json({ results: facts(bank) })
  throw new Error('Unexpected test request')
}
const request = vi.fn<typeof fetch>(defaultRequest)
const project = () => memory.scopes().find(scope => scope.kind === 'project' && scope.label === 'app')!
const shared = (id = 'a') => ({ trigger_id: id, scope: project().id, quote: store.triggers.get(id)!.text })
const trigger = (id: string, chat = 'a', text = '项目使用 SQLite 保存持久状态。'): Trigger => ({ id, source: 'feishu', threads: [{ source: 'feishu', id: chat }],
  actor: { source: 'feishu', id: 'alice' }, human: true, at: '2026-11-07T00:00:00Z', text, meta: { chatId: chat } })
function settings() { return SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [{ id: 'alice' }] } } }, sources: {
  feishu: { enabled: true, config: { chats: [{ chatId: 'a', repositories: 'app' }, { chatId: 'b', repositories: 'app' }, { chatId: 'c', repositories: 'other' }] } },
  git: { enabled: true, config: { repositories: [{ id: 'app', provider: 'github', url: 'https://github.com/acme/app', cli: 'gh' },
    { id: 'other', provider: 'github', url: 'https://github.com/acme/other', cli: 'gh' }] } },
} }) }
function ticket(): Ticket { return { id: 't', title: 'test', decisionId: '', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' },
  actor: { source: 'feishu', id: 'alice' }, scope: '' }, channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
  origin: { triggerId: 'a', triggerIds: ['a'] }, execution: { name: 'test', directory: '/tmp/test', assignment: 'a1', repositories: [{ id: 'app', provider: 'github', url: 'https://github.com/acme/app', cli: 'gh' }] } } }
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'superagent-memory-')); store = new Store(join(directory, 'state.sqlite'))
  store.saveSettings(settings()); store.triggers.save(trigger('a')); store.triggers.save(trigger('b', 'b')); store.triggers.save(trigger('c', 'c'))
  documents.clear(); request.mockReset(); request.mockImplementation(defaultRequest)
  memory = new Memories(store, new AbortController().signal, request)
  memory.configure({ ...memory.config(), enabled: true, hindsightApiKey: 'test-hindsight-private' })
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

it('sends original source text straight to Hindsight without screening or a local memory mirror', async () => {
  const receipt = await memory.propose({ trigger_id: 'a' })
  expect(receipt).toMatchObject({ retained: true, scope: { id: 'group:feishu:a' } })
  expect([...documents.values()]).toEqual([expect.objectContaining({ document_id: receipt.document_id, content: store.triggers.get('a')!.text,
    metadata: { source: 'trigger/a', source_kind: 'human_message' } })])
  expect(request).toHaveBeenCalledTimes(1)
  const body = JSON.parse(String(request.mock.calls[0]![1]!.body))
  expect(body).not.toHaveProperty('questions'); expect(body.items[0]).not.toHaveProperty('tags')
  expect(store.keys('memory-entry:')).toEqual([]); expect(store.keys('memory-history:')).toEqual([])
  expect(JSON.stringify(memory.view())).not.toContain('test-hindsight-private')
})
it('defaults to the original group and requires an explicit authorized project and excerpt for cross-group sharing', async () => {
  await memory.propose({ trigger_id: 'a' })
  expect((await memory.recall('数据库', 'b')).items).toEqual([])
  const excerpt = '项目使用 SQLite 保存持久状态。'
  store.triggers.save(trigger('a2', 'a', '群内私密讨论。'+excerpt))
  const entry = await memory.propose({ trigger_id: 'a2', scope: project().id, quote: excerpt })
  const recalled = await memory.recall('数据库', 'b')
  expect(recalled.items).toHaveLength(1); expect(recalled.items[0]!.sources[0]!.document_id).toBe(entry.document_id)
  expect(JSON.stringify(recalled)).not.toContain('群内私密讨论')
  await expect(memory.propose({ trigger_id: 'a2', scope: project().id })).rejects.toThrow('原文片段')
  expect((await memory.recall('数据库', 'c')).items).toEqual([])
})
it('exposes only authorized scope choices and cannot choose another project', async () => {
  const result = await memory.recall('知识', 'a')
  expect(result.scopes.map(scope => scope.label)).not.toContain('other')
  const other = memory.scopes().find(scope => scope.label === 'other')!
  request.mockClear()
  await expect(memory.propose({ trigger_id: 'a', scope: other.id, quote: '项目使用 SQLite 保存持久状态。' })).rejects.toThrow('范围不属于')
  expect(request).not.toHaveBeenCalled()
})
it('requires an explicit scope for direct messages rather than sharing them with a project by default', async () => {
  const next = settings(); next.sources.feishu!.config.directRepositories = 'app'; store.saveSettings(next)
  store.triggers.save({ ...trigger('dm'), meta: { direct: true, chatId: 'private' } })
  await expect(memory.propose({ trigger_id: 'dm' })).rejects.toThrow('明确选择')
  expect(documents.size).toBe(0)
})
it('recalls native Hindsight facts without any matching local publication record', async () => {
  documents.set(`dsh-superagent-${key(project().id)}/native`, { document_id: 'native', content: '由 Hindsight 管理界面维护的项目知识', metadata: {} })
  const result = await memory.recall('项目知识', 'a')
  expect(result.degraded).toBe(false); expect(result.items[0]!.text).toContain('管理界面')
  expect(result.items[0]!.sources[0]).toEqual({ document_id: 'native', resource: 'hindsight' })
})
it('does not reuse a project bank after its repository URL changes', async () => {
  await memory.propose(shared()); const next = settings()
  ;(next.sources.git!.config.repositories as { url: string }[])[0]!.url = 'https://github.com/acme/replacement'
  store.saveSettings(next)
  expect((await memory.recall('数据库', 'a')).items).toEqual([])
})
it('rejects fabricated excerpts and credentials before publishing', async () => {
  await expect(memory.propose({ trigger_id: 'a', quote: 'invented' })).rejects.toThrow('引用')
  const text = 'api_key=secretvalue123456'; store.triggers.save(trigger('secret', 'a', text))
  await expect(memory.propose({ trigger_id: 'secret' })).rejects.toThrow('密钥')
  expect(request).not.toHaveBeenCalled()
})
it('binds workers to their own ticket, selected repositories and authorized human input', async () => {
  store.tickets.save(ticket())
  expect((await memory.propose(shared(), 't')).retained).toBe(true)
  await expect(memory.propose({ ...shared(), ticket_id: 'another' }, 't')).rejects.toThrow('工单不属于')
  await expect(memory.recall('数据库', 'b', 't')).rejects.toThrow('消息不属于')
  await expect(memory.recall('数据库', 'a', 'missing')).rejects.toThrow('工单不存在')
  const next = settings(); next.policy.sources.feishu!.allowed = []; store.saveSettings(next)
  await expect(memory.recall('数据库', 'a')).rejects.toThrow('获准')
})
it('restricts legacy GitHub scopes when an executor has explicit repository selections', async () => {
  const next = settings(); next.sources.github = { enabled: true, config: { repository: 'acme/legacy' } }
  next.policy.sources.github = { allowed: [{ id: 'alice' }], admission: {} }; store.saveSettings(next)
  const original = trigger('gh'); store.triggers.save({ ...original, source: 'github', actor: { source: 'github', id: 'alice' } })
  const work = ticket(); work.origin = { triggerId: 'gh', triggerIds: ['gh'] }; store.tickets.save(work)
  await expect(memory.recall('项目知识', 'gh', 't')).rejects.toThrow('范围')
})
it('preserves final report provenance and rejects reports outside the current ticket', async () => {
  const work = ticket(); work.assignments = [{ id: 'done', state: 'ended', createdAt: '', report: { state: 'ready', summary: '验证完成：重启后保留状态。', at: '' } }]
  store.tickets.save(work)
  await memory.propose({ ticket_id: 't', report_id: 'done' })
  expect([...documents.values()][0]!.metadata).toEqual({ source: 'ticket/t/report/done', source_kind: 'worker_report' })
  await expect(memory.propose({ ticket_id: 't', report_id: 'missing' })).rejects.toThrow('执行报告不属于')
})
it('delegates observation management to Hindsight and filters explicitly forgotten supporting documents', async () => {
  const a = await memory.propose(shared()); store.triggers.save(trigger('a2', 'a', '项目持久状态改为 PostgreSQL。'))
  await memory.propose(shared('a2'))
  const original = facts(), observation = { id: 'obs', text: '当前数据库为 PostgreSQL。', type: 'observation', source_fact_ids: original.map(fact => fact.id) }
  request.mockImplementation(async (url, init) => String(url).endsWith('/recall') && String(url).includes(key(project().id))
    ? Response.json({ results: [observation], source_facts: Object.fromEntries(original.map(fact => [fact.id, fact])) }) : defaultRequest(url, init))
  const result = await memory.recall('当前数据库', 'b')
  expect(result.items[0]!.text).toBe(observation.text); expect(result.items[0]!.sources).toHaveLength(2)
  await memory.forget(a.document_id, project().id, 'a')
  expect((await memory.recall('当前数据库', 'b')).items).toEqual([])
})
it('omits observations when their supporting facts were truncated or are unavailable', async () => {
  request.mockResolvedValueOnce(Response.json({ results: [{ id: 'obs', text: 'incomplete', type: 'observation', source_fact_ids: ['missing'] }] }))
  expect((await memory.recall('知识', 'a')).items).toEqual([])
})
it('returns failed publication errors directly instead of creating another pending queue', async () => {
  request.mockResolvedValueOnce(new Response('test-hindsight-private', { status: 503 }))
  await expect(memory.propose(shared())).rejects.toThrow('HTTP 503')
  expect(store.keys('memory-entry:')).toEqual([]); expect(store.keys('memory-documents:')).toEqual([])
  request.mockResolvedValueOnce(Response.json({ success: true, async: true }))
  await expect(memory.propose(shared())).rejects.toThrow('尚未确认')
})
it('degrades failed or malformed recall and treats absent native banks as empty', async () => {
  request.mockResolvedValueOnce(new Response('test-hindsight-private', { status: 500 }))
  expect(await memory.recall('知识', 'a')).toMatchObject({ items: [], degraded: true })
  request.mockResolvedValueOnce(Response.json({ results: 'invalid' }))
  expect(await memory.recall('知识', 'a')).toMatchObject({ items: [], degraded: true })
  request.mockResolvedValueOnce(new Response('', { status: 404 }))
  expect(await memory.recall('知识', 'a')).toMatchObject({ items: [], degraded: false })
})
it('blocks deleted source fragments after restart without keeping their text or history', async () => {
  const entry = await memory.propose(shared())
  await memory.forget(entry.document_id, entry.scope.id, 'a')
  expect(documents.size).toBe(0)
  store.close(); store = new Store(join(directory, 'state.sqlite')); memory = new Memories(store, new AbortController().signal, request)
  const calls = request.mock.calls.length
  await expect(memory.propose(shared())).rejects.toThrow('已被遗忘')
  expect(request).toHaveBeenCalledTimes(calls)
  expect(store.keys('memory-entry:')).toEqual([]); expect(store.keys('memory-history:')).toEqual([])
})
it('does not let a deletion marker in one scope hide the same source in another authorized scope', async () => {
  const group = await memory.propose({ trigger_id: 'a' }), projectEntry = await memory.propose(shared())
  expect(group.document_id).toBe(projectEntry.document_id)
  await memory.forget(group.document_id, group.scope.id, 'a')
  expect((await memory.recall('知识', 'b')).items).toHaveLength(1)
})
it('retracts a source even if the earlier retain committed before its connection failed', async () => {
  request.mockImplementation(async (url, init) => {
    const result = await defaultRequest(url, init)
    if (init?.method === 'POST' && String(url).endsWith('/memories')) throw new Error('response lost')
    return result
  })
  await expect(memory.propose(shared())).rejects.toThrow('连接失败')
  expect(documents.size).toBe(1)
  const doc = [...documents.values()][0]!
  await memory.forget(doc.document_id, project().id, 'a'); expect(documents.size).toBe(0)
})
it('keeps deletion intent on backend failure, returns the error and allows an idempotent retry', async () => {
  const entry = await memory.propose(shared())
  request.mockResolvedValueOnce(new Response('private provider body', { status: 503 }))
  await expect(memory.forget(entry.document_id, entry.scope.id, 'a')).rejects.toThrow('HTTP 503')
  expect((await memory.recall('知识', 'a')).items).toEqual([])
  await expect(memory.propose(shared())).rejects.toThrow('已被遗忘')
  expect((await memory.forget(entry.document_id, entry.scope.id, 'a')).deleted).toBe(true)
})
it('does not return a stale in-flight recall after a forget request', async () => {
  const entry = await memory.propose(shared()), response = Response.json({ results: facts() })
  const wait = Promise.withResolvers<Response>(); request.mockImplementationOnce(() => wait.promise)
  const read = memory.recall('知识', 'a')
  await memory.forget(entry.document_id, entry.scope.id, 'a')
  wait.resolve(response); expect(await read).toMatchObject({ items: [], degraded: true })
})
it('serializes forgetting behind an in-flight retain and retracts the late publication', async () => {
  const wait = Promise.withResolvers<Response>()
  request.mockImplementation(async (url, init) => init?.method === 'POST' && String(url).endsWith('/memories') ? wait.promise : defaultRequest(url, init))
  const pending = memory.propose(shared()), failure = expect(pending).rejects.toThrow('发生变化')
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
  const [url, init] = request.mock.calls[0]!, body = JSON.parse(String(init!.body))
  const removed = memory.forget(body.items[0].document_id, project().id, 'a')
  wait.resolve(await defaultRequest(url, init)); await failure; await removed
  expect(documents.size).toBe(0)
})
it('refuses in-flight connection changes and unsafe URLs without forwarding a credential to another host', async () => {
  for (const hindsightUrl of ['not-a-url', 'file:///tmp/memory', 'http://user:password@localhost', 'http://localhost?key=secret'])
    expect(() => memory.configure({ ...memory.config(), hindsightUrl })).toThrow()
  expect(() => memory.configure({ ...memory.config(), hindsightUrl: 'https://different.example' })).toThrow('新密钥')
  const wait = Promise.withResolvers<Response>(); request.mockImplementationOnce(() => wait.promise)
  const pending = memory.propose(shared())
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
  expect(() => memory.configure({ ...memory.config(), hindsightUrl: 'https://different.example', hindsightApiKey: 'new-key' })).toThrow(MemoryConflict)
  const [url, init] = request.mock.calls[0]!; wait.resolve(await defaultRequest(url, init)); await pending
  expect(request.mock.calls.every(([, init]) => init?.redirect === 'error' && new Headers(init.headers).get('authorization') === 'Bearer test-hindsight-private')).toBe(true)
})
it('removes obsolete screening settings and credentials while retaining only Hindsight connection settings', () => {
  store.set<unknown>(KV.memory.config, { ...memory.config(), model: 'jev-latest', threshold: .9 })
  store.set(KV.memory.legacySecret, 'old-screening-secret')
  expect(memory.view()).not.toHaveProperty('model'); expect(memory.view()).not.toHaveProperty('threshold')
  memory.configure(memory.config())
  expect(store.get(KV.memory.legacySecret)).toBeUndefined()
  expect(store.get(KV.memory.config)).toEqual(memory.config())
})
it('disabled mode makes no backend calls and injects no memory instructions', async () => {
  memory.configure({ ...memory.config(), enabled: false }); request.mockClear()
  expect(await memory.recall('知识', 'a')).toEqual({ scopes: [], items: [], degraded: false })
  await expect(memory.propose(shared())).rejects.toThrow('尚未启用')
  await expect(memory.forget('id', project().id, 'a')).rejects.toThrow('尚未启用')
  expect(request).not.toHaveBeenCalled(); expect(memory.context()).toBe('')
})
it('uses the same scope-bound native source lifecycle through worker tools without a separate reviewer', async () => {
  const tools = memoryTools(memory), signal = new AbortController().signal
  const source = await tools.find(tool => tool.name === 'orchestrator_memory_propose')!.execute(shared(), signal) as { document_id: string; scope: { id: string } }
  const deleted = await tools.find(tool => tool.name === 'orchestrator_memory_forget')!.execute({ document_id: source.document_id, scope: source.scope.id, trigger_id: 'b' }, signal)
  expect(deleted).toMatchObject({ deleted: true }); expect(documents.size).toBe(0)
})
