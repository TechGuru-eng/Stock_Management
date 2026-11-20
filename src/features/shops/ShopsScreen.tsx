import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../auth/AuthProvider'
import { planLimit } from '../../billing/licenceStore'
import { ShopApiError, createShop, setMemberShops, updateShop } from '../../data/shopsApi'
import { canAddShop } from '../../domain/shops'
import { supabase } from '../../lib/supabase'

const input = 'input'
const btn = 'btn btn--primary'
const btn2 = 'btn btn--secondary'

interface ShopRow { id: string; name: string; town: string | null; active: boolean }
interface Member { id: string; full_name: string | null; role: string; active: boolean }

/** Owner only: add and rename shops, switch one off, and choose which shops each staff member may work in. */
export function ShopsScreen() {
  const { t } = useTranslation()
  const { membership, refreshMembership } = useAuth()
  const tenantId = membership?.tenantId
  const [shops, setShops] = useState<ShopRow[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [access, setAccess] = useState<Record<string, Set<string>>>({})
  const [msg, setMsg] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [town, setTown] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [limit, setLimit] = useState<number | null>(null)

  const load = useCallback(async () => {
    if (!supabase || !tenantId || !navigator.onLine) return
    const s = await supabase.from('shops').select('id, name, town, active').eq('tenant_id', tenantId).order('created_at')
    setShops((s.data as ShopRow[]) ?? [])
    const m = await supabase.from('memberships').select('id, full_name, role, active').eq('tenant_id', tenantId).neq('role', 'owner').eq('active', true).order('full_name')
    setMembers((m.data as Member[]) ?? [])
    const ms = await supabase.from('membership_shops').select('membership_id, shop_id').eq('tenant_id', tenantId)
    const map: Record<string, Set<string>> = {}
    for (const r of (ms.data ?? []) as { membership_id: string; shop_id: string }[]) (map[r.membership_id] ??= new Set()).add(r.shop_id)
    setAccess(map)
    setLimit(await planLimit('shops'))
  }, [tenantId])

  useEffect(() => { void load() }, [load])

  const run = async (fn: () => Promise<unknown>) => {
    setMsg(null)
    try {
      await fn()
      setMsg(t('shops.done'))
      await load()
      await refreshMembership()
    } catch (e) {
      const code = e instanceof ShopApiError ? e.code : 'server'
      setMsg(t(`shops.errors.${code}`, { defaultValue: (e as Error).message }))
    }
  }

  if (!navigator.onLine) return <p className="body-md muted">{t('shops.offline')}</p>
  const activeCount = shops.filter((s) => s.active).length
  const mayAdd = canAddShop(limit, activeCount)

  async function add(e: FormEvent) {
    e.preventDefault()
    await run(async () => { await createShop(tenantId!, name.trim(), town.trim()); setName(''); setTown('') })
  }

  return (
    <section className="panel stack" style={{ marginTop: 24 }}>
      <h3 className="h5">{t('shops.title')}</h3>
      <p className="body-md muted">
        {t('shops.hint')} {limit !== null && t('shops.planAllows', { n: limit, used: activeCount })}
      </p>
      {msg && <p role="status" className="notice body-sm">{msg}</p>}

      <ul className="stack" style={{ gap: 8 }}>
        {shops.map((s) => (
          <li key={s.id} className="panel">
            {editing === s.id ? (
              <EditShop shop={s} onCancel={() => setEditing(null)} onSave={(n, tw) => run(async () => { await updateShop(s.id, n, tw, s.active); setEditing(null) })} />
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="body-md">{s.name} {s.id === membership?.shopId && <span className="label-lg muted">· {t('shops.here')}</span>}</div>
                  <div className="body-sm muted">{s.town || '—'}{s.active ? '' : ` · ${t('shops.off')}`}</div>
                </div>
                <div className="flex gap-2">
                  <button className={btn2} onClick={() => setEditing(s.id)}>{t('shops.edit')}</button>
                  {s.active
                    ? <button className={btn2} disabled={activeCount <= 1} onClick={() => run(() => updateShop(s.id, s.name, s.town ?? '', false))}>{t('shops.deactivate')}</button>
                    : <button className={btn2} disabled={!mayAdd} onClick={() => run(() => updateShop(s.id, s.name, s.town ?? '', true))}>{t('shops.reactivate')}</button>}
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      <form onSubmit={add} className="stack">
        <h4 className="h6">{t('shops.add')}</h4>
        <input className={input} placeholder={t('shops.name')} aria-label={t('shops.name')} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={60} />
        <input className={input} placeholder={t('shops.town')} aria-label={t('shops.town')} value={town} onChange={(e) => setTown(e.target.value)} />
        <button className={btn} disabled={!mayAdd || name.trim().length < 2}>{t('shops.addAction')}</button>
        {!mayAdd && <p className="label-lg">! {t('shops.errors.plan_limit')}</p>}
      </form>

      {members.length > 0 && activeCount > 1 && (
        <div className="stack">
          <h4 className="h6">{t('shops.access')}</h4>
          <p className="body-md muted">{t('shops.accessHint')}</p>
          {members.map((m) => {
            const mine = access[m.id] ?? new Set<string>()
            return (
              <fieldset key={m.id} className="panel" style={{ padding: 10 }}>
                <legend className="label-lg muted">{m.full_name ?? '—'}</legend>
                <div className="flex flex-wrap gap-3">
                  {shops.filter((s) => s.active).map((s) => {
                    const on = mine.has(s.id)
                    return (
                      <label key={s.id} className="check-row body-md">
                        <input
                          type="checkbox" checked={on}
                          onChange={() => {
                            const next = new Set(mine)
                            if (on) next.delete(s.id); else next.add(s.id)
                            if (next.size === 0) return setMsg(t('shops.errors.min_one'))
                            void run(() => setMemberShops(m.id, [...next]))
                          }}
                        />
                        {s.name}
                      </label>
                    )
                  })}
                </div>
              </fieldset>
            )
          })}
        </div>
      )}
    </section>
  )
}

function EditShop({ shop, onSave, onCancel }: { shop: ShopRow; onSave: (name: string, town: string) => void; onCancel: () => void }) {
  const { t } = useTranslation()
  const [n, setN] = useState(shop.name)
  const [tw, setTw] = useState(shop.town ?? '')
  return (
    <div className="stack">
      <input className={input} aria-label={t('shops.name')} value={n} onChange={(e) => setN(e.target.value)} maxLength={60} />
      <input className={input} aria-label={t('shops.town')} value={tw} onChange={(e) => setTw(e.target.value)} />
      <div className="flex gap-2">
        <button className={btn} disabled={n.trim().length < 2} onClick={() => onSave(n.trim(), tw.trim())}>{t('shops.save')}</button>
        <button className={btn2} onClick={onCancel}>{t('shops.cancel')}</button>
      </div>
    </div>
  )
}
