import { db } from '../data/db'
import { runSync, type SyncContext } from './engine'
import type { SyncTransport } from './transport'

const INTERVAL_MS = 30_000
const AFTER_WRITE_MS = 1_500

/**
 * Keeps the device in sync without the user thinking about it:
 *  - at start, when the connection returns, and every 30 seconds while online;
 *  - shortly after any new local record is queued.
 * Returns a function that stops everything.
 */
export function startAutoSync(transport: SyncTransport, ctx: SyncContext): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const run = () => {
    if (navigator.onLine) void runSync(transport, ctx)
  }
  const soon = () => {
    clearTimeout(timer)
    timer = setTimeout(run, AFTER_WRITE_MS)
  }

  const onCreate = () => {
    // Runs inside the write transaction: only schedule, never touch the database here.
    soon()
  }
  db.outbox.hook('creating', onCreate)
  window.addEventListener('online', run)
  const interval = setInterval(run, INTERVAL_MS)
  run()

  return () => {
    clearTimeout(timer)
    clearInterval(interval)
    window.removeEventListener('online', run)
    db.outbox.hook('creating').unsubscribe(onCreate)
  }
}
