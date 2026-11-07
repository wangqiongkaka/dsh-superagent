/** Hindsight transport; callers own source authorization and deletion protection. */
import { z } from 'zod'
import { key } from '../core/index.ts'
import type { MemoryScope } from './memory.ts'

const Fact = z.object({ id: z.string(), text: z.string(), type: z.string().nullish(), document_id: z.string().nullish(),
  metadata: z.record(z.string(), z.string()).nullish(), source_fact_ids: z.array(z.string()).nullish() })
const Recall = z.object({ results: z.array(Fact), source_facts: z.record(z.string(), Fact).nullish() })
export type HindsightFact = z.infer<typeof Fact>

/** Publishes source documents and recalls evidence from one authenticated Hindsight service. */
export class Hindsight {
  constructor(private readonly url: string, private readonly credential: string, private readonly lifetime: AbortSignal,
    private readonly request: typeof fetch = fetch) {}
  private async call(scope: MemoryScope, path: string, method: string, body?: unknown, signal?: AbortSignal) {
    if (!this.credential) throw new Error('请先配置 Hindsight API 密钥。')
    let response: Response
    try {
      response = await this.request(`${this.url}/v1/default/banks/dsh-superagent-${key(scope.id)}${path}`, {
        method, redirect: 'error', headers: { authorization: `Bearer ${this.credential}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([this.lifetime, AbortSignal.timeout(120_000), ...signal ? [signal] : []]),
      })
    } catch { throw new Error('Hindsight 连接失败或请求已中止。') }
    if (response.status === 404 && method === 'DELETE') return { success: true }
    if (response.status === 404 && path === '/memories/recall') return { results: [] }
    if (!response.ok) throw new Error(`Hindsight 请求失败（HTTP ${response.status}）。`)
    try { return await response.json() as unknown }
    catch { throw new Error('Hindsight 返回了无效的响应。') }
  }
  async retain(scope: MemoryScope, document: { id: string; content: string; resource: string; at: string; kind: string }, signal?: AbortSignal) {
    const result = await this.call(scope, '/memories', 'POST', { async: false, items: [{
      document_id: document.id, update_mode: 'replace', content: document.content, timestamp: document.at,
      metadata: { source: document.resource, source_kind: document.kind },
    }] }, signal)
    if (!z.object({ success: z.literal(true), async: z.literal(false) }).safeParse(result).success)
      throw new Error('Hindsight 尚未确认事实写入完成。')
  }
  async remove(scope: MemoryScope, id: string) {
    const result = await this.call(scope, `/documents/${encodeURIComponent(id)}`, 'DELETE')
    if (!z.object({ success: z.literal(true) }).safeParse(result).success) throw new Error('Hindsight 尚未确认来源删除完成。')
  }
  async recall(scope: MemoryScope, query: string, signal?: AbortSignal) {
    const result = Recall.safeParse(await this.call(scope, '/memories/recall', 'POST', {
      query, types: ['world', 'experience', 'observation'], prefer_observations: true, budget: 'mid', max_tokens: 2000,
      include: { entities: null, chunks: null, source_facts: { max_tokens: 8000 } },
    }, signal))
    if (!result.success) throw new Error('Hindsight 返回了无效的记忆结果。')
    return result.data
  }
}
