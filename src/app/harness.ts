/** Optional Harness Provider contract shared by worker startup and settings validation. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { ExternalHarness, HarnessSelection } from '../policy.ts'
import type { WorkerMcpServer } from './external-tools.ts'

export const HarnessCatalogSchema = z.object({
  models: z.array(z.object({ id: z.string(), label: z.string(), thinkingOptionIds: z.array(z.string()).nullable() })),
  defaultModel: z.object({ id: z.string(), label: z.string() }).nullable(),
  thinkingOptions: z.array(z.object({ id: z.string(), label: z.string() })),
  defaultThinkingOptionId: z.string().nullable(),
  configOptions: z.array(z.object({ id: z.string(), currentValue: z.union([z.boolean(), z.string()]),
    choices: z.array(z.object({ value: z.string(), label: z.string() })).nullable() })),
  error: z.string().nullable(),
})
export type HarnessCatalog = z.infer<typeof HarnessCatalogSchema>

/** A Harness a worker may run on, as the Provider offers it. */
export const HarnessOptionSchema = z.object({ id: z.string(), label: z.string() })
export type HarnessOption = z.infer<typeof HarnessOptionSchema>
/** What a Provider from before `managedHarnesses` runs workers on. */
const LEGACY_HARNESSES: HarnessOption[] = [{ id: 'dsh', label: 'DSH' }, { id: 'codex', label: 'Codex' }, { id: 'claude-code', label: 'Claude Code' }]

interface HarnessBridge {
  readonly managedSessionOptionsVersion?: number
  managedHarnesses?(request: Record<string, never>): Promise<unknown>
  models?(request: { sessionId: string; harness: ExternalHarness }): Promise<unknown>
  validateManagedSessionSelection?(sessionId: string, harness: ExternalHarness, selection: HarnessSelection): Promise<void>
  linkProjects?(request: { sessionId: string; workspaceIds: string[]; paths: string[] }): Promise<unknown>
  manageSession(id: string, options: { owner: string; harness: 'dsh' | ExternalHarness; selection?: HarnessSelection;
    context?: () => Promise<{ instructions: string; environment: Record<string, string | undefined>; mcpServers: WorkerMcpServer[] }> }): Promise<void>
  releaseManagedSession(id: string, owner: string): Promise<void>
}
export const harnessOf = (ctx: Context) => ctx.get('harness' as never) as HarnessBridge | undefined
/** The Harnesses workers may run on here: the Provider's installed managed ones, else DSH alone without a Provider. */
export async function harnessOptions(ctx: Context): Promise<HarnessOption[]> {
  const bridge = harnessOf(ctx)
  if (typeof bridge?.manageSession !== 'function') return LEGACY_HARNESSES.slice(0, 1)
  return typeof bridge.managedHarnesses === 'function' ? z.array(HarnessOptionSchema).parse(await bridge.managedHarnesses({})) : LEGACY_HARNESSES
}
export function configurableHarness(ctx: Context) {
  const bridge = harnessOf(ctx)
  if (!bridge || (bridge.managedSessionOptionsVersion ?? 0) < 1 || !bridge.models || !bridge.validateManagedSessionSelection) {
    throw new Error('请安装或升级同一 Profile 中的 Harness Provider，以支持执行器模型、推理强度和快速模式配置。')
  }
  return bridge
}
