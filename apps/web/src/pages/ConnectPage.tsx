import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Alert, BrandRow } from '../components/ui.js'

interface ConnectInfo {
  state: string
  reason: string
  permissions: string[]
  helperAvailable: boolean
}

const PERMISSION_LABELS: Record<string, string> = {
  view_screen: 'View your screen',
  control_input: 'Move the mouse and type (remote control)',
  terminal: 'Open an elevated terminal',
  file_transfer: 'Send and receive files',
  clipboard: 'Synchronize the clipboard',
  system_manage: 'Manage running programs and services',
  elevation: 'Administrator (elevated) access',
  reboot_reconnect: 'Reconnect after a reboot',
}

function permissionLabel(permission: string): string {
  return PERMISSION_LABELS[permission] ?? permission
}

export default function ConnectPage() {
  const { code = '' } = useParams<{ code: string }>()
  const [info, setInfo] = useState<ConnectInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch(`/api/connect/${encodeURIComponent(code)}`)
      if (!res.ok) {
        setInfo(null)
        setError('This support link is invalid or has expired. Ask your technician for a new one.')
        return
      }
      setInfo((await res.json()) as ConnectInfo)
    } catch {
      setInfo(null)
      setError('Could not reach the support service. Please check your connection and try again.')
    }
  }, [code])

  useEffect(() => {
    void load()
  }, [load])

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-panel connect-panel">
        <BrandRow />
        <h1 className="auth-title">DeskOS support</h1>
        <p className="auth-sub">Your support team is ready to help with this device.</p>

        {error ? <Alert kind="error">{error}</Alert> : null}

        {info ? (
          <div className="connect-request">
            <div className="connect-reason">
              <span className="etch">Your technician asked to:</span>
              <strong>{info.reason || 'Provide remote support'}</strong>
            </div>

            {info.permissions.length > 0 ? (
              <ul className="connect-permissions">
                {info.permissions.map((permission) => (
                  <li key={permission}>{permissionLabel(permission)}</li>
                ))}
              </ul>
            ) : null}

            <div className="connect-code">
              <span className="etch">Support code</span>
              <div className="support-code-digits">{code}</div>
              <button className="btn btn-ghost btn-sm" onClick={() => void copyCode()}>
                {copied ? 'Copied' : 'Copy code'}
              </button>
            </div>

            {info.helperAvailable ? (
              <div className="connect-download">
                <a className="btn btn-primary" href={`/api/connect/${encodeURIComponent(code)}/download`}>
                  Download the DeskOS helper
                </a>
                <span className="muted">
                  A small file — no installation. Open it, enter your support code, and approve the access request when
                  it appears.
                </span>
              </div>
            ) : (
              <p className="muted connect-download">
                The helper download is not available yet — ask your technician to walk you through connecting.
              </p>
            )}

            <p className="muted">
              You can end the session at any time, and everything your technician does is recorded.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  )
}
