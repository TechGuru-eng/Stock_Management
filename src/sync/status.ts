import { useLiveQuery } from 'dexie-react-hooks'
import { useSyncExternalStore } from 'react'
import { db } from '../data/db'
import { getEngineSnapshot, subscribeEngine } from './engine'

/** The five states the user sees. */
export type SyncStatus = 'synced' | 'pending' | 'syncing' | 'failed' | 'conflict'

export interface SyncSummary {
  pendingGroups: number
  rejectedGroups: number
  conflictGroups: number
  oldestPendingAt?: string
  lastSyncAt?: string
}

export async function getSyncSummary(): Promise<SyncSummary> {
  const rows = await db.outbox.toArray()
  const groups = (status: string) => new Set(rows.filter((r) => r.status === status).map((r) => r.groupId)).size
  const pending = rows.filter((r) => r.status === 'pending')
  return {
    pendingGroups: groups('pending'),
    rejectedGroups: groups('rejected'),
    conflictGroups: groups('conflict'),
    oldestPendingAt: pending.length ? pending.map((r) => r.createdAt).sort()[0] : undefined,
    lastSyncAt: (await db.meta.get('lastSyncAt'))?.value as string | undefined,
  }
}

export function syncStatus(s: SyncSummary, running: boolean): SyncStatus {
  if (running) return 'syncing'
  if (s.conflictGroups > 0) return 'conflict'
  if (s.rejectedGroups > 0) return 'failed'
  if (s.pendingGroups > 0) return 'pending'
  return 'synced'
}

const HOUR = 3_600_000
/** Important records unsynchronised for too long: warn the user. */
export const UNSYNCED_WARNING_HOURS = 48
/** Devices must reconnect at least this often (decision 2026-11-17). Enforced with licensing. */
export const OFFLINE_LIMIT_DAYS = 30

export function unsyncedTooLong(s: SyncSummary, now = Date.now()): boolean {
  return Boolean(s.oldestPendingAt) && now - Date.parse(s.oldestPendingAt!) > UNSYNCED_WARNING_HOURS * HOUR
}

export function offlineLimitExceeded(lastSyncAt: string | undefined, now = Date.now()): boolean {
  return Boolean(lastSyncAt) && now - Date.parse(lastSyncAt!) > OFFLINE_LIMIT_DAYS * 24 * HOUR
}

export function useSyncStatus() {
  const summary = useLiveQuery(getSyncSummary, [], undefined)
  const engine = useSyncExternalStore(subscribeEngine, getEngineSnapshot)
  const s: SyncSummary = summary ?? { pendingGroups: 0, rejectedGroups: 0, conflictGroups: 0 }
  return { summary: s, engine, status: syncStatus(s, engine.running), warn: unsyncedTooLong(s) }
}
