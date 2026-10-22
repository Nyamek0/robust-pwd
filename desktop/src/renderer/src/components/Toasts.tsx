import { AlertIcon, CheckIcon, ClockIcon, XIcon } from './icons'

export type ToastKind = 'success' | 'error' | 'info'

export interface ToastItem {
  id: number
  kind: ToastKind
  message: string
}

const ICONS = {
  success: CheckIcon,
  error: AlertIcon,
  info: ClockIcon,
}

export function Toasts({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[]
  onDismiss: (id: number) => void
}) {
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => {
        const Icon = ICONS[toast.kind]
        return (
          <div key={toast.id} className={`toast toast-${toast.kind}`} role="status">
            <span className="toast-icon">
              <Icon size={16} />
            </span>
            <span className="toast-message">{toast.message}</span>
            <button
              type="button"
              className="icon-btn toast-close"
              onClick={() => onDismiss(toast.id)}
              aria-label="Fermer la notification"
            >
              <XIcon size={14} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
