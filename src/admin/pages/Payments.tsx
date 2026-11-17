import { useState } from 'react'
import type { PaymentRow } from '../api'
import { useAdmin } from '../ctx'
import { Badge, Button, ErrorNote, fmtTime, fmtXaf, inputCls, Loading, ReasonDialog, useAsync } from '../ui'

const FILTERS = [['', 'All'], ['pending', 'To check'], ['recorded', 'Confirmed by admin'], ['provider_verified', 'Confirmed by provider'], ['failed', 'Rejected / failed']]

export function Payments() {
  const { api } = useAdmin()
  const [status, setStatus] = useState('pending')
  const list = useAsync(() => api.payments(status), [api, status])
  const [act, setAct] = useState<{ p: PaymentRow; kind: 'confirm' | 'reject' } | null>(null)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select className={`${inputCls} max-w-[14rem]`} aria-label="Filter payments" value={status} onChange={(e) => setStatus(e.target.value)}>
          {FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <p className="text-xs text-slate-500">Confirm a payment only after you have seen the money arrive on the MoMo / Orange Money merchant account. The reference, sender and time you type are saved in the audit log.</p>
      </div>
      {list.loading && !list.data ? <Loading /> : <ErrorNote message={list.error} />}
      {list.data && (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[44rem] text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500"><tr><th className="p-3 font-medium">Reference</th><th className="p-3 font-medium">Business</th><th className="p-3 font-medium">Amount</th><th className="p-3 font-medium">Method</th><th className="p-3 font-medium">Status</th><th className="p-3 font-medium">Started</th><th className="p-3" /></tr></thead>
            <tbody>
              {list.data.map((p) => (
                <tr key={p.id} className="border-t border-slate-100 align-top">
                  <td className="p-3 font-mono text-xs">{p.reference}</td>
                  <td className="p-3"><div className="font-medium">{p.business}</div><div className="text-xs text-slate-500">{p.plan_code} · {p.kind}</div></td>
                  <td className="p-3 tabular-nums">{fmtXaf(p.amount)}</td>
                  <td className="p-3">{p.method === 'mtn_momo' ? 'MTN MoMo' : 'Orange Money'}<div className="text-xs text-slate-500">{p.phone ?? ''}</div></td>
                  <td className="p-3"><Badge value={p.status} />{p.note && <div className="mt-1 max-w-[14rem] text-xs text-slate-500">{p.note}</div>}</td>
                  <td className="p-3">{fmtTime(p.created_at)}</td>
                  <td className="p-3 text-right">
                    {p.status === 'pending' && <div className="flex justify-end gap-2"><Button onClick={() => setAct({ p, kind: 'confirm' })}>Confirm</Button><Button kind="secondary" onClick={() => setAct({ p, kind: 'reject' })}>Reject</Button></div>}
                  </td>
                </tr>
              ))}
              {list.data.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-slate-500">Nothing here.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {act?.kind === 'confirm' && (
        <ReasonDialog title={`Confirm ${fmtXaf(act.p.amount)} from ${act.p.business}?`} description="This extends the subscription and issues the invoice. It cannot be undone." label="Proof you saw" minLength={5} confirmText="Confirm payment"
          onConfirm={async (r) => { await api.confirmPayment(act.p.id, r); list.reload() }} onClose={() => setAct(null)} />
      )}
      {act?.kind === 'reject' && (
        <ReasonDialog danger title={`Reject payment ${act.p.reference}?`} description="Use this when the money never arrived or the amount was wrong. The business can start a new payment." confirmText="Reject"
          onConfirm={async (r) => { await api.rejectPayment(act.p.id, r); list.reload() }} onClose={() => setAct(null)} />
      )}
    </div>
  )
}
