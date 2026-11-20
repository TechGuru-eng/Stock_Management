import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../auth/AuthProvider'
import { downloadText, reportFileName, toCsv, type Column } from '../../domain/csv'
import { formatXaf } from '../../domain/money'
import { can } from '../../domain/permissions'
import { dayEnd, dayStart, localDate, periodPreset, type PeriodKind } from '../../domain/reportTables'
import { QuickReminder } from '../money/DebtReminder'
import { useReport } from './useReport'

const input = 'input'
const btn2 = 'btn btn--secondary btn--sm print:hidden'
const KINDS: PeriodKind[] = ['today', 'last7', 'thisMonth', 'lastMonth']

function Section({ title, onExport, children }: { title: string; onExport?: () => void; children: ReactNode }) {
  const { t } = useTranslation()
  return (
    <section className="panel" style={{ breakInside: 'avoid' }}>
      <div className="panel__head">
        <h3 className="h6">{title}</h3>
        {onExport && <button className={btn2} onClick={onExport}>{t('reports.exportCsv')}</button>}
      </div>
      <div style={{ overflowX: 'auto' }}>{children}</div>
    </section>
  )
}

function Table({ head, rows, empty, foot }: { head: string[]; rows: ReactNode[][]; empty: string; foot?: ReactNode[] }) {
  if (rows.length === 0) return <p className="body-sm muted">{empty}</p>
  return (
    <table className="table" style={{ minWidth: '20rem' }}>
      <thead><tr>{head.map((h, i) => <th key={h} className={i ? 'num' : undefined}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={j ? 'num' : undefined}>{c}</td>)}</tr>)}</tbody>
      {foot && <tfoot><tr style={{ borderTop: '2px solid var(--tone-strong)' }}>{foot.map((c, j) => <td key={j} className={j ? 'num' : undefined}>{c}</td>)}</tr></tfoot>}
    </table>
  )
}

/** Reports for owners and managers: pick a period and a shop (or all shops), read it, export it, or print / save as PDF. */
export function ReportsScreen() {
  const { t, i18n } = useTranslation()
  const { membership } = useAuth()
  const [kind, setKind] = useState<PeriodKind | 'custom'>('thisMonth')
  const [custom, setCustom] = useState({ from: localDate(new Date().toISOString()), to: localDate(new Date().toISOString()) })
  const [shop, setShop] = useState<string>(membership?.shopId ?? '')

  const range = kind === 'custom' ? { from: dayStart(custom.from), to: dayEnd(custom.to) } : periodPreset(kind, new Date())
  const shopId = shop === 'all' ? undefined : shop
  const data = useReport(range.from, range.to, shopId)

  if (!membership || !can(membership.role, 'reports.operational')) return <p className="body-md muted">{t('reports.ownerOnly')}</p>
  const sep = i18n.language.startsWith('fr') ? ';' : ','
  const shopName = shopId ? (membership.shops.find((s) => s.id === shopId)?.name ?? '') : t('reports.allShops')
  const today = localDate(new Date().toISOString())
  const save = <T,>(name: string, cols: Column<T>[], rows: T[]) => downloadText(reportFileName(name, today), toCsv(cols, rows, sep))
  const d = (iso: string) => new Date(iso).toLocaleDateString(i18n.language)
  const cat = (c: string) => t(`money.cat.${c}`, { defaultValue: c })

  const s = data?.summary

  return (
    <div className="stack">
      <div className="stack print:hidden">
        <div className="flex flex-wrap gap-2">
          {KINDS.map((k) => (
            <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)} className={kind === k ? 'btn btn--primary' : 'btn btn--secondary'}>{t(`reports.period.${k}`)}</button>
          ))}
          <button aria-pressed={kind === 'custom'} onClick={() => setKind('custom')} className={kind === 'custom' ? 'btn btn--primary' : 'btn btn--secondary'}>{t('reports.period.custom')}</button>
        </div>
        {kind === 'custom' && (
          <div className="flex flex-wrap gap-2">
            <label className="field">{t('reports.from')}<input type="date" className={input} value={custom.from} max={custom.to} onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })} /></label>
            <label className="field">{t('reports.to')}<input type="date" className={input} value={custom.to} min={custom.from} onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })} /></label>
          </div>
        )}
        <div className="flex flex-wrap items-end gap-2">
          {membership.shops.length > 1 && (
            <label className="field">{t('reports.shop')}
              <select className={input} value={shop} onChange={(e) => setShop(e.target.value)}>
                <option value="all">{t('reports.allShops')}</option>
                {membership.shops.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </label>
          )}
          <button className="btn btn--primary" onClick={() => window.print()}>{t('reports.print')}</button>
        </div>
        <p className="body-sm muted">{t('reports.printHint')}</p>
      </div>

      <header>
        <h2 className="h4">{t('reports.title')} — {membership.tenantName}</h2>
        <p className="body-md muted">{shopName} · {d(range.from)} → {d(range.to)} · {t('reports.generated', { date: new Date().toLocaleString(i18n.language) })}</p>
      </header>

      {!data || !s ? <p className="body-md muted">…</p> : (
        <>
          <Section
            title={t('reports.summary')}
            onExport={() => save('summary', [{ label: t('reports.item'), value: (r: [string, number]) => r[0] }, { label: t('reports.amount'), value: (r: [string, number]) => r[1] }], [
              [t('money.salesCount'), s.salesCount], [t('money.revenue'), s.revenue], [t('money.cogs'), s.cogs], [t('money.grossProfit'), s.grossProfit], [t('money.expensesTotal'), s.expenses],
              [t('money.operatingProfit'), s.operatingProfit], [t('reports.tax'), s.tax], [t('reports.discounts'), s.discounts], [t('reports.returned'), s.returnedRevenue],
              [t('pos.cash'), s.collectedFromSales.cash], [t('pos.mtn_momo'), s.collectedFromSales.mtn_momo], [t('pos.orange_money'), s.collectedFromSales.orange_money],
              [t('money.repayments'), s.debtRepayments], [t('money.collected'), s.collectedTotal], [t('money.receivables'), s.receivables], [t('reports.payables'), s.supplierPayables],
            ] as [string, number][])}
          >
            <Table head={[t('reports.item'), t('reports.amount')]} empty="" rows={[
              [t('money.salesCount'), s.salesCount],
              [t('money.revenue'), formatXaf(s.revenue)], [t('money.cogs'), formatXaf(s.cogs)], [t('money.grossProfit'), formatXaf(s.grossProfit)],
              [t('money.expensesTotal'), formatXaf(s.expenses)], [<strong key="op">{t('money.operatingProfit')}</strong>, <strong key="opv">{formatXaf(s.operatingProfit)}</strong>],
              [t('reports.tax'), formatXaf(s.tax)], [t('reports.discounts'), formatXaf(s.discounts)], [t('reports.returned'), formatXaf(s.returnedRevenue)],
              [t('pos.cash'), formatXaf(s.collectedFromSales.cash)], [t('pos.mtn_momo'), formatXaf(s.collectedFromSales.mtn_momo)], [t('pos.orange_money'), formatXaf(s.collectedFromSales.orange_money)],
              [t('money.repayments'), formatXaf(s.debtRepayments)], [<strong key="c">{t('money.collected')}</strong>, <strong key="cv">{formatXaf(s.collectedTotal)}</strong>],
              [t('money.receivables'), formatXaf(s.receivables)], [t('reports.payables'), formatXaf(s.supplierPayables)],
            ]} />
            <p className="body-sm muted" style={{ marginTop: 8 }}>{t('money.note')}</p>
          </Section>

          <Section title={t('reports.daily')} onExport={() => save('daily', [
            { label: t('reports.date'), value: (r) => r.date }, { label: t('money.salesCount'), value: (r) => r.salesCount },
            { label: t('money.revenue'), value: (r) => r.revenue }, { label: t('money.expensesTotal'), value: (r) => r.expenses },
          ], data.daily)}>
            <Table head={[t('reports.date'), t('money.salesCount'), t('money.revenue'), t('money.expensesTotal')]} empty={t('reports.none')}
              rows={data.daily.map((r) => [r.date, r.salesCount, formatXaf(r.revenue), formatXaf(r.expenses)])} />
          </Section>

          <Section title={t('reports.byProduct')} onExport={() => save('sales-by-product', [
            { label: t('reports.product'), value: (r) => r.name }, { label: t('reports.qty'), value: (r) => r.quantity }, { label: t('money.revenue'), value: (r) => r.revenue },
            { label: t('money.cogs'), value: (r) => r.cogs }, { label: t('money.grossProfit'), value: (r) => r.profit }, { label: t('reports.margin'), value: (r) => (r.marginBp === null ? null : r.marginBp / 100) },
          ], data.products)}>
            <Table head={[t('reports.product'), t('reports.qty'), t('money.revenue'), t('money.grossProfit'), t('reports.margin')]} empty={t('reports.none')}
              rows={data.products.slice(0, 50).map((r) => [r.name, r.quantity, formatXaf(r.revenue), formatXaf(r.profit), r.marginBp === null ? '—' : `${(r.marginBp / 100).toFixed(1)} %`])} />
            {data.products.length > 50 && <p className="body-sm muted" style={{ marginTop: 4 }}>{t('reports.top50')}</p>}
          </Section>

          <Section title={t('reports.byEmployee')} onExport={() => save('sales-by-employee', [
            { label: t('reports.employee'), value: (r) => r.name ?? t('staff.mode.owner') }, { label: t('money.salesCount'), value: (r) => r.salesCount },
            { label: t('money.revenue'), value: (r) => r.revenue }, { label: t('reports.discounts'), value: (r) => r.discount }, { label: t('money.collected'), value: (r) => r.collected },
          ], data.employees)}>
            <Table head={[t('reports.employee'), t('money.salesCount'), t('money.revenue'), t('money.collected')]} empty={t('reports.none')}
              rows={data.employees.map((r) => [r.name ?? t('staff.mode.owner'), r.salesCount, formatXaf(r.revenue), formatXaf(r.collected)])} />
          </Section>

          <Section title={t('reports.stockValue')} onExport={() => save('stock-value', [
            { label: t('reports.product'), value: (r) => r.name }, { label: t('reports.qty'), value: (r) => r.quantity }, { label: t('reports.unit'), value: (r) => r.baseUnit },
            { label: t('reports.avgCost'), value: (r) => r.avgCost }, { label: t('reports.value'), value: (r) => r.value }, { label: t('reports.min'), value: (r) => r.minStock }, { label: t('reports.low'), value: (r) => (r.low ? 1 : 0) },
          ], data.stock.rows)}>
            <p className="body-sm muted" style={{ marginBottom: 8 }}>{t('reports.stockNote')}</p>
            <Table head={[t('reports.product'), t('reports.qty'), t('reports.avgCost'), t('reports.value')]} empty={t('reports.none')}
              rows={data.stock.rows.map((r) => [<span key={r.productId}>{r.name}{r.low && <span className="tag tag--flag" style={{ marginLeft: 4 }}>{t('reports.low')}</span>}</span>, `${r.quantity} ${r.baseUnit}`, formatXaf(r.avgCost), formatXaf(r.value)])}
              foot={data.stock.rows.length ? [t('reports.total'), '', '', formatXaf(data.stock.totalValue)] : undefined} />
          </Section>

          <Section title={t('reports.debtors')} onExport={() => save('customer-debts', [
            { label: t('reports.customer'), value: (r) => r.name }, { label: t('reports.phone'), value: (r) => r.phone }, { label: t('reports.owes'), value: (r) => r.balance }, { label: t('reports.lastActivity'), value: (r) => (r.lastActivity ? localDate(r.lastActivity) : '') },
          ], data.debtors.rows)}>
            <Table head={[t('reports.customer'), t('reports.lastActivity'), t('reports.owes'), '']} empty={t('money.noDebts')}
              rows={data.debtors.rows.map((r) => [<span key={r.customerId}>{r.name}{r.phone && <span className="block body-sm muted">{r.phone}</span>}</span>, r.lastActivity ? d(r.lastActivity) : '—', formatXaf(r.balance), <span key={`w${r.customerId}`} className="print:hidden"><QuickReminder customer={{ id: r.customerId, name: r.name, phone: r.phone }} balance={r.balance} /></span>])}
              foot={data.debtors.rows.length ? [t('reports.total'), '', formatXaf(data.debtors.total), ''] : undefined} />
            <p className="body-sm muted" style={{ marginTop: 4 }}>{t('reports.debtNote')}</p>
          </Section>

          <Section title={t('reports.expenses')} onExport={() => save('expenses', [
            { label: t('reports.date'), value: (r) => localDate(r.occurredAt) }, { label: t('money.category'), value: (r) => cat(r.category) },
            { label: t('money.description'), value: (r) => r.description }, { label: t('money.method'), value: (r) => t(`pos.${r.method}`) }, { label: t('reports.amount'), value: (r) => r.amount },
          ], data.expenses)}>
            <Table head={[t('money.category'), t('reports.amount')]} empty={t('money.noExpenses')}
              rows={Object.entries(s.expensesByCategory).sort((a, b) => b[1] - a[1]).map(([k, v]) => [cat(k), formatXaf(v)])}
              foot={Object.keys(s.expensesByCategory).length ? [t('reports.total'), formatXaf(s.expenses)] : undefined} />
          </Section>
        </>
      )}
    </div>
  )
}
