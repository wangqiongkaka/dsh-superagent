import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { RepositorySchema, RepositoryListSchema, availableRepositories, selectRepositories, validateRepositoryBindings } from '../src/repositories.ts'
import { SettingsSchema } from '../src/policy.ts'
import { feishu, startRuntime } from './fixtures/host.ts'
import { forgeThread, gitKind } from '../src/sources/git.ts'
import { ForgeApi, type ForgeTopic } from '../src/sources/forge-api.ts'
import { ticketEnvironment } from '../src/app/execution-environment.ts'
import { workerGitConfig } from '../src/infra/environment.ts'
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
      await host.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Both changes ready', public_reply: 'Both changes ready' })
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
    expect(() => validateRepositoryBindings(config)).toThrow('飞书群「oc_team」绑定的仓库标识 backend 不存在')
    // Report missing repository before worktree path checks even when a primaryRepository is configured.
    config.sources.feishu!.config.chats = [{ chatId: 'oc_team', listen: 'all', repositories: 'frontend', primaryRepository: 'frontend' }]
    config.sources.feishu!.config.directRepositories = 'frontend,backend'
    config.sources.feishu!.config.directPrimaryRepository = 'backend'
    expect(() => validateRepositoryBindings(config)).toThrow('飞书私聊绑定的仓库标识 backend 不存在')
    config.sources.git!.config.repositories = [{ ...first, localPath: '/tmp/frontend' }, { ...second, localPath: '/tmp/backend' }]
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
  it('hot-reloads added and edited Git repositories without restarting, reuses verified entries, and keeps panel-only guard', async () => {
    const host = await startRuntime()
    try {
      host.runtime.sources.register(gitKind)
      const saveGit = (repositories: Record<string, unknown>[], enabled = true, origin: 'panel' | 'tool' = 'panel') =>
        host.runtime.settings.save('source:git', { enabled, config: { ...host.runtime.store.settings().sources.git!.config, repositories } },
          host.runtime.store.blockRevision('source:git'), origin)
      const existing = { id: 'service', provider: 'github', url: 'https://github.com/acme/service', cli: host.AGENT }
      const added = { id: 'packages', provider: 'github', url: 'https://github.com/acme/packages', cli: host.AGENT }
      // Non-panel callers remain blocked from changing Git repositories or toggling the Git source.
      await expect(saveGit([existing, added], true, 'tool')).rejects.toThrow('can only be changed in the management panel')
      // Invalid access fails before saving and leaves live repositories and worker-gitconfig unchanged.
      host.answers[`${host.AGENT} api repos/acme/packages --jq {name: .full_name, push: .permissions.push}`] = '{"name":"acme/packages","push":false}\n'
      await expect(saveGit([existing, added])).rejects.toMatchObject({ code: 'repositoryReadOnly' })
      expect(host.runtime.deployment.repositories?.map(repo => repo.id)).toEqual(['service'])
      expect(readFileSync(workerGitConfig(host.directory), 'utf8')).not.toContain('https://github.com/acme/packages')
      // Valid addition probes only the new repository and updates deployment and worker-gitconfig without restarting.
      host.answers[`${host.AGENT} api repos/acme/packages --jq {name: .full_name, push: .permissions.push}`] = '{"name":"acme/packages","push":true}\n'
      host.answers[`${host.AGENT} api repos/acme/packages`] = '{"default_branch":"main"}'
      host.subprocess.spawn.mockClear()
      expect(await saveGit([existing, added])).toMatchObject({ saved: true, restarting: false })
      expect(host.restarts).not.toHaveBeenCalled()
      expect(host.runtime.deployment.repositories?.map(repo => ({ id: repo.id, defaultBranch: repo.defaultBranch })))
        .toEqual([{ id: 'service', defaultBranch: 'main' }, { id: 'packages', defaultBranch: 'main' }])
      expect(readFileSync(workerGitConfig(host.directory), 'utf8')).toContain('[credential "https://github.com/acme/packages"]')
      const probed = host.subprocess.spawn.mock.calls.map(([spec]) => (spec as { argv: string[] }).argv.join(' '))
      expect(probed.some(cmd => cmd.includes('repos/acme/packages'))).toBe(true)
      expect(probed.some(cmd => cmd.includes('repos/acme/service'))).toBe(false)
      // Editing only localPath reuses verified repository metadata with zero subprocess probes and no restart.
      host.subprocess.spawn.mockClear()
      expect(await saveGit([existing, { ...added, localPath: '/tmp/packages' }])).toMatchObject({ saved: true, restarting: false })
      expect(host.subprocess.spawn).not.toHaveBeenCalled()
      expect(host.runtime.deployment.repositories?.find(repo => repo.id === 'packages')?.localPath).toBe('/tmp/packages')
      expect(host.restarts).not.toHaveBeenCalled()
    } finally { await host.stop() }
  })
  it('still restarts when disabling the Git source leaves a git-only installation with no configured repository', async () => {
    const host = await startRuntime(store => {
      const current = store.settings()
      store.saveSettings({ ...current, sources: { ...current.sources, github: { enabled: false, config: {} } } })
    })
    try {
      host.runtime.sources.register(gitKind)
      const saveGit = (enabled: boolean) => host.runtime.settings.save('source:git',
        { enabled, config: host.runtime.store.settings().sources.git!.config }, host.runtime.store.blockRevision('source:git'), 'panel')
      expect(await saveGit(false)).toMatchObject({ saved: true, restarting: true })
      await vi.waitFor(() => expect(host.restarts).toHaveBeenCalledTimes(1))
    } finally { await host.stop() }
  })
})
