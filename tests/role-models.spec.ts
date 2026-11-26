import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { agentEvents, installModelSelection, type Agent, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { applyRoleModel, initializeRoleModel } from '../src/app/role-models.ts'
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); vi.restoreAllMocks() })
async function fixture() {
  const ctx = new Context(); contexts.push(ctx); await ctx.plugin(SystemPrompt)
  const resolve = vi.fn(async value => value)
  const flush = vi.fn(async () => {})
  ctx.reflect.provide('llm', { resolveCallConfig: resolve })
  ctx.reflect.provide('sessionPersistence', { flush })
  const session = Session.create(SessionId('role-model'))
  const agent = { ctx, session } as Agent
  const host: ModelSelectionRef = { get current() { return session.requestHeader()?.config ?? { provider: 'host', model: 'default', reasoningEffort: ReasoningEffortId('high') } }, assembled: undefined }
  installModelSelection(ctx, host)
  const request = () => agentEvents(ctx, agent).waterfall('agent/request', { turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'seed', model: 'seed' }))
  const preStep = (messages = [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user', form: 'message' } })]) =>
    agentEvents(ctx, agent).waterfall('agent/pre-step', { messages, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter' as const, messages }))
  const record = (selection: ModelSelection) => { const event = session.append('request/header', { header: { config: selection }, reason: 'initial' }); ctx.emit('session/event', session, event) }
  return { ctx, agent, host, resolve, flush, request, preStep, record }
}
it('keeps prompt variables and initial routing on the role model without saving the host default', async () => {
  const { ctx, agent, request, record, flush } = await fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker-provider', model: 'worker-model' })
  expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'worker-provider', model: 'worker-model' })
  const selected = await request()
  expect(selected).toEqual({ provider: 'worker-provider', model: 'worker-model' })
  expect(agent.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(true)
  expect(flush).toHaveBeenCalledOnce()
  record(selected)
  // A retry of the same assembled step keeps the same model even after the header is persisted.
  expect(await request()).toEqual(selected)
  await ctx.systemPrompt.assemble()
  expect(await request()).toEqual(selected)
})
it('lets a later explicit selection win without changing the in-flight assembled step', async () => {
  const { ctx, agent, host, request } = await fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'one' })
  await ctx.systemPrompt.assemble()
  const manual = { provider: 'manual', model: 'two', reasoningEffort: ReasoningEffortId('low') }
  Object.defineProperty(host, 'current', { value: manual, configurable: true })
  const event = agent.session.append('model/selection', manual); ctx.emit('session/event', agent.session, event)
  expect(await request()).toEqual({ provider: 'worker', model: 'one' })
  await ctx.systemPrompt.assemble()
  expect(await request()).toEqual(manual)
})
it.each(['header', 'selection'])('preserves a resumed Session with existing %s', async kind => {
  const { ctx, agent, resolve } = await fixture()
  const existing = { provider: 'existing', model: 'keep' }
  if (kind === 'header') agent.session.append('request/header', { header: { config: existing }, reason: 'initial' })
  else agent.session.append('model/selection', existing)
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'new' })
  expect(resolve).not.toHaveBeenCalled()
})
it('inherits the host when unset and fails unavailable routes before recording a selection', async () => {
  const { ctx, agent, resolve, request } = await fixture()
  await initializeRoleModel(ctx, agent, null)
  await ctx.systemPrompt.assemble()
  expect(await request()).toMatchObject({ provider: 'host', model: 'default' })
  resolve.mockRejectedValueOnce(new Error('unknown provider'))
  await expect(initializeRoleModel(ctx, agent, { provider: 'unknown', model: 'x' })).rejects.toThrow('unknown provider')
  expect(agent.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(false)
})
it('switches an existing session on the next step without mutating host default and preserves later manual switches', async () => {
  const { ctx, agent, host, request, preStep, record, flush } = await fixture()
  const initial = { provider: 'deepseek', model: 'flash' }
  record(initial)
  // Simulate an in-flight step already assembled with the previous model and a stale unconsumed host pick.
  Object.defineProperty(host, 'current', { value: { provider: 'stale', model: 'old-pick' }, configurable: true })
  await ctx.systemPrompt.assemble()
  expect(await applyRoleModel(ctx, agent, { provider: 'openai', model: 'gpt-6.1-sol', reasoningEffort: 'high' })).toBe(true)
  expect(flush).toHaveBeenCalledOnce()
  // The in-flight step stays on what it assembled; the next assembly picks up the saved role model.
  expect(await request()).toEqual({ provider: 'stale', model: 'old-pick' })
  expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'openai', model: 'gpt-6.1-sol' })
  const next = await request()
  expect(next).toEqual({ provider: 'openai', model: 'gpt-6.1-sol', reasoningEffort: 'high' })
  // Pre-step replaces any stale host switch notice with the true previous -> saved transition.
  const decision = await preStep()
  expect(decision.kind).toBe('enter')
  const notices = decision.kind === 'enter' ? decision.messages.filter(m => m.source?.kind === 'model-selection') : []
  expect(notices).toHaveLength(1)
  expect(notices[0]!.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('deepseek/flash') })
  expect(notices[0]!.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('openai/gpt-6.1-sol') })
  // After the header is recorded, subsequent turns still hold the saved model even with a stale host selection.
  record(next)
  await ctx.systemPrompt.assemble()
  expect(await request()).toEqual(next)
  // A later manual model switch in the chat UI yields control back to the host selection.
  const manual = { provider: 'anthropic', model: 'claude' }
  Object.defineProperty(host, 'current', { value: manual, configurable: true })
  const event = agent.session.append('model/selection', manual); ctx.emit('session/event', agent.session, event)
  await ctx.systemPrompt.assemble()
  expect(await request()).toEqual(manual)
})
it('switches back to the current DSH default when cleared to null, and no-ops when unavailable', async () => {
  const { ctx, agent, request, record } = await fixture()
  record({ provider: 'deepseek', model: 'flash' })
  expect(await applyRoleModel(ctx, agent, null)).toBe(false)
  ctx.reflect.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'openai', model: 'gpt-6.1-sol', reasoningEffort: ReasoningEffortId('high') }) })
  expect(await applyRoleModel(ctx, agent, null)).toBe(true)
  await ctx.systemPrompt.assemble()
  expect(await request()).toEqual({ provider: 'openai', model: 'gpt-6.1-sol', reasoningEffort: 'high' })
})
