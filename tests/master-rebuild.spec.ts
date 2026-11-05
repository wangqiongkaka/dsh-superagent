import { afterEach, expect, it, vi } from 'vitest'
import { KV } from '../src/kv.ts'
import { threadKey } from '../src/core/index.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { vi.useRealTimers(); await h?.stop(); h = undefined })

it('rebuilds an idle main Session, restores active evaluations and keeps its workers and records', async () => {
  const host = h = await startRuntime()
  const { runtime } = host
  const settings = runtime.store.settings()
  runtime.store.saveSettings({ ...settings, eval: { ...settings.eval, model: { provider: 'test-provider', model: 'main-model' } } })
  const first = feishu('1', '@bot fix it')
  const { sessionId: workerId } = await host.acceptedTicket(first)
  const tickets = runtime.store.tickets.list()
  const decisions = runtime.store.decisions.byThread(threadKey(first.threads[0]!))
  const trigger = feishu('2', 'another request')
  runtime.receive(trigger); await runtime.idle()
  const old = runtime.masterId, evaluation = runtime.engine.candidate(trigger.id)!.evalId
  host.agents.get(old)!.status = 'idle'
  const worker = host.agents.get(workerId)!
  const state = worker.status
  const { masterId } = await runtime.rebuildMaster(old)
  await runtime.idle()
  expect(masterId).not.toBe(old)
  expect(runtime.store.get(KV.runtime.masterId)).toBe(masterId)
  expect((await host.api('GET', 'state')).body).toMatchObject({ masterId })
  expect(runtime.store.tickets.list()).toEqual(tickets)
  expect(runtime.store.decisions.byThread(threadKey(first.threads[0]!))).toEqual(decisions)
  expect(worker.status).toBe(state)
  expect(worker.cancel).not.toHaveBeenCalled()
  expect(runtime.engine.candidate(trigger.id)!.evalId).toBe(evaluation)
  expect(host.relays(masterId)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'orchestrator_rebuilt', tickets: expect.objectContaining({ items: expect.arrayContaining([
      expect.objectContaining({ ticket_id: tickets[0]!.id }),
    ]) }) }),
    expect.objectContaining({ kind: 'candidate', trigger_id: trigger.id }),
  ]))
  const resolved = await host.controller.resolveAgent(masterId)
  if (!resolved.agent) throw new Error('Replacement Session is missing')
  expect(resolved.agent.session.append).toHaveBeenCalledWith('model/selection', { provider: 'test-provider', model: 'main-model' })
  expect(host.controller.selectModel).not.toHaveBeenCalled()
  await expect(host.runTool(old, 'orchestrator_route', { decisions: [{ trigger_id: trigger.id, kind: 'ignore', reason: 'stale' }] }))
    .rejects.toMatchObject({ code: 'masterChanged' })
  await host.runTool(masterId, 'orchestrator_route', { decisions: [{ trigger_id: trigger.id, kind: 'ignore', reason: 'decided by replacement' }] })
  expect(runtime.engine.candidate(trigger.id)).toBeUndefined()
  runtime.sessions.notify('after-rebuild', { current: true }, 'current')
  await runtime.idle()
  expect(host.agents.get(masterId)!.inject).toHaveBeenCalled()
  expect((await host.api('GET', 'prompts')).body).toMatchObject({ masterId })
})

it('creates a fresh main Session even when the previous Session no longer exists', async () => {
  const host = h = await startRuntime(), old = host.runtime.masterId
  host.agents.delete(old)
  const { masterId } = await host.runtime.rebuildMaster(old)
  await host.runtime.idle()
  expect(masterId).not.toBe(old)
  expect(host.agents.has(masterId)).toBe(true)
  expect(host.runtime.store.get(KV.runtime.masterId)).toBe(masterId)
  expect(host.relays(masterId)).toContainEqual(expect.objectContaining({ kind: 'orchestrator_rebuilt' }))
})

it('refuses a running main Session and leaves the persisted ID and records unchanged', async () => {
  const host = h = await startRuntime(), old = host.runtime.masterId
  host.agents.get(old)!.status = 'running'
  const created = host.controller.create.mock.calls.length
  await expect(host.runtime.rebuildMaster(old)).rejects.toMatchObject({ code: 'masterBusy' })
  expect(host.controller.create.mock.calls).toHaveLength(created)
  expect(host.runtime.masterId).toBe(old)
  expect(host.runtime.store.get(KV.runtime.masterId)).toBe(old)
})

it('keeps the original main Session usable when creating the replacement fails', async () => {
  const host = h = await startRuntime(), old = host.runtime.masterId
  host.controller.create.mockRejectedValueOnce(new Error('creation failed'))
  await expect(host.runtime.rebuildMaster(old)).rejects.toThrow('creation failed')
  expect(host.runtime.masterId).toBe(old)
  expect(host.runtime.store.get(KV.runtime.masterId)).toBe(old)
  host.runtime.sessions.relay('after-failure', JSON.stringify({ usable: true }))
  await host.runtime.idle()
  expect(host.relays(old)).toContainEqual({ usable: true })
})

it('holds concurrent deliveries and refuses duplicate or stale rebuild requests', async () => {
  const host = h = await startRuntime(), old = host.runtime.masterId
  const create = host.controller.create.getMockImplementation()!
  let release = () => {}
  const waiting = new Promise<void>(resolve => { release = resolve })
  host.controller.create.mockImplementationOnce(async request => { await waiting; return create(request) })
  const rebuilding = host.runtime.rebuildMaster(old)
  await vi.waitFor(() => expect(host.controller.create).toHaveBeenCalledTimes(2))
  await expect(host.runtime.rebuildMaster(old)).rejects.toMatchObject({ code: 'masterRebuilding' })
  host.runtime.sessions.relay('during-rebuild', JSON.stringify({ held: true }))
  const trigger = feishu('3', 'request during rebuild')
  host.runtime.receive(trigger)
  await host.runtime.idle()
  expect(host.relays(old)).not.toContainEqual({ held: true })
  release()
  const { masterId } = await rebuilding
  await host.runtime.idle()
  expect(host.relays(masterId)).toContainEqual({ held: true })
  expect(host.relays(masterId)).toContainEqual(expect.objectContaining({ kind: 'candidate', trigger_id: trigger.id }))
  await expect(host.runtime.rebuildMaster(old)).rejects.toMatchObject({ code: 'masterChanged' })
  expect(host.controller.create).toHaveBeenCalledTimes(2)
})

it('does not charge replacement preparation time to an evaluation when creation fails', async () => {
  const host = h = await startRuntime(), trigger = feishu('4', 'pending request')
  host.runtime.receive(trigger); await host.runtime.idle()
  const old = host.runtime.masterId
  host.agents.get(old)!.status = 'idle'
  const evaluation = host.runtime.engine.candidate(trigger.id)!.evalId
  const before = host.runtime.store.threads.get(threadKey(trigger.threads[0]!))!.evaluating!
  let release = () => {}
  const waiting = new Promise<void>(resolve => { release = resolve })
  host.controller.create.mockImplementationOnce(async () => { await waiting; throw new Error('creation failed') })
  const rebuilding = host.runtime.rebuildMaster(old)
  const rejected = expect(rebuilding).rejects.toThrow('creation failed')
  await vi.waitFor(() => expect(host.controller.create).toHaveBeenCalledTimes(2))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 180_000)
  release()
  await rejected
  await host.runtime.idle()
  const after = host.runtime.store.threads.get(threadKey(trigger.threads[0]!))!.evaluating!
  expect(after.id).toBe(evaluation)
  expect(Date.parse(after.deadline) - Date.parse(before.deadline)).toBeGreaterThanOrEqual(180_000)
  expect(after.pausedAt).toBeUndefined()
})
