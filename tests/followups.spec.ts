/** Follow-up routing: human messages on subscribed threads go directly to the ticket worker and notify the main session without starting an Eval. */
import { afterEach, expect, it, vi } from 'vitest'
import { CHAT, feishu, startRuntime, type Host } from './fixtures/host.ts'
import { repliedTo } from '../src/app/links.ts'
import { inputMessage } from '../src/executor/dsh.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
const THREAD = `feishu:${CHAT}:om_1`
const followup = (id: string, text: string, overrides: Record<string, unknown> = {}) => feishu(id, text, { mentions: [], root_id: 'om_1',
  ...overrides })
const notices = (host: Host) => host.relays(host.runtime.masterId).filter(item => item.kind === 'follow_up')

it('routes a subscribed human message through the main Session before delivering it once', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  h.deliveries.mockClear()
  const message = followup('2', '顺便把标题也改了', { parent_id: 'om_1' })
  h.runtime.receive(message); await h.runtime.idle()
  expect(h.relays(sessionId)).toEqual([])
  expect(notices(h)).toEqual([])
  expect(h.candidates()).toEqual([message.id])
  expect(h.runtime.store.triggers.disposition(message.id)).toMatchObject({ fanout: [] })
  await h.route({ kind: 'attach', ticket_id: ticket.id, trigger_id: message.id })
  await h.runtime.idle()
  expect(h.relays(sessionId)).toEqual([expect.objectContaining({ trigger_id: message.id })])
  expect(h.runtime.receive(message)).toBe('duplicate')
  await expect(h.route({ kind: 'accept', trigger_id: message.id, title: 'Duplicate', worktree_name: 'duplicate',
    acknowledgement: 'ok' })).rejects.toThrow(/its worker decides/)
})

it('sends a person\'s message that reaches no ticket, such as only one a person stopped, to Eval as before', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  h.runtime.engine.stopTicket(ticket.id)
  h.deliveries.mockClear()
  const message = followup('2', '@bot 换个方式修', { mentions: [{ id: 'ou_bot' }] })
  h.runtime.receive(message)
  await h.runtime.idle()
  expect(notices(h)).toEqual([])
  expect(h.candidates()).toEqual([message.id])
})

it('routes new work and stops without first waking or asking an unrelated worker to hand back', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 解释隔离机制'))
  h.deliveries.mockClear()
  const message = followup('2', '增加群列表折叠功能')
  h.runtime.receive(message); await h.runtime.idle()
  const result = await h.route({ kind: 'accept', trigger_id: message.id, title: '群列表折叠',
    worktree_name: 'collapse', acknowledgement: '收到。' })
  expect(result).toMatchObject({ decision: 'accept' })
  await h.runtime.idle()
  expect(h.relays(sessionId)).toEqual([])
  expect(h.runtime.store.tickets.list()).toHaveLength(2)
  const stop = followup('3', '停止解释工单')
  h.runtime.receive(stop); await h.runtime.idle()
  expect(await h.route({ kind: 'stop', ticket_id: ticket.id, trigger_id: stop.id })).toMatchObject({ decision: 'stop' })
  expect(h.relays(sessionId)).toEqual([])
})

it('batches human follow-ups as candidates and retries delivery without waking workers', async () => {
  h = await startRuntime()
  const { sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  h.deliveries.mockClear()
  h.agents.get(h.runtime.masterId)!.steer.mockImplementationOnce(() => { throw new Error('session gone') })
  const messages = ['2', '3', '4'].map(id => followup(id, `补充 ${id}`))
  for (const message of messages) h.runtime.receive(message)
  await h.runtime.idle()
  expect(h.runtime.receive(messages[0]!)).toBe('duplicate')
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2000 })
  try { await h.runtime.pump(); await h.runtime.idle() } finally { vi.useRealTimers() }
  expect(h.candidates()).toContain(messages[0]!.id)
  expect(h.relays(sessionId)).toEqual([])
  expect(h.runtime.effects.pending('relay')).toBe(false)
})

it('relays a message a worker handed back as a candidate with the worker\'s reason', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const message = followup('2', '另外把导出按钮也加上')
  h.runtime.receive(message)
  await h.runtime.idle()
  await h.route({ kind: 'attach', ticket_id: ticket.id, trigger_id: message.id })
  await h.runtime.idle()
  h.deliveries.mockClear()
  expect(await h.runTool(sessionId, 'orchestrator_trigger_handback', { trigger_id: message.id, reason: 'It asks for an export button.' }))
    .toEqual({ trigger_id: message.id, queued: true })
  await h.runtime.pump(); await h.runtime.idle()
  // The candidate tells the main Session; no requeue notice comes before it.
  const injected = h.agents.get(h.runtime.masterId)!.inject.mock.calls.map(([notice]) => JSON.stringify(notice))
  expect(injected.filter(notice => notice.includes('trigger_requeued'))).toEqual([])
  expect(h.relays(h.runtime.masterId).find(item => item.kind === 'candidate'
    && item.trigger_id === message.id)).toMatchObject({ strength: 'explicit',
    handed_back: [{ trigger_id: message.id, ticket_id: ticket.id, reason: 'It asks for an export button.' }] })
  await expect(h.runTool(sessionId, 'orchestrator_trigger_handback', { trigger_id: message.id,
    reason: 'Again' })).rejects.toThrow(/handed that trigger back/)
  // Attaching it back to the ticket that returned it is refused.
  await expect(h.route({ kind: 'attach', ticket_id: ticket.id, trigger_id: message.id }))
    .rejects.toThrow(/handed that trigger back as beyond it/)
})

it('lets a worker follow a related thread for context, which the main Session hears of without waking, and notes a ticket', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const master = h.agents.get(h.runtime.masterId)!
  master.inject.mockClear(); h.deliveries.mockClear()
  expect(await h.runTool(sessionId, 'orchestrator_thread_follow', { thread: 'github:7',
    reason: 'The issue it fixes.' })).toEqual({ followed: true, thread: 'github:7' })
  await h.runtime.idle()
  expect(h.runtime.store.threads.get('github:7')).toMatchObject({ subscriptions: [ticket.id], context: [ticket.id] })
  const text = (message: unknown) => (message as { content: { text: string }[] }).content[0]!.text
  const injected = master.inject.mock.calls.map(([message]) => JSON.parse(text(message)) as Record<string, unknown>)
  expect(injected).toEqual([expect.objectContaining({ thread_followed: { ticket_id: ticket.id, thread: 'github:7',
    reason: 'The issue it fixes.' } })])
  expect(h.relays(h.runtime.masterId)).toEqual([])
  await expect(h.runTool(sessionId, 'orchestrator_thread_follow', { thread: 'github', reason: 'x' })).rejects.toThrow(/<source>:<id>/)
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_ticket_note', { ticket_id: ticket.id, text: 'Ticket B renamed the setting.' }))
    .toMatchObject({ reason: 'Noted for the worker' })
  await h.runtime.idle()
  expect(h.deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === sessionId).map(call => call.text))
    .toEqual([expect.stringContaining('Note from the orchestrator, for context only: Ticket B renamed the setting.')])
})

it('takes the message a follow-up answers from its Source kind, whichever kind it is', async () => {
  h = await startRuntime()
  const parent = feishu('1', 'the earlier message')
  h.runtime.store.triggers.save(parent)
  const reply = { ...feishu('2', 'a reply'), source: 'other' }
  expect(repliedTo({ store: h.runtime.store, sources: { repliesTo: trigger => trigger.id === reply.id ? parent.id : undefined } },
    reply)).toEqual(parent)
  expect(repliedTo({ store: h.runtime.store, sources: { repliesTo: () => undefined } }, reply)).toBeUndefined()
  expect(repliedTo(h.runtime, followup('3', 'yes', { parent_id: 'om_1' }))).toEqual(parent)
})

it('keeps ended tickets asleep across pause and resumes only the ticket selected by the main Session', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done' })
  await h.runtime.settings.pause(true, 'panel')
  h.deliveries.mockClear()
  const message = followup('2', '再改一下标题')
  h.runtime.receive(message); await h.runtime.idle()
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeDefined()
  expect(h.relays(sessionId)).toEqual([])
  expect(h.candidates()).toContain(message.id)
  await h.route({ kind: 'attach', ticket_id: ticket.id, trigger_id: message.id })
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  expect(notices(h)).toEqual([])
})

it('tells the main Session nothing of a message it attached to an ended ticket, which resumes for it', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'dropped', summary: 'nothing to do' })
  const request = feishu('40', '@bot 上次那个改动还要改一下', { root_id: undefined })
  h.runtime.receive(request); await h.runtime.idle()
  await h.route({ kind: 'attach', ticket_id: ticket.id, trigger_id: request.id })
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  expect(notices(h)).toEqual([])
})

it('tells the main Session of a follow-up an earlier version queued for Eval, when the queue lets it go', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const message = followup('2', '顺便看看日志')
  h.deliveries.mockClear()
  // An earlier version delivered the follow-up to the ticket, queued it for Eval as well, and told the main Session nothing.
  h.runtime.store.atomic(() => {
    h!.runtime.store.triggers.save(message)
    h!.runtime.store.triggers.saveDisposition(message.id, { fanout: [ticket.id], at: message.at })
    h!.runtime.store.threads.save({ ...h!.runtime.store.threads.get(THREAD)!, pending: [message.id] })
  })
  await h.runtime.pump(); await h.runtime.idle()
  expect(h.runtime.store.threads.get(THREAD)).toMatchObject({ pending: [] })
  expect(notices(h)).toEqual([expect.objectContaining({ trigger_id: message.id, delivered_to: [expect.objectContaining({ ticket_id: ticket.id })] })])
})

it('routes human messages on context-only threads without delivering a worker copy', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.runTool(sessionId, 'orchestrator_thread_follow', { thread: `feishu:${CHAT}:om_9`, reason: 'The same page.' })
  h.deliveries.mockClear()
  const request = feishu('10', '@bot 把这里的按钮也改了', { root_id: 'om_9' })
  h.runtime.receive(request)
  await h.runtime.idle()
  // Context subscriptions do not bypass human routing.
  expect(h.candidates()).toEqual([request.id])
  expect(notices(h)).toEqual([])
  expect(h.runtime.store.triggers.disposition(request.id)).toMatchObject({ fanout: [] })
  expect(h.relays(sessionId)).toEqual([])
})

it('shows a candidate\'s message as its workers would read it, with the message it answers', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const long = `另外，${'导出按钮的文案也需要改。'.repeat(60)}`
  const reply = followup('2', long, { parent_id: 'om_1' })
  h.runtime.receive(reply); await h.runtime.idle()
  await h.runtime.pump(); await h.runtime.idle()
  const card = h.relays(h.runtime.masterId).find(item => item.kind === 'candidate' && item.trigger_id === reply.id)!
  expect(card).toMatchObject({ from: 'ou_alice', text: long.slice(0, 600) + '…', chars: long.length, read: `trigger/${reply.id}`,
    replies_to: { trigger_id: ticket.origin.triggerId, preview: '@bot 修一下回归' } })
  expect(card).not.toHaveProperty('triggers')
})

it('routes GitHub human reviews first but delivers automatic events directly', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  h.runtime.engine.bindThread(ticket.id, { source: 'github', id: '7' }, true)
  h.deliveries.mockClear()
  const human = { ...followup('2', 'Please fix this review'), source: 'github', threads: [{ source: 'github', id: '7' }] }
  h.runtime.receive(human); await h.runtime.idle()
  expect(h.relays(sessionId)).toEqual([])
  expect(h.runtime.store.triggers.disposition(human.id)).toMatchObject({ fanout: [] })
  const automatic = { ...human, id: 'ci-event', human: false, text: 'CI failed' }
  h.runtime.receive(automatic); await h.runtime.idle()
  expect(h.runtime.store.triggers.disposition(automatic.id)).toMatchObject({ fanout: [ticket.id] })
  expect(h.relays(sessionId)).toEqual([expect.objectContaining({ trigger_id: automatic.id })])
})

it('tells a worker it may hand back a message beyond its ticket or for another one, also when the message resumed it', async () => {
  expect(inputMessage({ id: 'r', kind: 'resumed', triggerId: 't', at: '' })).toContain('hand it back with orchestrator_trigger_handback')
  h = await startRuntime()
  const { sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  expect((h.tools.get(sessionId)!.get('orchestrator_trigger_handback') as unknown as { description: string }).description)
    .toContain('beyond this ticket or for another one')
})
