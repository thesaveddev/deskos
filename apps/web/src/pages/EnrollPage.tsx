import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Alert, BrandRow } from '../components/ui.js'

interface EnrolInfo {
  valid: boolean
  expiresAt?: string
  helperAvailable?: boolean
  platform?: string
}

function platformLabel(platform: string): string {
  if (platform === 'macos') return 'macOS'
  if (platform === 'android') return 'Android'
  if (platform === 'windows') return 'Windows'
  return 'your device'
}

export default function EnrollPage() {
  const { code = '' } = useParams<{ code: string }>()
  const [info, setInfo] = useState<EnrolInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!/^\d{12}$/.test(code)) {
      setError('This enrollment code is invalid. Ask your technician for a new code.')
      return
    }
    let cancelled = false
    void fetch(`/api/enrol/${encodeURIComponent(code)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error('This enrollment code is invalid or expired. Ask your technician for a new code.')
        return response.json() as Promise<EnrolInfo>
      })
      .then((next) => { if (!cancelled) setInfo(next) })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not validate this enrollment code.') })
    return () => { cancelled = true }
  }, [code])

  const platform = info?.platform ?? 'windows'
  const downloadUrl = `/api/enrol/${encodeURIComponent(code)}/download`

  return (
    <div className="auth-screen">
      <div className="auth-panel connect-panel enrol-page">
        <BrandRow />
        <span className="settings-eyebrow">Device enrollment</span>
        <h1 className="auth-title">Add this device to ReyDesk</h1>
        <p className="auth-sub">This is an enrollment link, not a remote support session. Install the agent, enter the code, and your technician will see the device in Devices.</p>
        {error ? <Alert kind="error">{error}</Alert> : null}
        {info ? <div className="connect-request">
          <div className="connect-code"><span className="etch">Enrollment code</span><div className="support-code-digits">{code}</div></div>
          <section className="connect-how-to">
            <span className="settings-eyebrow">Install steps</span>
            <ol>
              <li>Download the ReyDesk agent for {platformLabel(platform)}.</li>
              <li>Run or install it on this device.</li>
              <li>Enter the 12-digit enrollment code shown above.</li>
              <li>Approve the requested Windows security or screen permissions.</li>
            </ol>
          </section>
          {info.helperAvailable ? <a className="btn btn-primary btn-block" href={downloadUrl}>Download the {platformLabel(platform)} ReyDesk agent</a> : <div className="connect-download"><strong>Agent download unavailable</strong><span className="muted">Ask your technician to configure the signed agent package before enrolling this device.</span></div>}
          {info.expiresAt ? <span className="muted">This code expires {new Date(info.expiresAt).toLocaleString()} and can be used once.</span> : null}
          <div className="enrol-modal-note"><strong>Important:</strong><span>Do not enter this enrollment code on the Remote Session support page. Remote Session codes and enrollment codes are separate.</span></div>
        </div> : null}
      </div>
    </div>
  )
}
