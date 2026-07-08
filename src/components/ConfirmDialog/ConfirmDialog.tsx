import { useEffect, useId, useRef } from 'react'
import styles from './ConfirmDialog.module.css'

interface Props {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  /** Two buttons (cancel + confirm) or single OK button */
  variant?: 'confirm' | 'alert'
  /** Primary confirm button style */
  confirmTone?: 'primary' | 'danger'
  loading?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  variant = 'confirm',
  confirmTone = 'primary',
  loading = false,
  onConfirm,
  onCancel,
}: Props) {
  const titleId = useId()
  const messageId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return

    cancelRef.current?.focus()

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }

    document.addEventListener('keydown', onKeyDown)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prevOverflow
    }
  }, [open, onCancel])

  if (!open) return null

  const confirmClass =
    confirmTone === 'danger' ? styles.buttonDanger : styles.buttonPrimary

  return (
    <div
      className={styles.overlay}
      onClick={onCancel}
      role="presentation"
    >
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        onClick={e => e.stopPropagation()}
      >
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <p id={messageId} className={styles.message}>
          {message}
        </p>
        <div className={styles.actions}>
          {variant === 'confirm' && (
            <button
              ref={cancelRef}
              type="button"
              className={styles.buttonSecondary}
              onClick={onCancel}
              disabled={loading}
            >
              {cancelLabel}
            </button>
          )}
          <button
            type="button"
            className={confirmClass}
            onClick={onConfirm}
            disabled={loading}
            autoFocus={variant === 'alert'}
          >
            {loading ? 'Please wait…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
