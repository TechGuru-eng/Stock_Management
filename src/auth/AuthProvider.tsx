import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { removeLocalPin } from './localPin'
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
  signOut: () => Promise<void>
}

export const AuthContext = createContext<AuthState | null>(null)
export type { AuthState }

const cacheKey = (userId: string) => `stockcm.membership.${userId}`

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
    .select('id, tenant_id, role, tenants(name, language, oversell_policy)')
    .eq('user_id', userId)
    .eq('active', true)
    .limit(1)
  if (error) return 'unavailable'
  const row = data?.[0] as
    | { id: string; tenant_id: string; role: Membership['role']; tenants: TenantRow | TenantRow[] }
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
    oversellPolicy: tenant?.oversell_policy ?? 'allow_and_flag',
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [session, setSession] = useState<Session | null>(null)
  const [membership, setMembership] = useState<Membership | null>(null)

  const load = useCallback(async (s: Session | null) => {
    setSession(s)
    if (!s) {
      setMembership(null)
      setLoading(false)
      return
    }
    const result = await fetchMembership(s.user.id)
    if (result === 'unavailable') {
      // Offline or server unreachable: keep working from the last known membership.
      setMembership(readCache(s.user.id))
    } else {
      writeCache(s.user.id, result)
      setMembership(result)
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
        try { localStorage.setItem(shopKey(session.user.id), shopId) } catch { /* remembered next time */ }
        const next = { ...membership, shopId }
        writeCache(session.user.id, next)
        setMembership(next)
      },
      signOut: async () => {
        if (session) {
          writeCache(session.user.id, null)
          await removeLocalPin(session.user.id)
        }
        clearLockState()
        await supabase?.auth.signOut()
      },
    }),
    [loading, session, membership, load],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
