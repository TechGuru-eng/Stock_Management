import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { noticeText, parseNotices } from './notices'

describe('platform notices', () => {
  it('keeps only well-formed values from the server', () => {
    const n = parseNotices({
      announcement: { active: true, level: 'warn', fr: 'Bonjour', en: 'Hello', evil: '<script>' },
      maintenance: { active: 'yes' },
      flags: { reports_pdf: true, bad: 'x', n: 1 },
    })
    expect(n.announcement).toEqual({ active: true, level: 'warn', fr: 'Bonjour', en: 'Hello' })
    expect(n.maintenance?.active).toBe(false) // only a real true switches it on
    expect(n.flags).toEqual({ reports_pdf: true })
  })
  it('survives garbage', () => {
    expect(parseNotices(null)).toEqual({ announcement: null, maintenance: null, flags: {} })
    expect(parseNotices('x').flags).toEqual({})
  })
  it('shows the right language, falls back to the other, and nothing when off', () => {
    const n = { active: true, fr: 'Maintenance ce soir', en: '' }
    expect(noticeText(n, 'fr')).toBe('Maintenance ce soir')
    expect(noticeText(n, 'en')).toBe('Maintenance ce soir') // English missing: French is better than nothing
    expect(noticeText({ ...n, active: false }, 'fr')).toBeNull()
    expect(noticeText({ active: true, fr: '  ', en: '' }, 'fr')).toBeNull()
    expect(noticeText(null, 'fr')).toBeNull()
  })
})
