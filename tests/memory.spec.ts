import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { memoryTools } from '../src/app/tools/memory.ts'
import { Memories, MemoryConflict } from '../src/app/memory.ts'
import { Store } from '../src/app/store.ts'
import { SettingsSchema } from '../src/policy.ts'
import { KV } from '../src/kv.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'

let directory: string, store: Store, memory: Memories
let scope = 's0', relation = 'new', remember = 0.99, supported = 0.99
const judgment = (name: string, questions: Record<string, { type: string }>) => questions[name]!.type === 'noul'
  ? { type: 'noul', noul: name === 'remember' ? remember : name === 'supported' ? supported : 0.99 }
  : { type: 'choice', choice: name === 'scope' ? scope : relation, probabilities: { [name === 'scope' ? scope : relation]: 0.99 } }
const request = vi.fn<typeof fetch>(async (_url, init) => {
  const { questions } = JSON.parse(String(init?.body)) as { questions: Record<string, { type: string }> }
  return Response.json({ model: 'jev-test', answers: Object.fromEntries(Object.keys(questions).map(name => [name, judgment(name, questions)])) })
})
const trigger = (id: string, chat = 'a', text = '项目使用 SQLite 保存持久状态。'): Trigger => ({ id, source: 'feishu', threads: [{ source: 'feishu', id: chat }],
  actor: { source: 'feishu', id: 'alice' }, human: true, at: '2026-11-07T00:00:00Z', text, meta: { chatId: chat } })
const proposal = (id = 'a', text = '项目使用 SQLite 保存持久状态。') => ({ trigger_id: id, text, quote: text })
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
  scope = 's0'; relation = 'new'; remember = supported = 0.99; request.mockClear()
  memory = new Memories(store, new AbortController().signal, request)
  memory.configure({ ...memory.config(), enabled: true, apiKey: 'test-private-key' })
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
it('persists across process/session replacement, keeps revisions and never resurrects a deleted candidate', async () => {
  const entry = await memory.propose(proposal())
  expect(entry.status).toBe('active')
  expect(memory.history(entry.id)).toHaveLength(2)
  const deleted = memory.edit(entry.id, { revision: entry.revision, scope: entry.scope.id, text: entry.text, status: 'deleted' })
  expect(() => memory.edit(entry.id, { revision: entry.revision, scope: entry.scope.id, text: entry.text, status: 'active' })).toThrow(MemoryConflict)
  store.close(); store = new Store(join(directory, 'state.sqlite')); memory = new Memories(store, new AbortController().signal, request)
  expect(await memory.propose(proposal())).toEqual(deleted)
  expect((await memory.recall('SQLite', 'a')).items).toEqual([])
  expect(memory.history(entry.id)).toHaveLength(3)
  expect(JSON.stringify(memory.view())).not.toContain('test-private-key')
})
it('shares project text across linked groups without leaking evidence; isolates other projects and group preferences', async () => {
  await memory.propose(proposal())
  const shared = await memory.recall('SQLite', 'b')
  expect(shared.items).toHaveLength(1); expect(shared.items[0]!.source).not.toHaveProperty('quote')
  expect((await memory.recall('SQLite', 'c')).items).toEqual([])
  scope = 's1'; store.triggers.save(trigger('a2', 'a', '群内沟通使用中文。'))
  await memory.propose(proposal('a2', '群内沟通使用中文。'))
  expect((await memory.recall('沟通', 'a')).items).toHaveLength(2)
  expect((await memory.recall('沟通', 'b')).items).toHaveLength(1)
})
it('does not treat a reused repository ID with a different URL as the same project', async () => {
  await memory.propose(proposal()); const next = settings()
  ;(next.sources.git!.config.repositories as { url: string }[])[0]!.url = 'https://github.com/acme/replacement'
  store.saveSettings(next)
  expect((await memory.recall('SQLite', 'a')).items).toEqual([])
})
it.each(['duplicate', 'conflict', 'uncertain'])('keeps existing facts when comparison is %s', async value => {
  const original = await memory.propose(proposal()); relation = value
  const text = '项目使用 SQLite 数据库。'; store.triggers.save(trigger('a2', 'a', text))
  const next = await memory.propose(proposal('a2', text))
  expect(next.status).toBe(value === 'duplicate' ? 'rejected' : 'pending')
  expect(store.get(KV.memory.entry(original.id))).toEqual(original)
})
it('rejects unsupported, temporary and fabricated evidence before it can become active', async () => {
  await expect(memory.propose({ ...proposal(), quote: 'invented' })).rejects.toThrow('引用')
  expect(request).not.toHaveBeenCalled()
  supported = 0.01; expect((await memory.propose(proposal())).reason).toBe('unsupported')
  remember = 0.01; expect((await memory.propose(proposal('b'))).reason).toBe('temporary')
})
it('keeps failures and unknown scope judgments pending without leaking provider error bodies', async () => {
  request.mockResolvedValueOnce(new Response('test-private-key', { status: 500 }))
  expect((await memory.propose(proposal())).reason).toBe('unavailable')
  scope = 'external'; expect((await memory.propose(proposal('b'))).status).toBe('pending')
  expect(JSON.stringify(memory.list())).not.toContain('test-private-key')
})
it('restricts workers to their own ticket, current repositories and authorized human messages', async () => {
  store.tickets.save(ticket())
  expect((await memory.propose(proposal(), 't')).status).toBe('active')
  await expect(memory.recall('SQLite', 'b', 't')).rejects.toThrow('消息不属于')
  await expect(memory.recall('SQLite', 'a', 'missing')).rejects.toThrow('工单不存在')
  const next = settings(); next.policy.sources.feishu!.allowed = []; store.saveSettings(next)
  await expect(memory.recall('SQLite', 'a')).rejects.toThrow('获准')
})
it('fails closed after source removal, and disabled mode makes no provider calls', async () => {
  await memory.propose(proposal()); const next = settings(); next.sources.feishu!.enabled = false; store.saveSettings(next)
  await expect(memory.recall('SQLite', 'a')).rejects.toThrow('范围')
  memory.configure({ ...memory.config(), enabled: false }); request.mockClear()
  expect((await memory.recall('SQLite', 'a')).items).toEqual([])
  await expect(memory.propose(proposal())).rejects.toThrow('尚未启用')
  expect(request).not.toHaveBeenCalled(); expect(memory.context()).toBe('')
})
it('does not overwrite a manual edit when a judgment finishes later', async () => {
  const wait = Promise.withResolvers<Response>(); request.mockImplementationOnce(() => wait.promise)
  const pending = memory.propose(proposal()); const entry = memory.list().items[0]!
  memory.edit(entry.id, { revision: entry.revision, text: '人工修正', scope: entry.scope.id, status: 'rejected' })
  wait.resolve(Response.json({ model: 'jev', answers: { remember: { type: 'noul', noul: .99 }, supported: { type: 'noul', noul: .99 }, scope: { type: 'choice', choice: 's0', probabilities: { s0: .99 } } } }))
  expect((await pending).text).toBe('人工修正')
})
it('rechecks a recalled record after deletion during the provider request', async () => {
  const entry = await memory.propose(proposal())
  const wait = Promise.withResolvers<Response>(); request.mockImplementationOnce(() => wait.promise)
  const read = memory.recall('SQLite', 'a')
  memory.edit(entry.id, { revision: entry.revision, text: entry.text, scope: entry.scope.id, status: 'deleted' })
  wait.resolve(Response.json({ model: 'jev', answers: { m0: { type: 'noul', noul: .99 } } }))
  expect((await read).items).toEqual([])
})
it('checks explicit forget requests against the authorized source and preserves history', async () => {
  const entry = await memory.propose(proposal()); store.triggers.save(trigger('forget', 'a', '请忘记项目使用 SQLite 这条记忆。'))
  expect((await memory.forget(entry.id, entry.revision, 'forget')).status).toBe('deleted')
  expect(memory.history(entry.id)).toHaveLength(3)
})

it('lets the main Session preserve verified final reports, while workers cannot name another ticket', async () => {
  const work = ticket()
  work.assignments = [{ id: 'done', state: 'ended', createdAt: '', report: { state: 'ready', summary: '验证完成：SQLite 重启后保留状态。', at: '' } }]
  store.tickets.save(work)
  const input = { ticket_id: 't', report_id: 'done', text: 'SQLite 重启后保留状态。', quote: '验证完成：SQLite 重启后保留状态。' }
  expect((await memory.propose(input)).source.resource).toBe('ticket/t/report/done')
  await expect(memory.propose({ ...input, ticket_id: 'another' }, 't')).rejects.toThrow('工单不属于')
  await expect(memory.propose({ ...input, report_id: 'missing' })).rejects.toThrow('执行报告不属于')
})
it('keeps concurrent conflicting candidates pending when active versions change during comparison', async () => {
  await memory.propose(proposal())
  const waits = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()]
  let compared = 0
  const original = request.getMockImplementation()!
  request.mockImplementation(async (url, init) => {
    const body = JSON.parse(String(init?.body))
    return body.questions.relation ? waits[compared++]!.promise : original(url, init)
  })
  const a = '项目日志保存 7 天。', b = '项目日志保存 30 天。'
  store.triggers.save(trigger('a2', 'a', a)); store.triggers.save(trigger('a3', 'a', b))
  const first = memory.propose(proposal('a2', a)), second = memory.propose(proposal('a3', b))
  await vi.waitFor(() => expect(compared).toBe(2))
  const response = () => Response.json({ model: 'jev', answers: { relation: { type: 'choice', choice: 'new', probabilities: { new: .99 } } } })
  waits[0]!.resolve(response()); expect((await first).status).toBe('active')
  waits[1]!.resolve(response()); expect(await second).toMatchObject({ status: 'pending', reason: 'changed' })
  request.mockImplementation(original)
})
it('rechecks permissions after a model request and never returns a moved memory to its former scope', async () => {
  const wait = Promise.withResolvers<Response>(); request.mockImplementationOnce(() => wait.promise)
  const pending = memory.propose(proposal()); const entry = memory.list().items[0]!
  const other = memory.scopes().find(scope => scope.label === 'other')!
  memory.edit(entry.id, { revision: entry.revision, text: '其他项目的知识', scope: other.id, status: 'active' })
  wait.resolve(Response.json({ model: 'jev', answers: {} }))
  await expect(pending).rejects.toThrow('访问范围已变化')
  await expect(memory.propose(proposal())).rejects.toThrow('访问范围已变化')
})
it('does not return the original group quote through propose or forget tool receipts', async () => {
  const tools = memoryTools(memory), signal = new AbortController().signal
  const propose = tools.find(tool => tool.name === 'orchestrator_memory_propose')!
  const result = await propose.execute(proposal(), signal) as { id: string; revision: number; source: object }
  expect(result.source).not.toHaveProperty('quote')
  store.triggers.save(trigger('forget', 'b', '忘记 SQLite 记忆'))
  const forget = tools.find(tool => tool.name === 'orchestrator_memory_forget')!
  const deleted = await forget.execute({ id: result.id, revision: result.revision, trigger_id: 'forget' }, signal) as { source: object }
  expect(deleted.source).not.toHaveProperty('quote')
})
it('keeps low confidence and malformed judgments pending, blocks common credentials, and degrades failed reads', async () => {
  remember = .5; expect((await memory.propose(proposal())).status).toBe('pending')
  request.mockResolvedValueOnce(Response.json({ answers: 'invalid' }))
  expect((await memory.propose(proposal('b'))).reason).toBe('unavailable')
  const text = 'api_key=secretvalue123456'; store.triggers.save(trigger('key', 'a', text))
  await expect(memory.propose(proposal('key', text))).rejects.toThrow('密钥')
  const entry = memory.list().items[0]!
  memory.edit(entry.id, { revision: entry.revision, text: entry.text, scope: entry.scope.id, status: 'active' })
  request.mockRejectedValueOnce(new Error('provider unavailable'))
  expect(await memory.recall('SQLite', entry.source.resource.endsWith('/b') ? 'b' : 'a')).toEqual({ items: [], degraded: true })
})
