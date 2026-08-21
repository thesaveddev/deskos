import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from './Icons.js'
import { BRAND } from '../lib/brand.js'

export function Alert({ kind, children }: { kind: 'error' | 'info'; children: ReactNode }) {
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  )
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  )
}

export function SubmitButton({ busy, children }: { busy: boolean; children: string }) {
  return (
    <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
      {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="check" size={15} />}
      {children}
    </button>
  )
}

export function BrandRow() {
  return (
    <div className="brand-row">
      <span className="brand">{BRAND.name}</span>
      <span className="etch">IT Support OS</span>
    </div>
  )
}

/** Page header: title + optional subtitle on the left, actions on the right. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: string
  actions?: ReactNode
}) {
  return (
    <div className="page-head">
      <div className="page-head-main">
        <h1 className="page-title">{title}</h1>
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  )
}

/** Primary list/table container: optional head, toolbar, and body. */
export function Panel({
  title,
  subtitle,
  actions,
  toolbar,
  children,
  empty,
}: {
  title?: string
  subtitle?: string
  actions?: ReactNode
  toolbar?: ReactNode
  children?: ReactNode
  empty?: boolean
}) {
  return (
    <section className="panel">
      {title || actions ? (
        <div className="panel-head">
          <div className="panel-head-main">
            {title ? <h2 className="panel-title">{title}</h2> : null}
            {subtitle ? <p className="panel-sub">{subtitle}</p> : null}
          </div>
          {actions ? <div className="page-actions">{actions}</div> : null}
        </div>
      ) : null}
      {toolbar ? <div className="panel-toolbar">{toolbar}</div> : null}
      <div className="panel-body">
        {empty ? <div className="panel-empty">Nothing here yet.</div> : children}
      </div>
    </section>
  )
}

/** Accessible modal dialog — forms live here so lists stay clean and primary. */
export interface ConfirmOptions {
  title?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

type ConfirmRequest = ConfirmOptions & { message: string; resolve: (confirmed: boolean) => void }

const ConfirmContext = createContext<((message: string, options?: ConfirmOptions) => Promise<boolean>) | null>(null)

/** App-level confirmation dialog. Use this instead of browser confirm() so confirmations are accessible and consistent. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null)

  const confirm = useCallback((message: string, options: ConfirmOptions = {}) => new Promise<boolean>((resolve) => {
    setRequest({ message, resolve, ...options })
  }), [])

  const finish = (confirmed: boolean) => {
    if (!request) return
    request.resolve(confirmed)
    setRequest(null)
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal open={Boolean(request)} onClose={() => finish(false)} title={request?.title ?? 'Please confirm'} width={440}>
        {request ? <>
          <p className="confirm-dialog-message">{request.message}</p>
          <div className="form-actions confirm-dialog-actions">
            <button type="button" className="btn btn-ghost" onClick={() => finish(false)}>{request.cancelLabel ?? 'Cancel'}</button>
            <button type="button" className={`btn ${request.destructive ? 'btn-danger' : 'btn-primary'}`} onClick={() => finish(true)}>{request.confirmLabel ?? 'Confirm'}</button>
          </div>
        </> : null}
      </Modal>
    </ConfirmContext.Provider>
  )
}

export function useConfirm() {
  const confirm = useContext(ConfirmContext)
  if (!confirm) throw new Error('useConfirm must be used within ConfirmProvider')
  return confirm
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 560,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  width?: number
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onCloseRef.current(); return }
      // Focus trap: Tab cycles within the modal
      if (e.key === 'Tab' && panel) {
        const focusable = panel.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    // Do not focus the dialog on every render. The parent often re-renders
    // when a controlled input changes; stealing focus here made text fields
    // accept exactly one character before losing focus. Preserve autofocus
    // and only focus the first control when the modal opens without one.
    if (panel && !panel.contains(document.activeElement)) {
      const autofocus = panel.querySelector<HTMLElement>('[autofocus]')
      const first = panel.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
      ;(autofocus ?? first ?? panel).focus()
    }
    // Prevent body scroll while modal is open
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open])

  if (!open) return null

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panelRef}
        style={{ maxWidth: width }}
      >
        <div className="modal-head">
          <h2 className="modal-title">{title}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close dialog"><Icon name="close" size={17} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  )
}
