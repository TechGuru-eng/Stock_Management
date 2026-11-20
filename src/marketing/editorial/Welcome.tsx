import { useEffect } from 'react'
import './styles.css'
import fefoFlowSvg from './illustrations/fefo-flow.svg?raw'

const FONT_HREF = 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;700&family=Geist+Mono:wght@400&display=swap'

function useEditorialTasteMotion() {
  useEffect(() => {
    document.documentElement.classList.add('js')

    if (!document.querySelector(`link[href="${FONT_HREF}"]`)) {
      const preconnect1 = document.createElement('link')
      preconnect1.rel = 'preconnect'
      preconnect1.href = 'https://fonts.googleapis.com'
      const preconnect2 = document.createElement('link')
      preconnect2.rel = 'preconnect'
      preconnect2.href = 'https://fonts.gstatic.com'
      preconnect2.crossOrigin = 'anonymous'
      const stylesheet = document.createElement('link')
      stylesheet.rel = 'stylesheet'
      stylesheet.href = FONT_HREF
      document.head.append(preconnect1, preconnect2, stylesheet)
    }

    const w = window as typeof window & { __editorialTasteLoaded?: boolean }
    if (!w.__editorialTasteLoaded) {
      w.__editorialTasteLoaded = true
      void import('./motion.js')
    }
  }, [])
}

function useDrawer() {
  useEffect(() => {
    const nav = document.getElementById('nav')
    const menuBtn = document.getElementById('menuBtn')
    const drawer = document.getElementById('drawer')
    if (!nav || !menuBtn || !drawer) return

    const toggleDrawer = (open: boolean) => {
      drawer.classList.toggle('is-open', open)
      drawer.setAttribute('aria-hidden', String(!open))
      menuBtn.setAttribute('aria-expanded', String(open))
      menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu')
      document.body.style.overflow = open ? 'hidden' : ''
    }
    const onMenuClick = () => toggleDrawer(!drawer.classList.contains('is-open'))
    const links = Array.from(drawer.querySelectorAll('a'))
    const onLinkClick = () => toggleDrawer(false)

    menuBtn.addEventListener('click', onMenuClick)
    links.forEach((a) => a.addEventListener('click', onLinkClick))
    return () => {
      menuBtn.removeEventListener('click', onMenuClick)
      links.forEach((a) => a.removeEventListener('click', onLinkClick))
    }
  }, [])
}

function useMeta() {
  useEffect(() => {
    const prevTitle = document.title
    document.title = 'Stockora — the till that watches your stock'
    let meta = document.querySelector('meta[name="description"]')
    const hadMeta = Boolean(meta)
    const prevContent = meta?.getAttribute('content') ?? ''
    if (!meta) {
      meta = document.createElement('meta')
      meta.setAttribute('name', 'description')
      document.head.appendChild(meta)
    }
    meta.setAttribute(
      'content',
      'Stockora tracks expiry by FEFO, pays loyalty points and takes MTN MoMo and Orange Money at the till — built for small and medium shops, online or off.',
    )
    return () => {
      document.title = prevTitle
      if (hadMeta) meta?.setAttribute('content', prevContent)
    }
  }, [])
}

const currentYear = new Date().getFullYear()

const heroImage = {
  src: 'https://images.unsplash.com/photo-1542715473-63675d7974bd?ixid=M3wxMTM5MTk1fDB8MXxzZWFyY2h8MXx8c21hbGwlMjBjb252ZW5pZW5jZSUyMHN0b3JlJTIwY291bnRlciUyMHNob3BrZWVwZXIlMjBkYXlsaWdodHxlbnwxfDB8fHwxNzk1MTQ1NDI2fDA&ixlib=rb-4.1.0&w=2400&h=1500&fit=crop&crop=entropy&auto=format&q=80',
  srcSet:
    'https://images.unsplash.com/photo-1542715473-63675d7974bd?ixid=M3wxMTM5MTk1fDB8MXxzZWFyY2h8MXx8c21hbGwlMjBjb252ZW5pZW5jZSUyMHN0b3JlJTIwY291bnRlciUyMHNob3BrZWVwZXIlMjBkYXlsaWdodHxlbnwxfDB8fHwxNzk1MTQ1NDI2fDA&ixlib=rb-4.1.0&w=1200&h=750&fit=crop&crop=entropy&auto=format&q=80 1200w, https://images.unsplash.com/photo-1542715473-63675d7974bd?ixid=M3wxMTM5MTk1fDB8MXxzZWFyY2h8MXx8c21hbGwlMjBjb252ZW5pZW5jZSUyMHN0b3JlJTIwY291bnRlciUyMHNob3BrZWVwZXIlMjBkYXlsaWdodHxlbnwxfDB8fHwxNzk1MTQ1NDI2fDA&ixlib=rb-4.1.0&w=2400&h=1500&fit=crop&crop=entropy&auto=format&q=80 2400w',
  color: '#d9c0c0',
  alt: "A small shop's front counter, its shelves stacked with packaged goods in daylight",
  credit: { name: 'Zhu Hongzhi', photoUrl: 'https://unsplash.com/photos/displayed-products-pHdx3P6zVn0?utm_source=stockora&utm_medium=referral', profileUrl: 'https://unsplash.com/@zhuzhutrain?utm_source=stockora&utm_medium=referral' },
}

const navLinks = [
  { href: '#offer', label: 'Features' },
  { href: '#how', label: 'How it works' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#faq', label: 'FAQ' },
]

const offerRows = [
  { name: 'Low-stock alerts', desc: 'Levels, a banner, a tab count, snooze, and a device notification before a shelf runs out.' },
  { name: 'Expiry & FEFO', desc: 'Dated batches, remaining stock drawn from the oldest one first, and a write-off when one expires.' },
  { name: 'Customer loyalty', desc: 'Points earned on money paid, spent as a till discount, reversed automatically on returns.' },
  { name: 'Mobile money', desc: 'MTN MoMo and Orange Money, confirmed by the provider and logged in an attempts ledger.' },
]

const steps = [
  'A batch arrives with its own expiry date.',
  'A sale always draws from the oldest batch first.',
  "Remaining stock and expiry alerts sync to every device.",
]

const pricingPlans = [
  {
    name: 'Starter',
    price: '5,000',
    suffix: '/month',
    recommended: false,
    features: ['1 shop, 3 staff, 1,000 products', 'Cash, MTN MoMo and Orange Money at the till', 'Stock counts and low-stock alerts', 'WhatsApp debt reminders'],
    cta: { label: 'Start free trial', href: '/' },
  },
  {
    name: 'Business',
    price: '15,000',
    suffix: '/month',
    recommended: true,
    features: ['3 shops, 10 staff, 5,000 products', 'Verified mobile money, straight to your account', 'Expiry dates, oldest-first stock, write-off', 'Loyalty points and reorder suggestions', 'PDF invoices and barcode labels'],
    cta: { label: 'Start free trial', href: '/' },
  },
  {
    name: 'Pro',
    price: '25,000',
    suffix: '/month',
    recommended: false,
    features: ['10 shops, unlimited staff and products', 'Supplier price lists and quote hints', 'Priority support', 'Set-up help for your data and team'],
    cta: { label: 'Start free trial', href: '/' },
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    suffix: 'by quote',
    recommended: false,
    features: ['Limits set around your business', 'Onboarding and staff training', 'Dedicated support contact'],
    cta: { label: 'Contact sales', href: 'mailto:{{sales email}}' },
  },
]

const faqs = [
  { q: 'Does Stockora work without internet?', a: 'Yes. Sales, stock counts and till actions keep working offline, and everything syncs once a device is back online.' },
  { q: 'How does FEFO expiry tracking work?', a: "Every batch is dated when it comes in. A sale always draws from the oldest batch first, and stock close to expiring is flagged before it's wasted." },
  { q: 'Which mobile money providers are supported?', a: "MTN MoMo and Orange Money today. The customer approves the payment on their own phone, and it settles into the shop's own account." },
  { q: 'Can staff have limited access?', a: 'Yes. Owners, managers and staff see different screens, and an idle device locks itself after a pause.' },
  { q: 'How do loyalty points work?', a: 'Customers earn points on what they pay, redeem them as a discount at the till, and points reverse automatically if the sale is returned.' },
  { q: 'Can I run more than one shop?', a: 'Yes, depending on your plan. Switch between shops from the till, and each one keeps its own stock and staff.' },
  { q: 'What happens if I miss a renewal?', a: "New sales and stock entries pause until the plan is renewed, but the shop can still view and export everything already recorded — nothing is deleted." },
  { q: "Is my shop's data backed up?", a: "Yes. Stock, sales and money records sync to the cloud as soon as a device is online, in addition to what's kept on the device." },
]

const faqJsonLd = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: faqs.map((f) => ({
    '@type': 'Question',
    name: f.q,
    acceptedAnswer: { '@type': 'Answer', text: f.a },
  })),
})

export function Welcome() {
  useEditorialTasteMotion()
  useDrawer()
  useMeta()

  return (
    <div className="editorial-taste">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: faqJsonLd }} />
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <symbol id="logo" viewBox="0 0 150 24">
          <text x="0" y="18" fill="currentColor" fontFamily="Geist, sans-serif" fontWeight={700} fontSize={20} letterSpacing={-0.5}>STOCKORA</text>
        </symbol>
        <symbol id="i-arrow" viewBox="0 0 12 12"><path d="M1 6h10M7 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="square" /></symbol>
        <symbol id="i-plus" viewBox="0 0 14 14"><path d="M7 1v12M1 7h12" fill="none" stroke="currentColor" strokeWidth={1.3} /></symbol>
        <symbol id="i-menu" viewBox="0 0 16 16"><path d="M2 5h12M2 11h12" fill="none" stroke="currentColor" strokeWidth={1.3} /></symbol>
      </svg>

      <a className="sr-only" href="#main">Skip to content</a>

      <header className="nav" id="nav">
        <div className="container nav__inner">
          <a className="logo" href="/welcome" aria-label="Stockora home"><svg aria-hidden="true"><use href="#logo" /></svg></a>
          <div className="nav__right">
            <nav aria-label="Primary">
              <ul className="nav__links">
                {navLinks.map((l) => (
                  <li key={l.href}><a className="nav__link" href={l.href}>{l.label}</a></li>
                ))}
              </ul>
            </nav>
            <div className="nav__utils">
              <a className="btn btn--primary btn--sm" href="/">Start free trial</a>
              <button className="icon-btn nav__menu" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="drawer" id="menuBtn">
                <svg><use href="#i-menu" /></svg>
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="drawer" id="drawer" aria-hidden="true">
        <ul className="drawer__links h4">
          {navLinks.map((l) => (
            <li key={l.href}><a href={l.href}>{l.label}</a></li>
          ))}
          <li><a href="/">Start free trial</a></li>
        </ul>
        <div className="drawer__meta label-lg">Stockora</div>
      </div>

      <main id="main">
        {/* ===== Hero — split screen ===== */}
        <section className="hero-split" aria-labelledby="hero-title">
          <div className="hero-split__grid">
            <div className="hero-split__text">
              <div className="hero-split__top">
                <span className="eyebrow">Stock, sales &amp; money</span>
                <h1 className="h2" id="hero-title" data-reveal="text" style={{ ['--d' as string]: '.15s' }}>Stock that watches itself.</h1>
                <p className="body-lg reveal" style={{ ['--d' as string]: '.4s' }}>
                  Stockora runs the till, tracks every batch by its expiry date, and pays loyalty points on what
                  customers actually spend. Built for small and medium shops that can't always rely on a signal.
                </p>
                <div className="btn-row reveal" style={{ ['--d' as string]: '.5s' }}>
                  <a className="btn btn--primary btn--wide" href="/">Start free trial</a>
                  <a className="btn btn--secondary btn--wide" href="#how">See how it works</a>
                </div>
              </div>
              <div className="hero-split__stats reveal" data-stagger="90" style={{ ['--d' as string]: '.6s' }}>
                <div className="stat"><span className="h4 stat__value">PWA</span><span className="label-lg muted">Installs like an app</span></div>
                <div className="stat"><span className="h4 stat__value">FEFO</span><span className="label-lg muted">Expiry-aware stock</span></div>
                <div className="stat"><span className="h4 stat__value">2</span><span className="label-lg muted">Mobile money adapters</span></div>
              </div>
            </div>
            <div className="hero__media">
              <img src={heroImage.src} srcSet={heroImage.srcSet} sizes="50vw" width={2400} height={1500} alt={heroImage.alt} fetchPriority="high" style={{ background: heroImage.color }} />
            </div>
          </div>
        </section>

        {/* ===== Proof — dark stat band ===== */}
        <section className="stats stats--dark" aria-label="Stockora in numbers">
          <div className="container stats__grid" data-stagger="90">
            <div className="stat reveal"><span className="h1 stat__value" data-count>4</span><span className="body-lg muted">Modules in one till</span></div>
            <div className="stat reveal"><span className="h1 stat__value" data-count>2</span><span className="body-lg muted">Till payment adapters</span></div>
            <div className="stat reveal"><span className="h1 stat__value">FEFO</span><span className="body-lg muted">Batches, oldest out first</span></div>
            <div className="stat reveal"><span className="h1 stat__value">PWA</span><span className="body-lg muted">Works without a connection</span></div>
          </div>
        </section>

        {/* ===== Statement ===== */}
        <section className="statement" aria-label="Stockora in one statement">
          <div className="container">
            <p className="h0 statement__text" data-words>
              Stockora keeps a shop's stock, money and customers in one till — even when the signal drops.
            </p>
          </div>
        </section>

        {/* ===== Offer — index rows ===== */}
        <section className="section" id="offer" aria-labelledby="offer-title">
          <div className="container">
            <div className="intro intro--simple reveal">
              <div>
                <span className="eyebrow intro__eyebrow">01 — What it does</span>
                <h2 className="h3" id="offer-title" data-reveal="text">Everything the till needs</h2>
              </div>
            </div>
            <div className="index" data-stagger="80">
              {offerRows.map((row, i) => (
                <div className="index__row reveal" key={row.name}>
                  <span className="index__num">{String(i + 1).padStart(2, '0')}</span>
                  <div className="index__name"><span className="h4">{row.name}</span></div>
                  <p className="body-md index__desc">{row.desc}</p>
                  <span className="index__arrow" aria-hidden="true"><svg><use href="#i-arrow" /></svg></span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ===== Approach — illustration split ===== */}
        <section className="section" id="how" aria-labelledby="how-title">
          <div className="container illo-split">
            <div className="illo-split__text reveal">
              <span className="eyebrow intro__eyebrow">02 — How it works</span>
              <h2 className="h3" id="how-title" data-reveal="text">Stock leaves in the order it expires.</h2>
              <p className="body-md muted">
                Every batch gets a received date. A sale always draws from the oldest batch first, and what's left
                — or close to expiring — updates on every device in the shop.
              </p>
              <ol className="steps" data-stagger="80">
                {steps.map((s, i) => (
                  <li className="reveal" key={s}><span className="label-lg">{String(i + 1).padStart(2, '0')}</span><span className="body-md">{s}</span></li>
                ))}
              </ol>
            </div>
            <figure className="illo" data-reveal="iso" dangerouslySetInnerHTML={{ __html: fefoFlowSvg }} />
          </div>
        </section>

        {/* ===== Offer — pricing ===== */}
        <section className="section" id="pricing" aria-labelledby="pricing-title">
          <div className="container">
            <div className="intro intro--simple reveal">
              <div>
                <span className="eyebrow intro__eyebrow">03 — Pricing</span>
                <h2 className="h3" id="pricing-title" data-reveal="text">Plans for every shop.</h2>
              </div>
            </div>
            <div className="pricing reveal">
              {pricingPlans.map((plan) => (
                <div className={`pricing__plan${plan.recommended ? ' pricing__plan--recommended' : ''}`} key={plan.name}>
                  <span className="label-lg pricing__name">{plan.name}</span>
                  <div className="h1 pricing__price">{plan.price}<span className="body-md">{' '}{plan.suffix}</span></div>
                  <ul className="body-md pricing__list">
                    {plan.features.map((f) => <li key={f}>{f}</li>)}
                  </ul>
                  <a className="btn btn--primary" href={plan.cta.href}>{plan.cta.label}</a>
                </div>
              ))}
            </div>
            <p className="body-md muted reveal" style={{ marginTop: 'var(--space-25)', maxWidth: '72ch' }}>
              Every plan starts with a 30-day free trial of the Business features, no card needed. Longer terms earn
              free months — 6 months bills for 7, 12 months bills for 14. Pay by MTN MoMo or Orange Money.
            </p>
          </div>
        </section>

        {/* ===== Objections — FAQ, two columns ===== */}
        <section className="section" id="faq" aria-labelledby="faq-title">
          <div className="container faq faq--split">
            <div className="reveal" style={{ marginBottom: 'var(--section-gap)' }}>
              <span className="eyebrow intro__eyebrow">04 — Questions</span>
              <h2 className="h3" id="faq-title" data-reveal="text">Questions, answered.</h2>
            </div>
            <div className="faq--split__cols">
              <div className="faq__list reveal">
                {faqs.slice(0, 4).map((f) => (
                  <details className="faq__item" key={f.q}>
                    <summary className="h6">{f.q} <svg aria-hidden="true"><use href="#i-plus" /></svg></summary>
                    <p className="body-md">{f.a}</p>
                  </details>
                ))}
              </div>
              <div className="faq__list reveal">
                {faqs.slice(4).map((f) => (
                  <details className="faq__item" key={f.q}>
                    <summary className="h6">{f.q} <svg aria-hidden="true"><use href="#i-plus" /></svg></summary>
                    <p className="body-md">{f.a}</p>
                  </details>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ===== Action — type CTA ===== */}
        <section className="section section--dark cta-type" aria-labelledby="cta-title">
          <div className="container cta-type__inner reveal">
            <span className="eyebrow">Stockora</span>
            <h2 className="h2 cta-type__title" id="cta-title" data-reveal="text">Your shelf already knows what's running low.</h2>
            <hr />
            <p className="body-md">Start free, and watch your stock, money and loyalty numbers update as the first sale comes in.</p>
            <div className="btn-row">
              <a className="btn btn--light btn--wide" href="/">Start free trial</a>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer--light">
        <div className="container footer--light__row">
          <a className="logo" href="/welcome" aria-label="Stockora home"><svg aria-hidden="true"><use href="#logo" /></svg></a>
          <nav className="footer--light__links label-lg" aria-label="Footer">
            {navLinks.map((l) => <a className="u-link" href={l.href} key={l.href}>{l.label}</a>)}
          </nav>
          <div className="footer--light__legal label-lg">
            <span>© {currentYear} Stockora.</span>
            <a className="u-link" href="{{/privacy}}">Privacy</a>
            <a className="u-link" href="{{/terms}}">Terms</a>
          </div>
        </div>
        <p className="container label-lg muted" style={{ marginTop: 'var(--space-20)' }}>
          Hero photo by{' '}
          <a className="u-link" href={heroImage.credit.profileUrl} target="_blank" rel="noopener noreferrer">{heroImage.credit.name}</a>
          {' '}on{' '}
          <a className="u-link" href={heroImage.credit.photoUrl} target="_blank" rel="noopener noreferrer">Unsplash</a>
        </p>
      </footer>
    </div>
  )
}
