import { useState } from 'react'
import type { PlanInput, PlanRow } from '../api'
import { useAdmin } from '../ctx'
import { Button, Card, ErrorNote, fmtXaf, inputCls, Loading, useAsync } from '../ui'

const num = (v: string): number | null => (v.trim() === '' ? null : Number(v))
const show = (n: number | null) => (n == null ? '' : String(n))

export function Plans() {
  const { api } = useAdmin()
  const list = useAsync(() => api.plans(), [api])
  const [edit, setEdit] = useState<PlanRow | 'new' | null>(null)

  if (list.loading && !list.data) return <Loading />
  return (
    <div className="space-y-4">
      <ErrorNote message={list.error} />
      <p className="text-sm text-slate-600">An empty limit means “unlimited”. A price change applies to the next payment; it never changes a payment already made. Businesses on a plan keep their limits from the signed licence on their devices until they next connect.</p>
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[40rem] text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500"><tr><th className="p-3 font-medium">Plan</th><th className="p-3 font-medium">Price / month</th><th className="p-3 font-medium">Shops</th><th className="p-3 font-medium">Staff</th><th className="p-3 font-medium">Products</th><th className="p-3 font-medium">Subscribers</th><th className="p-3" /></tr></thead>
          <tbody>
            {list.data?.map((p) => (
              <tr key={p.code} className="border-t border-slate-100">
                <td className="p-3"><div className="font-medium">{p.name}</div><div className="text-xs text-slate-500">{p.code}{p.active ? '' : ' · hidden'}</div></td>
                <td className="p-3 tabular-nums">{p.price_xaf == null ? 'Custom' : fmtXaf(p.price_xaf)}</td>
                <td className="p-3">{p.max_shops ?? '∞'}</td><td className="p-3">{p.max_staff ?? '∞'}</td><td className="p-3">{p.max_products ?? '∞'}</td>
                <td className="p-3">{p.subscribers}</td>
                <td className="p-3 text-right"><Button kind="secondary" onClick={() => setEdit(p)}>Edit</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button onClick={() => setEdit('new')}>Add a plan</Button>
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
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }))

  async function save() {
    setBusy(true); setError(null)
    const input: PlanInput = { code: f.code.trim(), name: f.name.trim(), price: num(f.price), shops: num(f.shops), staff: num(f.staff), products: num(f.products), active: f.active }
    try { await api.savePlan(input); onDone() } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); setBusy(false) }
  }

  const field = (k: 'name' | 'price' | 'shops' | 'staff' | 'products', label: string, hint?: string) => (
    <label className="block text-sm font-medium text-slate-700">{label}{hint && <span className="font-normal text-slate-500"> ({hint})</span>}
      <input className={`${inputCls} mt-1`} value={f[k]} inputMode={k === 'name' ? 'text' : 'numeric'} onChange={(e) => set(k, e.target.value)} />
    </label>
  )

  return (
    <Card title={plan ? `Edit ${plan.name}` : 'New plan'}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium text-slate-700">Code <span className="font-normal text-slate-500">(lowercase letters, cannot change later)</span>
          <input className={`${inputCls} mt-1`} value={f.code} disabled={Boolean(plan)} onChange={(e) => set('code', e.target.value)} />
        </label>
        {field('name', 'Name')}
        {field('price', 'Price per month in FCFA', 'empty = custom quote')}
        {field('shops', 'Max shops', 'empty = unlimited')}
        {field('staff', 'Max staff', 'empty = unlimited')}
        {field('products', 'Max products', 'empty = unlimited')}
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> Offer this plan to businesses</label>
      <div className="mt-3"><ErrorNote message={error} /></div>
      <div className="mt-3 flex gap-2"><Button disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save plan'}</Button><Button kind="secondary" onClick={onDone}>Cancel</Button></div>
    </Card>
  )
}
