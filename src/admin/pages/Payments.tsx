import { useState } from 'react'
import type { PaymentRow } from '../api'
import { useAdmin } from '../ctx'
import { Badge, Button, ErrorNote, fmtTime, fmtXaf, Loading, ReasonDialog, useAsync } from '../ui'

const FILTERS = [['', 'All'], ['pending', 'To check'], ['recorded', 'Confirmed by admin'], ['provider_verified', 'Confirmed by provider'], ['failed', 'Rejected / failed']]

export function Payments() {
  const { api } = useAdmin()
  const [status, setStatus] = useState('pending')
  const list = useAsync(() => api.payments(status), [api, status])
  const [act, setAct] = useState<{ p: PaymentRow; kind: 'confirm' | 'reject' } | null>(null)

  return (
    <div className="stack">
      <div className="btn-row" style={{ alignItems: 'center' }}>
        <select className="input" style={{ maxWidth: 220 }} aria-label="Filter payments" value={status} onChange={(e) => setStatus(e.target.value)}>
          {FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <p className="body-sm muted">Confirm a payment only after you have seen the money arrive on the MoMo / Orange Money merchant account. The reference, sender and time you type are saved in the audit log.</p>
      </div>
      {list.loading && !list.data ? <Loading /> : <ErrorNote message={list.error} />}
      {list.data && (
        <div className="table-wrap">
          <table className="table" style={{ minWidth: '44rem' }}>
            <thead><tr><th>Reference</th><th>Business</th><th>Amount</th><th>Method</th><th>Status</th><th>Started</th><th /></tr></thead>
            <tbody>
              {list.data.map((p) => (
                <tr key={p.id}>
                  <td className="body-sm" style={{ fontFamily: 'var(--font-ui)' }}>{p.reference}</td>
                  <td><div className="body-md">{p.business}</div><div className="body-sm muted">{p.plan_code} · {p.kind}</div></td>
                  <td className="num">{fmtXaf(p.amount)}</td>
                  <td>{p.method === 'mtn_momo' ? 'MTN MoMo' : 'Orange Money'}<div className="body-sm muted">{p.phone ?? ''}</div></td>
                  <td><Badge value={p.status} />{p.note && <div className="body-sm muted" style={{ marginTop: 4, maxWidth: '14rem' }}>{p.note}</div>}</td>
                  <td>{fmtTime(p.created_at)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {p.status === 'pending' && <div className="btn-row" style={{ justifyContent: 'flex-end' }}><Button onClick={() => setAct({ p, kind: 'confirm' })}>Confirm</Button><Button kind="secondary" onClick={() => setAct({ p, kind: 'reject' })}>Reject</Button></div>}
                  </td>
                </tr>
              ))}
              {list.data.length === 0 && <tr><td colSpan={7} className="table-empty">Nothing here.</td></tr>}
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
