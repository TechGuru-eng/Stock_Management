import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../data/db'
import { setOutboxActor } from '../data/actor'
import { removeLocalPin } from './localPin'
import { rememberPerson, type Roster, type RosterEntry } from './roster'
import { clearLockState } from './lock'
import { pickShop, type ShopInfo } from '../domain/shops'

export interface Membership {
  tenantId: string
  tenantName: string
  role: 'owner' | 'manager' | 'cashier' | 'storekeeper'
  language: 'fr' | 'en'
  /** The shop this person is working in right now (one of `shops`). */
  shopId: string
  /** Every active shop this person may work in. */
  shops: ShopInfo[]
  /** This person's own membership id (used to look up shop access). */
  membershipId?: string
  fullName?: string
  oversellPolicy: 'allow_and_flag' | 'block'
}

interface AuthState {
  loading: boolean
  session: Session | null
  /** null = signed in but has no business yet (needs onboarding) */
  membership: Membership | null
  refreshMembership: () => Promise<void>
  /** Work in another of the shops this person may use. Remembered on this device. */
  selectShop: (shopId: string) => void
  /** The person at the till: normally the signed-in person, or someone who took over with their PIN (even offline). */
  actingUserId: string
  /** People who have signed in on this device and may take over with their PIN. Empty for owners. */
  roster: RosterEntry[]
  /** Take over the till as someone on the roster. Call ONLY after their PIN has been checked. */
  switchActor: (userId: string) => void
  signOut: () => Promise<void>
}

export const AuthContext = createContext<AuthState | null>(null)
export type { AuthState }

const cacheKey = (userId: string) => `stockcm.membership.${userId}`

const actorKey = (sessionUserId: string) => `stockcm.actor.${sessionUserId}`
function readActor(sessionUserId: string): string | null {
  try { return localStorage.getItem(actorKey(sessionUserId)) } catch { return null }
}
function saveActor(sessionUserId: string, actor: string | null) {
  try { if (actor) localStorage.setItem(actorKey(sessionUserId), actor); else localStorage.removeItem(actorKey(sessionUserId)) } catch { /* resumes as the signed-in person */ }
}

const shopKey = (userId: string) => `stockcm.shop.${userId}`

function readSavedShop(userId: string): string | null {
  try { return localStorage.getItem(shopKey(userId)) } catch { return null }
}

function readCache(userId: string): Membership | null {
  try {
    const raw = localStorage.getItem(cacheKey(userId))
    if (!raw) return null
    const m = JSON.parse(raw) as Membership
    // older caches (before several shops) only knew one shop
    if (!m.shops) m.shops = [{ id: m.shopId, name: '' }]
    return m
  } catch {
    return null
  }
}

function writeCache(userId: string, m: Membership | null) {
  try {
    if (m) localStorage.setItem(cacheKey(userId), JSON.stringify(m))
    else localStorage.removeItem(cacheKey(userId))
  } catch {
    /* storage unavailable: app still works online */
  }
}

interface TenantRow {
  name: string
  language: 'fr' | 'en'
  oversell_policy: 'allow_and_flag' | 'block'
}

async function fetchMembership(userId: string): Promise<Membership | null | 'unavailable'> {
  if (!supabase) return 'unavailable'
  const { data, error } = await supabase
    .from('memberships')
    .select('id, tenant_id, role, full_name, tenants(name, language, oversell_policy)')
    .eq('user_id', userId)
    .eq('active', true)
    .limit(1)
  if (error) return 'unavailable'
  const row = data?.[0] as
    | { id: string; tenant_id: string; role: Membership['role']; full_name: string | null; tenants: TenantRow | TenantRow[] }
    | undefined
  if (!row) return null
  const tenant = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants
  const all = await supabase.from('shops').select('id, name, town').eq('tenant_id', row.tenant_id).eq('active', true).order('created_at')
  if (all.error || !all.data?.[0]) return 'unavailable'
  let mine = all.data as ShopInfo[]
  if (row.role !== 'owner') {
    const ms = await supabase.from('membership_shops').select('shop_id').eq('membership_id', row.id)
    if (ms.error) return 'unavailable'
    const ids = new Set((ms.data ?? []).map((x) => x.shop_id as string))
    const allowed = mine.filter((s) => ids.has(s.id))
    mine = allowed.length ? allowed : mine.slice(0, 1) // never lock someone out of the app
  }
  return {
    tenantId: row.tenant_id,
    tenantName: tenant?.name ?? '',
    role: row.role,
    language: tenant?.language ?? 'fr',
    shopId: pickShop(mine, readSavedShop(userId))!,
    shops: mine,
    membershipId: row.id,
    fullName: row.full_name ?? undefined,
    oversellPolicy: tenant?.oversell_policy ?? 'allow_and_flag',
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [session, setSession] = useState<Session | null>(null)
  const [sessionMembership, setMembership] = useState<Membership | null>(null)
  const [actorId, setActorId] = useState<string | null>(null)
  const [shopTick, setShopTick] = useState(0)
  const rosterRec = useLiveQuery(() => db.meta.get('roster'), [])
  const rosterMap = useMemo(() => (rosterRec?.value as Roster | undefined) ?? {}, [rosterRec])

  const load = useCallback(async (s: Session | null) => {
    setSession(s)
    if (!s) {
      setMembership(null)
      setActorId(null)
      setLoading(false)
      return
    }
    // The person who took over the till belongs to the session they took over; a new sign-in starts clean.
    setActorId(readActor(s.user.id))
    const result = await fetchMembership(s.user.id)
    if (result === 'unavailable') {
      // Offline or server unreachable: keep working from the last known membership.
      setMembership(readCache(s.user.id))
    } else {
      writeCache(s.user.id, result)
      setMembership(result)
      // Remember who has worked on this device, so they can take over offline later (owners are never listed).
      if (result && result.role !== 'owner') {
        await rememberPerson({ userId: s.user.id, name: result.fullName ?? '', role: result.role, shopIds: result.shops.map((x) => x.id) })
      }
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (!supabase) {
      setLoading(false)
      return
    }
    void supabase.auth.getSession().then(({ data }) => load(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      void load(s)
    })
    return () => sub.subscription.unsubscribe()
  }, [load])

  const actor = actorId && sessionMembership && sessionMembership.role !== 'owner' ? rosterMap[actorId] : undefined
  const membership = useMemo<Membership | null>(() => {
    if (!sessionMembership || !actor) return sessionMembership
    const allowed = actor.shopIds.length ? sessionMembership.shops.filter((x) => actor.shopIds.includes(x.id)) : sessionMembership.shops
    const shops = allowed.length ? allowed : sessionMembership.shops
    return { ...sessionMembership, role: actor.role, fullName: actor.name, shops, shopId: pickShop(shops, readSavedShop(actor.userId))! }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionMembership, actor, shopTick])
  const actingUserId = actor?.userId ?? session?.user.id ?? ''
  const roster = useMemo(() => Object.values(rosterMap), [rosterMap])

  // Everything recorded from now on is credited to the person at the till.
  useEffect(() => { setOutboxActor(session ? actingUserId : null) }, [session, actingUserId])

  const value = useMemo<AuthState>(
    () => ({
      loading,
      session,
      membership,
      refreshMembership: async () => {
        if (session) await load(session)
      },
      selectShop: (shopId: string) => {
        if (!session || !membership || !membership.shops.some((s) => s.id === shopId)) return
        try { localStorage.setItem(shopKey(actingUserId), shopId) } catch { /* remembered next time */ }
        if (actor) { setShopTick((x) => x + 1); return } // the acting person's own choice is re-read
        const next = { ...membership, shopId }
        writeCache(session.user.id, next)
        setMembership(next)
      },
      actingUserId,
      roster,
      switchActor: (userId: string) => {
        if (!session || sessionMembership?.role === 'owner') return
        const next = userId === session.user.id ? null : userId
        if (next && !rosterMap[next]) return
        saveActor(session.user.id, next)
        setActorId(next)
      },
      signOut: async () => {
        if (session) {
          writeCache(session.user.id, null)
          saveActor(session.user.id, null)
          await removeLocalPin(session.user.id)
        }
        clearLockState()
        await supabase?.auth.signOut()
      },
    }),
    [loading, session, membership, load, actingUserId, roster, actor, rosterMap, sessionMembership],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
