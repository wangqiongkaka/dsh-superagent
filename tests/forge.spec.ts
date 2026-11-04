import { afterEach, describe, expect, it, vi } from 'vitest'
import { ForgeApi } from '../src/sources/forge-api.ts'
import { GitConfigSchema, gitKind, pollRepository, repositoryKey } from '../src/sources/git.ts'
import { Commands } from '../src/infra/commands.ts'
import type { ResolvedRepository } from '../src/repositories.ts'
import { testDeployment, testMachine } from './fixtures/deployment.ts'
import { resolveRepositories } from '../src/deployment.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { key, type Trigger } from '../src/core/index.ts'

afterEach(() => vi.restoreAllMocks())
const repo: ResolvedRepository = { id: 'backend', provider: 'gitlab', url: 'https://gitlab.local/team/sub/backend', cli: process.execPath, login: 'agent', email: 'agent@example.com', projectId: 9, defaultBranch: 'main' }
const topic = (extra: Record<string, unknown> = {}) => ({ iid: 1, title: 'Fix login', description: '@agent fix it', author: { username: 'alice' }, web_url: `${repo.url}/-/issues/1`,
  created_at: '2026-11-04T01:00:01Z', updated_at: '2026-11-04T01:00:01Z', state: 'opened', ...extra })
const note = (extra: Record<string, unknown> = {}) => ({ id: 8, body: '@agent please fix', author: { username: 'alice' }, created_at: '2026-11-04T01:00:02Z', updated_at: '2026-11-04T01:00:02Z', system: false, ...extra })
function fixture() {
  const deployment = testDeployment({ repositories: [repo] })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const run = vi.spyOn(commands, 'run').mockImplementation(async (_program, args) => {
    const path = args[3]!
    if (path.includes('/issues?')) return JSON.stringify([topic()])
    if (path.includes('/merge_requests?')) return '[]'
    if (path.includes('/notes?')) return JSON.stringify([note(), note({ id: 9, author: { username: 'agent' } }), note({ id: 10, system: true })])
    if (path.endsWith('/issues/1')) return JSON.stringify(topic())
    throw new Error(`Unexpected API ${path}`)
  })
  const state = new Map<string, unknown>()
  const received: Trigger[] = []
  const config = GitConfigSchema.parse({ repositories: [repo].map(({ login: _login, email: _email, projectId: _projectId, defaultBranch: _defaultBranch, ...config }) => config), observeComments: true })
  const ctx = { deployment, commands, state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => state.set(key, value) },
    threads: { subscribed: () => [], get: () => undefined, describe: vi.fn(), patch: vi.fn() }, tickets: { open: () => [], threadClosed: vi.fn() },
    receive: async (trigger: Trigger) => { received.push(trigger) }, config: () => config,
  } as unknown as SourceContext
  return { api: new ForgeApi(commands, repo), ctx, run, state, received, config }
}
describe('GitLab source', () => {
  it('emits default branch failure and recovery, not every successful pipeline', async () => {
    const { ctx, run, config, state, received } = fixture()
    config.observeCi = true
    state.set(`git:cursor:${repositoryKey(repo)}`, { since: new Date().toISOString(), ci: '1:success' })
    let pipeline = { id: 2, status: 'success', web_url: `${repo.url}/-/pipelines/2` }
    run.mockImplementation(async (_program, args) => JSON.stringify(args[3]!.includes('/pipelines?') ? [pipeline] : []))
    await pollRepository(ctx, repo, config)
    expect(received).toHaveLength(0)
    pipeline = { ...pipeline, id: 3, status: 'failed' }
    await pollRepository(ctx, repo, config)
    expect(received).toHaveLength(1)
    pipeline = { ...pipeline, id: 4 }
    await pollRepository(ctx, repo, config)
    expect(received).toHaveLength(1)
    pipeline = { ...pipeline, id: 5, status: 'success' }
    await pollRepository(ctx, repo, config)
    expect(received).toHaveLength(2)
    expect(received.map(item => item.human)).toEqual([false, false])
  })
  it('uses an explicit host and URL-encodes nested projects without accepting traversal', async () => {
    const { api, run } = fixture()
    await api.read('issue', 1)
    expect(run).toHaveBeenCalledWith(process.execPath, ['api', '--hostname', 'gitlab.local', 'projects/team%2Fsub%2Fbackend/issues/1'])
    await expect(api.request('../user')).rejects.toThrow('relative')
  })
  it('starts from now, advances only after successful ingestion, and skips own/system notes', async () => {
    const { ctx, state, config, received, run } = fixture()
    await pollRepository(ctx, repo, config)
    expect(run).not.toHaveBeenCalled()
    state.set(`git:cursor:${repositoryKey(repo)}`, { since: '2026-11-04T01:00:00Z' })
    await pollRepository(ctx, repo, config)
    expect(received).toHaveLength(2)
    expect(received[0]).toMatchObject({ actor: { id: 'gitlab.local/alice' }, addressed: 'mention', meta: { repositoryId: 'backend', kind: 'issue' } })
    expect(received[1]).toMatchObject({ meta: { kind: 'comment', topicKind: 'issue', commentId: 8 } })
    const saved = state.get(`git:cursor:${repositoryKey(repo)}`)
    run.mockRejectedValueOnce(new Error('HTTP 503'))
    await expect(pollRepository(ctx, repo, config)).rejects.toThrow('503')
    expect(state.get(`git:cursor:${repositoryKey(repo)}`)).toBe(saved)
  })
  it('does not advance a cursor when trigger ingestion fails', async () => {
    const { ctx, state, config } = fixture()
    const saved = { since: '2026-11-04T01:00:00Z' }
    state.set(`git:cursor:${repositoryKey(repo)}`, saved)
    ctx.receive = async () => { throw new Error('database unavailable') }
    await expect(pollRepository(ctx, repo, config)).rejects.toThrow('database unavailable')
    expect(state.get(`git:cursor:${repositoryKey(repo)}`)).toBe(saved)
  })
  it('reads comment context with distinct root and note IDs', async () => {
    const { ctx, config, state, received } = fixture()
    state.set(`git:cursor:${repositoryKey(repo)}`, { since: '2026-11-04T01:00:00Z' })
    await pollRepository(ctx, repo, config)
    const result = await gitKind.threadContext!.read(ctx.commands, received[1]!, 'thread', undefined, config)
    expect(result.messages[0]!.id).toBe('root')
    expect(result.messages[1]!.id).toBe('note:8')
    expect(result.body.messages).toEqual(result.messages)
  })
  it('deduplicates replies by a marker authored by the configured account', async () => {
    const { api, run } = fixture()
    run.mockImplementation(async (_program, args) => args[3]!.endsWith('/issues/1') ? JSON.stringify(topic())
      : JSON.stringify([note({ author: { username: 'agent' }, body: `done\n<!-- dsh-superagent:${key('reply-1')} -->` })]))
    await api.send('issue', 1, 'reply-1', 'done')
    expect(run.mock.calls.every(([, args]) => !args.includes('POST'))).toBe(true)
    run.mockImplementation(async (_program, args) => args[3]!.endsWith('/issues/1') ? JSON.stringify(topic()) : args.includes('POST') ? '{}' : '[]')
    await api.send('issue', 1, 'reply-2', 'done')
    expect(run.mock.calls.at(-1)![1]).toContain(`body=done\n\n<!-- dsh-superagent:${key('reply-2')} -->`)
  })
  it('resolves GitLab credentials and project access without a GitHub configuration', async () => {
    const { login: _login, email: _email, projectId: _projectId, defaultBranch: _defaultBranch, ...entry } = repo
    const settings = SettingsSchema.parse({ sources: { git: { enabled: true, config: { repositories: [entry] } } } })
    const probe = vi.fn(async (argv: string[]) => argv.at(-1) === 'user' ? JSON.stringify({ username: 'agent', email: 'agent@example.com' })
      : JSON.stringify({ id: 9, default_branch: 'main', permissions: { project_access: { access_level: 30 }, group_access: null } }))
    expect(await resolveRepositories(testMachine(), settings, probe)).toEqual([repo])
    probe.mockResolvedValueOnce(JSON.stringify({ username: 'agent', email: 'agent@example.com' }))
      .mockResolvedValueOnce(JSON.stringify({ id: 9, default_branch: 'main', permissions: { project_access: { access_level: 20 }, group_access: null } }))
    await expect(resolveRepositories(testMachine(), settings, probe)).rejects.toThrow('Developer')
  })
})
