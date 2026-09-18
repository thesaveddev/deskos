import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from './Icons.js'

/**
 * Lightweight toast feedback for transient action outcomes (replies, status
 * changes, escalations…). Deliberately minimal — no external dependency — and
 * shaped after ConfirmProvider in ui.tsx: one provider at the app root, one
 * hook for callers. Success toasts auto-dismiss; error toasts linger a little
 * longer and can be dismissed manually.
 */

export type ToastKind = 'success' | 'error' | 'info'

interface ToastItem {
  id: number
  kind: ToastKind
  message: string
}

interface ToastApi {
  toast: (kind: ToastKind, message: string) => void
}

const ToastContext = createContext<ToastApi | null>(null)

const SUCCESS_MS = 3500
const ERROR_MS = 6000

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id))
  }, [])

  const toast = useCallback((kind: ToastKind, message: string) => {
    if (!message) return
    const id = nextId.current++
    const ttl = kind === 'error' ? ERROR_MS : SUCCESS_MS
    setItems((current) => [...current.slice(-4), { id, kind, message }])
    window.setTimeout(() => dismiss(id), ttl)
  }, [dismiss])

  const api = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" aria-live="polite" aria-atomic="false">
        {items.map((item) => (
          <div key={item.id} className={`toast toast-${item.kind}`} role={item.kind === 'error' ? 'alert' : 'status'}>
            <Icon name={item.kind === 'success' ? 'check' : item.kind === 'error' ? 'alert' : 'bell'} size={15} />
            <span className="toast-message">{item.message}</span>
            <button
              type="button"
              className="toast-close"
              aria-label="Dismiss notification"
              onClick={() => dismiss(item.id)}
            >
              <Icon name="close" size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast must be used within ToastProvider')
  return useMemo(() => ({
    /** Affirm the completed action in the user's own terms. */
    success: (message: string) => context.toast('success', message),
    /** Report what went wrong and, where possible, how to recover. */
    error: (message: string) => context.toast('error', message),
    /** Quietly note a state change the user did not directly trigger. */
    info: (message: string) => context.toast('info', message),
  }), [context])
}
