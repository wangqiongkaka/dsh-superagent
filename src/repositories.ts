import { z } from 'zod'
import { isAbsolute, normalize } from 'node:path'
import type { Trigger } from './core/index.ts'
import type { Settings } from './policy.ts'

export const RepositoryIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/)
const LocalPathSchema = z.string().trim().refine(value => !value || isAbsolute(value) && !/[\u0000-\u001f]/.test(value), '请输入本地绝对路径').transform(value => value ? normalize(value) : value).optional()
export const PrimaryRepositorySchema = z.union([RepositoryIdSchema, z.literal('')]).optional()
export const RepositorySchema = z.object({
  id: RepositoryIdSchema,
  provider: z.enum(['github', 'gitlab']),
  url: z.string().trim().transform(value => value.replace(/\/$/, '').replace(/\.git$/, '')),
  cli: z.string().trim().min(1),
  localPath: LocalPathSchema,
  workspaceParent: LocalPathSchema,
  worktreeRoot: LocalPathSchema,
}).strict().superRefine((value, ctx) => {
  let url: URL
  try { url = new URL(value.url) } catch { ctx.addIssue({ code: 'custom', path: ['url'], message: 'Use a full HTTPS repository URL' }); return }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || /[\u0000-\u0020\\]/.test(value.url) || value.url.split('/').some(part => part === '.' || part === '..')
    || !/^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(url.pathname)
    || url.pathname.split('/').some(part => part === '.' || part === '..')
    || value.provider === 'github' && (url.hostname !== 'github.com' || url.pathname.split('/').length !== 3)) {
    ctx.addIssue({ code: 'custom', path: ['url'], message: 'Use an HTTPS project URL without credentials, query or fragment; GitHub uses github.com/owner/name' })
  }
}).transform(value => ({ ...value, url: new URL(value.url).href.replace(/\/$/, '') }))
export type Repository = z.infer<typeof RepositorySchema>
export interface ResolvedRepository extends Repository { login: string; email: string; projectId?: number; defaultBranch: string }
export const RepositoryListSchema = z.array(RepositorySchema).max(50).default([]).superRefine((items, ctx) => {
  for (const field of ['id', 'url'] as const) {
    if (new Set(items.map(item => item[field].toLowerCase())).size !== items.length)
      ctx.addIssue({ code: 'custom', message: `Duplicate repository ${field}` })
  }
})
export const repositoryIds = (value: string): string[] => value.split(/[\s,，]+/).filter(Boolean)
export const RepositoryBindingsSchema = z.string().trim().default('').refine(value => {
  const ids = repositoryIds(value)
  return ids.every(id => RepositoryIdSchema.safeParse(id).success) && new Set(ids).size === ids.length
}, 'Use unique repository IDs separated by commas')

export function repositoryCatalog(settings: Settings): Repository[] {
  const source = settings.sources.git
  return source?.enabled ? RepositoryListSchema.parse(source.config.repositories ?? []) : []
}
export function availableRepositories(settings: Settings, trigger: Trigger): Repository[] {
  const catalog = repositoryCatalog(settings)
  if (trigger.source === 'git') return catalog.filter(repo => repo.id === trigger.meta.repositoryId && repo.url === trigger.meta.repositoryUrl)
  if (trigger.source !== 'feishu') return []
  const config = settings.sources.feishu?.config ?? {}
  const chats = (config.chats ?? []) as { chatId: string; repositories?: string }[]
  const binding = trigger.meta.direct === true ? config.directRepositories : chats.find(chat => chat.chatId === trigger.meta.chatId)?.repositories
  const ids = repositoryIds(typeof binding === 'string' ? binding : '')
  return catalog.filter(repo => ids.includes(repo.id))
}
export function selectRepositories(settings: Settings, trigger: Trigger, selected?: string[]): Repository[] | undefined {
  if (trigger.source !== 'feishu' && trigger.source !== 'git') {
    if (selected?.length) throw new Error('This legacy source does not accept repository selections')
    return undefined
  }
  const available = availableRepositories(settings, trigger)
  if (!available.length) throw new Error('此入口尚未绑定可用仓库，请先配置群或私聊的仓库列表，再发起工作。')
  if (!selected && available.length === 1) return available
  if (!selected?.length) throw new Error(`Select repositories from ${available.map(repo => repo.id).join(', ')}. If the request is ambiguous, ask the sender before accepting.`)
  if (new Set(selected).size !== selected.length || selected.some(id => !available.some(repo => repo.id === id)))
    throw new Error('Repository selection contains duplicates or repositories not authorized for this source')
  return selected.map(id => available.find(repo => repo.id === id)!)
}

export function validateRepositoryBindings(settings: Settings): void {
  const repositories = RepositoryListSchema.parse(settings.sources.git?.config.repositories ?? [])
  const config = settings.sources.feishu?.config ?? {}
  const chats = (config.chats ?? []) as { chatId: string; repositories?: string; primaryRepository?: string }[]
  for (const entry of [...chats, { repositories: String(config.directRepositories ?? ''), primaryRepository: String(config.directPrimaryRepository ?? '') }]) {
    if (!entry.primaryRepository) continue
    const ids = repositoryIds(entry.repositories ?? '')
    if (!ids.includes(entry.primaryRepository)) throw new Error('主仓库必须是该群或私聊已绑定的仓库。')
    for (const id of ids) {
      const repo = repositories.find(repo => repo.id === id)
      if (!repo?.localPath && !repo?.workspaceParent) throw new Error(`仓库 ${id} 需要配置已有本地仓库路径或工作区父目录才能使用 worktree。`)
    }
  }
  for (const binding of [...chats.map(chat => chat.repositories ?? ''), String(config.directRepositories ?? '')]) {
    for (const id of repositoryIds(binding)) if (!repositories.some(repo => repo.id === id)) throw new Error(`仓库标识 ${id} 不存在；请先在 Git 仓库中添加，或移除该绑定。`)
  }
  const legacy = settings.sources.github
  if (legacy?.enabled && settings.sources.git?.enabled && repositories.some(repo => repo.provider === 'github'
    && new URL(repo.url).pathname.slice(1).toLowerCase() === String(legacy.config.repository).toLowerCase()))
    throw new Error('同一 GitHub 仓库不能同时启用旧 GitHub 来源和多仓库来源，请先关闭旧来源，避免重复派工。')
}

export function primaryRepository(settings: Settings, trigger: Trigger): string | undefined {
  if (trigger.source === 'git') return availableRepositories(settings, trigger).find(repo => repo.localPath || repo.workspaceParent)?.id
  if (trigger.source !== 'feishu') return undefined
  const config = settings.sources.feishu?.config ?? {}
  const chats = (config.chats ?? []) as { chatId: string; primaryRepository?: string }[]
  const id = trigger.meta.direct === true ? config.directPrimaryRepository : chats.find(chat => chat.chatId === trigger.meta.chatId)?.primaryRepository
  return typeof id === 'string' && id ? id : undefined
}
