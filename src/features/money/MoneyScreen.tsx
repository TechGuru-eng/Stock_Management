import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../data/db'
import { closeCashSession, currentSession, moveCash, openCashSession, openSalesForCustomer, recentClosures, recordExpense, repayDebt } from '../../data/financeRepo'
import type { Ctx } from '../../data/repo'
import { useCtx } from '../../data/useCtx'
import { expenseCategories, sessionTotals, expectedClosing, type ExpenseCategory } from '../../domain/finance'
import { formatXaf } from '../../domain/money'
import { can } from '../../domain/permissions'
import { dayRange } from '../../domain/reports'
import { useBalances, useSummary } from './useSummary'

type Sub = 'summary' | 'debts' | 'expenses' | 'cash'
type Method = 'cash' | 'mtn_momo' | 'orange_money'
const input = 'min-h-12 w-full rounded border border-slate-300 bg-transparent px-3'
const btn = 'min-h-12 rounded bg-teal-700 px-4 font-semibold text-white disabled:opacity-60'
const num = (s: string) => (s.trim() === '' ? 0 : Math.round(Number(s)))

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </label>
  )
}

function Row({ label, value, strong, hint }: { label: string; value: string; strong?: boolean; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <span className={strong ? 'font-semibold' : ''}>{label}{hint && <span className="block text-xs text-slate-500">{hint}</span>}</span>
      <span className={strong ? 'text-lg font-bold' : ''}>{value}</span>
    </div>
  )
}

function MethodSelect({ value, onChange }: { value: Method; onChange: (m: Method) => void }) {
  const { t } = useTranslation()
  return (
    <select className={input} value={value} onChange={(e) => onChange(e.target.value as Method)}>
      {(['cash', 'mtn_momo', 'orange_money'] as const).map((m) => <option key={m} value={m}>{t(`pos.${m}`)}</option>)}
    </select>
  )
}

/* -------------------------------- summary -------------------------------- */

function SummaryView({ ctx }: { ctx: Ctx }) {
  const { t } = useTranslation()
  const range = useMemo(() => dayRange(new Date()), [])
  const s = useSummary(range.from, range.to, ctx.shopId)
  const profitVisible = can(ctx.role, 'reports.operational')
  if (!s) return null
  return (
    <div className="flex flex-col divide-y divide-slate-200 dark:divide-slate-800">
      <h3 className="pb-2 text-lg font-semibold">{t('money.today')}</h3>
      <Row label={t('money.salesCount')} value={String(s.salesCount)} />
      <Row label={t('money.revenue')} value={formatXaf(s.revenue)} />
      <Row label={t('money.collected')} value={formatXaf(s.collectedTotal)} strong hint={`${t('money.repayments')}: ${formatXaf(s.debtRepayments)}`} />
      <Row label={t('money.receivables')} value={formatXaf(s.receivables)} />
      <Row label={t('purch.owedTotal')} value={formatXaf(s.supplierPayables)} />
      {profitVisible && (
        <>
          <Row label={t('money.cogs')} value={formatXaf(s.cogs)} />
          <Row label={t('money.grossProfit')} value={formatXaf(s.grossProfit)} strong />
          <Row label={t('money.expensesTotal')} value={formatXaf(s.expenses)} />
          <Row label={t('money.operatingProfit')} value={formatXaf(s.operatingProfit)} strong />
          <p className="pt-3 text-xs text-slate-500">{t('money.note')}</p>
        </>
      )}
    </div>
  )
}

/* --------------------------------- debts --------------------------------- */

function DebtDetail({ ctx, customerId, onBack }: { ctx: Ctx; customerId: string; onBack: () => void }) {
  const { t } = useTranslation()
  const customer = useLiveQuery(() => db.customers.get(customerId), [customerId])
  const open = useLiveQuery(() => openSalesForCustomer(customerId), [customerId]) ?? []
  const sales = useLiveQuery(() => db.sales.toArray(), []) ?? []
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<Method>('cash')
  const [msg, setMsg] = useState<string | null>(null)
  const owed = open.reduce((x, o) => x + o.outstanding, 0)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setMsg(null)
    try {
      await repayDebt(ctx, { customerId, amount: num(amount), method })
      setAmount('')
      setMsg(t('money.repaid'))
    } catch (err) {
      setMsg(t('money.error', { msg: (err as Error).message }))
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <button onClick={onBack} className="min-h-12 self-start text-teal-700 underline">{t('stock.back')}</button>
      <h3 className="text-xl font-semibold">{customer?.name}</h3>
      <p>{t('money.owes')}: <strong>{formatXaf(owed)}</strong></p>
      <ul className="text-sm text-slate-600 dark:text-slate-300">
        {open.map((o) => (
          <li key={o.saleId}>{sales.find((x) => x.id === o.saleId)?.saleNumber} · {o.createdAt.slice(0, 10)} · {formatXaf(o.outstanding)}</li>
        ))}
      </ul>
      {can(ctx.role, 'payments.receive') && owed > 0 && (
        <form onSubmit={submit} className="flex flex-col gap-3 rounded border border-slate-200 p-3">
          <h4 className="font-semibold">{t('money.repay')}</h4>
          <Field label={t('money.amount')}><input className={input} inputMode="numeric" required value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label={t('money.method')}><MethodSelect value={method} onChange={setMethod} /></Field>
          <button className={btn}>{t('money.add')}</button>
        </form>
      )}
      {msg && <p role="status" className="text-sm">{msg}</p>}
    </div>
  )
}

function DebtsView({ ctx }: { ctx: Ctx }) {
  const { t } = useTranslation()
  const rows = useBalances()
  const [sel, setSel] = useState<string | null>(null)
  if (sel) return <DebtDetail ctx={ctx} customerId={sel} onBack={() => setSel(null)} />
  const list = (rows ?? []).filter((r) => r.balance !== 0)
  return (
    <div>
      {list.length === 0 && <p className="text-slate-500">{t('money.noDebts')}</p>}
      <ul className="divide-y divide-slate-200 dark:divide-slate-800">
        {list.map(({ customer, balance }) => (
          <li key={customer.id}>
            <button onClick={() => setSel(customer.id)} className="flex min-h-14 w-full items-center justify-between py-2 text-left">
              <span>{customer.name}</span>
              <span className={balance > 0 ? 'font-semibold text-red-700' : 'text-teal-700'}>
                {balance > 0 ? `${t('money.owes')} ${formatXaf(balance)}` : `${t('money.inCredit')} ${formatXaf(-balance)}`}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* -------------------------------- expenses -------------------------------- */

function ExpensesView({ ctx }: { ctx: Ctx }) {
  const { t } = useTranslation()
  const list = useLiveQuery(async () => (await db.expenses.toArray()).sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1)).slice(0, 30), []) ?? []
  const [category, setCategory] = useState<ExpenseCategory>('transport')
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<Method>('cash')
  const [description, setDescription] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const allowed = can(ctx.role, 'expenses.write')

  async function submit(e: FormEvent) {
    e.preventDefault()
    setMsg(null)
    try {
      await recordExpense(ctx, { category, amount: num(amount), method, description })
      setAmount(''); setDescription('')
      setMsg(t('money.saved'))
    } catch (err) {
      setMsg(t('money.error', { msg: (err as Error).message }))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {allowed && (
        <form onSubmit={submit} className="flex flex-col gap-3 rounded border border-slate-200 p-3">
          <h4 className="font-semibold">{t('money.newExpense')}</h4>
          <Field label={t('money.category')}>
            <select className={input} value={category} onChange={(e) => setCategory(e.target.value as ExpenseCategory)}>
              {expenseCategories.map((c) => <option key={c} value={c}>{t(`money.cat.${c}`)}</option>)}
            </select>
          </Field>
          <Field label={t('money.amount')}><input className={input} inputMode="numeric" required value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label={t('money.method')}><MethodSelect value={method} onChange={setMethod} /></Field>
          <Field label={t('money.description')}><input className={input} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
          <button className={btn}>{t('money.add')}</button>
          {msg && <p role="status" className="text-sm">{msg}</p>}
        </form>
      )}
      {list.length === 0 && <p className="text-slate-500">{t('money.noExpenses')}</p>}
      <ul className="divide-y divide-slate-200 dark:divide-slate-800">
        {list.map((e) => (
          <li key={e.id} className="flex justify-between py-2">
            <span>{t(`money.cat.${e.category}`)} <span className="text-sm text-slate-500">{e.occurredAt.slice(0, 10)}{e.description ? ` · ${e.description}` : ''}</span></span>
            <span>{formatXaf(e.amount)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ------------------------------- cash register ------------------------------- */

function CashView({ ctx }: { ctx: Ctx }) {
  const { t } = useTranslation()
  const session = useLiveQuery(() => currentSession(ctx), [ctx.userId, ctx.shopId])
  const txns = useLiveQuery(() => db.transactions.where('shopId').equals(ctx.shopId).toArray(), [ctx.shopId]) ?? []
  const closures = useLiveQuery(recentClosures, []) ?? []
  const [opening, setOpening] = useState('')
  const [counted, setCounted] = useState('')
  const [moveKind, setMoveKind] = useState<'cash_deposit' | 'cash_withdrawal'>('cash_withdrawal')
  const [moveAmount, setMoveAmount] = useState('')
  const [moveReason, setMoveReason] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [result, setResult] = useState<{ expected: number; difference: number; status: 'balanced' | 'shortage' | 'surplus' } | null>(null)

  const expected = session ? expectedClosing(sessionTotals(session, txns, new Date().toISOString())) : 0
  const guard = async (fn: () => Promise<void>) => {
    setMsg(null)
    try { await fn() } catch (err) { setMsg(t('money.error', { msg: (err as Error).message })) }
  }

  return (
    <div className="flex flex-col gap-4">
      {!session ? (
        <form onSubmit={(e) => { e.preventDefault(); void guard(async () => { await openCashSession(ctx, num(opening)); setResult(null) }) }} className="flex flex-col gap-3 rounded border border-slate-200 p-3">
          <p>{t('money.noSession')}</p>
          <Field label={t('money.openingCash')}><input className={input} inputMode="numeric" required value={opening} onChange={(e) => setOpening(e.target.value)} /></Field>
          <button className={btn}>{t('money.openSession')}</button>
        </form>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void guard(async () => { const r = await closeCashSession(ctx, session.id, num(counted)); setResult(r.reconciliation); setCounted('') }) }} className="flex flex-col gap-3 rounded border border-slate-200 p-3">
          <Row label={t('money.openingCash')} value={formatXaf(session.openingCash)} />
          <Row label={t('money.expectedNow')} value={formatXaf(expected)} strong />
          <Field label={t('money.counted')}><input className={input} inputMode="numeric" required value={counted} onChange={(e) => setCounted(e.target.value)} /></Field>
          <button className={btn}>{t('money.closeSession')}</button>
        </form>
      )}
      {result && (
        <p role="status" className={`rounded p-3 ${result.status === 'balanced' ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-900'}`}>
          {t(`money.${result.status}`)} · {t('money.difference')}: {formatXaf(result.difference)}
        </p>
      )}
      {msg && <p role="alert" className="text-red-700">{msg}</p>}

      <form
        onSubmit={(e) => { e.preventDefault(); void guard(async () => { await moveCash(ctx, { kind: moveKind, amount: num(moveAmount), reason: moveReason }); setMoveAmount(''); setMoveReason(''); setMsg(t('money.saved')) }) }}
        className="flex flex-col gap-3 rounded border border-slate-200 p-3"
      >
        <h4 className="font-semibold">{t('money.movement')}</h4>
        {!can(ctx.role, 'finance.write') && <p className="text-sm text-slate-500">{t('money.ownerOnly')}</p>}
        <select className={input} value={moveKind} onChange={(e) => setMoveKind(e.target.value as typeof moveKind)} disabled={!can(ctx.role, 'finance.write')}>
          <option value="cash_withdrawal">{t('money.withdrawal')}</option>
          <option value="cash_deposit">{t('money.deposit')}</option>
        </select>
        <input className={input} inputMode="numeric" placeholder={t('money.amount')} value={moveAmount} onChange={(e) => setMoveAmount(e.target.value)} disabled={!can(ctx.role, 'finance.write')} />
        <input className={input} placeholder={t('money.reason')} value={moveReason} onChange={(e) => setMoveReason(e.target.value)} disabled={!can(ctx.role, 'finance.write')} />
        <button className={btn} disabled={!can(ctx.role, 'finance.write')}>{t('money.add')}</button>
      </form>

      <section>
        <h4 className="mb-2 font-semibold">{t('money.closures')}</h4>
        <ul className="divide-y divide-slate-200 text-sm dark:divide-slate-800">
          {closures.map((c) => (
            <li key={c.id} className="flex justify-between py-2">
              <span>{c.closedAt.slice(0, 16).replace('T', ' ')}</span>
              <span className={c.difference === 0 ? 'text-teal-700' : 'font-semibold text-red-700'}>
                {c.difference === 0 ? t('money.balanced') : `${t('money.difference')} ${formatXaf(c.difference)}`}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

/* -------------------------------- screen -------------------------------- */

export function MoneyScreen({ initial = 'summary' }: { initial?: Sub }) {
  const { t } = useTranslation()
  const ctx = useCtx()
  const [sub, setSub] = useState<Sub>(initial)
  if (!ctx) return null
  const tabs: Sub[] = ['summary', 'debts', 'expenses', 'cash']
  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" className="grid grid-cols-4 gap-1">
        {tabs.map((k) => (
          <button key={k} role="tab" aria-selected={sub === k} onClick={() => setSub(k)}
            className={`min-h-12 rounded px-1 text-sm ${sub === k ? 'bg-teal-700 font-semibold text-white' : 'border border-slate-300'}`}>
            {t(`money.${k}`)}
          </button>
        ))}
      </div>
      {sub === 'summary' && <SummaryView ctx={ctx} />}
      {sub === 'debts' && <DebtsView ctx={ctx} />}
      {sub === 'expenses' && <ExpensesView ctx={ctx} />}
      {sub === 'cash' && <CashView ctx={ctx} />}
    </div>
  )
}
