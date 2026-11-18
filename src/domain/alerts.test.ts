import { describe, expect, it } from 'vitest'
import { DEFAULT_ALERTS, active, computeAlerts, countByLevel, digestText, isSnoozed, newAlerts, snoozeUntil, type AlertProduct, type StockAlert } from './alerts'

const P = (id: string, over: Partial<AlertProduct> = {}): AlertProduct => ({ id, name: id, minStock: 0, isService: false, active: true, baseUnit: 'piece', ...over })
const run = (products: AlertProduct[], have: Record<string, number>, speed: Record<string, number> = {}, incoming: Record<string, number> = {}, s = DEFAULT_ALERTS) =>
  computeAlerts(products, new Map(Object.entries(have)), new Map(Object.entries(speed)), new Map(Object.entries(incoming)), s)

describe('which products need attention', () => {
  it('out of stock, low (at or below the minimum), and running out (fewer days left than the delivery time)', () => {
    const r = run([P('a'), P('b', { minStock: 10 }), P('c')], { a: 0, b: 8, c: 12 }, { a: 1, c: 3 })
    expect(r.map((x) => [x.productId, x.level])).toEqual([['a', 'out'], ['b', 'low'], ['c', 'running_out']])
    expect(r[2].daysLeft).toBe(4)
  })
  it('exactly at the minimum is low; one more is fine', () => {
    expect(run([P('b', { minStock: 10 })], { b: 10 })[0].level).toBe('low')
    expect(run([P('b', { minStock: 10 })], { b: 11 })).toEqual([])
  })
  it('a product nobody buys and without a minimum is never an alert, however empty', () => {
    expect(run([P('dead')], { dead: 0 })).toEqual([])
    expect(run([P('dead', { minStock: 3 })], { dead: 0 })[0].level).toBe('out')
  })
  it('services, hidden products and healthy stock are not alerts; negative stock is an empty shelf', () => {
    expect(run([P('s', { isService: true }), P('h', { active: false })], { s: 0, h: 0 }, { s: 5, h: 5 })).toEqual([])
    expect(run([P('ok')], { ok: 500 }, { ok: 1 })).toEqual([])
    expect(run([P('neg')], { neg: -4 }, { neg: 1 })[0]).toMatchObject({ level: 'out', daysLeft: 0 })
  })
  it('the delivery time setting changes what counts as running out', () => {
    expect(run([P('x')], { x: 10 }, { x: 1 })).toEqual([]) // 10 days left, delivery takes 7
    expect(run([P('x')], { x: 10 }, { x: 1 }, {}, { ...DEFAULT_ALERTS, leadDays: 14 })[0].level).toBe('running_out')
  })
})

describe('an order that is already on its way', () => {
  it('covers the alert (shown, but not counted)', () => {
    const r = run([P('a', { minStock: 6 })], { a: 2 }, { a: 1 }, { a: 24 })
    expect(r[0]).toMatchObject({ level: 'low', covered: true })
    expect(active(r, {}, new Date())).toEqual([])
  })
  it('a small order that does not solve it does not cover it', () => {
    expect(run([P('a', { minStock: 6 })], { a: 2 }, { a: 1 }, { a: 3 })[0].covered).toBe(false)
  })
})

describe('worst first', () => {
  it('out before low before running out; uncovered before covered', () => {
    const r = run([P('c'), P('b', { minStock: 10 }), P('a'), P('z', { minStock: 6 })], { a: 0, b: 5, c: 2, z: 1 }, { a: 1, c: 1 }, { z: 50 })
    expect(r.map((x) => x.productId)).toEqual(['a', 'b', 'c', 'z'])
  })
})

describe('snoozing', () => {
  const now = new Date('2026-11-18T10:00:00Z')
  it('hides a product until the time is up', () => {
    const until = { a: snoozeUntil(now, 7) }
    expect(isSnoozed(until, 'a', now)).toBe(true)
    expect(isSnoozed(until, 'a', new Date('2026-11-26T10:00:00Z'))).toBe(false)
    expect(isSnoozed(until, 'b', now)).toBe(false)
    const alerts = run([P('a'), P('b')], { a: 0, b: 0 }, { a: 1, b: 1 })
    expect(active(alerts, until, now).map((x) => x.productId)).toEqual(['b'])
  })
})

describe('telling the person only what is new', () => {
  const alert = (id: string, level: StockAlert['level']): StockAlert => ({ productId: id, name: id, baseUnit: 'piece', level, onHand: 0, onOrder: 0, minStock: 0, daysLeft: null, covered: false })
  it('notifies new alerts and ones that got worse, never the same one twice', () => {
    const first = newAlerts([alert('a', 'low'), alert('b', 'running_out')], {})
    expect(first.notify.map((x) => x.productId)).toEqual(['a', 'b'])
    const again = newAlerts([alert('a', 'low'), alert('b', 'running_out')], first.next)
    expect(again.notify).toEqual([])
    const worse = newAlerts([alert('a', 'out'), alert('b', 'running_out')], again.next)
    expect(worse.notify.map((x) => x.productId)).toEqual(['a'])
  })
  it('a product that recovers is forgotten, so the problem coming back is new again; getting better is not re-announced', () => {
    const t1 = newAlerts([alert('a', 'out')], {})
    const better = newAlerts([alert('a', 'low')], t1.next)
    expect(better.notify).toEqual([])
    expect(better.next.a).toBe('out') // remembers the worst told, so low -> out later is not announced twice
    const recovered = newAlerts([], better.next)
    expect(recovered.next).toEqual({})
    expect(newAlerts([alert('a', 'low')], recovered.next).notify).toHaveLength(1)
  })
})

describe('summaries', () => {
  const alerts = run([P('a'), P('b', { minStock: 9 }), P('c')], { a: 0, b: 4, c: 3 }, { a: 1, c: 1 })
  it('counts by level', () => {
    expect(countByLevel(alerts)).toEqual({ out: 1, low: 1, running_out: 1 })
  })
  it('writes a short digest in either language, with a cap', () => {
    expect(digestText('fr', 'Boutique', alerts)).toBe('Stock à surveiller — Boutique\n- a: 0 piece (rupture)\n- b: 4 piece (stock bas)\n- c: 3 piece (bientôt fini)')
    expect(digestText('en', 'Shop', alerts, 1)).toBe('Stock to watch — Shop\n- a: 0 piece (out of stock)\n… and 2 more')
    expect(digestText('en', 'Shop', [])).toBe('Stock to watch — Shop\nNothing to report.')
  })
})
