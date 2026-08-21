const LOCKED_USER_KEY = 'deskos.lockedUser'
const LOCK_STATE_KEY = 'deskos.locked'

/** Dispatch a custom event to instantly lock the current authenticated screen. */
export function lockScreen() {
  window.dispatchEvent(new CustomEvent('deskos:lock'))
}

/** Preserve only the identity needed to render the post-sign-out lock screen. */
export function rememberLockedUser(user: { id: string; email: string; name: string }) {
  try { sessionStorage.setItem(LOCKED_USER_KEY, JSON.stringify(user)) } catch { /* storage may be unavailable */ }
}

export function readLockedUser(): { id: string; email: string; name: string } | null {
  try {
    const raw = sessionStorage.getItem(LOCKED_USER_KEY)
    if (!raw) return null
    const user = JSON.parse(raw) as Partial<{ id: string; email: string; name: string }>
    if (typeof user.id !== 'string' || typeof user.email !== 'string' || typeof user.name !== 'string') return null
    return user as { id: string; email: string; name: string }
  } catch {
    return null
  }
}

export function clearLockedUser() {
  try { sessionStorage.removeItem(LOCKED_USER_KEY) } catch { /* storage may be unavailable */ }
}

/**
 * Persist the lock flag in localStorage so every tab agrees the workspace is
 * locked. localStorage is shared across tabs, unlike sessionStorage, so a new
 * tab cannot bypass the lock screen by re-hydrating the still-valid token.
 */
export function setPersistedLocked(locked: boolean) {
  try {
    if (locked) localStorage.setItem(LOCK_STATE_KEY, '1')
    else localStorage.removeItem(LOCK_STATE_KEY)
  } catch { /* storage may be unavailable */ }
}

export function readPersistedLocked(): boolean {
  try { return localStorage.getItem(LOCK_STATE_KEY) === '1' } catch { return false }
}

/**
 * Subscribe to lock/unlock changes made in other tabs. The `storage` event only
 * fires in tabs other than the one that wrote the key, which is exactly the
 * cross-tab propagation we need.
 */
export function onLockStateChange(handler: (locked: boolean) => void): () => void {
  const fn = (event: StorageEvent) => {
    if (event.key === LOCK_STATE_KEY || event.key === null) handler(readPersistedLocked())
  }
  window.addEventListener('storage', fn)
  return () => window.removeEventListener('storage', fn)
}

/** Subscribe to the lock event. Returns an unsubscribe function. */
export function onLockRequest(handler: () => void): () => void {
  const fn = () => handler()
  window.addEventListener('deskos:lock', fn)
  return () => window.removeEventListener('deskos:lock', fn)
}
