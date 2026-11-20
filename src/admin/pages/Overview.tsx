import { useAdmin } from '../ctx'
import { can } from '../permissions'
import { Card, ErrorNote, fmtXaf, Loading, Stat, useAsync } from '../ui'

export function Overview() {
  const { api, role } = useAdmin()
  const o = useAsync(() => api.overview(), [api])
  const rev = useAsync(() => (can(role, 'revenue') ? api.revenue() : Promise.resolve(null)), [api, role])

  if (o.loading) return <Loading />
  if (o.error || !o.data) return <ErrorNote message={o.error} />
  const d = o.data

  return (
    <div className="stack">
      <div className="panel-grid">
        <Stat label="Businesses" value={d.businesses} hint={`${d.active_shops} active shops`} />
        <Stat label="Paying" value={d.paying} hint={`${d.trial} on trial`} />
        <Stat label="In grace period" value={d.grace} tone={d.grace > 0 ? 'warn' : undefined} hint="Payment overdue, still working" />
        <Stat label="Expired / suspended" value={`${d.expired} / ${d.suspended}`} tone={d.expired > 0 ? 'bad' : undefined} />
        <Stat label="Monthly revenue (estimate)" value={fmtXaf(d.mrr_estimate)} hint="List price of every paying plan" />
        <Stat label="Revenue, last 30 days" value={fmtXaf(d.revenue_30d)} hint="Confirmed invoices" />
        <Stat label="Payments to check" value={d.payments_pending} tone={d.payments_pending > 0 ? 'warn' : undefined} hint={`${d.payment_failures_30d} failed in 30 days`} />
        <Stat label="Open sync problems" value={d.open_sync_issues} tone={d.open_sync_issues > 0 ? 'warn' : undefined} />
      </div>

      <Card title="Device sync health">
        <div className="panel-grid">
          <div><div className="label-lg muted">Devices</div><div className="h5">{d.devices.total}</div></div>
          <div><div className="label-lg muted">Synced in 24 h</div><div className="h5">{d.devices.synced_24h}</div></div>
          <div><div className="label-lg muted">Silent over 48 h</div><div className="h5">{d.devices.stale_over_48h}</div></div>
          <div><div className="label-lg muted">Silent over 30 days</div><div className="h5">{d.devices.stale_over_30d > 0 ? `! ${d.devices.stale_over_30d}` : d.devices.stale_over_30d}</div></div>
        </div>
        <p className="body-sm muted" style={{ marginTop: 10 }}>Devices silent for 30 days are in read-only mode until they connect.</p>
      </Card>

      {rev.data && (
        <div className="panel-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
          <Card title="Revenue by month">
            <Table head={['Month', 'Invoices', 'Amount']} rows={rev.data.by_month.map((m) => [m.month, String(m.invoices), fmtXaf(m.amount)])} empty="No invoices yet." />
          </Card>
          <Card title="Revenue by plan (12 months)">
            <Table head={['Plan', 'Invoices', 'Amount']} rows={rev.data.by_plan.map((m) => [m.plan_code, String(m.invoices), fmtXaf(m.amount)])} empty="No invoices yet." />
          </Card>
        </div>
      )}
    </div>
  )
}

function Table({ head, rows, empty }: { head: string[]; rows: string[][]; empty: string }) {
  if (!rows.length) return <p className="body-sm muted">{empty}</p>
  return (
    <table className="table">
      <thead><tr>{head.map((h, i) => <th key={h} className={i ? 'num' : undefined}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r) => <tr key={r[0]}>{r.map((c, i) => <td key={i} className={i ? 'num' : undefined}>{c}</td>)}</tr>)}</tbody>
    </table>
  )
}
