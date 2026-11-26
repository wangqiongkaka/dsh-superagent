/** Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness. */
import type { Context } from '@deepseek-ai/cordis'
import { delimiter } from 'node:path'
import { UserError } from '../core/index.ts'
import { SETUP_FIELDS, resolveDeployment, resolveRepositories, resolveFeishuBot, workerProbe, type Deployment, type Machine } from '../deployment.ts'
import { agentVariables, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import type { ResolvedRepository } from '../repositories.ts'
import { SetupError, type SetupProblem } from '../setup.ts'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  restart(): void
}

const setupFields = (settings: Settings) =>
  JSON.stringify(Object.entries(SETUP_FIELDS).map(([id, keys]) => keys.map(key => settings.sources[id]?.config[key] ?? '')))
export const setupChanged = (before: Settings, after: Settings): boolean => setupFields(before) !== setupFields(after)
const gitRepositoryFields = (settings: Settings) => JSON.stringify([settings.sources.git?.enabled ?? false, settings.sources.git?.config.repositories ?? []])
export const gitRepositoriesChanged = (before: Settings, after: Settings): boolean => gitRepositoryFields(before) !== gitRepositoryFields(after)

/**
 * Resolves the target repository, GitHub account, and optional Feishu bot by probing CLIs, then writes the isolated git and shim environment used by worker processes.
 * `Runtime` runs it at startup to gate orchestration readiness, while `Settings` uses it to validate account changes, hot-update Git repositories, update blocked command shims, and schedule restarts.
 */
export class Setup {
  private resolved?: Deployment
  private envWrite: Promise<void> = Promise.resolve()
  problem?: SetupProblem
  feishuProblem?: SetupProblem
  /** PATH with the worker shim directory removed so the host's own CLI calls invoke the real binaries. */
  private readonly path: string
  /** Environment variables pointing agent subprocesses at the isolated git config and command shims. */
  private readonly variables: Record<string, string | undefined>
  constructor(private readonly host: SetupHost) {
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    this.variables = agentVariables(host.machine.stateDir)
  }
  /** Host command environment with agent git variables applied and the worker shim directory excluded from PATH. */
  get commandEnvironment(): Record<string, string | undefined> { return { ...this.variables, PATH: this.path } }
  /** Environment overrides for managed sessions and ticket subprocesses. */
  workerEnvironment(feishu = this.resolved?.feishu?.cli ?? ''): NodeJS.ProcessEnv {
    return { ...this.variables, PATH: [workerBin(this.host.machine.stateDir), this.path].join(delimiter), DSH_SUPERAGENT_FEISHU_CLI: feishu }
  }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-superagent is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.resolved
  }
  configured(): boolean { return this.resolved !== undefined }
  hasLegacyRepository(): boolean { return !!this.resolved?.repository }
  /** Resolve deployment accounts and verify the worker environment, recording `SetupError` failures in `problem`/`feishuProblem` and rethrowing unexpected errors. */
  async run(settings: Settings): Promise<boolean> {
    try { this.resolved = await this.resolve(settings); return true }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.problem = error.problem
      return false
    }
  }
  /** Trigger a restart to re-run setup, refusing if setup and Feishu are already healthy so running assignments are not interrupted. */
  check(): void {
    if (this.configured() && !this.feishuProblem) throw new UserError('setupComplete')
    this.restart()
  }
  /** Defer the restart to the next macrotask so the current HTTP or tool caller receives its response first. */
  restart(): void { setTimeout(this.host.restart, 0) }
  /** Verify account CLIs for a modified source block before saving, ignoring setup errors belonging to other blocks. */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    const { machine } = this.host
    const check = block === 'source:git' ? resolveRepositories(machine, settings, this.probe(), undefined, this.resolved?.repositories ?? [])
      : block === 'source:feishu' ? resolveFeishuBot(machine, settings.sources.feishu?.config, this.probe())
      : resolveDeployment(machine, settings.sources.github?.config, this.probe())
    await check.catch((error: unknown) => { if (!(error instanceof SetupError) || error.place === block.slice(7)) throw error })
  }
  /** Verify newly added or changed Git repositories before saving, reusing already-verified entries for unchanged repositories. */
  async checkRepositories(settings: Settings): Promise<ResolvedRepository[]> {
    return resolveRepositories(this.host.machine, settings, this.probe(), undefined, this.resolved?.repositories ?? [])
      .catch((error: unknown) => {
        if (error instanceof SetupError) throw error
        throw new SetupError('gitRepositoriesFailed', { output: error instanceof Error ? error.message : String(error) })
      })
  }
  /** Atomically write worker shims and gitconfig for `repositories` before committing them to in-memory deployment state. */
  async syncRepositories(repositories: ResolvedRepository[], blocked: readonly string[]): Promise<void> {
    if (this.resolved) await this.writeEnv(this.withRepositories(repositories), blocked)
  }
  /** Publish verified repositories into the live deployment immediately after the settings transaction commits. */
  commitRepositories(repositories: ResolvedRepository[]): void {
    if (this.resolved) this.resolved = this.withRepositories(repositories)
  }
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (this.resolved) await this.writeEnv(this.resolved, blocked)
  }
  private withRepositories(repositories: ResolvedRepository[]): Deployment {
    const { repositories: _previous, ...base } = this.resolved!
    return { ...base, ...(repositories.length ? { repositories } : {}) }
  }
  /** Serializes writes to worker shims and gitconfig so concurrent settings saves cannot collide on temporary files. */
  private writeEnv(deployment: Deployment, blocked: readonly string[]): Promise<void> {
    const next = this.envWrite.catch(() => {}).then(() => writeEnvironment(deployment, blocked))
    this.envWrite = next.catch(() => {})
    return next
  }
  /** Probes CLIs the way worker shells run them, using `stateDir` as `cwd` since it exists even before the repository clone is valid. */
  private probe() {
    const { context, machine, lifetime } = this.host
    return workerProbe(context.subprocess, machine.stateDir, machine.stateDir, lifetime)
  }
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    const probe = this.probe()
    const legacy = settings.sources.github
    const legacyDeployment = legacy?.enabled && legacy.config.repository
      ? await resolveDeployment(machine, legacy.config, probe) : undefined
    const repositories = await resolveRepositories(machine, settings, probe).catch((error: unknown) => {
      throw new SetupError('gitRepositoriesFailed', { output: error instanceof Error ? error.message : String(error) })
    })
    const deployment = legacyDeployment ?? (repositories.length && (!legacy?.enabled || !legacy.config.repository)
      ? { ...machine, repository: '', github: { cli: '', login: '', noreply: '' } }
      : await resolveDeployment(machine, legacy?.config, probe))
    const feishu = await resolveFeishuBot(machine, settings.sources.feishu?.config, probe).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.feishuProblem = error.problem
      context.logger.warn('dsh-superagent leaves Feishu out: %s', error.message)
      return undefined
    })
    const resolved = { ...deployment, ...(repositories.length ? { repositories } : {}), ...(feishu ? { feishu } : {}) }
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    await writeEnvironment(resolved, settings.executor.blockedCommands).catch(machineProblem)
    await verifyEnvironment(resolved, context.subprocess, lifetime, this.workerEnvironment(feishu?.cli)).catch(machineProblem)
    return resolved
  }
}
