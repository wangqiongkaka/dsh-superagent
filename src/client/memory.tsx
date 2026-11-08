/** Embedded native Hindsight management with independent connection settings and login. */
import { useState } from 'react'
import { MEMORY_CONSOLE_PATH, type ApiResponse } from '../app/api.ts'
import { usePoll } from './api.ts'
import { Button, Input, Switch } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { Hint, LoadState, Section } from './widgets.tsx'

type Configuration = ApiResponse<'GET memory'>['config']
function Connection({ initial, reload, resetConsole }: { initial: Configuration; reload: () => Promise<void>; resetConsole: () => void }) {
  const { call, t } = usePanel()
  const [value, setValue] = useState(initial), [hindsightApiKey, setKey] = useState('')
  const [consoleKey, setConsoleKey] = useState<string | null>('')
  const save = useAction(async () => {
    const { configured, consoleConfigured, ...config } = value, changed = consoleKey !== ''
    setValue(await call('PUT memory/config', { body: { ...config, hindsightApiKey, hindsightConsoleKey: consoleKey } }))
    setKey(''); setConsoleKey(''); await reload(); if (changed) resetConsole()
  })
  const refresh = useAction(async () => { setValue((await call('GET memory')).config); setKey(''); setConsoleKey('') })
  return <div className="dt-form dt-block">
    <div className="dt-actions"><strong>{t('memory.enabled')}</strong><Switch label={t('memory.enabled')} checked={value.enabled}
      onChange={enabled => setValue({ ...value, enabled })} /></div>
    <Hint>{t('memory.explain')}</Hint>
    <label className="dt-field">{t('memory.hindsightUrl')}<Input type="url" aria-label={t('memory.hindsightUrl')} value={value.hindsightUrl}
      onChange={event => setValue({ ...value, hindsightUrl: event.target.value })} /></label>
    <label className="dt-field">{t('memory.hindsightKey')}<Input type="password" autoComplete="new-password" aria-label={t('memory.hindsightKey')}
      value={hindsightApiKey} onChange={event => setKey(event.target.value)} /><small>{t(value.configured ? 'memory.configured' : 'memory.unconfigured')}</small></label>
    <label className="dt-field">{t('memory.consoleUrl')}<Input type="url" aria-label={t('memory.consoleUrl')} value={value.consoleUrl}
      onChange={event => setValue({ ...value, consoleUrl: event.target.value })} /></label>
    <label className="dt-field">{t('memory.consoleKey')}<Input type="password" autoComplete="new-password" aria-label={t('memory.consoleKey')}
      value={consoleKey ?? ''} onChange={event => setConsoleKey(event.target.value)} />
      <small>{t(consoleKey === null ? 'memory.autoLoginClearing' : value.consoleConfigured ? 'memory.consoleConfigured' : 'memory.consoleUnconfigured')}</small></label>
    {value.consoleConfigured && <div className="dt-actions"><Button disabled={save.busy || consoleKey === null}
      onClick={() => setConsoleKey(null)}>{t('memory.disableAutoLogin')}</Button></div>}
    <Hint>{t('memory.manageHint')}</Hint>
    <div className="dt-actions"><Button variant="primary" disabled={save.busy} onClick={() => void save.run()}>{t('save')}</Button>
      <Button disabled={refresh.busy || save.busy} onClick={() => void refresh.run()}>{t('memory.reload')}</Button></div>
  </div>
}
function Management({ url, externalUrl, automatic }: { url: string; externalUrl: string; automatic: boolean }) {
  const { t } = usePanel()
  const [version, setVersion] = useState(0), [loading, setLoading] = useState(true)
  return <Section title={t('memory.manage')} action={<div className="dt-actions">
    <Button onClick={() => { setLoading(true); setVersion(value => value + 1) }}>{t('memory.reloadConsole')}</Button>
    <a className="dt-btn" href={externalUrl} target="_blank" rel="noopener noreferrer">{t('memory.openConsole')}</a>
  </div>}>
    <Hint>{t(automatic ? 'memory.autoLoginHint' : 'memory.consoleHint')}</Hint>
    {loading && <p className="dt-hint" role="status">{t('memory.consoleLoading')}</p>}
    <iframe key={version} className="dt-memory-console" src={url} title={t('memory.consoleTitle')}
      sandbox="allow-scripts allow-forms allow-same-origin allow-downloads allow-popups allow-modals"
      allow="clipboard-write" referrerPolicy="no-referrer" onLoad={() => setLoading(false)} />
  </Section>
}
export function MemoryPage() {
  const { call, t } = usePanel()
  const [connectionOpen, setConnectionOpen] = useState<boolean>()
  const [version, setVersion] = useState(0)
  const { data, error, reload } = usePoll(() => call('GET memory'), [call])
  if (!data) return <LoadState loading error={error} />
  return <div className="dt-form">
    <details className="dt-memory-settings" open={connectionOpen ?? !data.config.configured}
      onToggle={event => setConnectionOpen(event.currentTarget.open)}>
      <summary>{t('memory.connection')}</summary><Connection initial={data.config} reload={reload} resetConsole={() => setVersion(value => value + 1)} />
    </details>
    {error && <LoadState loading={false} error={error} />}
    <Management key={`${data.config.consoleUrl}:${version}`} url={MEMORY_CONSOLE_PATH + '/'} automatic={data.config.consoleConfigured}
      externalUrl={location.protocol === 'dsh-app:' ? data.config.consoleUrl.replace(/\/(?:dashboard\/?)?$/, '') + '/dashboard' : MEMORY_CONSOLE_PATH + '/'} />
  </div>
}
