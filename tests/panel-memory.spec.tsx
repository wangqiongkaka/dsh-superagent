// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { act } from 'react'
import { usePanel, at, mount, click, type, field, text } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'
usePanel()
const consolePath = '/orchestrator/hindsight/'
const start = () => at({ page: 'settings', query: { group: 'memory' } })
it('configures Hindsight without exposing its key in drafts and retains the key on a blank save', async () => {
  start(); await mount()
  expect(field<HTMLInputElement>('Hindsight API 密钥').type).toBe('password')
  await type(field('Hindsight API 密钥'), 'private-hindsight-key'); await click('启用共享记忆'); await click('保存')
  expect(server.memory.config.enabled).toBe(true); expect(server.memory.config.configured).toBe(true)
  expect(document.querySelector('details')!.open).toBe(true)
  expect(field<HTMLInputElement>('Hindsight API 密钥').value).toBe('')
  expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain('private-hindsight-key')
  await click('保存'); expect(server.memory.config.configured).toBe(true)
})
it('keeps the browser on the panel origin and applies a saved upstream change by remounting the console', async () => {
  start(); await mount()
  const link = document.querySelector<HTMLAnchorElement>('a[href="/orchestrator/hindsight/"]')!
  expect(link.textContent).toContain('在新窗口打开'); expect(link.target).toBe('_blank'); expect(link.rel).toContain('noopener')
  expect(document.querySelector('iframe')?.getAttribute('src')).toBe(consolePath)
  expect(text()).not.toContain('TypeSafe API 密钥'); expect(text()).not.toContain('自动保存阈值')
  expect(text()).not.toContain('确认生效'); expect(text()).not.toContain('记忆来源记录')
  const frame = document.querySelector('iframe')!
  await type(field('Hindsight 管理页面'), 'https://memory.example/orchestrator/hindsight')
  expect(link.getAttribute('href')).toBe(consolePath)
  expect(document.querySelector('iframe')).toBe(frame)
  expect(document.querySelector('iframe')?.getAttribute('src')).toBe(consolePath)
  await click('保存')
  expect(document.querySelector('iframe')).not.toBe(frame)
  expect(document.querySelector('iframe')?.getAttribute('src')).toBe(consolePath)
  expect(server.memory.config.consoleUrl).toBe('https://memory.example/orchestrator/hindsight')
})
it('keeps the draft when another session changes settings and can explicitly reload the saved connection', async () => {
  start(); await mount(); await type(field('Hindsight 服务地址'), 'https://draft.example')
  server.memory.config = { ...server.memory.config, revision: 1, hindsightUrl: 'https://saved.example' }
  await click('保存'); expect(text()).toContain('记忆设置已变化')
  expect(field<HTMLInputElement>('Hindsight 服务地址').value).toBe('https://draft.example')
  await click('重新载入设置'); expect(field<HTMLInputElement>('Hindsight 服务地址').value).toBe('https://saved.example')
})

it('embeds the native console with a separate login and collapses already configured connection settings', async () => {
  start(); server.memory.config.configured = true; await mount()
  expect(document.querySelector('details')!.open).toBe(false)
  const frame = document.querySelector('iframe')!
  expect(frame.title).toBe('Hindsight 原生管理控制台')
  expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
  expect(frame.getAttribute('sandbox')).toContain('allow-scripts'); expect(frame.getAttribute('sandbox')).toContain('allow-forms')
  expect(frame.getAttribute('sandbox')).not.toContain('allow-top-navigation')
  expect(frame.src).not.toContain('key=')
  await act(async () => frame.dispatchEvent(new Event('load')))
  expect(document.querySelector('[role="status"]')).toBeNull()
})
it('reloads only the console and keeps it mounted when merely reloading connection settings', async () => {
  start(); await mount()
  const frame = document.querySelector('iframe')!
  await click('重新载入设置'); expect(document.querySelector('iframe')).toBe(frame)
  await click('重新加载')
  expect(document.querySelector('iframe')).not.toBe(frame)
  expect(document.querySelector('iframe')!.getAttribute('src')).toBe(consolePath)
  expect(server.requests.some(request => request.method === 'PUT')).toBe(false)
})
