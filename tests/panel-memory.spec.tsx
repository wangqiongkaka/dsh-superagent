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
