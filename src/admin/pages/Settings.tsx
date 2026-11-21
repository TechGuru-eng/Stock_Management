import { useState, type ReactNode } from 'react'
import { useAdmin } from '../ctx'
import { Button, Card, ErrorNote, Loading, useAsync } from '../ui'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** One setting = one small form with its own Save button, so a change is deliberate and logged on its own. */
function Section({ title, hint, children, onSave }: { title: string; hint?: string; children: ReactNode; onSave: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  return (
    <Card title={title}>
      {hint && <p className="body-sm muted" style={{ marginBottom: 15 }}>{hint}</p>}
      <div className="stack">{children}</div>
      <div className="btn-row" style={{ alignItems: 'center', marginTop: 15 }}>
        <Button disabled={busy} onClick={() => { setBusy(true); setMsg(null); onSave().then(() => setMsg({ ok: true, text: 'Saved' }), (e: unknown) => setMsg({ ok: false, text: e instanceof Error ? e.message : 'Failed' })).finally(() => setBusy(false)) }}>{busy ? 'Saving…' : 'Save'}</Button>
        {msg && <span role="status" className={msg.ok ? 'label-lg muted' : 'field__error'}>{msg.ok ? msg.text : msg.text}</span>}
      </div>
    </Card>
  )
}

const Label = ({ text, children }: { text: string; children: ReactNode }) => <label className="field"><span>{text}</span>{children}</label>

export function SettingsPage() {
  const { api } = useAdmin()
  const s = useAsync(() => api.settings(), [api])
  if (s.loading && !s.data) return <Loading />
  if (s.error || !s.data) return <ErrorNote message={s.error} />
  const st = s.data
  const save = async (key: string, value: unknown) => { await api.setSetting(key, value); s.reload() }

  return (
    <div className="panel-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))' }}>
      <Rules st={st} save={save} />
      <Terms st={st} save={save} />
      <Payment st={st} save={save} />
      <Notice st={st} save={save} k="announcement" title="Announcement" hint="A banner shown to every business in the app (FR and EN)." withLevel />
      <Notice st={st} save={save} k="maintenance" title="Maintenance notice" hint="Shown to every business. It informs only: it does not block anyone, so shops keep selling." />
      <Flags st={st} save={save} />
      <Templates st={st} save={save} />
      <Secret />
    </div>
  )
}

interface P { st: Obj; save: (k: string, v: unknown) => Promise<void> }

function Rules({ st, save }: P) {
  const [v, setV] = useState({ trial_days: String(st.trial_days ?? 30), grace_days: String(st.grace_days ?? 7), offline_limit_days: String(st.offline_limit_days ?? 30) })
  return (
    <Section title="Subscription rules" hint="Apply to the next licence each device receives." onSave={async () => { for (const k of Object.keys(v) as (keyof typeof v)[]) if (String(st[k]) !== v[k]) await save(k, Number(v[k])) }}>
      <Label text="Free trial (days)"><input className="input" inputMode="numeric" value={v.trial_days} onChange={(e) => setV({ ...v, trial_days: e.target.value })} /></Label>
      <Label text="Grace period after expiry (days)"><input className="input" inputMode="numeric" value={v.grace_days} onChange={(e) => setV({ ...v, grace_days: e.target.value })} /></Label>
      <Label text="Longest a device may stay offline (days)"><input className="input" inputMode="numeric" value={v.offline_limit_days} onChange={(e) => setV({ ...v, offline_limit_days: e.target.value })} /></Label>
    </Section>
  )
}

function Terms({ st, save }: P) {
  const initial = Array.isArray(st.billing_terms) ? (st.billing_terms as { months: number; bonus?: number }[]) : []
  const [rows, setRows] = useState(initial.map((t) => ({ months: String(t.months), bonus: String(t.bonus ?? 0) })))
  return (
    <Section title="Payment terms" hint="What a business can pay for at once, with free bonus months (for example 12 months + 2 free)." onSave={() => save('billing_terms', rows.map((r) => ({ months: Number(r.months), bonus: Number(r.bonus) })))}>
      {rows.map((r, i) => (
        <div key={i} className="term-row">
          <Label text="Months"><input className="input" inputMode="numeric" value={r.months} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, months: e.target.value } : x)))} /></Label>
          <Label text="Free months"><input className="input" inputMode="numeric" value={r.bonus} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, bonus: e.target.value } : x)))} /></Label>
          <Button kind="secondary" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</Button>
        </div>
      ))}
      <div><Button kind="secondary" onClick={() => setRows([...rows, { months: '1', bonus: '0' }])}>Add a term</Button></div>
    </Section>
  )
}

function Payment({ st, save }: P) {
  const m = obj(st.merchant_numbers)
  const p = obj(st.provider_config)
  const [mode, setMode] = useState(str(st.payment_mode) || 'manual')
  const [mtn, setMtn] = useState(str(m.mtn_momo))
  const [om, setOm] = useState(str(m.orange_money))
  const [prov, setProv] = useState({ name: str(p.name), enabled: Boolean(p.enabled) })
  return (
    <Section
      title="Payment collection" hint="Merchant numbers businesses send money to (9 digits starting with 6), and the payment-provider connection."
      onSave={async () => { await save('merchant_numbers', { mtn_momo: mtn.trim(), orange_money: om.trim() }); await save('payment_mode', mode); await save('provider_config', prov) }}
    >
      <Label text="MTN MoMo merchant number"><input className="input" inputMode="numeric" value={mtn} onChange={(e) => setMtn(e.target.value)} /></Label>
      <Label text="Orange Money merchant number"><input className="input" inputMode="numeric" value={om} onChange={(e) => setOm(e.target.value)} /></Label>
      <Label text="How payments are confirmed">
        <select className="input" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="manual">Manually by an administrator</option><option value="aggregator">Automatically by a payment provider</option>
        </select>
      </Label>
      <Label text="Payment provider name"><input className="input" maxLength={40} value={prov.name} onChange={(e) => setProv({ ...prov, name: e.target.value })} /></Label>
      <label className="check-row body-md"><input type="checkbox" checked={prov.enabled} onChange={(e) => setProv({ ...prov, enabled: e.target.checked })} /> Provider connection is enabled</label>
    </Section>
  )
}

function Notice({ st, save, k, title, hint, withLevel }: P & { k: 'announcement' | 'maintenance'; title: string; hint: string; withLevel?: boolean }) {
  const o = obj(st[k])
  const [v, setV] = useState({ active: Boolean(o.active), level: str(o.level) || 'info', fr: str(o.fr), en: str(o.en) })
  return (
    <Section title={title} hint={hint} onSave={() => save(k, withLevel ? v : { active: v.active, fr: v.fr, en: v.en })}>
      <label className="check-row body-md"><input type="checkbox" checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} /> Show it now</label>
      {withLevel && <Label text="Style"><select className="input" value={v.level} onChange={(e) => setV({ ...v, level: e.target.value })}><option value="info">Information</option><option value="warn">Warning</option></select></Label>}
      <Label text="Message in French (max 300)"><textarea className="input" rows={2} maxLength={300} value={v.fr} onChange={(e) => setV({ ...v, fr: e.target.value })} /></Label>
      <Label text="Message in English (max 300)"><textarea className="input" rows={2} maxLength={300} value={v.en} onChange={(e) => setV({ ...v, en: e.target.value })} /></Label>
    </Section>
  )
}

function Flags({ st, save }: P) {
  const [flags, setFlags] = useState<Record<string, boolean>>(Object.fromEntries(Object.entries(obj(st.feature_flags)).map(([k, v]) => [k, Boolean(v)])))
  const [name, setName] = useState('')
  return (
    <Section title="Feature flags" hint="Switch features on or off for every business without a new release. Names: lowercase letters and underscores." onSave={() => save('feature_flags', flags)}>
      {Object.entries(flags).map(([k, v]) => (
        <div key={k} className="panel__head">
          <label className="check-row body-md"><input type="checkbox" checked={v} onChange={(e) => setFlags({ ...flags, [k]: e.target.checked })} /> <span style={{ fontFamily: 'var(--font-ui)' }}>{k}</span></label>
          <button className="label-lg muted" style={{ textDecoration: 'underline' }} onClick={() => setFlags(Object.fromEntries(Object.entries(flags).filter(([x]) => x !== k)))}>remove</button>
        </div>
      ))}
      {Object.keys(flags).length === 0 && <p className="body-sm muted">No flags yet.</p>}
      <div className="btn-row"><input className="input" style={{ maxWidth: 220 }} placeholder="new_flag_name" aria-label="New flag name" value={name} onChange={(e) => setName(e.target.value)} /><Button kind="secondary" disabled={!name.trim()} onClick={() => { setFlags({ ...flags, [name.trim()]: false }); setName('') }}>Add</Button></div>
    </Section>
  )
}

const TEMPLATES: [string, string][] = [['payment_receipt', 'Payment received'], ['renewal_5d', 'Renewal reminder, 5 days before'], ['renewal_2d', 'Renewal reminder, 2 days before'], ['grace_started', 'Grace period started'], ['expired', 'Subscription expired'], ['debt_reminder', 'Customer debt reminder']]

function Templates({ st, save }: P) {
  const cur = obj(st.notification_templates)
  const [t, setT] = useState<Record<string, { fr: string; en: string }>>(Object.fromEntries(TEMPLATES.map(([k]) => [k, { fr: str(obj(cur[k]).fr), en: str(obj(cur[k]).en) }])))
  return (
    <Section title="Message templates" hint="Texts for WhatsApp / SMS reminders (sending will be connected later). Leave empty to use the default wording." onSave={() => save('notification_templates', Object.fromEntries(Object.entries(t).filter(([, v]) => v.fr || v.en)))}>
      {TEMPLATES.map(([k, label]) => (
        <details key={k} className="panel">
          <summary className="body-md">{label}</summary>
          <div className="stack" style={{ gap: 8 }}>
            <textarea className="input" rows={2} maxLength={600} placeholder="Français" aria-label={`${label} (French)`} value={t[k].fr} onChange={(e) => setT({ ...t, [k]: { ...t[k], fr: e.target.value } })} />
            <textarea className="input" rows={2} maxLength={600} placeholder="English" aria-label={`${label} (English)`} value={t[k].en} onChange={(e) => setT({ ...t, [k]: { ...t[k], en: e.target.value } })} />
          </div>
        </details>
      ))}
    </Section>
  )
}

function Secret() {
  const { api } = useAdmin()
  const [secret, setSecret] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  return (
    <Card title="Payment webhook secret">
      <p className="body-sm muted" style={{ marginBottom: 15 }}>The payment provider signs its notifications with this secret. Revealing it is recorded in the audit log. Never paste it in chat or email.</p>
      {secret ? <code className="body-sm" style={{ display: 'block', wordBreak: 'break-all', background: 'var(--bg-base)', borderRadius: 'var(--radius-4)', padding: 10 }}>{secret}</code> : <Button kind="secondary" onClick={() => { setError(null); api.webhookSecret().then(setSecret, (e: unknown) => setError(e instanceof Error ? e.message : 'Failed')) }}>Reveal secret</Button>}
      <ErrorNote message={error} />
    </Card>
  )
}
