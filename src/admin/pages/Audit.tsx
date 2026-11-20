import { useAdmin } from '../ctx'
import { ErrorNote, fmtTime, Loading, useAsync } from '../ui'

export function Audit() {
  const { api } = useAdmin()
  const log = useAsync(() => api.audit(200), [api])
  if (log.loading && !log.data) return <Loading />
  return (
    <div className="stack">
      <p className="body-sm muted">Every administrator action and every sensitive view, newest first. This record cannot be edited or deleted.</p>
      <ErrorNote message={log.error} />
      <div className="table-wrap">
        <table className="table" style={{ minWidth: '40rem' }}>
          <thead><tr><th>When</th><th>Action</th><th>Business</th><th>Details</th><th>Admin</th></tr></thead>
          <tbody>
            {log.data?.map((r) => (
              <tr key={r.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtTime(r.at)}</td>
                <td className="body-sm" style={{ fontFamily: 'var(--font-ui)' }}>{r.action}</td>
                <td>{r.business ?? '—'}</td>
                <td className="body-sm muted" style={{ maxWidth: '20rem', wordBreak: 'break-word' }}>{r.detail ? Object.entries(r.detail).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ') : ''}</td>
                <td className="body-sm muted" style={{ fontFamily: 'var(--font-ui)' }}>{r.admin_id.slice(0, 8)}</td>
              </tr>
            ))}
            {log.data?.length === 0 && <tr><td colSpan={5} className="table-empty">Nothing recorded yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
