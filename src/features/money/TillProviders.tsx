import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { planHasFeature } from '../../billing/licenceStore'
import { useCtx } from '../../data/useCtx'
import { can } from '../../domain/permissions'
import { parseMtnConfig, parseOrangeConfig } from '../../domain/paymentProviders'
import type { CollectionProvider } from '../../domain/tillCollections'
import { supabase } from '../../lib/supabase'

const box = 'input'

const FIELDS: Record<CollectionProvider, { key: string; secret?: boolean; placeholder?: string }[]> = {
  mtn_momo: [
    { key: 'baseUrl', placeholder: 'https://sandbox.momodeveloper.mtn.com' }, { key: 'subscriptionKey', secret: true }, { key: 'apiUser' }, { key: 'apiKey', secret: true },
    { key: 'targetEnvironment', placeholder: 'sandbox' }, { key: 'currency', placeholder: 'XAF' },
  ],
  orange_money: [
    { key: 'baseUrl', placeholder: 'https://api.orange.com' }, { key: 'authorization', secret: true, placeholder: 'Basic ...' }, { key: 'merchantKey', secret: true },
    { key: 'currency', placeholder: 'XAF' }, { key: 'returnUrl', placeholder: 'https://' }, { key: 'cancelUrl', placeholder: 'https://' },
  ],
}

function ProviderForm({ provider, tenantId, on, locked, onChanged }: { provider: CollectionProvider; tenantId: string; on: boolean; locked: boolean; onChanged: () => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [v, setV] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<string | null>(null)

  async function save(e: FormEvent) {
    e.preventDefault()
    setMsg(null)
    const cfg = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x.trim()]))
    const ok = provider === 'mtn_momo' ? parseMtnConfig(cfg) : parseOrangeConfig(cfg)
    if (!ok) return setMsg(t('tillProviders.invalid'))
    const { error } = await supabase!.rpc('set_tenant_provider', { p_tenant: tenantId, p_provider: provider, p_config: ok })
    if (error) return setMsg(error.message)
    setV({}); setOpen(false); setMsg(t('tillProviders.saved')); onChanged()
  }
  async function remove() {
    const { error } = await supabase!.rpc('set_tenant_provider', { p_tenant: tenantId, p_provider: provider, p_config: null })
    setMsg(error ? error.message : t('tillProviders.removed'))
    onChanged()
  }

  return (
    <div className="panel stack">
      <div className="flex items-center justify-between gap-2">
        <strong className="body-md">{t(`pos.${provider}`)}</strong>
        <span className={on ? 'tag tag--solid' : 'tag'}>{on ? t('tillProviders.on') : t('tillProviders.off')}</span>
      </div>
      {!open && (
        <div className="flex gap-2">
          <button type="button" className="btn btn--secondary" disabled={locked} onClick={() => setOpen(true)}>{on ? t('tillProviders.replace') : t('tillProviders.setup')}</button>
          {on && <button type="button" className="btn btn--danger" onClick={() => void remove()}>{t('tillProviders.remove')}</button>}
        </div>
      )}
      {locked && !on && <p className="label-lg">! {t('tillProviders.planLocked')}</p>}
      {open && (
        <form onSubmit={save} className="stack">
          {FIELDS[provider].map((f) => (
            <label key={f.key} className="field">{t(`tillProviders.field.${f.key}`)}
              <input className={box} type={f.secret ? 'password' : 'text'} autoComplete="off" placeholder={f.placeholder} value={v[f.key] ?? ''} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
            </label>
          ))}
          <div className="flex gap-2">
            <button className="btn btn--primary flex-1">{t('tillProviders.save')}</button>
            <button type="button" className="btn btn--secondary" onClick={() => { setOpen(false); setV({}) }}>{t('shops.cancel')}</button>
          </div>
        </form>
      )}
      {msg && <p role="status" className="label-lg">{msg}</p>}
    </div>
  )
}

/** More tab (owner): the business's own MTN / Orange accounts, so customers' mobile money is paid straight to the business. Never shown again once saved. */
export function TillProviders() {
  const { t } = useTranslation()
  const ctx = useCtx()
  const [on, setOn] = useState<Record<string, boolean>>({})
  const [verifiedMomo, setVerifiedMomo] = useState(false)
  const load = useCallback(async () => {
    if (!supabase || !ctx || !navigator.onLine) return
    const r = await supabase.rpc('tenant_providers', { p_tenant: ctx.tenantId })
    setOn((r.data as Record<string, boolean> | null) ?? {})
    setVerifiedMomo(await planHasFeature('verified_momo'))
  }, [ctx])
  useEffect(() => { void load() }, [load])
  if (!ctx || !can(ctx.role, 'settings.write') || !supabase || !navigator.onLine) return null
  return (
    <section className="panel stack" style={{ marginTop: 24 }}>
      <h3 className="h5">{t('tillProviders.title')}</h3>
      <p className="body-md muted">{t('tillProviders.hint')}</p>
      <ProviderForm provider="mtn_momo" tenantId={ctx.tenantId} on={Boolean(on.mtn_momo)} locked={!verifiedMomo} onChanged={() => void load()} />
      <ProviderForm provider="orange_money" tenantId={ctx.tenantId} on={Boolean(on.orange_money)} locked={!verifiedMomo} onChanged={() => void load()} />
    </section>
  )
}
