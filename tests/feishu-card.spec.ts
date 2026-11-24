import { describe, expect, it, vi } from 'vitest'
import type { Ticket, Trigger } from '../src/core/index.ts'
import { answerFromCard, cardAnswerId } from '../src/sources/feishu-card.ts'
import type { SourceContext } from '../src/sources/host.ts'

const asker: Trigger = { id: 'feishu-ask', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_root' }], actor: { source: 'feishu', id: 'ou_asker' },
  human: true, at: '2026-11-25T00:00:00.000Z', text: '做个按钮', meta: { chatId: 'oc_1', messageId: 'om_ask', direct: false, rootId: 'om_root', threadId: 'omt_1' } }
const attention = { id: 'A1', question: '按钮用哪种颜色？', triggerId: asker.id, options: [{ label: '红色', recommended: true }, { label: '蓝色' }] }
const ticket = { id: 'T1', origin: { triggerId: asker.id }, attention } as unknown as Ticket

function context(open = ticket) {
  const triggers = new Map<string, Trigger>([[asker.id, asker]])
  const lark = vi.fn(async (_args: string[]) => '{}')
  const answer = vi.fn((_ticket: string, _attention: string, trigger: Trigger) => {
    if (trigger.actor.id !== asker.actor.id) return 'refused' as const
    triggers.set(trigger.id, trigger); return 'answered' as const
  })
  const ctx = { commands: { lark }, triggers: { get: (id: string) => triggers.get(id) },
    tickets: { get: (id: string) => id === open.id ? open : undefined, answer } } as unknown as SourceContext
  return { ctx, lark, answer, triggers }
}
const click = (choice: number, operator = 'ou_asker', extra: Record<string, string> = {}) => ({ type: 'card.action.trigger', event_id: `e${choice}`,
  operator_id: operator, message_id: 'om_card', chat_id: 'oc_1', action_value: JSON.stringify({ ticket: 'T1', attention: 'A1', choice }), ...extra })
const patched = (lark: ReturnType<typeof context>['lark']) => {
  const args = lark.mock.calls.at(-1)![0]
  expect(args.slice(0, 3)).toEqual(['api', 'PATCH', '/open-apis/im/v1/messages/om_card'])
  return JSON.parse(JSON.parse(args[4]!).content) as { header: { title: { content: string } }; body: { elements: { content: string }[] } }
}

describe('Feishu question cards', () => {
  it('answers with the chosen option as the asker\'s message on the asking Thread, then shows the answer without buttons', async () => {
    const { ctx, lark, answer } = context()
    await answerFromCard(ctx, click(1))
    const [ticketId, attentionId, trigger] = answer.mock.calls[0]!
    expect([ticketId, attentionId]).toEqual(['T1', 'A1'])
    expect(trigger).toMatchObject({ id: cardAnswerId('A1'), human: true, actor: { source: 'feishu', id: 'ou_asker' }, threads: asker.threads,
      text: '选择: 蓝色', channel: { address: { chatId: 'oc_1', messageId: 'om_card' } }, meta: { card: true, question: attention.question, rootId: 'om_root', threadId: 'omt_1' } })
    const card = patched(lark)
    expect(card.header.title.content).toBe('已回答')
    expect(card.body.elements.map(element => element.content)).toEqual([attention.question, '✅ <at id=ou_asker></at> 已回答：**选择: 蓝色**'])
  })
  it('answers with a typed answer, and ignores an empty one', async () => {
    const { ctx, answer, lark } = context()
    await answerFromCard(ctx, click(-1, 'ou_asker', { form_value: JSON.stringify({ answer: '  ' }) }))
    expect(answer).not.toHaveBeenCalled(); expect(lark).not.toHaveBeenCalled()
    await answerFromCard(ctx, click(-1, 'ou_asker', { form_value: JSON.stringify({ answer: '绿色' }) }))
    expect(answer.mock.calls[0]![2].text).toBe('绿色')
  })
  it('leaves the card alone for anyone else, and redraws the recorded answer on a repeated click', async () => {
    const { ctx, answer, lark } = context()
    await answerFromCard(ctx, click(0, 'ou_other'))
    expect(lark).not.toHaveBeenCalled()
    await answerFromCard(ctx, click(0)); await answerFromCard(ctx, click(1))
    expect(answer).toHaveBeenCalledTimes(2)
    expect(lark).toHaveBeenCalledTimes(2)
    expect(patched(lark).body.elements[1]!.content).toContain('选择: 红色')
  })
  it('closes the card of a question that no longer stands, and ignores values it did not write', async () => {
    const { ctx, answer, lark } = context({ ...ticket, attention: { ...attention, id: 'A2' } } as Ticket)
    await answerFromCard(ctx, click(0))
    expect(answer).not.toHaveBeenCalled()
    expect(patched(lark).header.title.content).toBe('问题已失效')
    lark.mockClear()
    await answerFromCard(ctx, { ...click(0), action_value: '{"choice":9}' })
    await answerFromCard(ctx, { ...click(0), action_value: 'not json' })
    expect(lark).not.toHaveBeenCalled()
  })
})
