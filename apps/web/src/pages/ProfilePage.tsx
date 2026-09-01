import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert, PageHeader } from '../components/ui.js'
import { PasswordField } from '../components/PasswordField.js'
import { api } from '../lib/api.js'
import { useAuth } from '../lib/auth.js'

export default function ProfilePage() {
  const auth = useAuth()
  const user = auth.user

  const [name, setName] = useState(user?.name || '')
  const [email, setEmail] = useState(user?.email || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Password change
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [pwSaving, setPwSaving] = useState(false)
  const [pwError, setPwError] = useState<string | null>(null)
  const [pwNotice, setPwNotice] = useState<string | null>(null)

  // Avatar
  const [avatarUrl, setAvatarUrl] = useState<string | null>(user?.avatarUrl ?? null)
  const [avatarUploading, setAvatarUploading] = useState(false)

  const handleProfileSave = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      await api('/me/profile', { method: 'PATCH', body: { name, email } })
      setNotice('Profile updated.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update profile')
    }
    setSaving(false)
  }

  const handlePasswordChange = async (e: FormEvent) => {
    e.preventDefault()
    if (newPw !== confirmPw) {
      setPwError('Passwords do not match')
      return
    }
    if (newPw.length < 10) {
      setPwError('Password must be at least 10 characters')
      return
    }
    setPwSaving(true)
    setPwError(null)
    setPwNotice(null)
    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword: currentPw, newPassword: newPw } })
      setPwNotice('Password changed. You may need to sign in again on other devices.')
      setCurrentPw('')
      setNewPw('')
      setConfirmPw('')
    } catch (err) {
      setPwError(err instanceof Error ? err.message : 'Failed to change password')
    }
    setPwSaving(false)
  }

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 2 * 1024 * 1024) {
      setError('Image must be under 2MB')
      return
    }
    setAvatarUploading(true)
    setError(null)
    try {
      const formData = new FormData()
      formData.append('avatar', file)
      const res = await fetch('/api/v1/me/avatar', {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('reydesk.accessToken')}` },
        body: formData,
      })
      if (!res.ok) throw new Error('Upload failed')
      const data = await res.json() as { avatarUrl: string }
      setAvatarUrl(data.avatarUrl)
      setNotice('Profile picture updated.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload avatar')
    }
    setAvatarUploading(false)
  }

  const initials = (user?.name || user?.email || '?').charAt(0).toUpperCase()

  return (
    <Shell>
      <PageHeader title="Profile" subtitle="Manage your personal settings" />

      <div className="profile-layout">
        {/* Avatar section */}
        <div className="profile-avatar-section">
          <div className="profile-avatar-large">
            {avatarUrl ? (
              <img src={avatarUrl} alt="Profile" style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} />
            ) : initials}
          </div>
          <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>
            {avatarUploading ? 'Uploading…' : 'Change photo'}
            <input
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={handleAvatarUpload}
              disabled={avatarUploading}
            />
          </label>
          <span className="muted" style={{ fontSize: 12 }}>JPG, PNG or GIF. Max 2MB.</span>
        </div>

        <div className="profile-forms">
          {/* Basic info */}
          <div className="form-panel">
            <h2 className="channel-form-title">Personal information</h2>
            {error && <Alert kind="error">{error}</Alert>}
            {notice && <Alert kind="info">{notice}</Alert>}
            <form onSubmit={handleProfileSave}>
              <div className="field">
                <label className="field-label" htmlFor="profile-name">Name</label>
                <input
                  className="field-input"
                  id="profile-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="profile-email">Email</label>
                <input
                  className="field-input"
                  id="profile-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
                <span className="field-hint">Changing your email will require verification.</span>
              </div>
              <div className="form-actions">
                <button className="btn btn-primary" type="submit" disabled={saving}>
                  {saving ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </form>
          </div>

          {/* Password */}
          <div className="form-panel">
            <h2 className="channel-form-title">Change password</h2>
            {pwError && <Alert kind="error">{pwError}</Alert>}
            {pwNotice && <Alert kind="info">{pwNotice}</Alert>}
            <form onSubmit={handlePasswordChange}>
              <PasswordField
                label="Current password"
                className="field-input"
                id="pw-current"
                required
                value={currentPw}
                onChange={(e) => setCurrentPw(e.target.value)}
              />
              <PasswordField
                label="New password"
                hint="At least 10 characters"
                className="field-input"
                id="pw-new"
                required
                minLength={10}
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
              />
              <PasswordField
                label="Confirm new password"
                className="field-input"
                id="pw-confirm"
                required
                minLength={10}
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
              />
              <div className="form-actions">
                <button className="btn btn-primary" type="submit" disabled={pwSaving}>
                  {pwSaving ? 'Changing…' : 'Change password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </Shell>
  )
}
