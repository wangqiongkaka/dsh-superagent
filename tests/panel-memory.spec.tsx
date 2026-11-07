// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { usePanel, at, mount, click, type, field, text, find, settle } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'
usePanel()
function start() {
  at({ page: 'settings', query: { group: 'memory' } })
  server.memory.scopes = [{ id: 'p', kind: 'project', label: 'app' }]
  server.memory.items = [{ id: 'm', revision: 2, text: '使用 SQLite', scope: server.memory.scopes[0]!, status: 'pending', reason: 'conflict',
    source: { resource: 'trigger/a', quote: '项目使用 SQLite', at: '' }, createdAt: '', updatedAt: '' }]
}
it('configures Jev without storing the credential in browser drafts, and retains it on a blank save', async () => {
  start(); await mount()
  expect(field<HTMLInputElement>('TypeSafe API 密钥').type).toBe('password')
  await type(field('TypeSafe API 密钥'), 'private-test-value'); await click('启用共享记忆'); await click('保存')
  expect(server.memory.config.enabled).toBe(true); expect(server.memory.config.configured).toBe(true)
  expect(field<HTMLInputElement>('TypeSafe API 密钥').value).toBe('')
  expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain('private-test-value')
  await click('保存'); expect(server.memory.config.configured).toBe(true)
})
it('reviews, edits, deactivates and reads history without deleting the audit trail', async () => {
  start(); await mount(); expect(text()).toContain('与已有记忆冲突')
  await click('确认生效'); expect(server.memory.items[0]!.status).toBe('active')
  await click('编辑'); await type(field('记忆正文'), 'SQLite 用于保存状态')
  const card = field('记忆正文').closest('article')!
  await click([...card.querySelectorAll('button')].find(button => button.textContent === '保存')!)
  expect(server.memory.items[0]!.text).toBe('SQLite 用于保存状态')
  await click('停用记忆'); expect(server.memory.items[0]!.status).toBe('deleted')
  await click('版本历史'); expect(text()).toContain('v2'); expect(text()).toContain('使用 SQLite')
  await type(field('记忆状态'), 'pending'); expect(text()).toContain('暂无记忆')
})
it('preserves the draft on a competing update and refuses to overwrite a newer version', async () => {
  start(); await mount(); await click('编辑'); await type(field('记忆正文'), '本地草稿')
  server.memory.items[0] = { ...server.memory.items[0]!, revision: 3, text: '另一会话修改' }
  await click('刷新列表'); expect(field<HTMLTextAreaElement>('记忆正文').value).toBe('本地草稿')
  const card = field('记忆正文').closest('article')!
  await click([...card.querySelectorAll('button')].find(button => button.textContent === '保存')!)
  expect(text()).toContain('记忆已被其他会话修改'); expect(server.memory.items[0]!.text).toBe('另一会话修改')
  expect(field<HTMLTextAreaElement>('记忆正文').value).toBe('本地草稿')
  await click('取消'); await click('编辑'); expect(field<HTMLTextAreaElement>('记忆正文').value).toBe('另一会话修改')
})
it('requires confirmation, allows cancellation, and removes the record and its history after deletion', async () => {
  start(); server.memoryHistory.m = [server.memory.items[0]!]; await mount()
  await click('永久删除')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('全部版本')
  expect(server.requests.some(request => request.method === 'DELETE')).toBe(false)
  await click('取消'); expect(server.memory.items).toHaveLength(1)
  await click('永久删除')
  await click(document.querySelector<HTMLElement>('[role="dialog"] .dt-btn-primary')!)
  expect(server.memory.items).toEqual([]); expect(server.memoryHistory.m).toBeUndefined()
  expect(text()).toContain('暂无记忆'); expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(server.requests.filter(request => request.method === 'DELETE')).toEqual([{ path: 'memory/m', method: 'DELETE', body: { revision: 2 } }])
})
it('keeps the confirmation snapshot and refuses to delete a record edited while the dialog is open', async () => {
  start(); await mount(); await click('永久删除')
  server.memory.items[0] = { ...server.memory.items[0]!, revision: 3, text: '其他会话的新内容' }
  await click('刷新列表')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('使用 SQLite')
  await click(document.querySelector<HTMLElement>('[role="dialog"] .dt-btn-primary')!)
  expect(text()).toContain('重新载入后再删除')
  expect(server.memory.items[0]!.text).toBe('其他会话的新内容')
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
})
it('returns to the previous page after removing the last record of a page', async () => {
  start()
  server.memory.items = Array.from({ length: 31 }, (_, index) => ({ ...server.memory.items[0]!, id: `m${index}` }))
  await mount(); await click('下一页')
  await click('永久删除'); await click(document.querySelector<HTMLElement>('[role="dialog"] .dt-btn-primary')!)
  expect(server.memory.items).toHaveLength(30)
  expect(document.querySelectorAll('article')).toHaveLength(30)
})
