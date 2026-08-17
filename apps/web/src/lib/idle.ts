import { useEffect, useRef, useState, useCallback } from 'react'

/** Default idle timeout: 10 minutes */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Detects user inactivity and triggers a lock callback.
 * Resets on mouse move, keypress, click, or touch.
 */
export function useIdleTimeout(
  onIdle: () => void,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): { isLocked: boolean; resetTimer: () => void } {
  const [isLocked, setIsLocked] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      setIsLocked(true)
      onIdle()
    }, timeoutMs)
  }, [onIdle, timeoutMs])

  const handleActivity = useCallback(() => {
    if (!isLocked) resetTimer()
  }, [isLocked, resetTimer])

  const unlock = useCallback(() => {
    setIsLocked(false)
    resetTimer()
  }, [resetTimer])

  useEffect(() => {
    if (isLocked) return

    const events = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart']
    events.forEach((e) => document.addEventListener(e, handleActivity, { passive: true }))
    resetTimer()

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      events.forEach((e) => document.removeEventListener(e, handleActivity))
    }
  }, [handleActivity, resetTimer, isLocked])

  return { isLocked, resetTimer: unlock }
}
