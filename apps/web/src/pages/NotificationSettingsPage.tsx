import { useCallback, useEffect, useState } from 'react'
import { Alert } from '../components/ui.js'
import {
  listNotificationPreferences, upsertNotificationPreference,
  type NotificationChannel, type NotificationPreference,
} from '../lib/notifications.js'
import { disablePush, enablePush, getPushStatus, testPush } from '../lib/push.js'

const KIND_LABELS: Record<string, string> = {
  'ticket.replied': 'Ticket replied',
  'ticket.requester_replied': 'Requester replied',
  'ticket.resolved': 'Ticket resolved',
  'sla.breached': 'SLA breach',
  'device.alert': 'Device alert',
  'offline': 'Device offline',
  'low_disk': 'Low disk space',
  'session_invite': 'Session invite',
  'session.adhoc.claimed': 'Support code claimed',
  'automation': 'Automation actions',
  'membership.invited': 'Membership invited',
}

export default function NotificationSettingsPage() {
  const [items, setItems] = useState<NotificationPreference[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busyKind, setBusyKind] = useState<string | null>(null)
  const [pushEnabled, setPushEnabled] = useState(false)
  const [pushCount, setPushCount] = useState(0)
  const [pushBusy, setPushBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setItems((await listNotificationPreferences()).preferences)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load preferences')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void getPushStatus()
      .then((status) => {
        setPushEnabled(status.enabled)
        setPushCount(status.subscriptions)
      })
      .catch(() => {
        setPushEnabled(false)
        setPushCount(0)
      })
  }, [])

  const togglePush = async () => {
    setPushBusy(true)
    setError(null)
    setNotice(null)
    try {
      if (pushEnabled) {
        const result = await disablePush()
        if (!result.ok) {
          setError(result.error ?? 'Could not disable push')
          return
        }
        setPushCount(0)
        setNotice('Push notifications disabled on this device.')
      } else {
        const result = await enablePush()
        if (!result.ok) {
          setError(result.error ?? 'Could not enable push')
          return
        }
        setNotice('Push notifications enabled — you will be notified on this device.')
      }
      const status = await getPushStatus()
      setPushEnabled(status.enabled)
      setPushCount(status.subscriptions)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Push setup failed')
    } finally {
      setPushBusy(false)
    }
  }

  const sendTestPush = async () => {
    setPushBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await testPush()
      setNotice(result.delivered > 0 ? 'Test push sent to this device.' : 'No device subscription to deliver to yet.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test push failed')
    } finally {
      setPushBusy(false)
    }
  }

  async function save(pref: NotificationPreference, patch: { enabled?: boolean; channels?: NotificationChannel[] }) {
    setBusyKind(pref.kind)
    setError(null)
    setNotice(null)
    try {
      await upsertNotificationPreference(pref.kind, patch)
      setNotice('Preferences saved.')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setBusyKind(null)
    }
  }

  return (
    <div className="form-panel">
      <h2 className="channel-form-title">Notifications</h2>
      <p className="muted" style={{ marginBottom: 16 }}>
        Choose which notifications you receive. In-app notifications appear in your
        notification feed; push notifications mirror them to this device.
      </p>

      <div className="channel-card" style={{ marginBottom: 16 }}>
        <div className="channel-main">
          <span className="channel-name">Push notifications</span>
          <span className="channel-meta">
            {pushEnabled ? `Enabled on ${pushCount} device${pushCount === 1 ? '' : 's'} — delivered when you're not in the app.` : 'Not enabled on this device.'}
          </span>
        </div>
        <div className="channel-actions">
          {pushEnabled ? (
            <button className="btn btn-ghost btn-sm" disabled={pushBusy || pushCount === 0} onClick={() => void sendTestPush()}>
              {pushBusy ? '…' : 'Send test'}
            </button>
          ) : null}
          <button className="btn btn-ghost btn-sm" disabled={pushBusy} onClick={() => void togglePush()}>
            {pushBusy ? '…' : pushEnabled ? 'Disable' : 'Enable'}
          </button>
        </div>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="info">{notice}</Alert> : null}

      {items === null ? (
        <span className="etch">Loading preferences…</span>
      ) : (
        <ul className="channel-list">
          {items.map((pref) => {
            const label = KIND_LABELS[pref.kind] ?? pref.kind
            const busy = busyKind === pref.kind
            return (
              <li key={pref.kind} className="channel-card">
                <div className="channel-main">
                  <span className="channel-name">{label}</span>
                  <span className="channel-meta mono">{pref.kind}</span>
                </div>
                <div className="channel-actions">
                  <label className="checkbox-field" style={{ marginBottom: 0 }}>
                    <input
                      type="checkbox"
                      checked={pref.channels.includes('in_app')}
                      disabled={!pref.enabled || busy}
                      onChange={(e) => {
                        const channels: NotificationChannel[] = e.target.checked
                          ? Array.from(new Set<NotificationChannel>([...pref.channels, 'in_app']))
                          : pref.channels.filter((c) => c !== 'in_app')
                        void save(pref, { channels })
                      }}
                    />
                    <span className="field-label">In-app</span>
                  </label>
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => void save(pref, { enabled: !pref.enabled })}
                  >
                    {busy ? '…' : pref.enabled ? 'Mute' : 'Enable'}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
