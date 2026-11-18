import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../data/db'
import { useCtx } from '../../data/useCtx'
import { formatXaf } from '../../domain/money'
import { can } from '../../domain/permissions'
import { dayRange } from '../../domain/reports'
import { useSummary } from '../money/useSummary'
import { AttentionCard } from '../alerts/AttentionCard'
import { useSyncStatus } from '../../sync/status'
import { pendingApprovals } from '../../data/returnsRepo'

type Go = (tab: 'sales' | 'stock' | 'money', sub?: 'summary' | 'debts' | 'expenses' | 'cash') => void

function Card({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div className={`rounded border p-3 ${tone === 'warn' ? 'border-amber-400 bg-amber-50 text-amber-900' : 'border-slate-200 dark:border-slate-800'}`}>
      <p className="text-sm text-slate-600 dark:text-slate-300">{label}</p>
      <p className="text-xl font-bold">{value}</p>
    </div>
  )
}

/** Cards are chosen by what the user is allowed to see: a cashier never sees profit. */
export function HomeScreen({ go }: { go: Go }) {
  const { t } = useTranslation()
  const ctx = useCtx()
  const range = useMemo(() => dayRange(new Date()), [])
  const s = useSummary(range.from, range.to, ctx?.shopId ?? '')
  const { summary } = useSyncStatus()
  const lowStock =
    useLiveQuery(async () => {
      if (!ctx) return 0
      const products = await db.products.filter((p) => p.active && !p.isService).toArray()
      const costs = new Map((await db.costs.where('shopId').equals(ctx.shopId).toArray()).map((c) => [c.productId, c.quantity]))
      return products.filter((p) => (costs.get(p.id) ?? 0) <= p.minStock).length
    }, [ctx?.shopId]) ?? 0
  const shortages =
    useLiveQuery(async () => (await db.cashClosures.toArray()).filter((c) => c.difference !== 0).length, []) ?? 0
  const waiting = useLiveQuery(async () => (await pendingApprovals()).length, []) ?? 0
  if (!ctx || !s) return null

  const money = can(ctx.role, 'reports.operational')
  const issues = summary.rejectedGroups + summary.conflictGroups
  const shortcuts: { label: string; run: () => void }[] = [
    { label: t('home.newSale'), run: () => go('sales') },
    { label: t('home.products'), run: () => go('stock') },
    { label: t('home.expense'), run: () => go('money', 'expenses') },
    { label: t('home.repayment'), run: () => go('money', 'debts') },
    { label: t('home.cashRegister'), run: () => go('money', 'cash') },
    ...(money ? [{ label: t('home.report'), run: () => go('money', 'summary') }] : []),
  ]

  return (
    <div className="flex flex-col gap-4">
      <AttentionCard goOrder={() => go('stock')} />
      <div className="grid grid-cols-2 gap-3">
        <Card label={t('home.todaySales')} value={formatXaf(s.revenue)} />
        <Card label={t('home.collected')} value={formatXaf(s.collectedTotal)} />
        <Card label={t('home.owed')} value={formatXaf(s.receivables)} />
        {money && <Card label={t('purch.owedTotal')} value={formatXaf(s.supplierPayables)} />}
        {money && <Card label={t('home.expenses')} value={formatXaf(s.expenses)} />}
        {money && <Card label={t('home.profit')} value={formatXaf(s.grossProfit)} />}
        <Card label={t('home.lowStock')} value={String(lowStock)} tone={lowStock > 0 ? 'warn' : undefined} />
        {money && shortages > 0 && <Card label={t('home.shortage')} value={String(shortages)} tone="warn" />}
        {money && waiting > 0 && <Card label={t('rets.pending')} value={String(waiting)} tone="warn" />}
        {issues > 0 && <Card label={t('home.issues')} value={String(issues)} tone="warn" />}
      </div>
      <section>
        <h3 className="mb-2 font-semibold">{t('home.shortcuts')}</h3>
        <div className="grid grid-cols-2 gap-3">
          {shortcuts.map((x) => (
            <button key={x.label} onClick={x.run} className="min-h-14 rounded border border-teal-700 px-2 text-teal-700">{x.label}</button>
          ))}
        </div>
      </section>
    </div>
  )
}
