/** Hindsight connection settings; memory content and lifecycle are managed in its native console. */
import { useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { usePoll } from './api.ts'
import { Button, Input, Switch } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { Hint, LoadState } from './widgets.tsx'

type Configuration = ApiResponse<'GET memory'>['config']
function Connection({ initial, reload }: { initial: Configuration; reload: () => Promise<void> }) {
  const { call, t } = usePanel()
  const [value, setValue] = useState(initial), [hindsightApiKey, setKey] = useState('')
  const save = useAction(async () => {
    const { configured, ...config } = value
    setValue(await call('PUT memory/config', { body: { ...config, hindsightApiKey } })); setKey(''); await reload()
  })
  const refresh = useAction(async () => { setValue((await call('GET memory')).config); setKey('') })
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
    <Hint>{t('memory.manageHint')}</Hint>
    <div className="dt-actions"><Button variant="primary" disabled={save.busy} onClick={() => void save.run()}>{t('save')}</Button>
      <Button disabled={refresh.busy || save.busy} onClick={() => void refresh.run()}>{t('memory.reload')}</Button>
      <a className="dt-btn" href={initial.consoleUrl} target="_blank" rel="noopener noreferrer">{t('memory.manage')}</a></div>
  </div>
}
export function MemoryPage() {
  const { call } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET memory'), [call])
  if (!data) return <LoadState loading error={error} />
  return <div className="dt-form"><Connection initial={data.config} reload={reload} />{error && <LoadState loading={false} error={error} />}</div>
}
