/** What the Executor and its workers report about the Assignments that run tickets. */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, liveTicket, runningAssignment } from './model.ts'
import type { Attention, AttentionOption, ReportState, Ticket } from './model.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Replies } from './replies.ts'
import { automatic, type Tickets } from './tickets.ts'

/** How long an Input's delivery keeps failing before the person whose message waits is told. */
export const DELIVERY_STALLED_MS = 5 * 60_000

/** What an Assignment reports: a worker's report, or the Executor's own (`waiting` after an idle turn, `failed` after an error). */
export interface WorkerReport {
  state: ReportState
  summary: string
  /** Final text for the source conversation, supplied for a ready result or an answer. */
  publicReply?: string
  /** A short, shareable explanation of a failure, separate from internal diagnostics. */
  failureReason?: string | { zh: string; en: string }
  /** Open question for a person: a string asks it, `null` clears an open one, and `undefined` keeps the current one. */
  question?: string | null
  /** Choices for a `question` that a Channel may offer as buttons; the question text stays complete without them. */
  options?: AttentionOption[]
  /** The person's message whose request raised the question; routes the question to the channel where it was written. */
  askedBy?: string
  /** The person's question this report answers, which the worker thereby takes up; authorizes the main Session to send an answer reply. */
  answers?: string
}
const RECOVERY_NOTE = 'The host restarted during this ticket. Inspect the current worktree, git history and GitHub state before continuing. Do not repeat an already completed external operation. Finish the original assignment and report its status.'

/**
 * Assignments records what the Executor and its workers report about the Assignments that run tickets: one started, Inputs
 * reached it or failed to, its worker's Session took Inputs into a step, a turn of its worker ended, a host restart
 * interrupted it, and a worker's report with its question for a person. It depends on
 * Tickets to restart or end a ticket and on Replies to withdraw a question a report replaced; the Engine routes the
 * Executor's lifecycle callbacks and its workers' reports here.
 */
export class Assignments extends EnginePart {
  constructor(options: EngineOptions, private readonly tickets: Tickets, private readonly replies: Replies) { super(options) }

  /** Marks a non-ended assignment running, notifies the original requester when recovering from a failure or block, queues waiting undelivered inputs on an open ticket, and emits `assignment.started`. */
  started(ticketId: string, assignmentId: string): void {
    const ticket = this.require(ticketId)
    const index = ticket.assignments.findIndex(item => item.id === assignmentId)
    const assignment = index >= 0 ? ticket.assignments[index] : undefined
    if (!assignment || assignment.state === 'ended') return
    const firstStart = assignment.state === 'pending'
    const previous = index > 0 ? ticket.assignments[index - 1] : undefined
    const recovered = firstStart && (
      assignment.report?.state === 'failed'
      || (previous?.endedReason === 'retried' && (previous.report?.state === 'failed' || previous.report?.state === 'blocked'))
    )
    assignment.state = 'running'; assignment.startedAt ??= this.now()
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    if (liveTicket(ticket) && recovered) this.replies.reportRecovered(ticket, assignment.id)
    if (liveTicket(ticket) && ticket.undelivered.length) this.options.executor.deliver(ticket, assignment)
    this.emit('assignment.started', { ticketId, assignmentId })
  }
  /**
   * Marks `inputIds` delivered on the ticket's running assignment and clears any prior `delivery` failure; ignored if no
   * longer running. Its worker reads each once its Session takes it into a step (see `read`).
   */
  delivered(ticketId: string, assignmentId: string, inputIds: string[]): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    ticket.undelivered = ticket.undelivered.filter(id => !inputIds.includes(id)); ticket.updatedAt = this.now()
    runningAssignment(ticket)!.deliveredAt = ticket.updatedAt
    const humanDelivered: { inputId: string; triggerId: string }[] = []
    for (const input of ticket.inputs) {
      if (input.kind === 'trigger' && inputIds.includes(input.id)) {
        input.readAt ??= null; input.deliveredTo = assignmentId
        if (input.human) humanDelivered.push({ inputId: input.id, triggerId: input.triggerId })
      }
    }
    delete ticket.delivery
    this.repo.tickets.save(ticket)
    for (const item of humanDelivered) this.replies.reportDeliveryRecovered(ticket, item.inputId, item.triggerId)
  }
  /** Records when the worker's Session of an open ticket took `inputIds` into a step, from which its model reads them. */
  read(ticketId: string, inputIds: string[]): void {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) return
    for (const input of ticket.inputs) if (input.kind === 'trigger' && inputIds.includes(input.id)) input.readAt ||= this.now()
    this.repo.tickets.save(ticket)
  }
  turnEnded(ticketId: string, assignmentId: string): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    runningAssignment(ticket)!.idleAt = this.now()
    this.repo.tickets.save(ticket)
  }
  deliveryFailed(ticketId: string, assignmentId: string, error: string): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    const at = this.now()
    const since = ticket.delivery?.since ?? ticket.delivery?.at ?? at
    ticket.delivery = { error: error.slice(0, 300), at, since }
    this.repo.tickets.save(ticket)
    // Retries stay silent until they have failed for a while; then the person whose message waits hears it once.
    if (Date.parse(at) - Date.parse(since) < DELIVERY_STALLED_MS) return
    const waiting = ticket.undelivered.map(id => ticket.inputs.find(input => input.id === id))
      .find(input => input?.kind === 'trigger' && input.human)
    if (waiting?.kind === 'trigger') this.replies.reportDeliveryStalled(ticket, waiting.id, waiting.triggerId)
  }
  /**
   * Handles a running assignment interrupted by a host restart: restarts it with a recovery note unless its latest report is
   * `waiting`, `ready`, `blocked`, or `failed` and no input was delivered after that report, in which case it keeps its
   * session and flushes any waiting undelivered inputs.
   */
  interrupted(ticketId: string, assignmentId: string): void {
    const ticket = this.running(ticketId, assignmentId)
    const running = ticket && runningAssignment(ticket)
    if (!ticket || !running) return
    const report = running.report
    const busy = !!running.deliveredAt && !!report && running.deliveredAt >= report.at
    const settled = !!report && ['waiting', 'ready', 'blocked', 'failed'].includes(report.state) && !busy
    if (!settled) this.tickets.restart(ticket, running, 'hostRestarted', RECOVERY_NOTE)
    else if (ticket.undelivered.length) this.options.executor.deliver(ticket, running)
  }
  /**
   * Records a worker status report on an open ticket's current assignment, updating `attention`, `answers`, held automated
   * inputs, and ending the ticket when `dropped` or when `ready` and not waiting on followed threads (`followsDone`).
   * @throws UserError for an unknown or ended ticket, an ended assignment, a question combined with a ready result or answer,
   * a question/answer referencing a non-human or unreached trigger, or a blocked report for a Feishu requester without an open question.
   */
  report(ticketId: string, report: WorkerReport): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    if (report.question && (report.state === 'ready' || report.answers)) throw new UserError('questionWithResult')
    if (report.askedBy && !report.question) throw new UserError('askerWithoutQuestion')
    const person = (id: string, channel: boolean) => {
      const trigger = this.repo.triggers.get(id)
      return !!trigger?.human && (!channel || !!trigger.channel) && this.reaches(ticket, trigger, false)
    }
    if (report.askedBy && !person(report.askedBy, true)) throw new UserError('notAsker')
    if (report.answers && !person(report.answers, false)) throw new UserError('notAnswerable')
    // Feishu gets the executor's own complete text, never the main Session's rewrite of a truncated summary. A dropped ticket
    // tells the person who asked for it why, unless it ends as the close of its followed Threads, whose own notice tells it;
    // one taken on unasked stays as quiet as its rules keep it.
    const tells = !!report.answers || report.state === 'ready'
      || (report.state === 'dropped' && ticket.mandate.strength === 'explicit' && !this.tickets.followsDone(ticket))
    if (tells && !report.publicReply?.trim() && this.replies.publicChannel(ticket, report.answers)) {
      throw new UserError('publicReplyRequired')
    }
    const assignment = runningAssignment(ticket) ?? latestAssignment(ticket)
    if (!assignment) throw new UserError('unknownAssignment')
    if (assignment.state === 'ended') throw new UserError('assignmentEnded')
    const at = this.now()
    const previous = ticket.attention
    const options = report.options?.length ? report.options : undefined
    const ask = (question: string): Attention => ({ id: key('attention', ticketId, question, at, ...options ? [JSON.stringify(options)] : []), question, at,
      ...(report.askedBy ? { triggerId: report.askedBy } : {}), ...(options ? { options } : {}) })
    // The same question with other choices is a new question, so its message goes out again with them; repeated without
    // choices, it keeps the ones it was asked with.
    const same = report.question === previous?.question && (!options || JSON.stringify(options) === JSON.stringify(previous?.options))
    const asked = report.question && !same ? ask(report.question) : previous
    const attention = report.question === null || report.state === 'ready' ? undefined : asked
    // A Feishu requester waits on a blocked ticket only for what a person must do, which a question still unanswered tells
    // them: one a person's message came after may be answered already.
    const unanswered = attention && !ticket.inputs.some(input => input.kind === 'trigger' && input.human && !!attention.at && input.at > attention.at)
    if (report.state === 'blocked' && !unanswered && this.replies.publicChannel(ticket)) throw new UserError('blockedNeedsAction')
    if (attention) ticket.attention = attention
    else delete ticket.attention
    // A replaced or cleared attention question withdraws any pending unsent reply for the previous question from the outbox.
    if (previous && previous.id !== attention?.id) this.replies.withdrawAttention(previous.id)
    assignment.report = { state: report.state, summary: report.summary, at }
    ticket.updatedAt = at
    const queued = report.publicReply && tells && this.replies.reportDelivery(ticket, report.publicReply, report.answers)
    if (report.answers) {
      if (queued && ticket.answers) ticket.answers = ticket.answers.filter(id => id !== report.answers)
      if (!queued && !ticket.answers?.includes(report.answers)) ticket.answers = [...ticket.answers ?? [], report.answers]
    }
    if (report.answers) this.takeUp(ticketId, report.answers)
    if (report.state === 'blocked' || report.state === 'failed') ticket.undelivered = ticket.undelivered.filter(id => !automatic(ticket.inputs.find(input => input.id === id)))
    this.repo.tickets.save(ticket)
    if (report.question && attention && report.state !== 'dropped') this.replies.reportAttention(ticket, attention)
    if (report.state === 'failed') this.replies.reportFailure(ticket, assignment.id, report.failureReason)
    // A ticket that follows Threads ends with them: a ready report ends it only once followsDone holds, with that outcome.
    const ready = !ticket.follows?.length ? 'completed' : this.tickets.followsDone(ticket)?.outcome
    // A dropped report after a close the ticket deferred ends it as the close did, which its final notice tells.
    const outcome = report.state === 'dropped' ? this.tickets.followsDone(ticket)?.outcome ?? 'dropped' : report.state === 'ready' ? ready : undefined
    if (outcome) this.tickets.end(ticketId, 'executor', outcome, at)
    return this.require(ticketId)
  }
  /** The ticket, while it is open and `assignmentId` runs it. */
  private running(ticketId: string, assignmentId: string): Ticket | undefined {
    const ticket = this.require(ticketId)
    return liveTicket(ticket) && runningAssignment(ticket)?.id === assignmentId ? ticket : undefined
  }
}
