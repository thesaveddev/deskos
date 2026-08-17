/** Dispatch a custom event to instantly lock the screen. */
export function lockScreen() {
  window.dispatchEvent(new CustomEvent('deskos:lock'))
}

/** Subscribe to the lock event. Returns an unsubscribe function. */
export function onLockRequest(handler: () => void): () => void {
  const fn = () => handler()
  window.addEventListener('deskos:lock', fn)
  return () => window.removeEventListener('deskos:lock', fn)
}
