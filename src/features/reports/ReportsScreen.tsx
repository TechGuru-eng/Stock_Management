import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../auth/AuthProvider'
import { downloadText, reportFileName, toCsv, type Column } from '../../domain/csv'
import { formatXaf } from '../../domain/money'
import { can } from '../../domain/permissions'
import { dayEnd, dayStart, localDate, periodPreset, type PeriodKind } from '../../domain/reportTables'
import { useReport } from './useReport'

const input = 'min-h-12 rounded border border-slate-300 bg-transparent px-3'
const btn2 = 'min-h-12 rounded border border-slate-300 px-3 text-sm print:hidden'
const KINDS: PeriodKind[] = ['today', 'last7', 'thisMonth', 'lastMonth']

function Section({ title, onExport, children }: { title: string; onExport?: () => void; children: ReactNode }) {
  const { t } = useTranslation()
  return (
    <section className="break-inside-avoid rounded border border-slate-200 p-3 dark:border-slate-700 print:border-slate-400">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="font-semibold">{title}</h3>
        {onExport && <button className={btn2} onClick={onExport}>{t('reports.exportCsv')}</button>}
      </div>
      <div className="overflow-x-auto">{children}</div>
    </section>
  )
}

function Table({ head, rows, empty, foot }: { head: string[]; rows: ReactNode[][]; empty: string; foot?: ReactNode[] }) {
  if (rows.length === 0) return <p className="text-sm text-slate-500">{empty}</p>
  return (
    <table className="w-full min-w-[20rem] text-sm">
      <thead><tr className="text-left text-xs text-slate-500">{head.map((h, i) => <th key={h} className={`pb-1 font-medium ${i ? 'text-right' : ''}`}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-slate-100 dark:border-slate-800">{r.map((c, j) => <td key={j} className={`py-1.5 ${j ? 'text-right tabular-nums' : ''}`}>{c}</td>)}</tr>)}</tbody>
      {foot && <tfoot><tr className="border-t-2 border-slate-300 font-semibold">{foot.map((c, j) => <td key={j} className={`py-1.5 ${j ? 'text-right tabular-nums' : ''}`}>{c}</td>)}</tr></tfoot>}
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

  if (!membership || !can(membership.role, 'reports.operational')) return <p className="text-slate-500">{t('reports.ownerOnly')}</p>
  const sep = i18n.language.startsWith('fr') ? ';' : ','
  const shopName = shopId ? (membership.shops.find((s) => s.id === shopId)?.name ?? '') : t('reports.allShops')
  const today = localDate(new Date().toISOString())
  const save = <T,>(name: string, cols: Column<T>[], rows: T[]) => downloadText(reportFileName(name, today), toCsv(cols, rows, sep))
  const d = (iso: string) => new Date(iso).toLocaleDateString(i18n.language)
  const cat = (c: string) => t(`money.cat.${c}`, { defaultValue: c })

  const s = data?.summary

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 print:hidden">
        <div className="flex flex-wrap gap-2">
          {KINDS.map((k) => (
            <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)} className={`min-h-12 rounded px-3 text-sm ${kind === k ? 'bg-teal-700 font-semibold text-white' : 'border border-slate-300'}`}>{t(`reports.period.${k}`)}</button>
          ))}
          <button aria-pressed={kind === 'custom'} onClick={() => setKind('custom')} className={`min-h-12 rounded px-3 text-sm ${kind === 'custom' ? 'bg-teal-700 font-semibold text-white' : 'border border-slate-300'}`}>{t('reports.period.custom')}</button>
        </div>
        {kind === 'custom' && (
          <div className="flex flex-wrap gap-2">
            <label className="flex flex-col text-sm">{t('reports.from')}<input type="date" className={input} value={custom.from} max={custom.to} onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })} /></label>
            <label className="flex flex-col text-sm">{t('reports.to')}<input type="date" className={input} value={custom.to} min={custom.from} onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })} /></label>
          </div>
        )}
        <div className="flex flex-wrap items-end gap-2">
          {membership.shops.length > 1 && (
            <label className="flex flex-col text-sm">{t('reports.shop')}
              <select className={input} value={shop} onChange={(e) => setShop(e.target.value)}>
                <option value="all">{t('reports.allShops')}</option>
                {membership.shops.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </label>
          )}
          <button className="min-h-12 rounded bg-teal-700 px-4 font-semibold text-white" onClick={() => window.print()}>{t('reports.print')}</button>
        </div>
        <p className="text-xs text-slate-500">{t('reports.printHint')}</p>
      </div>

      <header>
        <h2 className="text-xl font-semibold">{t('reports.title')} — {membership.tenantName}</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">{shopName} · {d(range.from)} → {d(range.to)} · {t('reports.generated', { date: new Date().toLocaleString(i18n.language) })}</p>
      </header>

      {!data || !s ? <p className="text-slate-500">…</p> : (
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
            <p className="mt-2 text-xs text-slate-500">{t('money.note')}</p>
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
            {data.products.length > 50 && <p className="mt-1 text-xs text-slate-500">{t('reports.top50')}</p>}
          </Section>

          <Section title={t('reports.stockValue')} onExport={() => save('stock-value', [
            { label: t('reports.product'), value: (r) => r.name }, { label: t('reports.qty'), value: (r) => r.quantity }, { label: t('reports.unit'), value: (r) => r.baseUnit },
            { label: t('reports.avgCost'), value: (r) => r.avgCost }, { label: t('reports.value'), value: (r) => r.value }, { label: t('reports.min'), value: (r) => r.minStock }, { label: t('reports.low'), value: (r) => (r.low ? 1 : 0) },
          ], data.stock.rows)}>
            <p className="mb-2 text-xs text-slate-500">{t('reports.stockNote')}</p>
            <Table head={[t('reports.product'), t('reports.qty'), t('reports.avgCost'), t('reports.value')]} empty={t('reports.none')}
              rows={data.stock.rows.map((r) => [<span key={r.productId}>{r.name}{r.low && <span className="ml-1 text-xs font-semibold text-red-700">{t('reports.low')}</span>}</span>, `${r.quantity} ${r.baseUnit}`, formatXaf(r.avgCost), formatXaf(r.value)])}
              foot={data.stock.rows.length ? [t('reports.total'), '', '', formatXaf(data.stock.totalValue)] : undefined} />
          </Section>

          <Section title={t('reports.debtors')} onExport={() => save('customer-debts', [
            { label: t('reports.customer'), value: (r) => r.name }, { label: t('reports.phone'), value: (r) => r.phone }, { label: t('reports.owes'), value: (r) => r.balance }, { label: t('reports.lastActivity'), value: (r) => (r.lastActivity ? localDate(r.lastActivity) : '') },
          ], data.debtors.rows)}>
            <Table head={[t('reports.customer'), t('reports.lastActivity'), t('reports.owes')]} empty={t('money.noDebts')}
              rows={data.debtors.rows.map((r) => [<span key={r.customerId}>{r.name}{r.phone && <span className="block text-xs text-slate-500">{r.phone}</span>}</span>, r.lastActivity ? d(r.lastActivity) : '—', formatXaf(r.balance)])}
              foot={data.debtors.rows.length ? [t('reports.total'), '', formatXaf(data.debtors.total)] : undefined} />
            <p className="mt-1 text-xs text-slate-500">{t('reports.debtNote')}</p>
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
