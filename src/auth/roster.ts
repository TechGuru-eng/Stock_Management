import { db } from '../data/db'
import { supabase } from '../lib/supabase'
import { deviceId } from '../data/db'
import { removeLocalPin } from './localPin'

/**
 * The people who have signed in on THIS device while online and may therefore take over the till offline with their PIN.
 * Owners are never listed (they sign in online with their phone). The list is a convenience for the screen; the server
 * only accepts records "as" a person it has seen on this device (see migration 0018), so a made-up entry gets nowhere.
 */
export interface RosterEntry {
  userId: string
  name: string
  role: 'manager' | 'cashier' | 'storekeeper'
  /** Shops this person may work in (empty = whatever the signed-in session may use). */
  shopIds: string[]
}

const KEY = 'roster'
export type Roster = Record<string, RosterEntry>

export async function loadRoster(): Promise<Roster> {
  return ((await db.meta.get(KEY))?.value as Roster | undefined) ?? {}
}

export async function rememberPerson(e: RosterEntry): Promise<void> {
  const r = await loadRoster()
  await db.meta.put({ key: KEY, value: { ...r, [e.userId]: e } })
}

/** Drops people who are no longer allowed on this device (deactivated, removed), together with their offline PIN check. */
export async function pruneRoster(keepUserIds: ReadonlySet<string>, alsoKeep?: string): Promise<string[]> {
  const r = await loadRoster()
  const gone = Object.keys(r).filter((id) => !keepUserIds.has(id) && id !== alsoKeep)
  if (gone.length === 0) return []
  const next = { ...r }
  for (const id of gone) {
    delete next[id]
    await removeLocalPin(id)
  }
  await db.meta.put({ key: KEY, value: next })
  return gone
}

/** Asks the server who is still allowed on this device. Silent when offline. */
export async function refreshRoster(sessionUserId: string): Promise<void> {
  if (!supabase || !navigator.onLine) return
  const { data, error } = await supabase.rpc('device_roster', { p_device: deviceId() })
  if (error || !Array.isArray(data)) return
  const ids = new Set((data as { user_id: string }[]).map((p) => p.user_id))
  await pruneRoster(ids, sessionUserId)
}
