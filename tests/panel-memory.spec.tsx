// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { usePanel, at, mount, click, type, field, text } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'
usePanel()
const start = () => at({ page: 'settings', query: { group: 'memory' } })
it('configures Hindsight without exposing its key in drafts and retains the key on a blank save', async () => {
  start(); await mount()
  expect(field<HTMLInputElement>('Hindsight API 密钥').type).toBe('password')
  await type(field('Hindsight API 密钥'), 'private-hindsight-key'); await click('启用共享记忆'); await click('保存')
  expect(server.memory.config.enabled).toBe(true); expect(server.memory.config.configured).toBe(true)
  expect(field<HTMLInputElement>('Hindsight API 密钥').value).toBe('')
  expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain('private-hindsight-key')
  await click('保存'); expect(server.memory.config.configured).toBe(true)
})
it('delegates memory management to the saved Hindsight console URL and removes the custom screening and review UI', async () => {
  start(); await mount()
  const link = document.querySelector<HTMLAnchorElement>('a[href="http://127.0.0.1:9999"]')!
  expect(link.textContent).toContain('打开 Hindsight 管理'); expect(link.target).toBe('_blank'); expect(link.rel).toContain('noopener')
  expect(text()).not.toContain('TypeSafe API 密钥'); expect(text()).not.toContain('自动保存阈值')
  expect(text()).not.toContain('确认生效'); expect(text()).not.toContain('记忆来源记录')
  await type(field('Hindsight 管理页面'), 'https://memory.example/console')
  expect(link.href).toBe('http://127.0.0.1:9999/')
  await click('保存')
  expect(document.querySelector<HTMLAnchorElement>('a[href="https://memory.example/console"]')).not.toBeNull()
})
it('keeps the draft when another session changes settings and can explicitly reload the saved connection', async () => {
  start(); await mount(); await type(field('Hindsight 服务地址'), 'https://draft.example')
  server.memory.config = { ...server.memory.config, revision: 1, hindsightUrl: 'https://saved.example' }
  await click('保存'); expect(text()).toContain('记忆设置已变化')
  expect(field<HTMLInputElement>('Hindsight 服务地址').value).toBe('https://draft.example')
  await click('重新载入设置'); expect(field<HTMLInputElement>('Hindsight 服务地址').value).toBe('https://saved.example')
})
