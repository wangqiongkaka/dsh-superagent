import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prepareWorktree, worktreeExecution } from '../src/executor/worktrees.ts'
import { RepositorySchema, validateRepositoryBindings } from '../src/repositories.ts'
import { SettingsSchema } from '../src/policy.ts'
import { feishu } from './fixtures/host.ts'
import { gitEnv } from './fixtures/git.ts'

vi.setConfig({ testTimeout: 30_000 })
const exec = promisify(execFile)
let root: string, base: string, remote: string
const repo = { id: 'idcrm', provider: 'github' as const, url: 'https://github.com/acme/idcrm', cli: 'gh' }
const env = gitEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' })
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd, env })).stdout.trim()
const run = vi.fn(async (argv: string[], cwd: string) => {
  const args = argv.slice(1).map(arg => arg === `${repo.url}.git` ? remote : arg)
  return git(cwd, ...args)
})
const verify = vi.fn(async (_directory: string) => {})
const checkout = (name = 'task-one') => ({ ...repo, worktree: { base, directory: join(root, 'worktrees', name) } })
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'superagent-worktree-'))
  base = join(root, 'idcrm'); remote = join(root, 'remote.git')
  await git(root, 'init', '--bare', remote)
  await git(root, 'init', '-b', 'main', base)
  await writeFile(join(base, 'file.txt'), 'initial')
  await git(base, 'add', '.'); await git(base, 'commit', '-m', 'initial')
  await git(base, 'push', remote, 'main')
  await git(root, '--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  await git(base, 'remote', 'add', 'origin', repo.url)
  run.mockClear(); verify.mockClear()
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

it('creates isolated branches from the latest remote main, leaving the main checkout dirty and untouched', async () => {
  await writeFile(join(base, 'file.txt'), 'uncommitted local work')
  const first = checkout(), second = checkout('task-two')
  await Promise.all([prepareWorktree(first, 'task-one', 'main', run, verify, true), prepareWorktree(second, 'task-two', 'main', run, verify, true)])
  expect(await readFile(join(first.worktree.directory, 'file.txt'), 'utf8')).toBe('initial')
  expect(await git(first.worktree.directory, 'branch', '--show-current')).toBe('agent/task-one')
  expect(await git(second.worktree.directory, 'branch', '--show-current')).toBe('agent/task-two')
  expect(await git(base, 'branch', '--show-current')).toBe('main')
  expect(await readFile(join(base, 'file.txt'), 'utf8')).toBe('uncommitted local work')
  expect(await git(first.worktree.directory, 'rev-parse', '--path-format=absolute', '--git-common-dir')).toBe(await git(base, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
  expect(run.mock.calls.filter(([argv]) => argv[1] === 'clone')).toHaveLength(0)
})

it('clones an absent base once for concurrent tickets, named by repository ID, then reuses it', async () => {
  const parent = join(root, 'new-projects')
  const shared = join(parent, repo.id)
  const first = { ...checkout(), worktree: { base: shared, directory: join(parent, 'idcrm-worktrees', 'task-one'), initialize: true } }
  const second = { ...first, worktree: { ...first.worktree, directory: join(parent, 'idcrm-worktrees', 'task-two') } }
  const autoRun = vi.fn(async (argv: string[], cwd: string) => {
    const result = await run(argv, cwd)
    if (argv[1] === 'clone') await git(shared, 'remote', 'set-url', 'origin', repo.url)
    return result
  })
  await Promise.all([prepareWorktree(first, 'task-one', 'main', autoRun, verify, true), prepareWorktree(second, 'task-two', 'main', autoRun, verify, true)])
  expect(autoRun.mock.calls.filter(([argv]) => argv[1] === 'clone')).toHaveLength(1)
  expect(await readFile(join(shared, 'file.txt'), 'utf8')).toBe('initial')
  expect(await git(first.worktree.directory, 'branch', '--show-current')).toBe('agent/task-one')
  expect(await git(second.worktree.directory, 'branch', '--show-current')).toBe('agent/task-two')
  await prepareWorktree(first, 'task-one', 'main', autoRun, verify, false)
  expect(autoRun.mock.calls.filter(([argv]) => argv[1] === 'clone')).toHaveLength(1)
  await rm(shared, { recursive: true })
  await expect(prepareWorktree(first, 'task-one', 'main', autoRun, verify, false)).rejects.toThrow('不会重建')
  await expect(prepareWorktree(first, 'task-one', 'main', autoRun, verify, true)).rejects.toThrow('基础仓库丢失')
})

it('preserves an occupied base and safely retries an unsuccessful initial clone', async () => {
  const selected = { ...checkout(), worktree: { base: join(root, 'auto', repo.id), directory: join(root, 'auto-worktrees', 'task-one'), initialize: true } }
  const failed = async (argv: string[], cwd: string) => { if (argv[1] === 'clone') throw new Error('network unavailable'); return run(argv, cwd) }
  await expect(prepareWorktree(selected, 'task-one', 'main', failed, verify, true)).rejects.toThrow('network unavailable')
  const autoRun = async (argv: string[], cwd: string) => {
    const result = await run(argv, cwd)
    if (argv[1] === 'clone') await git(selected.worktree.base, 'remote', 'set-url', 'origin', repo.url)
    return result
  }
  await prepareWorktree(selected, 'task-one', 'main', autoRun, verify, true)
  const occupied = { ...selected, worktree: { ...selected.worktree, base: join(root, 'occupied', repo.id) } }
  await mkdir(occupied.worktree.base, { recursive: true })
  await writeFile(join(occupied.worktree.base, 'keep'), 'foreign data')
  await expect(prepareWorktree(occupied, 'task-one', 'main', autoRun, verify, true)).rejects.toThrow()
  expect(await readFile(join(occupied.worktree.base, 'keep'), 'utf8')).toBe('foreign data')
})

it('validates the parent credentials before cloning and refuses automatic directory names that differ from the ID', async () => {
  const selected = { ...checkout(), worktree: { base: join(root, 'auto', repo.id), directory: join(root, 'auto-worktrees', 'task-one'), initialize: true } }
  await expect(prepareWorktree(selected, 'task-one', 'main', run, async () => { throw new Error('unsafe parent credentials') }, true)).rejects.toThrow('unsafe parent credentials')
  expect(run.mock.calls.some(([argv]) => argv[1] === 'clone')).toBe(false)
  await expect(prepareWorktree({ ...selected, worktree: { ...selected.worktree, base: join(root, 'wrong-name') } }, 'task-one', 'main', run, verify, true)).rejects.toThrow('目录名必须是仓库标识')
})

it('resumes and retries an existing worktree without fetching or resetting dirty files', async () => {
  const selected = checkout()
  await prepareWorktree(selected, 'task-one', 'main', run, verify, true)
  await writeFile(join(selected.worktree.directory, 'file.txt'), 'work in progress')
  run.mockClear()
  await prepareWorktree(selected, 'task-one', 'main', run, verify, true)
  await prepareWorktree(selected, 'task-one', 'main', run, verify, false)
  expect(run.mock.calls.some(([argv]) => argv[1] === 'fetch')).toBe(false)
  expect(await readFile(join(selected.worktree.directory, 'file.txt'), 'utf8')).toBe('work in progress')
  await rm(selected.worktree.directory, { recursive: true })
  await expect(prepareWorktree(selected, 'task-one', 'main', run, verify, false)).rejects.toThrow('已丢失')
})

it('starts new worktrees from an updated remote branch rather than local main', async () => {
  const producer = join(root, 'producer')
  await git(root, 'clone', '-b', 'main', remote, producer)
  await writeFile(join(producer, 'file.txt'), 'remote update')
  await git(producer, 'commit', '-am', 'remote update')
  await git(producer, 'push', 'origin', 'main')
  await git(base, 'remote', 'set-url', 'origin', 'git@github.com:acme/idcrm.git')
  const selected = checkout()
  await prepareWorktree(selected, 'task-one', 'main', run, verify, true)
  expect(await readFile(join(selected.worktree.directory, 'file.txt'), 'utf8')).toBe('remote update')
  expect(await readFile(join(base, 'file.txt'), 'utf8')).toBe('initial')
})

it('refuses origin mismatches, missing bases and checkout subdirectories', async () => {
  const selected = checkout()
  await git(base, 'remote', 'set-url', 'origin', 'https://github.com/acme/other')
  await expect(prepareWorktree(selected, 'task-one', 'main', run, verify, true)).rejects.toThrow('origin')
  await git(base, 'remote', 'set-url', 'origin', repo.url)
  await mkdir(join(base, 'sub'))
  await expect(prepareWorktree({ ...selected, worktree: { ...selected.worktree, base: join(base, 'sub') } }, 'task-one', 'main', run, verify, true)).rejects.toThrow('主工作区根目录')
  await expect(prepareWorktree({ ...selected, worktree: { ...selected.worktree, base: join(root, 'missing') } }, 'task-one', 'main', run, verify, true)).rejects.toThrow()
  expect(run.mock.calls.some(([argv]) => argv[1] === 'fetch')).toBe(false)
})

it('preserves foreign directories, symlinks and existing branches instead of overwriting them', async () => {
  const selected = checkout()
  await mkdir(selected.worktree.directory, { recursive: true })
  await writeFile(join(selected.worktree.directory, 'keep'), 'keep')
  await expect(prepareWorktree(selected, 'task-one', 'main', run, verify, true)).rejects.toThrow()
  expect(await readFile(join(selected.worktree.directory, 'keep'), 'utf8')).toBe('keep')
  await rm(selected.worktree.directory, { recursive: true })
  await symlink(base, selected.worktree.directory)
  await expect(prepareWorktree(selected, 'task-one', 'main', run, verify, true)).rejects.toThrow('符号链接')
  await rm(selected.worktree.directory)
  await git(base, 'branch', 'agent/task-one')
  const head = await git(base, 'rev-parse', 'agent/task-one')
  await expect(prepareWorktree(selected, 'task-one', 'main', run, verify, true)).rejects.toThrow()
  expect(await git(base, 'rev-parse', 'agent/task-one')).toBe(head)
})

it('fails closed on fetch or credential validation failure and allows a safe later retry', async () => {
  const selected = checkout()
  await expect(prepareWorktree(selected, 'task-one', 'main', run, async () => { throw new Error('unsafe credentials') }, true)).rejects.toThrow('unsafe credentials')
  expect(run.mock.calls.some(([argv]) => argv[1] === 'fetch')).toBe(false)
  const failFetch = async (argv: string[], cwd: string) => { if (argv[1] === 'fetch') throw new Error('offline'); return run(argv, cwd) }
  await expect(prepareWorktree(selected, 'task-one', 'main', failFetch, verify, true)).rejects.toThrow('offline')
  await prepareWorktree(selected, 'task-one', 'main', run, verify, true)
  expect(await git(selected.worktree.directory, 'branch', '--show-current')).toBe('agent/task-one')
})

it('uses separate manual primary bindings for groups and direct messages, always including the primary', () => {
  const frontend = { ...repo, localPath: base }
  const backend = { ...repo, id: 'backend', url: 'https://github.com/acme/backend', localPath: join(root, 'backend') }
  const settings = SettingsSchema.parse({ sources: {
    git: { enabled: true, config: { repositories: [frontend, backend] } },
    feishu: { enabled: true, config: { chats: [{ chatId: 'oc_team', repositories: 'idcrm,backend', primaryRepository: 'idcrm' }], directRepositories: 'idcrm,backend', directPrimaryRepository: 'backend' } },
  } })
  validateRepositoryBindings(settings)
  const execution = { name: 'task-one', directory: '/legacy', assignment: '' }
  const group = worktreeExecution(execution, [backend], settings, feishu('1', 'backend only'))
  expect(group.primaryRepository).toBe('idcrm')
  expect(group.repositories?.map(item => item.id)).toEqual(['idcrm', 'backend'])
  expect(group.directory).toBe(join(root, 'idcrm-worktrees', 'task-one'))
  const direct = worktreeExecution(execution, [frontend], settings, feishu('2', 'frontend only', { chat_type: 'p2p' }))
  expect(direct.primaryRepository).toBe('backend')
  expect(direct.directory).toBe(join(root, 'backend-worktrees', 'task-one'))
  const automaticBackend = { ...backend, localPath: '', workspaceParent: join(root, 'auto') }
  settings.sources.git!.config.repositories = [frontend, automaticBackend]
  validateRepositoryBindings(settings)
  const automatic = worktreeExecution(execution, [automaticBackend], settings, feishu('5', 'backend'))
  expect(automatic.repositories?.[1]?.worktree).toEqual({ base: join(root, 'auto/backend'), directory: join(root, 'auto/backend-worktrees/task-one'), initialize: true })
  expect(worktreeExecution(execution, [frontend], settings, feishu('6', 'frontend only')).repositories?.map(item => item.id)).toEqual(['idcrm'])
  settings.sources.git!.config.repositories = [frontend, { ...backend, worktreeRoot: join(root, 'idcrm-worktrees') }]
  expect(() => worktreeExecution(execution, [{ ...backend, worktreeRoot: join(root, 'idcrm-worktrees') }], settings, feishu('4', 'both'))).toThrow('重叠')
  settings.sources.git!.config.repositories = [frontend, { ...backend, localPath: '' }]
  expect(() => validateRepositoryBindings(settings)).toThrow('本地仓库路径')
  settings.sources.git!.config.repositories = [frontend, backend]
  settings.sources.feishu!.config.directPrimaryRepository = 'unknown'
  expect(() => validateRepositoryBindings(settings)).toThrow('已绑定')
  expect(() => worktreeExecution(execution, [frontend], settings, feishu('3', 'work', { chat_type: 'p2p' }))).toThrow('已绑定')
})

it('rejects invalid paths and keeps unconfigured workspaces on the legacy clone layout', () => {
  expect(RepositorySchema.safeParse({ ...repo, localPath: './relative' }).success).toBe(false)
  expect(RepositorySchema.safeParse({ ...repo, worktreeRoot: '/tmp/\ninvalid' }).success).toBe(false)
  expect(RepositorySchema.safeParse({ ...repo, workspaceParent: '../relative' }).success).toBe(false)
  const execution = { name: 'task', directory: '/legacy', assignment: '' }
  expect(worktreeExecution(execution, [repo], SettingsSchema.parse({}), feishu('1', 'work'))).toEqual({ ...execution, repositories: [repo] })
})
