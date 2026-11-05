import { afterEach, expect, it, vi } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import type { WorkerMcpServer } from '../src/app/external-tools.ts'
import { deferred, waitUntil } from './fixtures/async.ts'
import { SessionId } from '@deepseek-ai/dsh-session'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })

it.each(['codex', 'claude-code'] as const)('passes the %s selection to managed workers and validates settings before saving', async harness => {
  h = await startRuntime()
  const bridge = { managedSessionOptionsVersion: 1, models: vi.fn(), validateManagedSessionSelection: vi.fn(async () => {}),
    manageSession: vi.fn(async () => {}), releaseManagedSession: vi.fn(async () => {}) }
  h.ctx.reflect.provide('harness' as never, bridge)
  const settings = h.runtime.store.settings()
  const selection = { model: 'deep', thinking: 'high', fast: false }
  await h.runtime.settings.save('executor', { ...settings.executor, harness, harnessModels: { [harness]: selection } },
    h.runtime.store.blockRevision('executor'), 'panel')
  expect(bridge.validateManagedSessionSelection).toHaveBeenCalledWith(h.runtime.masterId, harness, selection)
  const { sessionId } = await h.acceptedTicket(feishu('1', '修复回归'))
  expect(bridge.manageSession).toHaveBeenCalledWith(sessionId, expect.objectContaining({ harness, selection }))
  const saved = h.runtime.store.settings().executor
  bridge.validateManagedSessionSelection.mockRejectedValueOnce(new Error('模型不支持此推理强度'))
  await expect(h.runtime.settings.save('executor', { ...saved, harnessModels: { [harness]: { model: 'small', thinking: 'high' } } },
    h.runtime.store.blockRevision('executor'), 'panel')).rejects.toThrow('模型不支持此推理强度')
  expect(h.runtime.store.settings().executor).toEqual(saved)
})

it('rejects explicit choices with an old Provider instead of silently ignoring them', async () => {
  h = await startRuntime()
  const bridge = { manageSession: vi.fn(async () => {}), releaseManagedSession: vi.fn(async () => {}) }
  h.ctx.reflect.provide('harness' as never, bridge)
  const executor = { ...h.runtime.store.settings().executor, harness: 'codex' as const, harnessModels: { codex: { fast: true } } }
  await expect(h.runtime.settings.save('executor', executor, h.runtime.store.blockRevision('executor'), 'panel')).rejects.toThrow('升级')
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), executor })
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '修复回归'))
  expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('升级') })
  expect(bridge.manageSession).not.toHaveBeenCalledWith(sessionId, expect.anything())
})

it.each(['codex', 'claude-code'] as const)('links only secondary worktrees for %s and persists the successful setup', async harness => {
  h = await startRuntime()
  const bridge = { manageSession: vi.fn(async () => {}), releaseManagedSession: vi.fn(async () => {}), linkProjects: vi.fn(async () => {}) }
  h.ctx.reflect.provide('harness' as never, bridge)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, harness } })
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '修复回归'))
  const primary = ticket.execution!.repositories![0]!
  h.runtime.store.tickets.save({ ...ticket, execution: { ...ticket.execution!, primaryRepository: primary.id,
    repositories: [{ ...primary, worktree: { base: '/projects/frontend', directory: ticket.execution!.directory } },
      { ...primary, id: 'backend', worktree: { base: '/projects/backend', directory: '/projects/backend-worktrees/task' } }] } })
  await h.runtime.sessions.ensure(sessionId, ticket.execution!.directory, ticket.title, 'worker')
  expect(bridge.linkProjects).toHaveBeenCalledExactlyOnceWith({ sessionId, workspaceIds: [], paths: ['/projects/backend-worktrees/task'] })
  expect(h.runtime.store.tickets.get(ticket.id)!.execution!.projectsLinked).toBe(true)
  await h.runtime.sessions.ensure(sessionId, ticket.execution!.directory, ticket.title, 'worker')
  expect(bridge.linkProjects).toHaveBeenCalledTimes(1)
})

it('does not mark linking complete when the provider fails, allowing an explicit retry', async () => {
  h = await startRuntime()
  const bridge = { manageSession: vi.fn(async () => {}), releaseManagedSession: vi.fn(async () => {}), linkProjects: vi.fn(async () => {}) }
  h.ctx.reflect.provide('harness' as never, bridge)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, harness: 'codex' } })
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '修复回归'))
  const primary = ticket.execution!.repositories![0]!
  h.runtime.store.tickets.save({ ...ticket, execution: { ...ticket.execution!, primaryRepository: primary.id,
    repositories: [primary, { ...primary, id: 'backend', worktree: { base: '/projects/backend', directory: '/projects/backend-worktrees/task' } }] } })
  bridge.linkProjects.mockRejectedValueOnce(new Error('busy'))
  await expect(h.runtime.sessions.ensure(sessionId, ticket.execution!.directory, ticket.title, 'worker')).rejects.toThrow('busy')
  expect(h.runtime.store.tickets.get(ticket.id)!.execution!.projectsLinked).toBeUndefined()
  await h.runtime.sessions.ensure(sessionId, ticket.execution!.directory, ticket.title, 'worker')
  expect(h.runtime.store.tickets.get(ticket.id)!.execution!.projectsLinked).toBe(true)
})

it.each(['codex', 'claude-code'] as const)('runs new %s tickets with scoped tools, keeps the main Session native and preserves the ticket Harness', async harness => {
  h = await startRuntime()
  type Managed = { owner: string; harness: string; context?: () => Promise<{ instructions: string; mcpServers: WorkerMcpServer[] }> }
  const managed = new Map<string, Managed>()
  const bridge = { manageSession: vi.fn(async (id: string, options: Managed) => { managed.set(id, options) }),
    releaseManagedSession: vi.fn(async () => {}) }
  h.ctx.reflect.provide('harness' as never, bridge)
  await waitUntil(() => managed.get(h!.runtime.masterId)?.harness === 'dsh')
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, harness } })
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '修复回归'))
  expect(managed.get(h.runtime.masterId)?.harness).toBe('dsh')
  expect(managed.get(sessionId)?.harness).toBe(harness)
  expect(ticket.execution?.harness).toBe(harness)
  const context = await managed.get(sessionId)!.context!()
  expect(context.instructions).toContain('dsh-superagent prompt revision')
  expect(context.instructions).toContain('orchestrator_report')
  expect(context.instructions).toContain('dsh-superagent-feishu')
  const current = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...current, executor: { ...current.executor, harness: 'dsh' } })
  await h.runtime.sessions.ensure(sessionId, ticket.execution!.directory, ticket.title, 'worker')
  expect(managed.get(sessionId)?.harness).toBe(harness)
  const server = context.mcpServers[0]!
  const call = (args: unknown) => fetch(server.url, { method: 'POST', headers: { authorization: server.headers[0]!.value },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'orchestrator_report', arguments: args } }) })
  const response = await call({ state: 'blocked', summary: '等待确认', human_action: '按钮应该使用哪种颜色？' })
  expect((await response.json()).result.isError).toBeUndefined()
  expect(h.runtime.store.tickets.get(ticket.id)?.attention?.question).toBe('按钮应该使用哪种颜色？')
  h.runtime.engine.stopTicket(ticket.id)
  await h.runtime.idle()
  expect((await call({ state: 'ready', summary: '完成' })).status).toBe(403)
  expect(bridge.releaseManagedSession).toHaveBeenCalledWith(sessionId, 'dsh-superagent')
})

it('fails an external ticket without the provider instead of silently running the native worker', async () => {
  h = await startRuntime()
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, harness: 'codex' } })
  const { ticket } = await h.acceptedTicket(feishu('1', '修复回归'))
  expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report).toMatchObject({ state: 'failed',
    summary: expect.stringContaining('dsh-harness-provider') })
})

it('returns the final MCP report before closing the worker process', async () => {
  h = await startRuntime()
  let context!: () => Promise<{ mcpServers: WorkerMcpServer[] }>
  const release = vi.fn(async () => {})
  h.ctx.reflect.provide('harness' as never, { manageSession: async (_id: string, options: { harness: string; context?: typeof context }) => {
    if (options.context) context = options.context
  }, releaseManagedSession: release })
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, harness: 'codex' } })
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '修复回归'))
  const idle = deferred()
  vi.spyOn(h.ctx.agents.get(SessionId(sessionId))!, 'whenIdle').mockImplementation(() => idle.promise)
  const server = (await context()).mcpServers[0]!
  try {
    const response = await fetch(server.url, { method: 'POST', headers: { authorization: server.headers[0]!.value },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'orchestrator_report', arguments: { state: 'ready', summary: '修复完成' } } }) })
    expect((await response.json()).result.isError).toBeUndefined()
    expect(h.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
    expect(release).not.toHaveBeenCalled()
    idle.resolve()
    await waitUntil(() => release.mock.calls.length === 1)
  } finally { idle.resolve() }
})

it('allows only the panel to change the worker Harness', async () => {
  h = await startRuntime()
  const settings = h.runtime.store.settings()
  await expect(h.runtime.settings.save('executor', { ...settings.executor, harness: 'codex' }, h.runtime.store.blockRevision('executor'), 'tool'))
    .rejects.toThrow()
  expect(h.runtime.store.settings().executor.harness).toBe('dsh')
})

it('rejects ended worker turns before a late provider while leaving live turns alone', async () => {
  h = await startRuntime()
  const provider = vi.fn(async () => ({ kind: 'enter' as const, messages: [] }))
  h.ctx.on('agent/pre-step', provider, { prepend: true })
  const bridge = { manageSession: vi.fn(async () => {}), releaseManagedSession: vi.fn(async () => {}) }
  h.ctx.reflect.provide('harness' as never, bridge)
  await waitUntil(() => bridge.manageSession.mock.calls.length > 0)
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '修复回归'))
  const agent = h.ctx.agents.get(SessionId(sessionId))!
  const turn = () => Promise.resolve().then(() => h!.ctx.waterfall('agent/pre-step', {
    agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [] })))
  await turn()
  expect(provider).toHaveBeenCalledTimes(1)
  h.runtime.engine.stopTicket(ticket.id)
  await h.runtime.idle()
  provider.mockRejectedValue(new Error('工单管理接口尚未恢复'))
  await expect(turn()).rejects.toThrow('该工单已结束，原会话仅供查看')
  expect(provider).toHaveBeenCalledTimes(1)
})
