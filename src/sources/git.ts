import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, liveTicket, type Trigger } from '../core/index.ts'
import { family } from '../kv.ts'
import { RepositoryListSchema, type ResolvedRepository } from '../repositories.ts'
import { ForgeApi, type ForgeTopic, type TopicKind } from './forge-api.ts'
import { mentions } from './github-trigger.ts'
import { ticketBranch } from './github-pull.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { pause } from './poll.ts'
import { escapeRegExp } from '../infra/text.ts'

export const GitConfigSchema = z.object({ repositories: RepositoryListSchema,
  pollSeconds: z.number().int().min(60).max(3600).default(60), failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false), observePulls: z.boolean().default(false), observeComments: z.boolean().default(false),
  observeCi: z.boolean().default(false),
}).strict()
type GitConfig = z.infer<typeof GitConfigSchema>
const cursor = family<{ since: string; ci?: string }>('git:cursor:')
export const repositoryKey = (repo: Pick<ResolvedRepository, 'id' | 'url'>): string => `${repo.id}-${key(repo.url).slice(0, 12)}`
export const forgeThread = (repo: Pick<ResolvedRepository, 'id' | 'url'>, kind: TopicKind, number: number): string => `${repositoryKey(repo)}:${kind}:${number}`
const actorId = (repo: ResolvedRepository, author: string) => `${new URL(repo.url).host}/${author}`
const observeField = { issue: 'observeIssues', pull: 'observePulls', comment: 'observeComments', ci: 'observeCi' } as const
const identity = z.object({ id: z.string().regex(/^[A-Za-z0-9.:[\]-]+\/[A-Za-z0-9_.[\]-]+$/) }).strict()
function repository(ctx: Pick<SourceContext, 'deployment'>, id: string, url?: string): ResolvedRepository {
  const found = ctx.deployment.repositories?.find(repo => repo.id === id && (!url || repo.url === url))
  if (!found) throw new Error(`Repository ${id} is not configured or its URL changed`)
  return found
}
const refSchema = z.object({ repositoryId: z.string(), repositoryUrl: z.string(), kind: z.enum(['issue', 'pull']), number: z.coerce.number().int().positive() })

export const gitKind: SourceKind<GitConfig> = {
  kind: 'git', title: { zh: 'Git 仓库（多仓库）', en: 'Git repositories' },
  description: { zh: '支持 GitHub 与自建 GitLab。先添加仓库，再将标识绑定到飞书群或私聊。每个仓库使用已登录的 gh / glab CLI；不填写令牌。旧 GitHub 来源保持独立，同一仓库不要重复监听。', en: 'GitHub and self-hosted GitLab. Add repositories, then bind IDs to Feishu chats. Use authenticated gh / glab CLIs, never tokens. Do not also watch the same project with the legacy GitHub Source.' },
  schema: GitConfigSchema, health: ['git'],
  find(query, config) {
    const threads = (config?.repositories ?? []).flatMap(repo => {
      const prefix = repo.provider === 'gitlab' ? '/-/(issues|merge_requests)' : '/(issues|pull)'
      const match = new RegExp(`^${escapeRegExp(repo.url)}${prefix}/(\\d+)(?:[/?#]|$)`).exec(query.trim())
      return match ? [`git:${forgeThread(repo, match[1] === 'issues' ? 'issue' : 'pull', Number(match[2]))}`] : []
    })
    return { threads, terms: [] }
  },
  fields: [
    { key: 'repositories', type: 'rows', label: { zh: '可用仓库', en: 'Repositories' },
      hint: { zh: '标识例如 idcrm、backend。地址例如 https://github.com/wangqiongkaka/idcrm 或 https://gitlab.example.com/team/backend。CLI 填命令名或绝对路径。保存会检查账号和项目权限并重启。', en: 'Stable IDs such as idcrm or backend; HTTPS project URLs; CLI command names or absolute paths. Saving verifies access and restarts.' },
      columns: [
        { key: 'id', type: 'text', label: { zh: '仓库标识', en: 'ID' }, pattern: '[a-z][a-z0-9-]{0,47}' },
        { key: 'provider', type: 'select', label: { zh: '平台', en: 'Provider' }, options: [{ value: 'github', label: { zh: 'GitHub', en: 'GitHub' } }, { value: 'gitlab', label: { zh: 'GitLab', en: 'GitLab' } }] },
        { key: 'url', type: 'text', label: { zh: 'HTTPS 项目地址', en: 'HTTPS project URL' } },
        { key: 'cli', type: 'text', label: { zh: '账号 CLI（gh / glab）', en: 'Account CLI (gh / glab)' } },
      ] },
    ...(['issue', 'pull', 'comment', 'ci'] as const).map(kind => ({ key: observeField[kind], type: 'switch' as const,
      label: { zh: ({ issue: '接收新 Issue', pull: '接收新 PR / MR', comment: '接收评论', ci: '接收默认分支 CI' })[kind],
        en: ({ issue: 'Receive Issues', pull: 'Receive PRs / MRs', comment: 'Receive comments', ci: 'Receive default branch CI' })[kind] } })),
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败报告阈值', en: 'Failed polls before error' } },
  ],
  scope: ({ meta }, config) => {
    const repo = config.repositories.find(item => item.id === meta.repositoryId && item.url === meta.repositoryUrl)
    const kind = meta.kind as keyof typeof observeField
    return repo ? { listened: true, observed: !!config[observeField[kind]], row: kind } : { listened: false, reason: 'repository_not_configured' }
  },
  policy: {
    schema: z.object({ allowed: z.array(identity).default([]), bots: z.array(identity).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的账号', en: 'Accounts allowed to start work' },
      hint: { zh: '以主机名/账号区分实例，例如 gitlab.example.com/wangqiong。', en: 'Use host/username, for example gitlab.example.com/wangqiong.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '主机名/账号', en: 'Host/username' } }] },
    { key: 'bots', type: 'rows', label: { zh: '可成为候选的机器人', en: 'Candidate bots' }, columns: [{ key: 'id', type: 'text', label: { zh: '主机名/账号', en: 'Host/username' } }] }],
    explicit: { zh: '名单内的主机名/账号在 Issue、PR、MR 或评论中 @ 对应仓库的智能体账号。', en: 'An allowed host/username mentions the repository agent in an Issue, PR, MR or comment.' },
    rows(stored) {
      const config = GitConfigSchema.parse(stored)
      return (['issue', 'pull', 'comment', 'ci'] as const).map(kind => ({ id: kind,
        label: { zh: ({ issue: 'Issue', pull: 'PR / MR', comment: '评论', ci: 'CI' })[kind], en: kind },
        note: config[observeField[kind]] ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' },
        cells: { listedUnaddressed: kind !== 'ci' && config[observeField[kind]], unlistedAddressed: kind !== 'ci', unlistedUnaddressed: config[observeField[kind]] } }))
    },
  },
  channel: {
    allowed: (address, config) => config.repositories.some(repo => repo.id === address.repositoryId && repo.url === address.repositoryUrl),
    async send({ commands }, message) {
      const ref = refSchema.parse(message.channel.address)
      const repo = repository({ deployment: commands.deployment }, ref.repositoryId, ref.repositoryUrl)
      await new ForgeApi(commands, repo).send(ref.kind, ref.number, message.id, message.text)
      return 'sent'
    },
    link: address => ({ url: address.url ?? '', label: { zh: '查看仓库消息', en: 'Open repository message' } }),
  },
  threadContext: {
    messageId: trigger => trigger.meta.commentId ? `note:${trigger.meta.commentId}` : 'root',
    async read(commands, trigger, part, next) {
      if (trigger.meta.ci) return { body: { text: trigger.text }, messages: [{ id: 'root', from: '', at: trigger.at, text: trigger.text }] }
      const ref = refSchema.parse({ ...trigger.meta, kind: trigger.meta.topicKind ?? trigger.meta.kind })
      const api = new ForgeApi(commands, repository({ deployment: commands.deployment }, ref.repositoryId, ref.repositoryUrl))
      const topic = await api.read(ref.kind, ref.number)
      const root = { id: 'root', from: actorId(api.repository, topic.author), at: topic.created, text: `${topic.title}\n\n${topic.text}`, url: topic.url }
      if (part !== 'thread') return { body: { title: topic.title, messages: [root] }, messages: [root] }
      const page = next === undefined ? 1 : z.coerce.number().int().min(1).parse(next)
      const comments = await api.commentPage(topic, page)
      const messages = [...(page === 1 ? [root] : []), ...comments.map(note => ({ id: `note:${note.id}`, from: actorId(api.repository, note.author), at: note.updated, text: note.text, url: note.url, ...(note.bot ? { bot: true as const } : {}) }))]
      return { body: { title: topic.title, messages }, messages, ...(comments.length === 50 ? { next: String(page + 1) } : {}) }
    },
  },
}

function topicTrigger(repo: ResolvedRepository, topic: ForgeTopic): Trigger {
  const thread = forgeThread(repo, topic.kind, topic.number)
  const address = { repositoryId: repo.id, repositoryUrl: repo.url, kind: topic.kind, number: String(topic.number), url: topic.url }
  return { id: key('git', thread, 'root'), source: 'git', actor: { source: 'git', id: actorId(repo, topic.author) }, human: !topic.bot,
    at: topic.created, text: `${topic.title}\n\n${topic.text}`, threads: [{ source: 'git', id: thread }], url: topic.url,
    ...(mentions(topic.text, repo.login) ? { addressed: 'mention' } : {}), channel: { source: 'git', thread: `git:${thread}`, address },
    meta: { ...address, number: topic.number, kind: topic.kind, isPr: topic.kind === 'pull' } }
}
export function claimForgePull(ctx: SourceContext, ticketId: string, repo: ResolvedRepository, topic: ForgeTopic): void {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) throw new Error('Ticket has ended')
  if (!ticket.execution?.repositories?.some(item => item.id === repo.id && item.url === repo.url)) throw new Error('Repository is not selected for this ticket')
  if (topic.kind !== 'pull') throw new Error('Expected a PR or MR')
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === 'git' && source.meta.repositoryId === repo.id && source.meta.repositoryUrl === repo.url
    && source.meta.kind === 'pull' && source.meta.number === topic.number
  const own = topic.author.toLowerCase() === repo.login.toLowerCase() && topic.sameProject === true && ticketBranch(ticket, topic.branch ?? '')
  if (!started && !own) throw new Error('Use the origin PR/MR or an agent-authored PR/MR from this ticket branch in the selected repository')
  const thread = forgeThread(repo, 'pull', topic.number)
  if (ctx.tickets.open().some(item => item.id !== ticketId && item.follows?.some(follow => follow.thread === `git:${thread}` && !follow.closed)))
    throw new Error('PR/MR already belongs to another ticket')
  ctx.tickets.bindThread(ticketId, { source: 'git', id: thread }, own)
  ctx.threads.patch(`git:${thread}`, { repositoryId: repo.id, repositoryUrl: repo.url, kind: 'pull', number: topic.number, url: topic.url })
}
function observePull(ctx: SourceContext, repo: ResolvedRepository, topic: ForgeTopic): void {
  const thread = forgeThread(repo, 'pull', topic.number)
  if (topic.state !== 'open') {
    ctx.tickets.threadClosed({ source: 'git', id: thread }, topic.state, topic.closedAt ?? topic.updated)
    return
  }
  const candidates = ctx.tickets.open().filter(ticket => ticket.execution?.repositories?.some(item => item.id === repo.id && item.url === repo.url)
    && ticketBranch(ticket, topic.branch ?? '') && topic.sameProject && topic.author.toLowerCase() === repo.login.toLowerCase())
  if (candidates.length === 1) claimForgePull(ctx, candidates[0]!.id, repo, topic)
}

export async function pollRepository(ctx: SourceContext, repo: ResolvedRepository, config: GitConfig, signal?: AbortSignal): Promise<void> {
  const api = new ForgeApi(ctx.commands.withSignal(signal), repo)
  const storage = cursor(repositoryKey(repo))
  const started = new Date().toISOString()
  const saved = ctx.state.get(storage)
  if (!saved) { ctx.state.set(storage, { since: started }); return }
  const since = new Date(Date.parse(saved.since) - 1000).toISOString()
  const topics = new Map((await api.updated(since)).map(topic => [`${topic.kind}:${topic.number}`, topic]))
  for (const thread of ctx.threads.subscribed('git')) {
    const match = new RegExp(`^git:${repositoryKey(repo)}:(issue|pull):(\\d+)$`).exec(thread.key)
    if (match) topics.set(`${match[1]}:${match[2]}`, await api.read(match[1] as TopicKind, Number(match[2])))
  }
  for (let topic of topics.values()) {
    signal?.throwIfAborted()
    if (topic.kind === 'pull') { topic = await api.read('pull', topic.number); observePull(ctx, repo, topic) }
    const base = topicTrigger(repo, topic)
    const subscribed = !!ctx.threads.get(`git:${base.threads[0]!.id}`)?.subscriptions.length
    if (subscribed && topic.kind === 'pull' && topic.state === 'open') {
      const ci = await api.pullCi(topic)
      const thread = `git:${base.threads[0]!.id}`
      const previous = ctx.threads.get(thread)?.meta.forgeCi as { version: string; revision: number } | undefined
      if (ci) {
        const version = `${ci.id}:${ci.state}`
        const revision = (previous?.revision ?? 0) + Number(previous?.version !== version)
        if (previous && previous.version !== version) {
          const { addressed: _addressed, ...unaddressed } = base
          await ctx.receive({ ...unaddressed, id: key('git-pull-ci', thread, String(revision)), human: false,
            actor: { source: 'git', id: '' }, at: started, text: `${repo.id} PR/MR #${topic.number}: CI ${ci.state}`, url: ci.url,
            meta: { ...base.meta, ci: true, kind: 'ci', topicKind: 'pull' } })
        }
        ctx.threads.patch(thread, { forgeCi: { version, revision } })
        ctx.threads.describe(thread, { facts: { ci: { label: { zh: 'CI', en: 'CI' }, value: ci.state, ...(['failed', 'failure'].includes(ci.state) ? { problem: true } : {}) } } })
      }
    }
    if (topic.created >= since && topic.author !== repo.login && (base.addressed || config[observeField[topic.kind]])) await ctx.receive(base)
    for (const note of await api.comments(topic)) {
      if (note.system || note.author === repo.login || note.updated < since) continue
      const addressed = mentions(note.text, repo.login)
      if (!subscribed && !addressed && !config.observeComments) continue
      const { addressed: _addressed, ...unaddressed } = base
      await ctx.receive({ ...unaddressed, id: key('git', base.threads[0]!.id, note.url, String(note.id), note.updated),
        actor: { source: 'git', id: actorId(repo, note.author) }, human: !note.bot, at: note.updated, text: note.text, url: note.url,
        ...(addressed ? { addressed: 'mention' } : {}), meta: { ...base.meta, kind: 'comment', topicKind: topic.kind, commentId: note.id } })
    }
    ctx.threads.describe(`git:${base.threads[0]!.id}`, { label: `${repo.id} ${topic.kind === 'pull' ? 'PR/MR' : 'Issue'} #${topic.number}: ${topic.title}`, url: topic.url })
  }
  let ci = saved.ci
  if (config.observeCi) {
    const latest = await api.ci()
    if (latest && ['failed', 'failure', 'success', 'canceled', 'cancelled', 'timed_out'].includes(latest.state)) {
      const version = `${latest.id}:${latest.state}`
      const previousState = ci?.split(':').at(-1)
      const previousFailed = previousState !== 'success'
      const failed = latest.state !== 'success'
      if (ci && previousFailed !== failed) await ctx.receive({ id: key('git-ci', repositoryKey(repo), version), source: 'git',
        actor: { source: 'git', id: '' }, human: false, at: started, text: `${repo.id} ${repo.defaultBranch}: CI ${latest.state}`, url: latest.url,
        threads: [{ source: 'git', id: `${repositoryKey(repo)}:ci` }], meta: { repositoryId: repo.id, repositoryUrl: repo.url, kind: 'ci', ci: true, branch: repo.defaultBranch } })
      ci = version
    }
  } else ci = undefined
  ctx.state.set(storage, { since: started, ...(ci ? { ci } : {}) })
}

export const name = 'dsh-superagent-git'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitKind), 'git: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal).catch((error: unknown) => { source.report('git', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report('git', health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<GitConfig>('git')
    const errors: string[] = []
    if (config) {
      for (const entry of config.repositories) {
        if (signal.aborted) break
        try { await pollRepository(ctx, repository(ctx, entry.id, entry.url), config, signal) }
        catch (error) { errors.push(`${entry.id}: ${String(error)}`) }
      }
      failures = errors.length ? failures + 1 : 0
      if (failures >= config.failuresBeforeError) ctx.report('git', health('error', 'pollFailures', { count: String(failures), error: errors.join('; ') }))
      else if (!failures) ctx.report('git', { state: 'ready', detail: `${config.repositories.length} repositories` })
    } else ctx.report('git', health('paused', 'sourceOff'))
    await pause((config?.pollSeconds ?? 60) * 1000, signal)
  }
}
