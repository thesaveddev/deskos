import { useState, type FormEvent } from 'react'
import LandingLayout from '../components/LandingLayout'

export default function ContactPage() {
  const [submitted, setSubmitted] = useState(false)

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    setSubmitted(true)
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
            {submitted ? (
              <div className="alert alert-info" style={{ textAlign: 'center', padding: 24 }}>
                <p style={{ margin: 0, fontSize: 15, fontWeight: 500 }}>Thank you for your message!</p>
                <p style={{ margin: '8px 0 0', fontSize: 13 }}>We'll get back to you within 24 hours.</p>
              </div>
            ) : (
              <form className="contact-form" onSubmit={handleSubmit}>
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
                  <select className="field-input" id="contact-subject" name="subject" required>
                    <option value="">Select a topic…</option>
                    <option value="sales">Sales &amp; pricing</option>
                    <option value="support">Technical support</option>
                    <option value="enterprise">Enterprise enquiry</option>
                    <option value="partnership">Partnership</option>
                    <option value="press">Press &amp; media</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="contact-message">Message</label>
                  <textarea className="field-input" id="contact-message" name="message" required />
                </div>
                <button className="btn btn-primary btn-block" type="submit">Send message</button>
              </form>
            )}
          </div>

          {/* info */}
          <div className="contact-info-panel">
            <div className="contact-info-card">
              <div className="contact-info-icon">📧</div>
              <div className="contact-info-text">
                <h3>Email</h3>
                <p>General: <a href="mailto:hello@reydesk.com">hello@reydesk.com</a><br />
                Sales: <a href="mailto:sales@reydesk.com">sales@reydesk.com</a><br />
                Support: <a href="mailto:support@reydesk.com">support@reydesk.com</a></p>
              </div>
            </div>

            <div className="contact-info-card">
              <div className="contact-info-icon">💬</div>
              <div className="contact-info-text">
                <h3>Live chat</h3>
                <p>Available Monday–Friday, 9 AM – 6 PM GMT. Click the chat widget on any page of the app.</p>
              </div>
            </div>

            <div className="contact-info-card">
              <div className="contact-info-icon">🏢</div>
              <div className="contact-info-text">
                <h3>Office</h3>
                <p>Clean IT Ltd<br />United Kingdom<br />
                Registered in England &amp; Wales</p>
              </div>
            </div>

            <div className="contact-info-card">
              <div className="contact-info-icon">🔗</div>
              <div className="contact-info-text">
                <h3>Follow us</h3>
                <p>
                  <a href="https://github.com/thesaveddev/reydesk" target="_blank" rel="noreferrer">GitHub</a> ·{' '}
                  <a href="https://twitter.com/reydesk" target="_blank" rel="noreferrer">Twitter/X</a> ·{' '}
                  <a href="https://linkedin.com/company/reydesk" target="_blank" rel="noreferrer">LinkedIn</a>
                </p>
              </div>
            </div>

            <div className="contact-info-card">
              <div className="contact-info-icon">🕐</div>
              <div className="contact-info-text">
                <h3>Response times</h3>
                <p>
                  <strong>Pro &amp; Enterprise:</strong> Under 4 hours (business days)<br />
                  <strong>Starter:</strong> Under 24 hours<br />
                  <strong>Free tier:</strong> Community support via GitHub
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </LandingLayout>
  )
}
