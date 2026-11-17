import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

export interface Membership {
  tenantId: string
  tenantName: string
  role: 'owner' | 'manager' | 'cashier' | 'storekeeper'
  language: 'fr' | 'en'
}

interface AuthState {
  loading: boolean
  session: Session | null
  /** null = signed in but has no business yet (needs onboarding) */
  membership: Membership | null
  refreshMembership: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

const cacheKey = (userId: string) => `stockcm.membership.${userId}`

function readCache(userId: string): Membership | null {
  try {
    const raw = localStorage.getItem(cacheKey(userId))
    return raw ? (JSON.parse(raw) as Membership) : null
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

async function fetchMembership(userId: string): Promise<Membership | null | 'unavailable'> {
  if (!supabase) return 'unavailable'
  const { data, error } = await supabase
    .from('memberships')
    .select('tenant_id, role, tenants(name, language)')
    .eq('user_id', userId)
    .eq('active', true)
    .limit(1)
  if (error) return 'unavailable'
  const row = data?.[0] as
    | { tenant_id: string; role: Membership['role']; tenants: { name: string; language: 'fr' | 'en' } | { name: string; language: 'fr' | 'en' }[] }
    | undefined
  if (!row) return null
  const tenant = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants
  return { tenantId: row.tenant_id, tenantName: tenant?.name ?? '', role: row.role, language: tenant?.language ?? 'fr' }
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
      signOut: async () => {
        if (session) writeCache(session.user.id, null)
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
