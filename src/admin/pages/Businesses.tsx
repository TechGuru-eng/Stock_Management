import { useState } from 'react'
import type { BusinessRow, SupportDetail } from '../api'
import { useAdmin } from '../ctx'
import { can } from '../permissions'
import { ago, Badge, Button, Card, ErrorNote, fmtDate, fmtTime, fmtXaf, inputCls, Loading, ReasonDialog, useAsync } from '../ui'

const STATES = ['', 'trial', 'active', 'grace', 'expired', 'suspended']

export function Businesses() {
  const { api } = useAdmin()
  const [search, setSearch] = useState('')
  const [state, setState] = useState('')
  const [picked, setPicked] = useState<BusinessRow | null>(null)
  const list = useAsync(() => api.businesses(search, state), [api, search, state])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <input className={`${inputCls} max-w-xs`} placeholder="Search by business name" aria-label="Search businesses" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className={`${inputCls} max-w-[11rem]`} aria-label="Filter by status" value={state} onChange={(e) => setState(e.target.value)}>
          {STATES.map((s) => <option key={s} value={s}>{s ? s : 'All statuses'}</option>)}
        </select>
      </div>

      {list.loading && !list.data ? <Loading /> : <ErrorNote message={list.error} />}
      {list.data && (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr><th className="p-3 font-medium">Business</th><th className="p-3 font-medium">Plan</th><th className="p-3 font-medium">Status</th><th className="p-3 font-medium">Paid until</th><th className="p-3 font-medium">Last sync</th><th className="p-3 font-medium">Issues</th></tr>
            </thead>
            <tbody>
              {list.data.map((b) => (
                <tr key={b.id} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => setPicked(b)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setPicked(b)}>
                  <td className="p-3"><div className="font-medium">{b.name}</div><div className="text-xs text-slate-500">{b.town ?? '—'} · {b.owner_phone_masked ?? 'no phone'}</div></td>
                  <td className="p-3">{b.plan_code}</td>
                  <td className="p-3"><Badge value={b.state} /></td>
                  <td className="p-3 tabular-nums">{fmtDate(b.period_end)}</td>
                  <td className="p-3">{ago(b.last_sync)}</td>
                  <td className="p-3">{b.open_issues > 0 ? <span className="font-medium text-amber-700">{b.open_issues}</span> : '—'}</td>
                </tr>
              ))}
              {list.data.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-slate-500">No business matches.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {picked && <Panel b={picked} onClose={() => setPicked(null)} onChanged={() => { list.reload(); setPicked(null) }} />}
    </div>
  )
}

function Panel({ b, onClose, onChanged }: { b: BusinessRow; onClose: () => void; onChanged: () => void }) {
  const { api, role } = useAdmin()
  const [dlg, setDlg] = useState<null | 'suspend' | 'reactivate' | 'extend' | 'support'>(null)
  const [days, setDays] = useState(7)
  const [grant, setGrant] = useState<string | null>(null)
  const detail = useAsync<SupportDetail | null>(() => (grant ? api.supportDetail(b.id) : Promise.resolve(null)), [api, b.id, grant])

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/40" role="dialog" aria-modal="true" aria-label={`Business ${b.name}`}>
      <div className="h-full w-full max-w-lg overflow-y-auto bg-slate-50 p-4 shadow-xl">
        <div className="mb-3 flex items-start justify-between gap-2">
          <div><h2 className="text-lg font-semibold">{b.name}</h2><div className="text-sm text-slate-600">{b.town ?? '—'} · {b.category ?? '—'}</div></div>
          <Button kind="secondary" onClick={() => { if (grant) void api.endSupport(grant).catch(() => undefined); onClose() }}>Close</Button>
        </div>

        <Card title="Subscription">
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <div><dt className="text-slate-500">Plan</dt><dd className="font-medium">{b.plan_code}</dd></div>
            <div><dt className="text-slate-500">Status</dt><dd><Badge value={b.state} /></dd></div>
            <div><dt className="text-slate-500">Paid until</dt><dd className="font-medium">{fmtDate(b.period_end)}</dd></div>
            <div><dt className="text-slate-500">Shops / staff</dt><dd className="font-medium">{b.shops} / {b.staff}</dd></div>
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            {can(role, 'billing') && <Button kind="secondary" onClick={() => setDlg('extend')}>Extend subscription</Button>}
            {can(role, 'businesses') && (b.state === 'suspended'
              ? <Button onClick={() => setDlg('reactivate')}>Reactivate</Button>
              : <Button kind="danger" onClick={() => setDlg('suspend')}>Suspend</Button>)}
          </div>
        </Card>

        {can(role, 'support') && (
          <div className="mt-3">
            <Card title="Support session">
              {!grant ? (
                <>
                  <p className="mb-3 text-sm text-slate-600">To see this business’s devices, staff list and sync problems you must start a support session. It lasts one hour, the owner can see that it happened, and no sales, customers or money are ever shown.</p>
                  <Button onClick={() => setDlg('support')}>Start support session</Button>
                </>
              ) : detail.loading ? <Loading /> : detail.error ? <ErrorNote message={detail.error} /> : detail.data && <SupportView d={detail.data} onEnd={() => { void api.endSupport(grant).then(() => setGrant(null)) }} />}
            </Card>
          </div>
        )}
      </div>

      {dlg === 'suspend' && <ReasonDialog danger title={`Suspend ${b.name}?`} description="The business becomes read-only on every device until you reactivate it. Nothing is deleted." confirmText="Suspend" onConfirm={async (r) => { await api.setSuspension(b.id, true, r); onChanged() }} onClose={() => setDlg(null)} />}
      {dlg === 'reactivate' && <ReasonDialog title={`Reactivate ${b.name}?`} confirmText="Reactivate" onConfirm={async (r) => { await api.setSuspension(b.id, false, r); onChanged() }} onClose={() => setDlg(null)} />}
      {dlg === 'extend' && (
        <ReasonDialog
          title={`Extend ${b.name}`} description="Adds free days to the paid-until date (goodwill, or a payment problem on our side)." confirmText="Extend"
          extra={<label className="block text-sm font-medium text-slate-700">Days to add (1–90)<input className={`${inputCls} mt-1`} type="number" min={1} max={90} value={days} onChange={(e) => setDays(Number(e.target.value))} /></label>}
          onConfirm={async (r) => { await api.extendTrial(b.id, days, r); onChanged() }} onClose={() => setDlg(null)}
        />
      )}
      {dlg === 'support' && <ReasonDialog title="Start a support session" description="Say why you need to look at this account. The business owner will see this." label="Why" minLength={10} confirmText="Start for 1 hour" onConfirm={async (r) => { setGrant(await api.startSupport(b.id, r)) }} onClose={() => setDlg(null)} />}
    </div>
  )
}

function SupportView({ d, onEnd }: { d: SupportDetail; onEnd: () => void }) {
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between"><span className="text-xs font-medium text-emerald-700">Support session open · operational information only</span><Button kind="secondary" onClick={onEnd}>End session</Button></div>
      <div><div className="text-xs text-slate-500">Owner</div><div>{d.owner?.name ?? '—'} · {d.owner?.phone ?? '—'} · {d.owner?.town ?? '—'}</div></div>
      <div><div className="text-xs text-slate-500">Usage</div><div>{d.usage.shops} shops · {d.usage.staff} staff · {d.usage.products} products</div></div>
      <div>
        <div className="text-xs text-slate-500">Devices</div>
        {d.devices.length === 0 ? <div>None</div> : <ul>{d.devices.map((x) => <li key={x.id}>{x.name ?? 'Device'} — last sync {ago(x.last_sync_at)}{x.revoked ? ' (revoked)' : ''}</li>)}</ul>}
      </div>
      <div>
        <div className="text-xs text-slate-500">Staff accounts</div>
        {d.staff.length === 0 ? <div>None</div> : <ul>{d.staff.map((s, i) => <li key={i}>{s.name ?? '—'} — {s.role}{s.active ? '' : ' (disabled)'}</li>)}</ul>}
      </div>
      <div>
        <div className="text-xs text-slate-500">Sync problems</div>
        {d.sync_issues.length === 0 ? <div>None</div> : <ul>{d.sync_issues.map((s, i) => <li key={i}>{s.kind}: {s.error ?? '—'} · {fmtTime(s.last_seen)}{s.resolved ? ' (resolved)' : ''}</li>)}</ul>}
      </div>
      <div>
        <div className="text-xs text-slate-500">Subscription payments</div>
        {d.payments.length === 0 ? <div>None</div> : <ul>{d.payments.map((p) => <li key={p.reference}>{p.reference} · {fmtXaf(p.amount)} · <Badge value={p.status} /></li>)}</ul>}
      </div>
      <div>
        <div className="text-xs text-slate-500">Recent activity (what happened, not the content)</div>
        <ul>{d.recent_actions.slice(0, 8).map((a, i) => <li key={i}>{a.action} · {fmtTime(a.at)}</li>)}</ul>
      </div>
    </div>
  )
}
