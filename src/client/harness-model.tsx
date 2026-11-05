/** Per-Harness worker choices, drawn from the Provider's live model catalog. */
import { useEffect, useState } from 'react'
import type { ExternalHarness, HarnessSelection } from '../policy.ts'
import type { HarnessCatalog } from '../app/harness.ts'
import { usePanel } from './provider.tsx'
import { Field } from './settings-kit.tsx'
import { errorText } from './text.ts'
import { Hint } from './widgets.tsx'

export function HarnessModelField({ harness, value, onChange }: {
  harness: ExternalHarness; value: HarnessSelection; onChange: (value: HarnessSelection) => void
}) {
  const { t, call } = usePanel()
  const [catalog, setCatalog] = useState<HarnessCatalog>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    let active = true
    call('GET harness-models/:harness', { harness }).then(result => {
      if (active) { setCatalog(result); setError(result.error ?? undefined) }
    }, failure => { if (active) setError(errorText(failure)) })
    return () => { active = false }
  }, [call, harness])
  const modelId = value.model ?? catalog?.defaultModel?.id
  const model = catalog?.models.find(model => model.id === modelId)
  const efforts = catalog?.thinkingOptions.filter(option => !model?.thinkingOptionIds || model.thinkingOptionIds.includes(option.id)) ?? []
  const fast = catalog?.configOptions.find(option => option.id === 'fast' || option.id === 'fast-mode')
  const fastSupported = fast && (typeof fast.currentValue === 'boolean' || ['on', 'off'].every(value => fast.choices?.some(choice => choice.value === value)))
  const selectModel = (id: string) => {
    const { model: _model, thinking, ...rest } = value
    const next = catalog?.models.find(model => model.id === (id || catalog.defaultModel?.id))
    onChange({ ...rest, ...id ? { model: id } : {},
      ...thinking && (!next?.thinkingOptionIds || next.thinkingOptionIds.includes(thinking)) ? { thinking } : {} })
  }
  const defaultLabel = (label?: string | null) => label ? t('harnessDefaultValue', { value: label }) : t('harnessDefault')
  return <div className="dt-model">
    <Hint>{t('externalHarnessHint')}</Hint>
    {error && <p className="dt-error" role="alert">{t('modelCatalogError', { error })}</p>}
    <div className="dt-grid3">
      <Field label={t('modelName')}>
        <select className="dt-select" aria-label={t('modelName')} disabled={!catalog || !!error} value={value.model ?? ''}
          onChange={event => selectModel(event.target.value)}>
          <option value="">{defaultLabel(catalog?.defaultModel?.label)}</option>
          {value.model && !catalog?.models.some(model => model.id === value.model) && <option value={value.model}>{value.model}</option>}
          {catalog?.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select>
      </Field>
      <Field label={t('modelEffort')}>
        <select className="dt-select" aria-label={t('modelEffort')} disabled={!catalog || !!error} value={value.thinking ?? ''}
          onChange={event => { const { thinking: _thinking, ...rest } = value; onChange({ ...rest, ...event.target.value ? { thinking: event.target.value } : {} }) }}>
          <option value="">{t('harnessDefault')}</option>
          {value.thinking && !efforts.some(option => option.id === value.thinking) && <option value={value.thinking}>{value.thinking}</option>}
          {efforts.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </Field>
      <Field label={t('harnessFast')} hint={t('harnessFastHint')}>
        <select className="dt-select" aria-label={t('harnessFast')} disabled={!catalog || !!error || !fastSupported && value.fast === undefined} value={value.fast === undefined ? '' : String(value.fast)}
          onChange={event => { const { fast: _fast, ...rest } = value; onChange({ ...rest, ...event.target.value ? { fast: event.target.value === 'true' } : {} }) }}>
          <option value="">{catalog && !fastSupported ? t('harnessFastUnavailable') : defaultLabel(fast ? t(fast.currentValue === true || fast.currentValue === 'on' ? 'harnessOn' : 'harnessOff') : undefined)}</option>
          <option value="true" disabled={!fastSupported}>{t('harnessOn')}</option><option value="false" disabled={!fastSupported}>{t('harnessOff')}</option>
        </select>
      </Field>
    </div>
  </div>
}
