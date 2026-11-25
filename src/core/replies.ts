/** The Engine's messages to Channels, each by the rule that allows it. */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, liveTicket, ticketOutcome } from './model.ts'
import type { Attention, ChannelRef, Ticket, Trigger } from './model.ts'
import type { OutboundMessage, ReplyStatus } from './ports.ts'
import { EnginePart } from './part.ts'

/**
 * A message for a Channel, by purpose: an Executor's acknowledgement of a person's request it works on, the answer to a
 * person's question once the worker reported it, the result of a ticket that is `ready`, `completed`, `merged`, or `dropped`,
 * or the ticket's current `question` for a person (`attention`). When `ticketId` is omitted, the ticket that `triggerId` reached is used.
 */
export type ReplyRequest =
  | { purpose: 'acknowledgement'; ticketId: string; triggerId: string; text: string }
  | { purpose: 'answer' | 'result' | 'attention'; ticketId?: string; triggerId?: string; question?: string; text: string }
/** A queued message: its id, whether it went out, and whether an earlier request had queued it already. */
export interface Reply { id: string; status: ReplyStatus; reused: boolean }

/** The delivery of a question's answer or the result for an assignment's latest input. */
export function reportReplyId(ticket: Ticket, answerTo?: string): string {
  if (answerTo) return key('report-answer', ticket.id, answerTo)
  const assignment = latestAssignment(ticket)
  return key('report-result', ticket.id, assignment?.id ?? '', assignment?.deliveredAt ?? '')
}

/** The options a Channel may offer to answer the question, when it has any. */
const choices = (attention: Attention): Pick<OutboundMessage, 'choices'> =>
  attention.options?.length ? { choices: { attentionId: attention.id, options: attention.options } } : {}

/**
 * Replies writes the Engine's messages to Channels through the Outbox port: an acknowledgement, the answer to a person's
 * question, a ticket's result, and its question for a person, each only when its rule allows it, under a deterministic id
 * that keeps it from going out twice (idempotent). The Engine routes `reply` here; Tickets asks it for the acknowledgement
 * an accept carries, and Assignments asks it to withdraw a question a report replaced.
 */
export class Replies extends EnginePart {
  /**
   * Queue a message for the Channel its purpose names: an acknowledgement or an answer goes where that person's message was
   * written, attention where the message that raised the question was (or to the ticket's starting conversation), and a
   * result to the conversation where the ticket started (`result` is allowed only for a ticket in `ready`, `completed`,
   * `merged`, or `dropped`). Each message is queued at most once (idempotent). An acknowledgement, even one already queued,
   * records that the ticket's worker took the message up.
   * @throws UserError when the ticket or trigger is unknown or the purpose's rule refuses it, such as a result of a ticket
   * that is not ready, completed, merged, or dropped.
   */
  reply(request: ReplyRequest): Reply {
    return request.purpose === 'acknowledgement' ? this.acknowledge(request) : this.answer(request)
  }
  /**
   * Queue the acknowledgement an accept carries where the message that started the ticket was written, if it has a Channel
   * and a person wrote it.
   */
  acknowledgeAccepted(ticketId: string, trigger: Trigger, text: string): void {
    if (trigger.channel && trigger.human) this.options.outbox.send({ id: key('ack', trigger.id), channel: trigger.channel, text, kind: 'acknowledgement', ticketId })
  }
  /** Queue a failure on the original human request, never on a channel attached to the ticket later. */
  reportFailure(ticket: Ticket, assignmentId: string, reason?: string | { zh: string; en: string }): void {
    const origin = this.source(ticket)
    if (!origin?.human || !origin.channel) return
    const chinese = /\p{Script=Han}/u.test(origin.text) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(origin.text)
    const detail = typeof reason === 'string' ? reason.trim() : reason?.[chinese ? 'zh' : 'en']
    // Public details are deliberately separate from the internal summary. Drop credential-like content even in that field.
    const sensitive = /[\r\n]|https?:\/\/|(?:^|\s)(?:[a-z]:[\\/]|~?\/)\S|\bbearer\b|(?:authorization|password|secret|token|api[-_ ]?key)\s*[:=]|\b(?:gh[pousr]_|github_pat_|sk-|xox[bp]-)\S|-----BEGIN /i
    const safe = detail && !sensitive.test(detail) ? detail.slice(0, 72).replace(/[`<>@]/g, '').trim() : ''
    const id = ticket.id.slice(0, 12)
    const text = chinese
      ? `工单 ${id} 执行失败。${safe || '执行器未能完成任务。'} 处理后可重试。`
      : `Ticket ${id} failed. ${safe || 'The executor could not finish the task.'} You can retry after resolving the issue.`
    this.options.outbox.send({ id: key('ticket-failure', assignmentId, text), channel: origin.channel, text, kind: 'reply', ticketId: ticket.id })
  }
  /** Send the executor's complete question directly to its Feishu recipient. */
  reportAttention(ticket: Ticket, attention: Attention): void {
    const channel = this.attentionChannel(ticket, attention)
    if (channel?.source === 'feishu') this.options.outbox.send({
      id: key('attention-reply', attention.id), channel, text: attention.question, kind: 'reply', ticketId: ticket.id, ...choices(attention),
    })
  }
  /** Publish only an explicitly authored Feishu reply, never the internal report summary. */
  reportDelivery(ticket: Ticket, text: string, answerTo?: string): boolean {
    const channel = this.publicChannel(ticket, answerTo)
    if (!channel) return false
    this.options.outbox.send({ id: reportReplyId(ticket, answerTo), channel, text, kind: 'reply', ticketId: ticket.id })
    return true
  }
  /** The Feishu conversation of the person a ready result or an answer goes to, which only the executor's own text reaches. */
  publicChannel(ticket: Ticket, answerTo?: string): ChannelRef | undefined {
    const target = answerTo ? this.repo.triggers.get(answerTo) : this.source(ticket)
    return target?.human && target.channel?.source === 'feishu' ? target.channel : undefined
  }
  /** Withdraw a ticket's question for a person from the outbox, unless it went out already. */
  withdrawAttention(attentionId: string): void { this.options.outbox.withdraw(key('attention-reply', attentionId)) }
  private acknowledge(request: Extract<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const ticket = this.require(request.ticketId)
    if (!liveTicket(ticket)) throw new UserError('ackEnded')
    const trigger = this.repo.triggers.get(request.triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    // Context-only threads are read-only and cannot receive acknowledgements.
    if (!this.reaches(ticket, trigger, false)) throw new UserError('notReached')
    if (!trigger.channel) throw new UserError('ackNoChannel')
    const id = key('ack', trigger.id)
    const existing = this.options.outbox.status(id)
    if (!existing && !trigger.human) throw new UserError('ackNotPerson')
    // Preserve the automatic or first queued acknowledgement.
    if (!existing) this.options.outbox.send({ id, channel: trigger.channel, text: request.text, kind: 'acknowledgement', ticketId: ticket.id })
    this.takeUp(ticket.id, trigger.id)
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  private answer(request: Exclude<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const trigger = request.triggerId ? this.repo.triggers.get(request.triggerId) : undefined
    if (request.triggerId && !trigger) throw new UserError('unknownTrigger')
    const ticket = request.ticketId ? this.require(request.ticketId)
      : trigger ? this.repo.tickets.list().find(item => this.reaches(item, trigger)) : undefined
    if (request.purpose === 'result') {
      const outcome = ticket && ticketOutcome(ticket)
      const reported = !!ticket && liveTicket(ticket) && latestAssignment(ticket)?.report?.state === 'ready'
      const ready = outcome === 'merged' || outcome === 'completed' || outcome === 'dropped' || reported
      if (!ticket || !ready) throw new UserError('notReady')
    }
    const attention = request.purpose === 'attention' ? ticket?.attention : undefined
    // Attention replies must match the ticket's currently open question text.
    if (request.purpose === 'attention' && (!attention || attention.question !== request.question)) throw new UserError('notAttention')
    if (request.purpose === 'answer' && !trigger?.human) throw new UserError('notQuestion')
    if (ticket && (request.purpose === 'result' || request.purpose === 'answer')) {
      const id = reportReplyId(ticket, request.purpose === 'answer' ? trigger!.id : undefined)
      const status = this.options.outbox.status(id)
      if (status) return { id, status, reused: true }
    }
    const id = attention ? key('attention-reply', attention.id) : key('reply', trigger?.id ?? ticket?.id ?? '', request.text)
    const existing = this.options.outbox.status(id)
    const ready = !ticket || !trigger || ticket.answers?.includes(trigger.id)
    if (request.purpose === 'answer' && !ready && !existing) throw new UserError('noAnswer')
    const channel = request.purpose === 'answer' ? trigger!.channel
      : ticket && (attention ? this.attentionChannel(ticket, attention) : this.sourceChannel(ticket))
    if (!channel) throw new UserError('noChannel')
    const text = attention && channel.source === 'feishu' ? attention.question : request.text
    this.options.outbox.send({ id, channel, text, kind: 'reply', ...ticket ? { ticketId: ticket.id } : {}, ...attention ? choices(attention) : {} })
    if (request.purpose === 'answer' && ticket && trigger && ticket.answers?.includes(trigger.id)) {
      ticket.answers = ticket.answers.filter(item => item !== trigger.id)
      this.repo.tickets.save(ticket)
    }
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  private attentionChannel(ticket: Ticket, attention: Attention): ChannelRef | undefined {
    return (attention.triggerId ? this.repo.triggers.get(attention.triggerId)?.channel : undefined) ?? this.sourceChannel(ticket)
  }
  /** The conversation a ticket started in: its origin Trigger's Channel, else its first Channel. */
  private sourceChannel(ticket: Ticket): ChannelRef | undefined { return this.source(ticket)?.channel ?? ticket.channels[0] }
}
