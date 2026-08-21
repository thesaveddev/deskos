const LOCKED_USER_KEY = 'deskos.lockedUser'

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

/** Subscribe to the lock event. Returns an unsubscribe function. */
export function onLockRequest(handler: () => void): () => void {
  const fn = () => handler()
  window.addEventListener('deskos:lock', fn)
  return () => window.removeEventListener('deskos:lock', fn)
}
