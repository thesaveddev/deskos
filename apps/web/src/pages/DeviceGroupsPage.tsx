import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import { Alert, Field, Modal, SubmitButton, useConfirm } from '../components/ui.js'
import { Icon } from '../components/Icons.js'
import { useAuth } from '../lib/auth.js'
import {
  createDeviceGroup,
  deleteDeviceGroup,
  listDeviceGroups,
  updateDeviceGroup,
  type DeviceGroup,
} from '../lib/devices.js'

export default function DeviceGroupsPage() {
  const canManage = useAuth((state) => state.memberships.some((membership) => membership.permissions.includes('device.manage')))
  const confirm = useConfirm()
  const [groups, setGroups] = useState<DeviceGroup[] | null>(null)
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [editingParentId, setEditingParentId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      setGroups((await listDeviceGroups()).groups)
    } catch (err) {
      setGroups([])
      setError(err instanceof Error ? err.message : 'Failed to load device groups')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const saveNew = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await createDeviceGroup({ name: name.trim(), parentId: parentId || undefined })
      setName('')
      setParentId('')
      setNotice('Device group created.')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create group')
    } finally {
      setBusy(false)
    }
  }

  const startEdit = (group: DeviceGroup) => {
    setEditingId(group.id)
    setEditingName(group.name)
    setEditingParentId(group.parent_id ?? '')
    setError(null)
    setNotice(null)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditingName('')
    setEditingParentId('')
  }

  const saveEdit = async (group: DeviceGroup) => {
    if (!editingName.trim() || busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await updateDeviceGroup(group.id, {
        name: editingName.trim(),
        parentId: editingParentId || null,
      })
      cancelEdit()
      setNotice('Device group updated.')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update group')
    } finally {
      setBusy(false)
    }
  }

  const removeGroup = async (group: DeviceGroup) => {
    if (busy || !await confirm(`Delete “${group.name}”? Devices will remain and become ungrouped.`, { title: 'Delete device group', confirmLabel: 'Delete', destructive: true })) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await deleteDeviceGroup(group.id)
      setNotice('Device group deleted.')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete group')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell>
      <div className="detail-breadcrumb"><Link to="/devices">Devices</Link><span>/</span><span>Groups</span></div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Device groups</h1>
          <p className="page-subtitle">Organize endpoints by team, location, or ownership.</p>
        </div>
        <Link to="/devices" className="btn btn-ghost btn-sm"><Icon name="back" size={14} />Back to devices</Link>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="info">{notice}</Alert> : null}

      {canManage && (
        <div style={{ marginBottom: 16 }}>
          <button className="btn btn-primary btn-sm" onClick={() => { setShowCreate(true); setName(''); setParentId('') }}><Icon name="add" size={14} />New group</button>
        </div>
      )}

      <Modal open={showCreate} onClose={() => { if (!busy) { setShowCreate(false); setName(''); setParentId('') } }} title="New device group">
        <form onSubmit={saveNew}>
          <Field label="Group name">
            <input className="field-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. London laptops" required />
          </Field>
          <Field label="Parent group" hint="Optional hierarchy.">
            <select className="field-input" value={parentId} onChange={(event) => setParentId(event.target.value)}>
              <option value="">No parent</option>
              {groups?.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
            </select>
          </Field>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
            <button type="button" className="btn btn-ghost" onClick={() => setShowCreate(false)} disabled={busy}><Icon name="close" size={14} />Cancel</button>
            <SubmitButton busy={busy}>Create group</SubmitButton>
          </div>
        </form>
      </Modal>

      {groups === null ? <span className="etch">Loading groups…</span> : null}
      {groups && groups.length === 0 ? <div className="empty-state">No device groups yet.</div> : null}
      {groups && groups.length > 0 ? (
        <div className="group-list">
          {groups.map((group) => (
            <div className="group-card" key={group.id}>
              {editingId === group.id ? (
                <div className="group-edit-form">
                  <input className="field-input" value={editingName} onChange={(event) => setEditingName(event.target.value)} aria-label="Group name" autoFocus />
                  <select className="field-input" value={editingParentId} onChange={(event) => setEditingParentId(event.target.value)} aria-label="Parent group">
                    <option value="">No parent</option>
                    {groups.filter((candidate) => candidate.id !== group.id).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
                  </select>
                  <button className="btn btn-primary btn-sm" onClick={() => void saveEdit(group)} disabled={busy || !editingName.trim()}><Icon name="save" size={14} />Save</button>
                  <button className="btn btn-ghost btn-sm" onClick={cancelEdit} disabled={busy}><Icon name="close" size={14} />Cancel</button>
                </div>
              ) : (
                <>
                  <div className="group-card-main">
                    <div className="group-card-title"><strong>{group.name}</strong><span className="mono muted">{group.device_count} device{group.device_count === 1 ? '' : 's'}</span></div>
                    <div className="muted">{group.parent_name ? `Child of ${group.parent_name}` : 'Top-level group'}</div>
                  </div>
                  {canManage ? (
                    <div className="group-card-actions">
                      <button className="btn btn-ghost btn-sm" onClick={() => startEdit(group)} disabled={busy}><Icon name="edit" size={14} />Edit</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => void removeGroup(group)} disabled={busy}><Icon name="delete" size={14} />Delete</button>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </Shell>
  )
}
