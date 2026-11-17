import { useEffect, useState } from 'react'
import { idleExpired, IDLE_LOCK_MINUTES, sessionExpired } from '../domain/staffPin'

/**
 * A signed-in staff device locks itself after a few minutes without a tap or key press, so a till left
 * alone cannot be used by whoever walks past. Unlocking needs the PIN again. The state is kept in storage,
 * so reloading the page does not unlock it.
 */
const LOCKED = 'stockcm.locked'
const ACTIVITY = 'stockcm.lastActivity'
const LOGIN_AT = 'stockcm.loginAt'

const get = (k: string) => {
  try { return localStorage.getItem(k) } catch { return null }
}
const set = (k: string, v: string | null) => {
  try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v) } catch { /* storage unavailable */ }
}

export const markLoggedIn = () => { set(LOGIN_AT, String(Date.now())); set(ACTIVITY, String(Date.now())); set(LOCKED, null) }
export const clearLockState = () => { set(LOGIN_AT, null); set(ACTIVITY, null); set(LOCKED, null) }
export const unlock = () => { set(ACTIVITY, String(Date.now())); set(LOCKED, null) }
export const lockNow = () => set(LOCKED, '1')
export const loggedInAt = (): number | null => (get(LOGIN_AT) ? Number(get(LOGIN_AT)) : null)

/** True when the device must show the lock screen right now (also true after a long idle gap, e.g. a closed tab). */
export function isLocked(now = Date.now()): boolean {
  if (get(LOCKED) === '1') return true
  const last = Number(get(ACTIVITY) ?? now)
  return idleExpired(last, now)
}

export function useIdleLock(enabled: boolean, onSessionExpired: () => void) {
  const [locked, setLocked] = useState(() => enabled && isLocked())

  useEffect(() => {
    if (!enabled) { setLocked(false); return }
    setLocked(isLocked())
    const touch = () => { if (get(LOCKED) !== '1') set(ACTIVITY, String(Date.now())) }
    const events = ['pointerdown', 'keydown', 'touchstart'] as const
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }))
    const timer = setInterval(() => {
      if (isLocked()) { lockNow(); setLocked(true) }
      const at = loggedInAt()
      // After 12 hours the server must confirm the person again. Offline we cannot, so we do not cut them off mid-shift.
      if (at && navigator.onLine && sessionExpired(at, Date.now())) onSessionExpired()
    }, 15_000)
    return () => {
      events.forEach((e) => window.removeEventListener(e, touch))
      clearInterval(timer)
    }
  }, [enabled, onSessionExpired])

  return [locked, setLocked] as const
}

export const lockMinutes = IDLE_LOCK_MINUTES
