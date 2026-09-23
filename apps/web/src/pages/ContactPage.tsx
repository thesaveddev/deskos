import { useState, type FormEvent } from 'react'
import LandingLayout from '../components/LandingLayout'
import { Icon } from '../components/Icons'

// Must match the API enum in contact.routes.ts — 'enterprise' and 'press'
// were legacy options the backend never accepted.
const SUBJECTS = [
  { value: 'sales', label: 'Sales & pricing' },
  { value: 'support', label: 'Technical support' },
  { value: 'billing', label: 'Billing' },
  { value: 'partnership', label: 'Partnership' },
  { value: 'other', label: 'Other' },
]

export default function ContactPage() {
  const [status, setStatus] = useState<'idle' | 'sending' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (status === 'sending') return
    setStatus('sending')
    setError(null)

    const form = new FormData(e.currentTarget)
    const payload = {
      firstName: String(form.get('first_name') ?? '').trim(),
      lastName: String(form.get('last_name') ?? '').trim(),
      email: String(form.get('email') ?? '').trim(),
      company: String(form.get('company') ?? '').trim() || undefined,
      subject: String(form.get('subject') ?? ''),
      message: String(form.get('message') ?? '').trim(),
      // Honeypot — humans never see this field; bots that fill it are told
      // "success" server-side but nothing is stored or delivered.
      website: String(form.get('website') ?? ''),
    }

    try {
      const res = await fetch('/api/v1/contact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
        throw new Error(body?.error?.message ?? 'Something went wrong. Please email hello@reydesk.com instead.')
      }
      setStatus('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please email hello@reydesk.com instead.')
      setStatus('idle')
    }
  }

  return (
    <LandingLayout
      title="Contact Us — ReyDesk"
      description="Get in touch with the ReyDesk team. Sales enquiries, technical support, partnership opportunities, and general questions."
    >
      <section className="landing-hero">
        <div className="landing-hero-inner">
          <span className="landing-kicker">Get in touch</span>
          <h1 className="landing-title">Get in touch.</h1>
          <p className="landing-sub">
            Whether you have a question about features, pricing, deployment, or anything else — our team is ready to answer.
          </p>
        </div>
      </section>

      <section className="landing-section" style={{ paddingTop: 0 }}>
        <div className="contact-layout">
          {/* form */}
          <div className="contact-form-panel">
            <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 20 }}>Send us a message</h2>
            {status === 'done' ? (
              <div className="alert alert-info" style={{ textAlign: 'center', padding: 24 }}>
                <p style={{ margin: 0, fontSize: 15, fontWeight: 500 }}>Thank you for your message!</p>
                <p style={{ margin: '8px 0 0', fontSize: 13 }}>We've received it and will reply as soon as we can — usually within one business day.</p>
              </div>
            ) : (
              <form className="contact-form" onSubmit={(e) => void handleSubmit(e)}>
                {error ? (
                  <div className="alert alert-error" role="alert" style={{ marginBottom: 16 }}>
                    {error}
                  </div>
                ) : null}
                <div className="form-row">
                  <div className="field">
                    <label className="field-label" htmlFor="contact-first">First name</label>
                    <input className="field-input" id="contact-first" name="first_name" required />
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor="contact-last">Last name</label>
                    <input className="field-input" id="contact-last" name="last_name" required />
                  </div>
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="contact-email">Work email</label>
                  <input className="field-input" id="contact-email" name="email" type="email" required />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="contact-company">Company</label>
                  <input className="field-input" id="contact-company" name="company" />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="contact-subject">Subject</label>
                  <select className="field-input" id="contact-subject" name="subject" required defaultValue="">
                    <option value="" disabled>Select a topic…</option>
                    {SUBJECTS.map((s) => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="contact-message">Message</label>
                  <textarea className="field-input" id="contact-message" name="message" rows={5} required />
                </div>
                {/* Honeypot: visually hidden, tab-skipped, ignored by humans. */}
                <input
                  type="text"
                  name="website"
                  tabIndex={-1}
                  autoComplete="off"
                  aria-hidden="true"
                  style={{ position: 'absolute', left: '-9999px', top: '-9999px' }}
                />
                <button className="btn btn-primary btn-block" type="submit" disabled={status === 'sending'}>
                  {status === 'sending' ? 'Sending…' : 'Send message'}
                </button>
              </form>
            )}
          </div>

          {/* info */}
          <div className="contact-info-panel">
            <div className="contact-info-card">
              <div className="contact-info-icon"><Icon name="mail" size={18} /></div>
              <div className="contact-info-text">
                <h3>Email</h3>
                <p>General: <a href="mailto:hello@reydesk.com">hello@reydesk.com</a><br />
                Sales: <a href="mailto:sales@reydesk.com">sales@reydesk.com</a><br />
                Support: <a href="mailto:support@reydesk.com">support@reydesk.com</a></p>
              </div>
            </div>

            <div className="contact-info-card">
              <div className="contact-info-icon"><Icon name="chat" size={18} /></div>
              <div className="contact-info-text">
                <h3>Support</h3>
                <p>Every plan includes email support through our <a href="/support">support portal</a>. Enterprise customers get a dedicated support engineer.</p>
              </div>
            </div>

            <div className="contact-info-card">
              <div className="contact-info-icon"><Icon name="building" size={18} /></div>
              <div className="contact-info-text">
                <h3>Office</h3>
                <p><a href="https://34orients.com" target="_blank" rel="noreferrer">34orients Ltd</a><br />United Kingdom<br />
                Registered in England &amp; Wales</p>
              </div>
            </div>

            <div className="contact-info-card">
              <div className="contact-info-icon"><Icon name="link" size={18} /></div>
              <div className="contact-info-text">
                <h3>Follow us</h3>
                <p>
                  <a href="https://twitter.com/reydesk" target="_blank" rel="noreferrer">Twitter/X</a> ·{' '}
                  <a href="https://linkedin.com/company/reydesk" target="_blank" rel="noreferrer">LinkedIn</a>
                </p>
              </div>
            </div>

            <div className="contact-info-card">
              <div className="contact-info-icon"><Icon name="clock" size={18} /></div>
              <div className="contact-info-text">
                <h3>When we reply</h3>
                <p>
                  We answer every enquiry as quickly as we can, on business days (UK hours). Enterprise plans include a dedicated support engineer.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </LandingLayout>
  )
}
