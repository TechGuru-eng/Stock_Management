import { describe, expect, it } from 'vitest'
import { DEBT_TEMPLATE, RENEWAL_TEMPLATE, daysLeft, firstName, moneyText, renderTemplate, renewalKind, waLink } from './reminders'

describe('wa.me links', () => {
  it('accepts the usual ways of writing a Cameroon number', () => {
    for (const p of ['677123456', '+237 677 12 34 56', '237677123456', '00237-677-123-456', '(677) 123 456']) {
      expect(waLink(p, 'hi')).toBe('https://wa.me/237677123456?text=hi')
    }
  })
  it('refuses numbers that cannot be WhatsApp numbers here, so nobody opens a wrong chat', () => {
    for (const p of ['', null, undefined, '12345', '577123456', '67712345', '+33 6 12 34 56 78']) expect(waLink(p as string, 'x')).toBeNull()
  })
  it('encodes accents, line breaks and symbols in the message', () => {
    const u = waLink('677123456', 'Bonjour Élodie,\n100% à payer & merci')!
    expect(u).toContain('text=Bonjour%20%C3%89lodie%2C%0A100%25%20%C3%A0%20payer%20%26%20merci')
    expect(new URL(u).searchParams.get('text')).toBe('Bonjour Élodie,\n100% à payer & merci')
  })
})

describe('templates', () => {
  it('fills the placeholders and never shows a raw {placeholder}', () => {
    expect(renderTemplate('Hi {name}, {amount}{missing}!', { name: 'Awa', amount: '2 000 FCFA' })).toBe('Hi Awa, 2 000 FCFA!')
  })
  it('the debt message reads well in both languages', () => {
    const v = { name: 'Awa', shop: 'Boutique Mbarga', amount: moneyText(12500) }
    expect(renderTemplate(DEBT_TEMPLATE.fr, v)).toContain('12 500 FCFA')
    expect(renderTemplate(DEBT_TEMPLATE.en, v)).toContain('Hello Awa, this is Boutique Mbarga.')
    expect(renderTemplate(DEBT_TEMPLATE.fr, v)).not.toMatch(/[{}]/)
  })
  it('every renewal message uses only known placeholders', () => {
    const known = new Set(['name', 'business', 'plan', 'date', 'days'])
    for (const k of Object.keys(RENEWAL_TEMPLATE) as (keyof typeof RENEWAL_TEMPLATE)[]) {
      for (const l of ['fr', 'en'] as const) for (const m of RENEWAL_TEMPLATE[k][l].matchAll(/\{(\w+)\}/g)) expect(known.has(m[1])).toBe(true)
    }
  })
  it('money and names', () => {
    expect(moneyText(1234567)).toBe('1 234 567 FCFA')
    expect(moneyText(500)).toBe('500 FCFA')
    expect(firstName('Awa Ndongo')).toBe('Awa')
    expect(firstName('Mama')).toBe('Mama')
  })
})

describe('which renewal message', () => {
  it('follows how close the end is', () => {
    expect(renewalKind(9, 7)).toBeNull()
    expect(renewalKind(5, 7)).toBe('renewal_5d')
    expect(renewalKind(3, 7)).toBe('renewal_5d')
    expect(renewalKind(2, 7)).toBe('renewal_2d')
    expect(renewalKind(0, 7)).toBe('renewal_2d')
    expect(renewalKind(-1, 7)).toBe('grace_started')
    expect(renewalKind(-7, 7)).toBe('grace_started')
    expect(renewalKind(-8, 7)).toBe('expired')
  })
  it('counts days left', () => {
    const now = new Date('2026-11-17T12:00:00Z')
    expect(daysLeft('2026-11-20T12:00:00Z', now)).toBe(3)
    expect(daysLeft('2026-11-20T18:00:00Z', now)).toBe(4)
    expect(daysLeft('2026-11-16T12:00:00Z', now)).toBe(-1)
  })
})
