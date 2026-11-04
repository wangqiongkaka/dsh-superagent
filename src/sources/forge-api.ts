import { z } from 'zod'
import type { Commands } from '../infra/commands.ts'
import { key } from '../core/index.ts'
import type { ResolvedRepository } from '../repositories.ts'

export type TopicKind = 'issue' | 'pull'
export interface ForgeTopic {
  number: number; kind: TopicKind; title: string; text: string; author: string; bot: boolean; url: string
  created: string; updated: string; state: 'open' | 'closed' | 'merged'; branch?: string; sameProject?: boolean; closedAt?: string; sha?: string
}
export interface ForgeComment { id: number; text: string; author: string; bot: boolean; created: string; updated: string; url: string; system: boolean }
const GhUser = z.object({ login: z.string(), type: z.string().optional() }).nullable()
const GlUser = z.object({ username: z.string(), bot: z.boolean().optional() })
const GhTopic = z.object({ number: z.number().int().positive(), title: z.string(), body: z.string().nullish(), user: GhUser,
  html_url: z.string(), created_at: z.string(), updated_at: z.string(), state: z.enum(['open', 'closed']),
  pull_request: z.unknown().optional(), merged: z.boolean().optional(), merged_at: z.string().nullish(), closed_at: z.string().nullish(),
  head: z.object({ ref: z.string(), sha: z.string().optional(), repo: z.object({ full_name: z.string() }).nullish() }).optional() })
const GlTopic = z.object({ iid: z.number().int().positive(), title: z.string(), description: z.string().nullish(), author: GlUser,
  web_url: z.string(), created_at: z.string(), updated_at: z.string(), state: z.enum(['opened', 'closed', 'merged', 'locked']),
  source_branch: z.string().optional(), source_project_id: z.number().nullable().optional(), target_project_id: z.number().optional(),
  merged_at: z.string().nullish(), closed_at: z.string().nullish() })
const GhComment = z.object({ id: z.number(), body: z.string().nullish(), user: GhUser, created_at: z.string(), updated_at: z.string(), html_url: z.string() })
const GlComment = z.object({ id: z.number(), body: z.string(), author: GlUser, created_at: z.string(), updated_at: z.string(), system: z.boolean().default(false) })

/** Repository-scoped GitHub and GitLab API operations with validated responses and bounded pagination. */
export class ForgeApi {
  constructor(readonly commands: Commands, readonly repository: ResolvedRepository) {}
  get gitlab(): boolean { return this.repository.provider === 'gitlab' }
  get project(): string { return new URL(this.repository.url).pathname.slice(1) }
  async request(path: string, flags: string[] = []): Promise<unknown> {
    if (/^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)) throw new Error('Repository API path must be relative')
    const base = this.gitlab ? `projects/${encodeURIComponent(this.project)}` : `repos/${this.project}`
    const args = ['api', ...(this.gitlab ? ['--hostname', new URL(this.repository.url).host] : []), path ? `${base}/${path}` : base, ...flags]
    return JSON.parse(await this.commands.run(this.repository.cli, args)) as unknown
  }
  async pages(path: string): Promise<unknown[]> {
    const result: unknown[] = []
    for (let page = 1; page <= 1000; page++) {
      const batch = z.array(z.unknown()).parse(await this.request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`))
      result.push(...batch)
      if (batch.length < 100) return result
    }
    throw new Error('Repository pagination exceeded 1000 pages; cursor was not advanced')
  }
  topicPath(kind: TopicKind, number?: number): string {
    return `${kind === 'issue' ? 'issues' : this.gitlab ? 'merge_requests' : 'pulls'}${number ? `/${number}` : ''}`
  }
  topic(value: unknown, kind: TopicKind): ForgeTopic {
    if (this.gitlab) {
      const topic = GlTopic.parse(value)
      return { number: topic.iid, kind, title: topic.title, text: topic.description ?? '', author: topic.author.username,
        bot: topic.author.bot ?? false, url: topic.web_url, created: topic.created_at, updated: topic.updated_at,
        state: topic.state === 'opened' ? 'open' : topic.state === 'merged' ? 'merged' : 'closed',
        ...(topic.source_branch ? { branch: topic.source_branch, sameProject: topic.source_project_id === topic.target_project_id } : {}),
        ...(topic.merged_at ?? topic.closed_at ? { closedAt: (topic.merged_at ?? topic.closed_at)! } : {}) }
    }
    const topic = GhTopic.parse(value)
    return { number: topic.number, kind: topic.head || topic.pull_request ? 'pull' : kind, title: topic.title, text: topic.body ?? '',
      author: topic.user?.login ?? 'ghost', bot: topic.user?.type === 'Bot', url: topic.html_url,
      created: topic.created_at, updated: topic.updated_at, state: topic.merged || topic.merged_at ? 'merged' : topic.state,
      ...(topic.head ? { branch: topic.head.ref, sameProject: topic.head.repo?.full_name.toLowerCase() === this.project.toLowerCase(), ...(topic.head.sha ? { sha: topic.head.sha } : {}) } : {}),
      ...(topic.merged_at ?? topic.closed_at ? { closedAt: (topic.merged_at ?? topic.closed_at)! } : {}) }
  }
  async read(kind: TopicKind, number: number): Promise<ForgeTopic> { return this.topic(await this.request(this.topicPath(kind, number)), kind) }
  async updated(since: string): Promise<ForgeTopic[]> {
    const date = encodeURIComponent(since)
    if (!this.gitlab) return (await this.pages(`issues?state=all&sort=updated&direction=asc&since=${date}`)).map(item => this.topic(item, 'issue'))
    const result: ForgeTopic[] = []
    for (const kind of ['issue', 'pull'] as const) {
      const path = `${this.topicPath(kind)}?scope=all&state=all&order_by=updated_at&sort=asc&updated_after=${date}`
      result.push(...(await this.pages(path)).map(item => this.topic(item, kind)))
    }
    return result
  }
  commentsPath(kind: TopicKind, number: number): string {
    return this.gitlab ? `${this.topicPath(kind, number)}/notes` : `issues/${number}/comments`
  }
  comment(value: unknown, topic: Pick<ForgeTopic, 'url'>): ForgeComment {
    if (this.gitlab) {
      const note = GlComment.parse(value)
      return { id: note.id, text: note.body, author: note.author.username, bot: note.author.bot ?? false, created: note.created_at,
        updated: note.updated_at, url: `${topic.url}#note_${note.id}`, system: note.system }
    }
    const note = GhComment.parse(value)
    return { id: note.id, text: note.body ?? '', author: note.user?.login ?? 'ghost', bot: note.user?.type === 'Bot',
      created: note.created_at, updated: note.updated_at, url: note.html_url, system: false }
  }
  async comments(topic: ForgeTopic): Promise<ForgeComment[]> {
    const notes = await this.pages(this.commentsPath(topic.kind, topic.number))
    if (!this.gitlab && topic.kind === 'pull') notes.push(...await this.pages(`pulls/${topic.number}/comments`))
    return notes.map(note => this.comment(note, topic))
  }
  async send(kind: TopicKind, number: number, id: string, text: string): Promise<void> {
    const marker = `<!-- dsh-superagent:${key(id)} -->`
    const topic = await this.read(kind, number)
    const comments = await this.comments(topic)
    if (comments.some(comment => comment.author === this.repository.login && comment.text.includes(marker))) return
    await this.request(this.commentsPath(kind, number), ['--method', 'POST', '-f', `body=${text}\n\n${marker}`])
  }
  async commentPage(topic: ForgeTopic, page: number): Promise<ForgeComment[]> {
    const path = `${this.commentsPath(topic.kind, topic.number)}?per_page=50&page=${page}${this.gitlab ? '&sort=asc&order_by=created_at' : ''}`
    return z.array(z.unknown()).parse(await this.request(path)).map(note => this.comment(note, topic))
  }
  async ci(): Promise<{ id: string; state: string; url: string } | undefined> {
    const branch = encodeURIComponent(this.repository.defaultBranch)
    if (this.gitlab) {
      const items = z.array(z.object({ id: z.number(), status: z.string(), web_url: z.string() }))
        .parse(await this.request(`pipelines?ref=${branch}&per_page=1&order_by=id&sort=desc`))
      const latest = items[0]
      return latest ? { id: String(latest.id), state: latest.status, url: latest.web_url } : undefined
    }
    const result = z.object({ workflow_runs: z.array(z.object({ id: z.number(), status: z.string(), conclusion: z.string().nullable(), html_url: z.string() })) })
      .parse(await this.request(`actions/runs?branch=${branch}&per_page=1`))
    const latest = result.workflow_runs[0]
    return latest ? { id: String(latest.id), state: latest.conclusion ?? latest.status, url: latest.html_url } : undefined
  }
  async pullCi(topic: ForgeTopic): Promise<{ id: string; state: string; url: string } | undefined> {
    if (this.gitlab) {
      const pipelines = z.array(z.object({ id: z.number(), status: z.string(), web_url: z.string() }))
        .parse(await this.request(`merge_requests/${topic.number}/pipelines?per_page=100`))
      const latest = pipelines.sort((left, right) => right.id - left.id)[0]
      return latest ? { id: String(latest.id), state: latest.status, url: latest.web_url } : undefined
    }
    if (!topic.sha) return undefined
    const sha = encodeURIComponent(topic.sha)
    const status = z.object({ state: z.string(), total_count: z.number() }).parse(await this.request(`commits/${sha}/status`))
    const checks: { status: string; conclusion: string | null }[] = []
    for (let page = 1; page <= 1000; page++) {
      const result = z.object({ total_count: z.number(), check_runs: z.array(z.object({ status: z.string(), conclusion: z.string().nullable() })) })
        .parse(await this.request(`commits/${sha}/check-runs?per_page=100&page=${page}`))
      checks.push(...result.check_runs)
      if (checks.length >= result.total_count) break
      if (page === 1000 || !result.check_runs.length) throw new Error('Incomplete PR check pagination')
    }
    if (!checks.length && !status.total_count) return undefined
    const failed = (status.total_count && ['failure', 'error'].includes(status.state))
      || checks.some(check => ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'].includes(check.conclusion ?? ''))
    const pending = status.total_count && status.state === 'pending' || checks.some(check => check.status !== 'completed')
    return { id: topic.sha, state: failed ? 'failure' : pending ? 'pending' : 'success', url: topic.url }
  }
}
