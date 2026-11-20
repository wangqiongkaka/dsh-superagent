/** A worker's background work in DSH: waiting for its shell jobs and subagents, and stopping them. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it, vi } from 'vitest'
import { hasLiveChildren, stopSubagents, untilQuiet } from '../src/executor/background.ts'
import { jobRegistry } from './fixtures/host.ts'

/** A context with DSH's job registry and subagents, and an idle worker agent with one live subagent, `child-1`. */
function setup(waitForChildren: (agent: Agent) => Promise<boolean>, drainChildren: () => Promise<void> = async () => {}) {
  const jobs = jobRegistry()
  const agent = { id: 'worker-t1', status: 'idle', whenIdle: async () => {}, inbox: { nextTurn: [], nextStep: [] }, cancel: vi.fn() } as unknown as
    Agent & { status: string; cancel: ReturnType<typeof vi.fn> }
  const subagents = {
    waitForChildren: vi.fn(waitForChildren), listChildren: async () => [{ id: 'child-1' }], drainChildren: vi.fn(drainChildren),
    listDescendants: vi.fn(async () => { throw new Error('Prefer the direct-child API when it exists') }),
  }
  const services: Record<string, unknown> = { jobs: jobs.service, subagents }
  const ctx = { get: (name: string) => services[name], agents: { get: () => agent } } as unknown as Context
  return { ctx, agent, jobs, subagents }
}

it('is not quiet when an end during the subagent check woke the worker, whose own idle looks again', async () => {
  const { ctx, agent, jobs } = setup(async () => {
    // The job settles meanwhile, and its end wakes the worker.
    jobs.end(id); (agent as { status: string }).status = 'running'
    return false
  })
  const id = jobs.run('worker-t1')
  expect(await untilQuiet(ctx, agent, new AbortController().signal)).toBe(false)
})

it('stops waiting for subagents that never settle once the host stops', async () => {
  let joining!: () => void
  const joined = new Promise<void>(resolve => { joining = resolve })
  const { ctx, agent } = setup(() => { joining(); return new Promise(() => {}) })
  const stop = new AbortController()
  const quiet = untilQuiet(ctx, agent, stop.signal)
  // The host stops while the wait for its subagents runs.
  await joined
  stop.abort()
  expect(await quiet).toBe(false)
})

it('looks at the jobs only when one ends, not at each output of a noisy one', async () => {
  const { ctx, agent, jobs } = setup(async () => false)
  const id = jobs.run('worker-t1')
  const stop = new AbortController()
  const quiet = untilQuiet(ctx, agent, stop.signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  const looked = jobs.service.list.mock.calls.length
  for (let line = 0; line < 100; line++) jobs.output(id)
  expect(jobs.service.list.mock.calls.length).toBe(looked)
  jobs.end(id)
  expect(await quiet).toBe(true)
})

it('joins a worker\'s subagents once for the looks that wait on them, as DSH cannot cancel the join', async () => {
  const { ctx, agent, subagents } = setup(() => new Promise(() => {}))
  for (let look = 0; look < 3; look++) {
    const stop = new AbortController()
    const quiet = untilQuiet(ctx, agent, stop.signal)
    stop.abort()
    expect(await quiet).toBe(false)
  }
  expect(subagents.waitForChildren).toHaveBeenCalledTimes(1)
})

it('gives up a release of subagents that does not end within 10 seconds, and cancels the turn their ends woke', async () => {
  const { ctx, agent } = setup(async () => false, () => new Promise(() => {}))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    let stopped = false
    const stopping = stopSubagents(ctx, agent).then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await stopping
  } finally { vi.useRealTimers() }
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
})

it('uses the desktop tree API for workspace occupancy and waiting', async () => {
  const { agent } = setup(async () => false)
  const agents = new Map([[agent.id, agent], ['child-1', agent]])
  const service = {
    listDescendants: vi.fn(async () => [{ kind: 'child', id: 'child-1', activity: 'inactive' }]),
    waitForTreeWork: vi.fn(async () => false),
  }
  const ctx = { get: (name: string) => name === 'subagents' ? service : undefined, agents } as unknown as Context
  await expect(hasLiveChildren(ctx, agent.id)).resolves.toBe(true)
  agents.delete('child-1')
  await expect(hasLiveChildren(ctx, agent.id)).resolves.toBe(false)
  await expect(untilQuiet(ctx, agent, new AbortController().signal)).resolves.toBe(true)
  expect(service.waitForTreeWork).toHaveBeenCalledWith(agent)
})

it('distinguishes an uncreated worker from a descendant lookup failure', async () => {
  const listDescendants = vi.fn().mockRejectedValueOnce(Object.assign(new Error('missing session'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' }))
    .mockRejectedValueOnce(new Error('catalog unavailable'))
  const ctx = { get: () => ({ listDescendants }), agents: new Map() } as unknown as Context
  await expect(hasLiveChildren(ctx, 'worker-t1')).resolves.toBe(false)
  await expect(hasLiveChildren(ctx, 'worker-t1')).rejects.toThrow('catalog unavailable')
})

it('interrupts live descendants for a handoff and only closes the tree when ending its ticket', async () => {
  const { agent } = setup(async () => false)
  const service = {
    listDescendants: async () => [{ kind: 'child', id: 'child-1', activity: 'running' }],
    waitForTreeWork: vi.fn(async () => false),
    interrupt: vi.fn(),
    drainDescendants: vi.fn(async () => {}),
  }
  const ctx = { get: (name: string) => name === 'subagents' ? service : undefined, agents: new Map([[agent.id, agent]]) } as unknown as Context
  await stopSubagents(ctx, agent, true)
  expect(service.interrupt).toHaveBeenCalledWith('child-1', { kind: 'ancestor', agent })
  expect(service.waitForTreeWork).toHaveBeenCalledWith(agent)
  expect(service.drainDescendants).not.toHaveBeenCalled()
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
  await stopSubagents(ctx, agent, false, true)
  expect(service.drainDescendants).toHaveBeenCalledWith([agent])
})
