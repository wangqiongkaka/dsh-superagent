/** Outbox delivery when processing is paused or a Source kind registers late. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { OutboundMessage } from '../src/core/index.ts'
import { CliError, Commands } from '../src/infra/commands.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
async function at(ms: number) {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
  try { await h.runtime.pump(); await h.runtime.sendReplies() } finally { vi.useRealTimers() }
}

it('holds every message while processing is paused, and sends it once processing resumes', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  await h.runtime.settings.pause(true, 'panel')
  lark.mockClear()
  h.runtime.outbox.send({ id: 'held', channel: feishu('1', 'x').channel!, text: '已合并。', kind: 'notice' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('held'), lark.mock.calls.length]).toEqual(['pending', 0])
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.sendReplies()
  expect(h.runtime.outbox.status('held')).toBe('sent')
  expect(JSON.stringify(lark.mock.calls)).toContain('已合并。')
})

it('keeps a message for a Source that is not installed waiting, and sends it once the Source\'s kind registers', async () => {
  const sent: OutboundMessage[] = []
  const probe: SourceKind<Record<string, never>> = { kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
    schema: z.object({}).strict(), fields: [],
    channel: { send: async (_host, message) => { sent.push(message); return 'sent' }, link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }) } }
  h.runtime.outbox.send({ id: 'waiting', channel: { source: 'probe', thread: 'probe:1', address: {} }, text: 'Done', kind: 'reply' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('waiting'), h.runtime.health.reply?.state]).toEqual(['pending', 'ready'])
  h.runtime.sources.register(probe)
  // A message whose Source was not installed is tried again after 5 seconds.
  await at(5000)
  expect([h.runtime.outbox.status('waiting'), sent.map(message => message.id)]).toEqual(['sent', ['waiting']])
})

it('settles a failed reply and clears its alert when plain fallback succeeds, without sending it again', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  lark.mockRejectedValue(new CliError('internal error', 2200))
  h.runtime.outbox.send({ id: 'thread-failed', channel: feishu('1', 'x').channel!, text: '已完成。', kind: 'reply' })
  await h.runtime.sendReplies(); await at(5000); await at(15_000)
  expect(h.runtime.outbox.status('thread-failed')).toBe('pending')
  expect(h.runtime.health.reply?.state).toBe('error')
  lark.mockClear()
  lark.mockImplementation(async args => {
    if (args.includes('--reply-in-thread')) throw new CliError('internal error', 2200)
    return {}
  })
  await at(35_000)
  expect(h.runtime.outbox.status('thread-failed')).toBe('sent')
  expect(h.runtime.store.read.failingReplies()).toEqual([])
  expect(h.runtime.health.reply).toMatchObject({ state: 'ready', detail: 'Nothing waiting' })
  expect(lark).toHaveBeenCalledTimes(2)
  await at(300_000)
  expect(lark).toHaveBeenCalledTimes(2)
})
