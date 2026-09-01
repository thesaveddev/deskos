const LOCKED_USER_KEY = 'reydesk.lockedUser'
const LOCK_STATE_KEY = 'reydesk.locked'
const LOCK_SIGNAL_KEY = 'reydesk.lockSignal'

/** Dispatch a custom event to instantly lock the current authenticated screen. */
export function lockScreen() {
  window.dispatchEvent(new CustomEvent('reydesk:lock'))
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
 * Broadcast a MANUAL lock to already-open tabs. Idle timeouts only persist the
 * flag (so brand-new tabs honour it) and deliberately do NOT broadcast, so an
 * idle tab can't yank an actively-used tab into the lock screen.
 */
export function signalManualLock() {
  try { localStorage.setItem(LOCK_SIGNAL_KEY, String(Date.now())) } catch { /* storage may be unavailable */ }
}

export function signalManualUnlock() {
  try { localStorage.removeItem(LOCK_SIGNAL_KEY) } catch { /* storage may be unavailable */ }
}

/**
 * Subscribe to MANUAL lock/unlock changes made in other tabs. The `storage`
 * event only fires in tabs other than the one that wrote the key.
 */
export function onLockStateChange(handler: (locked: boolean) => void): () => void {
  const fn = (event: StorageEvent) => {
    if (event.key !== LOCK_SIGNAL_KEY) return
    handler(event.newValue !== null)
  }
  window.addEventListener('storage', fn)
  return () => window.removeEventListener('storage', fn)
}

/** Subscribe to the lock event. Returns an unsubscribe function. */
export function onLockRequest(handler: () => void): () => void {
  const fn = () => handler()
  window.addEventListener('reydesk:lock', fn)
  return () => window.removeEventListener('reydesk:lock', fn)
}
