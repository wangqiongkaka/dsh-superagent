import { lstat, mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { lock } from 'proper-lockfile'
import type { Execution } from '../core/index.ts'
import { availableRepositories, primaryRepository, type Repository } from '../repositories.ts'
import type { Settings } from '../policy.ts'
import type { Trigger } from '../core/index.ts'

type Checkout = NonNullable<Execution['repositories']>[number]
type GitRun = (argv: string[], cwd: string) => Promise<string>
const contains = (parent: string, child: string): boolean => {
  const path = relative(parent, child)
  return !path || path !== '..' && !path.startsWith('../') && !isAbsolute(path)
}
const remoteUrl = (value: string): string => value.trim().replace(/^git@([^:]+):/, 'https://$1/').replace(/^ssh:\/\/git@/, 'https://').replace(/\/$/, '').replace(/\.git$/, '')

/** Freezes workspace paths on acceptance; the configured primary is included even for a secondary-only task. */
export function worktreeExecution(execution: Execution, repositories: Repository[], settings: Settings, trigger: Trigger): Execution {
  const primary = primaryRepository(settings, trigger)
  if (!primary) return { ...execution, repositories }
  const main = availableRepositories(settings, trigger).find(repo => repo.id === primary)
  if (!main) throw new Error('主仓库必须是当前入口已绑定的可用仓库。')
  const selected = [main, ...repositories.filter(repo => repo.id !== primary)]
  const checkouts = selected.map(repo => {
    const base = repo.localPath || (repo.workspaceParent ? join(repo.workspaceParent, repo.id) : '')
    if (!base) throw new Error(`仓库 ${repo.id} 尚未配置已有本地仓库路径或工作区父目录。`)
    const root = repo.worktreeRoot || join(dirname(base), `${basename(base)}-worktrees`)
    return { id: repo.id, provider: repo.provider, url: repo.url, cli: repo.cli,
      worktree: { base, directory: join(root, execution.name), initialize: true } }
  })
  for (const checkout of checkouts) for (const other of checkouts) {
    if (contains(other.worktree.base, checkout.worktree.directory)
      || checkout !== other && (contains(other.worktree.directory, checkout.worktree.directory) || contains(checkout.worktree.directory, other.worktree.directory)))
      throw new Error('Worktree 目录不能位于基础仓库内，也不能与其他仓库的工单目录重叠。')
  }
  return { ...execution, directory: checkouts[0]!.worktree.directory, primaryRepository: primary, repositories: checkouts }
}

const exists = async (path: string): Promise<boolean> => !!await lstat(path).catch((error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return undefined
  throw error
})

/** Initializes only absent, explicitly opted-in base repositories; Git retains responsibility for interrupted clone cleanup. */
async function initializeRepository(repo: Checkout, run: GitRun, verify: (directory: string) => Promise<void>, create: boolean): Promise<void> {
  const { base, directory, initialize } = repo.worktree!
  const present = await exists(base)
  if (!initialize || !create) {
    if (present) return
    throw new Error(`本地仓库不存在：${base}；已有工单不会重建基础仓库。请恢复原目录，或为新工单配置工作区父目录。`)
  }
  if (!present && await exists(directory)) throw new Error(`工单 worktree 已存在但基础仓库丢失：${base}；请恢复原目录。`)
  if (!present && basename(base) !== repo.id) throw new Error('自动创建的工作区目录名必须是仓库标识；请调整本地路径，或清空它并填写工作区父目录。')
  await mkdir(dirname(base), { recursive: true })
  const parent = await realpath(dirname(base))
  const release = await lock(parent, { lockfilePath: join(parent, `.dsh-superagent-init-${repo.id}.lock`), stale: 120_000, update: 10_000,
    retries: { retries: 100, minTimeout: 100, maxTimeout: 500 } })
  try {
    if (await exists(base)) return
    await verify(parent)
    await run(['git', 'clone', '--', `${repo.url}.git`, base], parent)
  } finally { await release() }
}

/** Validates existing checkouts without resetting them; creates only absent worktrees, under a shared repository lock. */
export async function prepareWorktree(repo: Checkout, name: string, defaultBranch: string, run: GitRun, verify: (directory: string) => Promise<void>, create: boolean): Promise<void> {
  const { base, directory } = repo.worktree!
  await initializeRepository(repo, run, verify, create)
  const source = await realpath(base)
  const git = async (args: string[], cwd = source) => (await run(['git', ...args], cwd)).trim()
  const top = await realpath(await git(['rev-parse', '--show-toplevel']))
  const common = await realpath(await git(['rev-parse', '--path-format=absolute', '--git-common-dir']))
  const own = await realpath(await git(['rev-parse', '--path-format=absolute', '--git-dir']))
  if (source !== top || common !== own || basename(common) !== '.git') throw new Error(`仓库 ${repo.id} 的本地路径必须是普通主工作区根目录，不能是子目录、裸仓库或 worktree。`)
  if (remoteUrl(await git(['remote', 'get-url', 'origin'])) !== repo.url) throw new Error(`仓库 ${repo.id} 的 origin 与配置地址不一致。`)
  await verify(source)
  const release = await lock(common, { lockfilePath: join(common, 'dsh-superagent-worktree.lock'), stale: 120_000, update: 10_000,
    retries: { retries: 100, minTimeout: 100, maxTimeout: 500 } })
  try {
    const branch = `agent/${name}`
    const existing = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (existing) {
      if (!existing.isDirectory()) throw new Error(`Worktree 路径已被文件或符号链接占用：${directory}`)
      const target = await realpath(directory)
      if (target === source || contains(source, target)
        || await realpath(await git(['rev-parse', '--show-toplevel'], target)) !== target
        || await realpath(await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], target)) !== common
        || await realpath(await git(['rev-parse', '--path-format=absolute', '--git-dir'], target)) === common
        || await git(['symbolic-ref', '--quiet', 'HEAD'], target) !== `refs/heads/${branch}`)
        throw new Error(`Worktree ${directory} 不属于该工单；保留现场，请人工检查。`)
      await verify(target)
      return
    }
    if (!create) throw new Error(`工单 worktree 已丢失：${directory}；不会自动重建或丢弃原工作。`)
    await mkdir(dirname(directory), { recursive: true })
    const parent = await realpath(dirname(directory))
    if (contains(source, join(parent, basename(directory)))) throw new Error('Worktree 目录不能位于基础仓库内。')
    await git(['check-ref-format', `refs/heads/${defaultBranch}`])
    await git(['fetch', '--no-tags', '--', `${repo.url}.git`, `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`])
    await git(['worktree', 'add', '-b', branch, '--', directory, `refs/remotes/origin/${defaultBranch}`])
    await verify(directory)
  } finally { await release() }
}

/** Removes only a clean, published worktree owned by this ticket; never removes its branch. */
export async function removeWorktree(repo: Checkout, name: string, run: GitRun, assertIdle: () => void | Promise<void>): Promise<string> {
  const { base, directory } = repo.worktree!
  const git = async (args: string[], cwd = base) => (await run(['git', ...args], cwd)).trim()
  const common = await realpath(await git(['rev-parse', '--path-format=absolute', '--git-common-dir']))
  const release = await lock(common, { lockfilePath: join(common, 'dsh-superagent-worktree.lock'), stale: 120_000, update: 10_000,
    retries: 0 })
  try {
    await assertIdle()
    const entry = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!entry) {
      const source = await realpath(base)
      const target = join(await realpath(dirname(directory)), basename(directory))
      if (source === target || contains(source, target)
        || await realpath(await git(['rev-parse', '--show-toplevel'])) !== source
        || await realpath(await git(['rev-parse', '--path-format=absolute', '--git-dir'])) !== common
        || remoteUrl(await git(['remote', 'get-url', 'origin'])) !== repo.url)
        throw new Error('仓库归属不一致，工作区登记已保留。')
      await git(['show-ref', '--verify', `refs/heads/agent/${name}`])
      const registered = (await git(['worktree', 'list', '--porcelain', '-z'])).split('\0').includes(`worktree ${target}`)
      if (registered) throw new Error('目录已丢失但 Git 登记仍存在，请先修复该 worktree。')
      await assertIdle()
      return target
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('目录不是普通 worktree，已保留。')
    const source = await realpath(base), target = await realpath(directory)
    if (source === target || contains(source, target)
      || await realpath(await git(['rev-parse', '--show-toplevel'])) !== source
      || await realpath(await git(['rev-parse', '--path-format=absolute', '--git-dir'])) !== common
      || await realpath(await git(['rev-parse', '--show-toplevel'], target)) !== target
      || await realpath(await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], target)) !== common
      || await realpath(await git(['rev-parse', '--path-format=absolute', '--git-dir'], target)) === common
      || await git(['symbolic-ref', '--quiet', 'HEAD'], target) !== `refs/heads/agent/${name}`
      || remoteUrl(await git(['remote', 'get-url', 'origin'])) !== repo.url)
      throw new Error('仓库或分支不属于该工单，已保留。')
    if (await git(['status', '--porcelain', '--untracked-files=all', '--ignored'], target))
      throw new Error('存在修改、未跟踪或忽略的文件，已保留。请先保存或自行清理。')
    const head = await git(['rev-parse', 'HEAD'], target)
    await git(['fetch', '--prune', '--no-tags', '--', `${repo.url}.git`, '+refs/heads/*:refs/remotes/origin/*'])
    if (!await git(['for-each-ref', '--format=%(refname)', '--contains', head, 'refs/remotes/origin/']))
      throw new Error('当前提交尚未包含在远端分支中，已保留。')
    await assertIdle()
    if (await git(['rev-parse', 'HEAD'], target) !== head
      || await git(['status', '--porcelain', '--untracked-files=all', '--ignored'], target))
      throw new Error('检查期间目录发生变化，已保留。')
    await git(['worktree', 'remove', '--', directory])
    return target
  } finally { await release() }
}
