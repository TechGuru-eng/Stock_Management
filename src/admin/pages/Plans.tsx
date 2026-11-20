import { useState } from 'react'
import type { PlanInput, PlanRow } from '../api'
import { useAdmin } from '../ctx'
import { Button, Card, ErrorNote, fmtXaf, Loading, useAsync } from '../ui'

const num = (v: string): number | null => (v.trim() === '' ? null : Number(v))
const show = (n: number | null) => (n == null ? '' : String(n))
const FEATURES: { key: string; label: string }[] = [
  { key: 'verified_momo', label: 'Verified mobile money at the till' },
  { key: 'loyalty', label: 'Customer loyalty points' },
]

export function Plans() {
  const { api } = useAdmin()
  const list = useAsync(() => api.plans(), [api])
  const [edit, setEdit] = useState<PlanRow | 'new' | null>(null)

  if (list.loading && !list.data) return <Loading />
  return (
    <div className="stack">
      <ErrorNote message={list.error} />
      <p className="body-sm muted">An empty limit means “unlimited”. A price change applies to the next payment; it never changes a payment already made. Businesses on a plan keep their limits from the signed licence on their devices until they next connect.</p>
      <div className="table-wrap">
        <table className="table" style={{ minWidth: '40rem' }}>
          <thead><tr><th>Plan</th><th>Price / month</th><th>Shops</th><th>Staff</th><th>Products</th><th>Features</th><th>Subscribers</th><th /></tr></thead>
          <tbody>
            {list.data?.map((p) => (
              <tr key={p.code}>
                <td><div className="body-md">{p.name}</div><div className="body-sm muted">{p.code}{p.active ? '' : ' · hidden'}</div></td>
                <td className="num">{p.price_xaf == null ? 'Custom' : fmtXaf(p.price_xaf)}</td>
                <td>{p.max_shops ?? '∞'}</td><td>{p.max_staff ?? '∞'}</td><td>{p.max_products ?? '∞'}</td>
                <td className="body-sm muted">{p.features.length ? p.features.join(', ') : '—'}</td>
                <td>{p.subscribers}</td>
                <td style={{ textAlign: 'right' }}><Button kind="secondary" onClick={() => setEdit(p)}>Edit</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div><Button onClick={() => setEdit('new')}>Add a plan</Button></div>
      {edit && <PlanForm plan={edit === 'new' ? null : edit} onDone={() => { setEdit(null); list.reload() }} />}
    </div>
  )
}

function PlanForm({ plan, onDone }: { plan: PlanRow | null; onDone: () => void }) {
  const { api } = useAdmin()
  const [f, setF] = useState({
    code: plan?.code ?? '', name: plan?.name ?? '', price: show(plan?.price_xaf ?? null), shops: show(plan?.max_shops ?? null),
    staff: show(plan?.max_staff ?? null), products: show(plan?.max_products ?? null), active: plan?.active ?? true,
  })
  const [features, setFeatures] = useState<Set<string>>(new Set(plan?.features ?? []))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }))
  const toggleFeature = (key: string) => setFeatures((s) => { const next = new Set(s); if (next.has(key)) next.delete(key); else next.add(key); return next })

  async function save() {
    setBusy(true); setError(null)
    const input: PlanInput = { code: f.code.trim(), name: f.name.trim(), price: num(f.price), shops: num(f.shops), staff: num(f.staff), products: num(f.products), features: [...features], active: f.active }
    try { await api.savePlan(input); onDone() } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); setBusy(false) }
  }

  const field = (k: 'name' | 'price' | 'shops' | 'staff' | 'products', label: string, hint?: string) => (
    <label className="field"><span>{label}{hint && <span style={{ textTransform: 'none' }}> ({hint})</span>}</span>
      <input className="input" value={f[k]} inputMode={k === 'name' ? 'text' : 'numeric'} onChange={(e) => set(k, e.target.value)} />
    </label>
  )

  return (
    <Card title={plan ? `Edit ${plan.name}` : 'New plan'}>
      <div className="stack">
        <div className="panel-grid">
          <label className="field"><span>Code <span style={{ textTransform: 'none' }}>(lowercase letters, cannot change later)</span></span>
            <input className="input" value={f.code} disabled={Boolean(plan)} onChange={(e) => set('code', e.target.value)} />
          </label>
          {field('name', 'Name')}
          {field('price', 'Price per month in FCFA', 'empty = custom quote')}
          {field('shops', 'Max shops', 'empty = unlimited')}
          {field('staff', 'Max staff', 'empty = unlimited')}
          {field('products', 'Max products', 'empty = unlimited')}
        </div>
        <fieldset className="stack" style={{ gap: 8 }}>
          <legend className="label-lg muted" style={{ marginBottom: 4 }}>Features</legend>
          {FEATURES.map((ft) => (
            <label key={ft.key} className="check-row body-md">
              <input type="checkbox" checked={features.has(ft.key)} onChange={() => toggleFeature(ft.key)} /> {ft.label}
            </label>
          ))}
        </fieldset>
        <label className="check-row body-md"><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> Offer this plan to businesses</label>
        <ErrorNote message={error} />
        <div className="btn-row"><Button disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save plan'}</Button><Button kind="secondary" onClick={onDone}>Cancel</Button></div>
      </div>
    </Card>
  )
}
