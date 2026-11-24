/** Feishu question cards: a ticket's open question with its options as buttons, and the click that answers it. */
import { z } from 'zod'
import { key, type AttentionOption, type OutboundMessage, type Trigger } from '../core/index.ts'
import type { SourceContext } from './host.ts'
import { feishuChannel, SOURCE } from './feishu-trigger.ts'

/** What a card button carries back: the ticket, the question it answers, and the option's index, `-1` for the typed answer. */
const ValueSchema = z.object({ ticket: z.string(), attention: z.string(), choice: z.number().int().min(-1).max(3) })
/** A `card.action.trigger` event as `lark-cli event consume` prints it; JSON-valued fields arrive as strings. */
const ClickSchema = z.looseObject({
  event_id: z.string(), operator_id: z.string(), message_id: z.string(), chat_id: z.string(),
  action_value: z.string().optional(), form_value: z.string().optional(),
})
const chinese = (text: string): boolean => /\p{Script=Han}/u.test(text) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)
const plain = (content: string) => ({ tag: 'plain_text', content })
const card = (title: string, template: string, elements: unknown[]): string =>
  JSON.stringify({ schema: '2.0', config: { update_multi: true }, header: { title: plain(title), template }, body: { elements } })

/** The interactive card for a question with options: its full text, one button per option, and a form for another answer. */
export function questionCard(message: OutboundMessage & Required<Pick<OutboundMessage, 'choices' | 'ticketId'>>): string {
  const zh = chinese(message.text)
  const value = (choice: number) => ({ ticket: message.ticketId, attention: message.choices.attentionId, choice })
  const button = (option: AttentionOption, choice: number) => ({ tag: 'column', width: 'auto', elements: [{ tag: 'button',
    text: plain(option.recommended ? `${option.label}${zh ? '（推荐）' : ' (recommended)'}` : option.label),
    type: option.recommended ? 'primary' : 'default', behaviors: [{ type: 'callback', value: value(choice) }] }] })
  return card(zh ? '需要你决定' : 'Your decision needed', 'blue', [
    { tag: 'markdown', content: message.text },
    { tag: 'column_set', columns: message.choices.options.map(button) },
    { tag: 'form', name: 'other', elements: [
      { tag: 'input', name: 'answer', max_length: 1000, placeholder: plain(zh ? '其他答案' : 'Another answer') },
      { tag: 'button', name: 'submit', form_action_type: 'submit', type: 'default', text: plain(zh ? '提交其他答案' : 'Submit answer'),
        behaviors: [{ type: 'callback', value: value(-1) }] }] },
    { tag: 'markdown', content: `<font color='grey'>${zh ? '仅提问对象可作答；也可以直接在话题中回复文字。' : 'Only the person asked can answer here; a text reply in the thread also works.'}</font>` },
  ])
}
/** The card after its question was answered, or after it no longer stands (`answer` undefined); its buttons are gone. */
function closedCard(question: string, zh: boolean, answer?: { by: string; text: string }): string {
  const line = answer ? `✅ <at id=${answer.by}></at> ${zh ? '已回答：' : 'answered: '}**${answer.text.replace(/[*<>]/g, '')}**`
    : zh ? '这个问题已更新或结束，请以话题中的最新消息为准。' : 'This question was replaced or closed; see the latest message in the thread.'
  return card(answer ? (zh ? '已回答' : 'Answered') : (zh ? '问题已失效' : 'Question closed'), answer ? 'green' : 'grey',
    [question, line].filter(Boolean).map(content => ({ tag: 'markdown', content })))
}

/** The Trigger a card answer becomes: one per question, so repeated clicks and redelivered events are duplicates. */
export const cardAnswerId = (attentionId: string): string => key('feishu-card', attentionId)

/**
 * Handles one card click: the person the question is for answers it with an option or a typed answer, which goes to its
 * ticket as that person's message, and the card then shows the answer; a click on a question that no longer stands closes
 * the card. Clicks by others, and values that do not name an open question's option, change nothing.
 */
export async function answerFromCard(ctx: SourceContext, input: unknown, now = new Date()): Promise<void> {
  const click = ClickSchema.parse(input)
  const value = ValueSchema.safeParse(parseJson(click.action_value))
  if (!value.success) return
  const { ticket: ticketId, attention: attentionId, choice } = value.data
  const ticket = ctx.tickets.get(ticketId)
  const attention = ticket?.attention?.id === attentionId ? ticket.attention : undefined
  const typed = z.object({ answer: z.string() }).safeParse(parseJson(click.form_value))
  const text = choice < 0 ? (typed.success ? typed.data.answer.trim() : '') : attention?.options?.[choice]?.label ?? ''
  const asker = attention && ctx.triggers.get(attention.triggerId ?? ticket!.origin.triggerId)
  const id = cardAnswerId(attentionId)
  let result: 'answered' | 'duplicate' | 'stale' | 'refused' = 'duplicate'
  if (!ctx.triggers.get(id)) {
    if (!attention || !asker) result = 'stale'
    else if (!text) return
    else {
      const direct = asker.meta.direct === true
      const trigger: Trigger = { id, source: SOURCE, threads: asker.threads, actor: { source: SOURCE, id: click.operator_id }, human: true,
        at: now.toISOString(), text: choice < 0 ? text : `${chinese(attention.question) ? '选择' : 'Choice'}: ${text}`,
        channel: feishuChannel(click.chat_id, click.message_id, direct),
        // The card is a reply in the asking message's topic; polls and history locate the topic by its newest message's root and thread.
        meta: { chatId: click.chat_id, messageId: click.message_id, direct, rootId: asker.meta.rootId ?? asker.meta.messageId,
          ...asker.meta.threadId ? { threadId: asker.meta.threadId } : {}, card: true, attentionId, question: attention.question } }
      result = ctx.tickets.answer(ticketId, attentionId, trigger)
    }
  }
  if (result === 'refused') return
  const answered = ctx.triggers.get(id)
  const question = attention?.question ?? (typeof answered?.meta.question === 'string' ? answered.meta.question : '')
  // Without the question, as on a card of an ended ticket, the card speaks the language of the request that started the ticket.
  const zh = chinese(question || (ticket && ctx.triggers.get(ticket.origin.triggerId)?.text) || '')
  const content = result === 'stale' ? closedCard(question, zh)
    : closedCard(question, zh, { by: answered?.actor.id ?? click.operator_id, text: answered?.text ?? text })
  // The answer is recorded already; a failed update (such as of a recalled card) only leaves the buttons showing, and the
  // next click redraws it, so it neither retries nor holds the stream's health in error.
  await ctx.commands.lark(['api', 'PATCH', `/open-apis/im/v1/messages/${click.message_id}`, '--data', JSON.stringify({ content })]).catch(() => {})
}
function parseJson(text: string | undefined): unknown {
  try { return text ? JSON.parse(text) : undefined } catch { return undefined }
}
