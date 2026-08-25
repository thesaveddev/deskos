import { useEffect, useRef, useState, useCallback } from 'react'

const STORAGE_KEY = 'deskos.idleTimeoutMinutes'
const TIMEOUT_CHANGED_EVENT = 'deskos:idle-timeout-changed'
const DEFAULT_MINUTES = 10

/** Read the stored idle timeout (in minutes). Falls back to 10. */
export function getIdleTimeoutMinutes(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored !== null) {
      const n = Number(stored)
      if (Number.isFinite(n) && n >= 0 && n <= 120) return n
    }
  } catch { /* ignore */ }
  return DEFAULT_MINUTES
}

/** Persist the idle timeout (in minutes). Pass 0 to disable. */
export function setIdleTimeoutMinutes(minutes: number) {
  const next = Number.isFinite(minutes) ? Math.max(0, Math.min(120, minutes)) : DEFAULT_MINUTES
  try {
    localStorage.setItem(STORAGE_KEY, String(next))
    window.dispatchEvent(new CustomEvent(TIMEOUT_CHANGED_EVENT))
  } catch { /* ignore */ }
}

/**
 * Detects user inactivity and triggers a lock callback.
 * Resets on mouse move, keypress, click, or touch.
 */
export function useIdleTimeout(
  onIdle: () => void,
  timeoutMs?: number,
): { isLocked: boolean; resetTimer: () => void } {
  const [isLocked, setIsLocked] = useState(false)
  const [storedTimeoutMs, setStoredTimeoutMs] = useState(() => getIdleTimeoutMinutes() * 60 * 1000)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Resolve timeout: explicit arg > the live preference > default. The live
  // preference is state so saving Settings can replace the active deadline.
  const resolvedMs = timeoutMs ?? storedTimeoutMs

  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)

    // If timeout is 0 or negative, disable idle lock entirely
    if (resolvedMs <= 0) return

    timerRef.current = setTimeout(() => {
      setIsLocked(true)
      onIdle()
    }, resolvedMs)
  }, [onIdle, resolvedMs])

  const handleActivity = useCallback(() => {
    if (!isLocked) resetTimer()
  }, [isLocked, resetTimer])

  const unlock = useCallback(() => {
    setIsLocked(false)
    resetTimer()
  }, [resetTimer])

  useEffect(() => {
    if (timeoutMs !== undefined) return

    const refreshPreference = (event?: Event) => {
      if (event instanceof StorageEvent && event.key !== STORAGE_KEY) return
      setStoredTimeoutMs(getIdleTimeoutMinutes() * 60 * 1000)
    }
    window.addEventListener(TIMEOUT_CHANGED_EVENT, refreshPreference)
    window.addEventListener('storage', refreshPreference)
    return () => {
      window.removeEventListener(TIMEOUT_CHANGED_EVENT, refreshPreference)
      window.removeEventListener('storage', refreshPreference)
    }
  }, [timeoutMs])

  useEffect(() => {
    if (isLocked) return

    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll']
    events.forEach((e) => document.addEventListener(e, handleActivity, { passive: true }))
    resetTimer()

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      events.forEach((e) => document.removeEventListener(e, handleActivity))
    }
  }, [handleActivity, resetTimer, isLocked])

  return { isLocked, resetTimer: unlock }
}
