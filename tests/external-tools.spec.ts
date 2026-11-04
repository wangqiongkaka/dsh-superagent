import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { ExternalTools } from '../src/app/external-tools.ts'

let bridge: ExternalTools | undefined
afterEach(async () => { await bridge?.close(); bridge = undefined })

it('serves only the assignment tools, validates arguments and refuses ended or replaced assignments', async () => {
  bridge = new ExternalTools()
  let active = true, reports = 0
  const server = await bridge.connect('worker-one', 'assignment-one', () => active, [{ name: 'orchestrator_report', description: 'report',
    schema: z.object({ state: z.literal('ready') }).strict(), execute: async () => { reports++; return { saved: true } } }])
  const call = (method: string, params: unknown = {}, authorization = server.headers[0]!.value) => fetch(server.url, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  expect((await call('initialize', { protocolVersion: '2025-03-26' })).status).toBe(200)
  const listed = await (await call('tools/list')).json()
  expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['orchestrator_report'])
  expect((await call('tools/list', {}, 'Bearer wrong')).status).toBe(403)
  expect((await (await call('tools/call', { name: 'orchestrator_report', arguments: { state: 'failed' } })).json()).result.isError).toBe(true)
  expect(reports).toBe(0)
  expect((await (await call('tools/call', { name: 'orchestrator_report', arguments: { state: 'ready' } })).json()).result.isError).toBeUndefined()
  expect(reports).toBe(1)
  await bridge.connect('worker-one', 'assignment-two', () => true, [])
  expect((await call('tools/list')).status).toBe(403)
  const second = await bridge.connect('worker-two', 'assignment-three', () => active, [])
  active = false
  expect((await fetch(second.url, { method: 'POST', headers: { authorization: second.headers[0]!.value },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).status).toBe(403)
})
