import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { attemptsLeft, idleExpired, lockSeconds, sessionExpired, validatePin } from '../domain/staffPin'

const { db } = await import('../data/db')
const { enrollLocalPin, hasLocalPin, pbkdf2, removeLocalPin, verifyLocalPin } = await import('./localPin')

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
})

describe('PIN policy', () => {
  it.each(['4821', '7391', '582049', '9037', '270615'])('accepts %s', (pin) => {
    expect(validatePin(pin)).toEqual({ ok: true })
  })
  it.each([
    ['123', 'format'], ['1234567', 'format'], ['12a4', 'format'], ['', 'format'], ['12 34', 'format'],
    ['0000', 'repeated'], ['777777', 'repeated'],
    ['1234', 'sequence'], ['4321', 'sequence'], ['345678', 'sequence'], ['9876', 'sequence'],
    ['2580', 'common'], ['6969', 'common'], ['123123', 'common'],
  ] as const)('refuses %s (%s)', (pin, problem) => {
    expect(validatePin(pin)).toEqual({ ok: false, problem })
  })
})

describe('lockout policy', () => {
  it('is free for 4 wrong PINs, then locks for 5 minutes and doubles up to an hour', () => {
    expect([0, 1, 2, 3, 4].map(lockSeconds)).toEqual([0, 0, 0, 0, 0])
    expect(lockSeconds(5)).toBe(300)
    expect(lockSeconds(6)).toBe(600)
    expect(lockSeconds(7)).toBe(1200)
    expect(lockSeconds(8)).toBe(2400)
    expect(lockSeconds(9)).toBe(3600)
    expect(lockSeconds(40)).toBe(3600)
  })
  it('counts the attempts left', () => {
    expect([0, 1, 4, 5, 9].map(attemptsLeft)).toEqual([5, 4, 1, 0, 0])
  })
  it('idle lock and maximum session length', () => {
    const t0 = Date.parse('2026-11-17T08:00:00Z')
    expect(idleExpired(t0, t0 + 4 * 60_000)).toBe(false)
    expect(idleExpired(t0, t0 + 5 * 60_000)).toBe(true)
    expect(sessionExpired(t0, t0 + 11 * 3_600_000)).toBe(false)
    expect(sessionExpired(t0, t0 + 12 * 3_600_000)).toBe(true)
  })
})

describe('offline unlock for a staff member who already signed in', () => {
  const fast = 1000 // low iteration count keeps the test quick; the real value is much higher

  it('accepts the right PIN and never stores the PIN itself', async () => {
    await enrollLocalPin('u1', '4821', 'Awa', fast)
    expect(await hasLocalPin('u1')).toBe(true)
    expect(await verifyLocalPin('u1', '4821')).toEqual({ ok: true })
    const stored = JSON.stringify((await db.meta.get('pin:u1'))!.value)
    expect(stored).not.toContain('4821')
    expect(await verifyLocalPin('u1', '9999')).toMatchObject({ ok: false, reason: 'wrong' })
  })

  it('the same PIN gives different stored values for different people (salted)', async () => {
    await enrollLocalPin('u1', '4821', 'Awa', fast)
    await enrollLocalPin('u2', '4821', 'Paul', fast)
    expect((await db.meta.get('pin:u1'))!.value).not.toEqual((await db.meta.get('pin:u2'))!.value)
    expect(await pbkdf2('4821', 'AAAAAAAAAAAAAAAAAAAAAA==', fast)).toBe(await pbkdf2('4821', 'AAAAAAAAAAAAAAAAAAAAAA==', fast))
  })

  it('locks after five wrong PINs, even for the right PIN, until the time passes', async () => {
    await enrollLocalPin('u1', '4821', 'Awa', fast)
    const t = Date.parse('2026-11-17T08:00:00Z')
    for (let i = 1; i <= 4; i++) {
      const r = await verifyLocalPin('u1', '0001', t)
      expect(r).toMatchObject({ ok: false, reason: 'wrong', attemptsLeft: 5 - i })
    }
    const fifth = await verifyLocalPin('u1', '0001', t)
    expect(fifth).toMatchObject({ ok: false, reason: 'wrong', attemptsLeft: 0, retryAfterSec: 300 })

    expect(await verifyLocalPin('u1', '4821', t + 60_000)).toMatchObject({ ok: false, reason: 'locked' })
    expect(await verifyLocalPin('u1', '4821', t + 301_000)).toEqual({ ok: true })
  })

  it('a correct PIN resets the count', async () => {
    await enrollLocalPin('u1', '4821', 'Awa', fast)
    await verifyLocalPin('u1', '1111')
    await verifyLocalPin('u1', '1111')
    expect(await verifyLocalPin('u1', '4821')).toEqual({ ok: true })
    expect(await verifyLocalPin('u1', '1111')).toMatchObject({ ok: false, attemptsLeft: 4 })
  })

  it('says so when there is nothing to check against, and forgets a removed person', async () => {
    expect(await verifyLocalPin('ghost', '4821')).toEqual({ ok: false, reason: 'none' })
    await enrollLocalPin('u1', '4821', 'Awa', fast)
    await removeLocalPin('u1')
    expect(await verifyLocalPin('u1', '4821')).toEqual({ ok: false, reason: 'none' })
  })
})
