import { useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert } from '../components/ui.js'
import { api } from '../lib/api.js'

type ProbeResult = {
  ok: boolean
  configured: boolean
  turnUrls: string[]
  iceServers: Array<{ urls: string | string[]; hasCredentials: boolean }>
  credentialExpiresAt: string | null
  note: string
}

export default function TurnProbePage() {
  const [result, setResult] = useState<ProbeResult | null>(null)
  const [status, setStatus] = useState('')
  const [running, setRunning] = useState(false)

  async function runProbe() {
    setRunning(true)
    setResult(null)
    setStatus('Checking TURN configuration and requesting a relay candidate…')
    try {
      const config = await api<ProbeResult>('/probe/turn-config')
      setResult(config)
      if (!config.configured) return
      const servers = await api<{ iceServers: RTCIceServer[] }>('/probe/turn-config')
      const peer = new RTCPeerConnection({ iceServers: servers.iceServers })
      peer.createDataChannel('turn-probe')
      const candidates: string[] = []
      const candidatePromise = new Promise<void>((resolve) => {
        const timeout = window.setTimeout(() => resolve(), 8000)
        peer.onicecandidate = (event) => {
          if (event.candidate) candidates.push(event.candidate.candidate)
          else { window.clearTimeout(timeout); resolve() }
        }
      })
      await peer.setLocalDescription(await peer.createOffer())
      await candidatePromise
      const relay = candidates.filter((candidate) => / typ relay(?: |$)/.test(candidate))
      peer.close()
      setResult({ ...config, ok: relay.length > 0, note: relay.length > 0 ? `TURN relay allocation succeeded (${relay.length} relay candidate${relay.length === 1 ? '' : 's'}).` : 'TURN credentials/configuration were returned, but no relay candidate was gathered. Check DNS, firewall, UDP/TCP 3478, and the coturn relay range.' })
      setStatus('')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'TURN probe failed')
    } finally {
      setRunning(false)
    }
  }

  return <Shell>
    <div className="page-header"><div><span className="eyebrow">Remote support diagnostics</span><h1 className="page-title">TURN connectivity</h1><p className="page-subtitle">Verify that this browser can obtain a relay candidate from the production TURN service.</p></div><button className="btn btn-primary" onClick={() => void runProbe()} disabled={running}>{running ? 'Running probe…' : 'Run TURN probe'}</button></div>
    {status && <Alert kind="info">{status}</Alert>}
    {result && <section className={`settings-section ${result.ok ? 'tone-ok' : 'tone-crit'}`} aria-live="polite"><h2>{result.ok ? 'TURN reachable' : 'TURN needs attention'}</h2><p>{result.note}</p><dl className="settings-list"><div className="settings-list-row"><dt>Configured</dt><dd>{result.configured ? 'Yes' : 'No'}</dd></div><div className="settings-list-row"><dt>TURN endpoints</dt><dd className="mono">{result.turnUrls.join(', ') || 'None'}</dd></div><div className="settings-list-row"><dt>Credential expiry</dt><dd>{result.credentialExpiresAt ?? '—'}</dd></div></dl></section>}
  </Shell>
}
