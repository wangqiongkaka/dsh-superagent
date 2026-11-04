/** Assignment-scoped MCP tools for external workers over a loopback-only, authenticated HTTP endpoint. */
import { randomBytes } from 'node:crypto'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { z } from 'zod'
import type { Tool } from './tools/tool.ts'

export interface WorkerMcpServer {
  type: 'http'; name: string; url: string; headers: { name: string; value: string }[]
}
interface Access { assignment: string; active: () => boolean; tools: Tool[]; server: WorkerMcpServer }
const Request = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(), params: z.unknown().optional() })
const Call = z.object({ name: z.string(), arguments: z.unknown().optional() })

/** Keeps credentials in memory and rejects requests as soon as an assignment ends or is replaced. */
export class ExternalTools {
  private readonly access = new Map<string, Access>()
  private readonly lifetime = new AbortController()
  private server?: Server
  private opening?: Promise<number>
  private listen(): Promise<number> {
    return this.opening ??= new Promise((resolve, reject) => {
      const server = this.server = createServer((req, res) => { void this.handle(req, res) })
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') reject(new Error('External worker tools did not start'))
        else resolve(address.port)
      })
    })
  }
  async connect(sessionId: string, assignment: string, active: () => boolean, tools: Tool[]): Promise<WorkerMcpServer> {
    if (this.lifetime.signal.aborted) throw new Error('External worker tools are closed')
    const port = await this.listen()
    if (this.lifetime.signal.aborted) throw new Error('External worker tools are closed')
    const previous = this.access.get(sessionId)
    if (previous?.assignment === assignment) { Object.assign(previous, { active, tools }); return previous.server }
    const server: WorkerMcpServer = { type: 'http', name: 'dsh-superagent',
      url: `http://127.0.0.1:${port}/mcp/${encodeURIComponent(sessionId)}`,
      headers: [{ name: 'Authorization', value: `Bearer ${randomBytes(32).toString('hex')}` }] }
    this.access.set(sessionId, { assignment, active, tools, server })
    return server
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, value?: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(value === undefined ? undefined : JSON.stringify(value)) }
    try {
      const address = new URL(req.url ?? '/', 'http://127.0.0.1')
      const access = this.access.get(decodeURIComponent(address.pathname.slice('/mcp/'.length)))
      if (req.headers.origin || !address.pathname.startsWith('/mcp/') || !access || !access.active()
        || req.headers.authorization !== access.server.headers[0]!.value) { send(403); return }
      if (req.method !== 'POST') { send(405); return }
      const chunks: Buffer[] = []
      let length = 0
      for await (const chunk of req) {
        length += chunk.length
        if (length > 1_048_576) { send(413); return }
        chunks.push(Buffer.from(chunk))
      }
      const parsed = Request.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      if (!parsed.success) { send(400); return }
      const request = parsed.data
      if (!access.active() || this.access.get(decodeURIComponent(address.pathname.slice('/mcp/'.length))) !== access) { send(403); return }
      if (request.id === undefined) { send(202); return }
      const result = (value: unknown) => send(200, { jsonrpc: '2.0', id: request.id, result: value })
      if (request.method === 'initialize') {
        result({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'dsh-superagent', version: '0.1.0' } })
      } else if (request.method === 'ping') result({})
      else if (request.method === 'tools/list') result({ tools: access.tools.map(tool => ({ name: tool.name, description: tool.description,
        inputSchema: z.toJSONSchema(tool.schema, { unrepresentable: 'any' }) })) })
      else if (request.method === 'tools/call') {
        try {
          const call = Call.parse(request.params)
          const tool = access.tools.find(tool => tool.name === call.name)
          if (!tool) throw new Error('Unknown worker tool')
          const value = await tool.execute(tool.schema.parse(call.arguments ?? {}), this.lifetime.signal)
          result({ content: [{ type: 'text', text: JSON.stringify(value) ?? 'null' }] })
        } catch (error) { result({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }) }
      } else send(200, { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })
    } catch { if (!res.headersSent) send(400) }
  }
  async close(): Promise<void> {
    this.lifetime.abort(); this.access.clear()
    await this.opening?.catch(() => {})
    const server = this.server
    if (server?.listening) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  }
}
