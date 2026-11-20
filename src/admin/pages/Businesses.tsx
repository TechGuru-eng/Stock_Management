import { useState } from 'react'
import type { BusinessRow, SupportDetail } from '../api'
import { useAdmin } from '../ctx'
import { can } from '../permissions'
import { ago, Badge, Button, Card, ErrorNote, fmtDate, fmtTime, fmtXaf, Loading, ReasonDialog, useAsync } from '../ui'

const STATES = ['', 'trial', 'active', 'grace', 'expired', 'suspended']

export function Businesses() {
  const { api } = useAdmin()
  const [search, setSearch] = useState('')
  const [state, setState] = useState('')
  const [picked, setPicked] = useState<BusinessRow | null>(null)
  const list = useAsync(() => api.businesses(search, state), [api, search, state])

  return (
    <div className="stack">
      <div className="btn-row">
        <input className="input" style={{ maxWidth: 260 }} placeholder="Search by business name" aria-label="Search businesses" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="input" style={{ maxWidth: 180 }} aria-label="Filter by status" value={state} onChange={(e) => setState(e.target.value)}>
          {STATES.map((s) => <option key={s} value={s}>{s ? s : 'All statuses'}</option>)}
        </select>
      </div>

      {list.loading && !list.data ? <Loading /> : <ErrorNote message={list.error} />}
      {list.data && (
        <div className="table-wrap">
          <table className="table" style={{ minWidth: '40rem' }}>
            <thead>
              <tr><th>Business</th><th>Plan</th><th>Status</th><th>Paid until</th><th>Last sync</th><th>Issues</th></tr>
            </thead>
            <tbody>
              {list.data.map((b) => (
                <tr key={b.id} style={{ cursor: 'pointer' }} onClick={() => setPicked(b)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setPicked(b)}>
                  <td><div className="body-md">{b.name}</div><div className="body-sm muted">{b.town ?? '—'} · {b.owner_phone_masked ?? 'no phone'}</div></td>
                  <td>{b.plan_code}</td>
                  <td><Badge value={b.state} /></td>
                  <td className="num">{fmtDate(b.period_end)}</td>
                  <td>{ago(b.last_sync)}</td>
                  <td>{b.open_issues > 0 ? <span className="tag tag--flag">{b.open_issues}</span> : '—'}</td>
                </tr>
              ))}
              {list.data.length === 0 && <tr><td colSpan={6} className="table-empty">No business matches.</td></tr>}
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
    <div className="side-panel-overlay" role="dialog" aria-modal="true" aria-label={`Business ${b.name}`}>
      <div className="side-panel">
        <div className="panel__head" style={{ alignItems: 'flex-start' }}>
          <div><h2 className="h4">{b.name}</h2><div className="body-md muted">{b.town ?? '—'} · {b.category ?? '—'}</div></div>
          <Button kind="secondary" onClick={() => { if (grant) void api.endSupport(grant).catch(() => undefined); onClose() }}>Close</Button>
        </div>

        <Card title="Subscription">
          <dl className="kv-grid">
            <div><dt>Plan</dt><dd className="body-md">{b.plan_code}</dd></div>
            <div><dt>Status</dt><dd><Badge value={b.state} /></dd></div>
            <div><dt>Paid until</dt><dd className="body-md">{fmtDate(b.period_end)}</dd></div>
            <div><dt>Shops / staff</dt><dd className="body-md">{b.shops} / {b.staff}</dd></div>
          </dl>
          <div className="btn-row" style={{ marginTop: 15 }}>
            {can(role, 'billing') && <Button kind="secondary" onClick={() => setDlg('extend')}>Extend subscription</Button>}
            {can(role, 'businesses') && (b.state === 'suspended'
              ? <Button onClick={() => setDlg('reactivate')}>Reactivate</Button>
              : <Button kind="danger" onClick={() => setDlg('suspend')}>Suspend</Button>)}
          </div>
        </Card>

        {can(role, 'support') && (
          <Card title="Support session">
            {!grant ? (
              <>
                <p className="body-md muted" style={{ marginBottom: 15 }}>To see this business’s devices, staff list and sync problems you must start a support session. It lasts one hour, the owner can see that it happened, and no sales, customers or money are ever shown.</p>
                <Button onClick={() => setDlg('support')}>Start support session</Button>
              </>
            ) : detail.loading ? <Loading /> : detail.error ? <ErrorNote message={detail.error} /> : detail.data && <SupportView d={detail.data} onEnd={() => { void api.endSupport(grant).then(() => setGrant(null)) }} />}
          </Card>
        )}
      </div>

      {dlg === 'suspend' && <ReasonDialog danger title={`Suspend ${b.name}?`} description="The business becomes read-only on every device until you reactivate it. Nothing is deleted." confirmText="Suspend" onConfirm={async (r) => { await api.setSuspension(b.id, true, r); onChanged() }} onClose={() => setDlg(null)} />}
      {dlg === 'reactivate' && <ReasonDialog title={`Reactivate ${b.name}?`} confirmText="Reactivate" onConfirm={async (r) => { await api.setSuspension(b.id, false, r); onChanged() }} onClose={() => setDlg(null)} />}
      {dlg === 'extend' && (
        <ReasonDialog
          title={`Extend ${b.name}`} description="Adds free days to the paid-until date (goodwill, or a payment problem on our side)." confirmText="Extend"
          extra={<label className="field"><span>Days to add (1–90)</span><input className="input" type="number" min={1} max={90} value={days} onChange={(e) => setDays(Number(e.target.value))} /></label>}
          onConfirm={async (r) => { await api.extendTrial(b.id, days, r); onChanged() }} onClose={() => setDlg(null)}
        />
      )}
      {dlg === 'support' && <ReasonDialog title="Start a support session" description="Say why you need to look at this account. The business owner will see this." label="Why" minLength={10} confirmText="Start for 1 hour" onConfirm={async (r) => { setGrant(await api.startSupport(b.id, r)) }} onClose={() => setDlg(null)} />}
    </div>
  )
}

function SupportView({ d, onEnd }: { d: SupportDetail; onEnd: () => void }) {
  return (
    <div className="stack body-md">
      <div className="panel__head"><span className="label-lg">Support session open · operational information only</span><Button kind="secondary" onClick={onEnd}>End session</Button></div>
      <div><div className="label-lg muted">Owner</div><div>{d.owner?.name ?? '—'} · {d.owner?.phone ?? '—'} · {d.owner?.town ?? '—'}</div></div>
      <div><div className="label-lg muted">Usage</div><div>{d.usage.shops} shops · {d.usage.staff} staff · {d.usage.products} products</div></div>
      <div>
        <div className="label-lg muted">Devices</div>
        {d.devices.length === 0 ? <div>None</div> : <ul className="stack" style={{ gap: 4 }}>{d.devices.map((x) => <li key={x.id}>{x.name ?? 'Device'} — last sync {ago(x.last_sync_at)}{x.revoked ? ' (revoked)' : ''}</li>)}</ul>}
      </div>
      <div>
        <div className="label-lg muted">Staff accounts</div>
        {d.staff.length === 0 ? <div>None</div> : <ul className="stack" style={{ gap: 4 }}>{d.staff.map((s, i) => <li key={i}>{s.name ?? '—'} — {s.role}{s.active ? '' : ' (disabled)'}</li>)}</ul>}
      </div>
      <div>
        <div className="label-lg muted">Sync problems</div>
        {d.sync_issues.length === 0 ? <div>None</div> : <ul className="stack" style={{ gap: 4 }}>{d.sync_issues.map((s, i) => <li key={i}>{s.kind}: {s.error ?? '—'} · {fmtTime(s.last_seen)}{s.resolved ? ' (resolved)' : ''}</li>)}</ul>}
      </div>
      <div>
        <div className="label-lg muted">Subscription payments</div>
        {d.payments.length === 0 ? <div>None</div> : <ul className="stack" style={{ gap: 4 }}>{d.payments.map((p) => <li key={p.reference}>{p.reference} · {fmtXaf(p.amount)} · <Badge value={p.status} /></li>)}</ul>}
      </div>
      <div>
        <div className="label-lg muted">Recent activity (what happened, not the content)</div>
        <ul className="stack" style={{ gap: 4 }}>{d.recent_actions.slice(0, 8).map((a, i) => <li key={i}>{a.action} · {fmtTime(a.at)}</li>)}</ul>
      </div>
    </div>
  )
}
