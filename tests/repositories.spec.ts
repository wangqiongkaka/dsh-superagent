import { describe, expect, it, vi } from 'vitest'
import { RepositorySchema, RepositoryListSchema, availableRepositories, selectRepositories, validateRepositoryBindings } from '../src/repositories.ts'
import { SettingsSchema } from '../src/policy.ts'
import { feishu, startRuntime } from './fixtures/host.ts'
import { forgeThread, gitKind } from '../src/sources/git.ts'
import { ForgeApi, type ForgeTopic } from '../src/sources/forge-api.ts'
import { ticketEnvironment } from '../src/app/execution-environment.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { testDeployment } from './fixtures/deployment.ts'
import type { Ticket } from '../src/core/index.ts'

const first = { id: 'frontend', provider: 'github' as const, url: 'https://github.com/acme/frontend', cli: '/bin/false' }
const second = { id: 'backend', provider: 'gitlab' as const, url: 'https://gitlab.local/team/subgroup/backend', cli: '/bin/false' }
const settings = () => SettingsSchema.parse({ sources: {
  git: { enabled: true, config: { repositories: [first, second] } },
  feishu: { enabled: true, config: { chats: [{ chatId: 'oc_team', listen: 'all', repositories: 'frontend,backend' }], directRepositories: 'backend' } },
} })

describe('repository bindings', () => {
  it('refuses unbound runtime requests without creating a worker and allows a configuration reply', async () => {
    const host = await startRuntime()
    try {
      const settings = host.runtime.store.settings()
      settings.sources.feishu!.config.chats = [{ chatId: 'oc_team', listen: 'all' }]
      host.runtime.store.saveSettings(settings)
      const trigger = feishu('10', '修复登录')
      host.runtime.receive(trigger)
      await host.runtime.idle()
      await expect(host.route({ kind: 'accept', trigger_id: trigger.id, title: 'Fix login', worktree_name: 'fix-login', acknowledgement: '修复登录' })).rejects.toThrow('尚未绑定')
      expect(host.runtime.store.tickets.list()).toHaveLength(0)
      expect(await host.runTool(host.runtime.masterId, 'orchestrator_reply', { purpose: 'answer', trigger_id: trigger.id, text: '请先配置这个群的可用仓库。' })).toMatchObject({ status: 'sent' })
    } finally { await host.stop() }
  })
  it('binds multiple PRs/MRs atomically and finishes only after both close', async () => {
    const host = await startRuntime()
    try {
      host.runtime.sources.register(gitKind)
      const { ticket, sessionId } = await host.acceptedTicket(feishu('1', 'fix both services'))
      const first = host.runtime.deployment.repositories![0]!
      const backend = { ...second, login: 'bot', email: 'bot@example.com', defaultBranch: 'main' }
      host.runtime.deployment.repositories!.push(backend)
      host.runtime.store.tickets.save({ ...ticket, execution: { ...ticket.execution!, repositories: [...ticket.execution!.repositories!, second] } })
      const pull = (author: string): ForgeTopic => ({ kind: 'pull', number: 1, title: 'Fix', text: '', author, bot: false,
        url: 'https://example.com/pull/1', created: ticket.createdAt, updated: ticket.createdAt, state: 'open', branch: `agent/${ticket.execution!.name}`, sameProject: true })
      const read = vi.spyOn(ForgeApi.prototype, 'read').mockResolvedValueOnce(pull(first.login)).mockResolvedValueOnce(pull('someone-else'))
      const args = { state: 'progress', summary: 'Two changes', pull_requests: [{ repository_id: first.id, number: 1 }, { repository_id: second.id, number: 1 }] }
      await expect(host.runTool(sessionId, 'orchestrator_report', args)).rejects.toThrow('agent-authored')
      expect(host.runtime.store.tickets.get(ticket.id)!.follows).toBeUndefined()
      read.mockResolvedValueOnce(pull(first.login)).mockResolvedValueOnce(pull(backend.login))
      await host.runTool(sessionId, 'orchestrator_report', args)
      expect(host.runtime.store.tickets.get(ticket.id)!.follows).toHaveLength(2)
      await host.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Both changes ready' })
      const source = host.runtime.context(gitKind)
      const closedAt = new Date(Date.now() + 1000).toISOString()
      source.tickets.threadClosed({ source: 'git', id: forgeThread(first, 'pull', 1) }, 'merged', closedAt)
      expect(host.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
      source.tickets.threadClosed({ source: 'git', id: forgeThread(backend, 'pull', 1) }, 'merged', closedAt)
      expect(host.runtime.store.tickets.get(ticket.id)!.ended?.outcome).toBe('merged')
    } finally { await host.stop() }
  })
  it('normalizes clone URLs and rejects embedded credentials and invalid projects', () => {
    expect(RepositorySchema.parse({ ...second, url: `${second.url}.git/` }).url).toBe(second.url)
    for (const url of ['https://token@gitlab.local/team/repo', 'https://gitlab.local/team/repo?token=x', 'file:///tmp/repo', 'https://github.com/acme/repo#main', 'https://gitlab.local/team/nested/../repo', 'https://gitlab.local/team\\repo'])
      expect(RepositorySchema.safeParse({ ...first, url }).success).toBe(false)
    expect(RepositoryListSchema.safeParse([first, { ...second, id: first.id }]).success).toBe(false)
  })
  it('keeps group and direct bindings independent and never falls back', () => {
    const config = settings()
    expect(availableRepositories(config, feishu('1', 'work')).map(repo => repo.id)).toEqual(['frontend', 'backend'])
    expect(availableRepositories(config, feishu('2', 'work', { chat_type: 'p2p' })).map(repo => repo.id)).toEqual(['backend'])
    expect(() => selectRepositories(config, feishu('3', 'work', { chat_id: 'oc_other' }), ['frontend'])).toThrow('尚未绑定')
    config.sources.git!.enabled = false
    expect(() => selectRepositories(config, feishu('4', 'work'), ['frontend'])).toThrow('尚未绑定')
  })
  it('requires selection for multiple targets and rejects unauthorized or duplicate IDs', () => {
    const config = settings(), trigger = feishu('1', 'work')
    expect(() => selectRepositories(config, trigger)).toThrow('ambiguous')
    expect(() => selectRepositories(config, trigger, ['elsewhere'])).toThrow('not authorized')
    expect(() => selectRepositories(config, trigger, ['frontend', 'frontend'])).toThrow('duplicates')
    expect(selectRepositories(config, trigger, ['backend', 'frontend'])).toEqual([second, first])
    expect(selectRepositories(config, feishu('2', 'work', { chat_type: 'p2p' }))).toEqual([second])
  })
  it('rejects dangling bindings and duplicate legacy listeners', () => {
    const config = settings()
    validateRepositoryBindings(config)
    config.sources.git!.config.repositories = [first]
    expect(() => validateRepositoryBindings(config)).toThrow('backend')
    config.sources.git!.config.repositories = [first, second]
    config.sources.github = { enabled: true, config: { repository: 'acme/frontend' } }
    expect(() => validateRepositoryBindings(config)).toThrow('重复派工')
  })
  it('qualifies topic identity by repository URL and distinguishes GitLab Issue and MR numbers', () => {
    const keys = [forgeThread(first, 'issue', 1), forgeThread(second, 'issue', 1), forgeThread(second, 'pull', 1),
      forgeThread({ ...second, url: 'https://other.local/team/subgroup/backend' }, 'pull', 1)]
    expect(new Set(keys).size).toBe(4)
    expect(gitKind.find!(`${second.url}/-/merge_requests/1#note_9`, gitKind.schema.parse({ repositories: [second] })).threads).toEqual([`git:${forgeThread(second, 'pull', 1)}`])
    expect(gitKind.scope!({ meta: { repositoryId: second.id, repositoryUrl: 'https://other.local/team/repo', kind: 'issue' } }, gitKind.schema.parse({ repositories: [second] })).listened).toBe(false)
  })
  it('exposes selected repositories only and refuses to resume a remapped repository', () => {
    const config = settings()
    const sources = new SourceRegistry(() => config)
    const resolved = { ...second, login: 'bot', email: 'bot@example.com', defaultBranch: 'main' }
    const deployment = testDeployment({ repositories: [resolved] })
    const ticket = { id: 'ticket', execution: { name: 'fix', directory: '/tmp/work/fix', assignment: '', repositories: [second] } } as Ticket
    const variables = ticketEnvironment({ deployment, sources, settings: config, ticket })
    expect(JSON.parse(variables.find(item => item.key === 'DSH_SUPERAGENT_REPOSITORIES')!.value)).toEqual([{ ...resolved, directory: '/tmp/work/fix/backend' }])
    deployment.repositories = [{ ...resolved, url: 'https://other.local/team/backend' }]
    expect(() => ticketEnvironment({ deployment, sources, settings: config, ticket })).toThrow('changed or was disabled')
  })
})
