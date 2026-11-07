/** Shared memory settings and source-backed review, using explicit revision checks for every edit. */
import { useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import type { MemoryEntry, MemoryScope } from '../app/memory.ts'
import { usePoll } from './api.ts'
import { Button, Input, Switch, Tag } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { Hint, LoadState, Section, When } from './widgets.tsx'

type View = ApiResponse<'GET memory'>
const statuses = ['active', 'pending', 'rejected', 'deleted'] as const
function Configuration({ initial, reload }: { initial: View['config']; reload: () => Promise<void> }) {
  const { call, t } = usePanel()
  const [value, setValue] = useState(initial), [apiKey, setKey] = useState('')
  const save = useAction(async () => {
    const { configured, ...config } = value
    setValue(await call('PUT memory/config', { body: { ...config, apiKey } })); setKey(''); await reload()
  })
  const refresh = useAction(async () => { setValue((await call('GET memory')).config); setKey('') })
  return <div className="dt-form dt-block">
    <div className="dt-actions"><strong>{t('memory.enabled')}</strong><Switch label={t('memory.enabled')} checked={value.enabled}
      onChange={enabled => setValue({ ...value, enabled })} /></div>
    <Hint>{t('memory.explain')}</Hint>
    <label className="dt-field">{t('memory.key')}<Input type="password" autoComplete="new-password" aria-label={t('memory.key')}
      value={apiKey} onChange={event => setKey(event.target.value)} /><small>{t(value.configured ? 'memory.configured' : 'memory.unconfigured')}</small></label>
    <div className="dt-row">
      <label className="dt-field dt-row-main">{t('memory.model')}<Input aria-label={t('memory.model')} value={value.model} maxLength={100}
        onChange={event => setValue({ ...value, model: event.target.value })} /></label>
      <label className="dt-field dt-row-main">{t('memory.threshold')}<Input aria-label={t('memory.threshold')} type="number" min={0.8} max={0.99} step={0.01}
        value={value.threshold} onChange={event => setValue({ ...value, threshold: Number(event.target.value) })} /></label>
    </div>
    <Hint>{t('memory.thresholdHint')}</Hint>
    <div className="dt-actions"><Button variant="primary" disabled={save.busy} onClick={() => void save.run()}>{t('save')}</Button>
      <Button disabled={refresh.busy || save.busy} onClick={() => void refresh.run()}>{t('memory.reload')}</Button></div>
  </div>
}
function Record({ entry, scopes, reload }: { entry: MemoryEntry; scopes: MemoryScope[]; reload: () => Promise<void> }) {
  const { call, t } = usePanel()
  const [draft, setDraft] = useState<MemoryEntry>(), [history, setHistory] = useState<MemoryEntry[]>()
  const save = useAction(async (value: MemoryEntry, status: MemoryEntry['status'] = value.status) => {
    await call('PUT memory/:id', { id: entry.id, body: { revision: value.revision, text: value.text, scope: value.scope.id, status } })
    setDraft(undefined); setHistory(undefined); await reload()
  })
  const versions = useAction(async () => setHistory(history ? undefined : await call('GET memory/:id/history', { id: entry.id })))
  return <article className="dt-card">
    <div className="dt-actions"><strong>{entry.scope.label}</strong><Tag>{t(`memory.${entry.scope.kind}`)}</Tag>
      <Tag tone={entry.status === 'pending' ? 'warning' : 'quiet'}>{t(`memory.${entry.status}`)}</Tag><When at={entry.updatedAt} /></div>
    {draft ? <>
      <label className="dt-field">{t('memory.text')}<textarea className="dt-textarea" aria-label={t('memory.text')} rows={4} maxLength={800}
        value={draft.text} onChange={event => setDraft({ ...draft, text: event.target.value })} /></label>
      <label className="dt-field">{t('memory.scope')}<select className="dt-select" aria-label={t('memory.scope')} value={draft.scope.id}
        onChange={event => setDraft({ ...draft, scope: scopes.find(scope => scope.id === event.target.value)! })}>
        {!scopes.some(scope => scope.id === draft.scope.id) && <option value={draft.scope.id}>{draft.scope.label}</option>}
        {scopes.map(scope => <option key={scope.id} value={scope.id}>{t(`memory.${scope.kind}`)} · {scope.label}</option>)}
      </select></label>
      <div className="dt-actions"><Button disabled={save.busy} onClick={() => void save.run(draft)}>{t('save')}</Button>
        <Button disabled={save.busy} onClick={() => setDraft(undefined)}>{t('cancel')}</Button></div>
    </> : <p className="dt-event-text">{entry.text}</p>}
    <Hint>{t(`memory.reason.${entry.reason}`)}</Hint>
    <details><summary>{t('memory.source')}</summary><p className="dt-event-text">{entry.source.quote}</p><small className="dt-event-text">{entry.source.resource}</small></details>
    {!draft && <div className="dt-actions">
      <Button onClick={() => setDraft(entry)}>{t('memory.edit')}</Button>
      {entry.status !== 'active' && <Button disabled={save.busy} onClick={() => void save.run(entry, 'active')}>{t('memory.activate')}</Button>}
      {entry.status === 'pending' && <Button disabled={save.busy} onClick={() => void save.run(entry, 'rejected')}>{t('memory.reject')}</Button>}
      {entry.status !== 'deleted' && <Button disabled={save.busy} onClick={() => void save.run(entry, 'deleted')}>{t('memory.delete')}</Button>}
      <Button disabled={versions.busy} aria-expanded={!!history} onClick={() => void versions.run()}>{t('memory.history')}</Button>
    </div>}
    {history && <div className="dt-form">{history.map(version => <div key={version.revision}>
      <div className="dt-actions">v{version.revision} · {version.scope.label} · {t(`memory.${version.status}`)} <When at={version.updatedAt} /></div>
      <p className="dt-event-text">{version.text}</p></div>)}</div>}
  </article>
}
export function MemoryPage() {
  const { call, t } = usePanel()
  const [scope, setScope] = useState(''), [status, setStatus] = useState(''), [offset, setOffset] = useState(0)
  const { data, error, reload } = usePoll(() => call('GET memory', { query: { scope, status, offset } }), [call, scope, status, offset])
  if (!data) return <LoadState loading error={error} />
  return <div className="dt-form">
    <Configuration initial={data.config} reload={reload} />
    <Section title={t('memory.records')} count={data.total} action={<Button onClick={() => void reload()}>{t('memory.refresh')}</Button>}>
      <div className="dt-form">
        <Hint>{t('memory.reviewHint')}</Hint>
        <div className="dt-row">
          <label className="dt-field dt-row-main">{t('memory.scope')}<select className="dt-select" aria-label={t('memory.scope')} value={scope}
            onChange={event => { setScope(event.target.value); setOffset(0) }}><option value="">{t('memory.all')}</option>
            {data.scopes.map(item => <option key={item.id} value={item.id}>{t(`memory.${item.kind}`)} · {item.label}</option>)}
          </select></label>
          <label className="dt-field dt-row-main">{t('memory.status')}<select className="dt-select" aria-label={t('memory.status')} value={status}
            onChange={event => { setStatus(event.target.value); setOffset(0) }}><option value="">{t('memory.all')}</option>
            {statuses.map(value => <option key={value} value={value}>{t(`memory.${value}`)}</option>)}</select></label>
        </div>
        {error && <LoadState loading={false} error={error} />}
        {!data.items.length && <Hint>{t('memory.empty')}</Hint>}
        {data.items.map(entry => <Record key={entry.id} entry={entry} scopes={data.scopes} reload={reload} />)}
        <div className="dt-actions">{offset > 0 && <Button onClick={() => setOffset(Math.max(0, offset - 30))}>{t('memory.previous')}</Button>}
          {data.nextOffset !== null && <Button onClick={() => setOffset(data.nextOffset!)}>{t('memory.next')}</Button>}</div>
      </div>
    </Section>
  </div>
}
