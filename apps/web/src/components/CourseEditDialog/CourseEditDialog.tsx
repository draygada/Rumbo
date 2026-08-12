import { useEffect, useId, useRef, useState } from 'react'
import {
  COURSE_COLORS,
  defaultCourseColor,
  useCourseOverrides,
  type CourseOverride,
} from '../../lib/courseOverrides'
import styles from './CourseEditDialog.module.css'

interface Props {
  open: boolean
  courseId: string
  /** The name Rumbo derived, shown as the placeholder so "clear to reset" is obvious. */
  derivedName: string
  onClose: () => void
}

export default function CourseEditDialog({ open, courseId, derivedName, onClose }: Props) {
  const titleId = useId()
  const nameId = useId()
  const inputRef = useRef<HTMLInputElement>(null)

  const override: CourseOverride | undefined = useCourseOverrides(s => s.byCourseId[courseId])
  const setOverride = useCourseOverrides(s => s.setOverride)
  const clearOverride = useCourseOverrides(s => s.clearOverride)

  const [name, setName] = useState('')
  const [color, setColor] = useState<string | undefined>(undefined)

  // Seed from the stored override each time the dialog opens, so cancelling
  // and reopening doesn't show a half-edited draft from last time.
  useEffect(() => {
    if (!open) return
    setName(override?.name ?? '')
    setColor(override?.color)
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [open, courseId, override?.name, override?.color])

  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prevOverflow
    }
  }, [open, onClose])

  if (!open) return null

  function save(e: React.FormEvent) {
    e.preventDefault()
    setOverride(courseId, { name, color })
    onClose()
  }

  function reset() {
    clearOverride(courseId)
    onClose()
  }

  const effectiveColor = color ?? defaultCourseColor(courseId)
  const hasOverride = Boolean(override)

  return (
    <div className={styles.overlay}>
      <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />
      <form
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={save}
      >
        <h2 id={titleId} className={styles.title}>Edit course</h2>

        <label className={styles.label} htmlFor={nameId}>Display name</label>
        <input
          id={nameId}
          ref={inputRef}
          className={styles.input}
          value={name}
          onChange={e => setName(e.target.value)}
          // Placeholder carries the derived name, so an empty field reads as
          // "fall back to this" rather than "no name".
          placeholder={derivedName}
          autoComplete="off"
        />
        <p className={styles.hint}>Leave blank to use {derivedName}.</p>

        <span className={styles.label}>Colour</span>
        <div className={styles.swatches} role="radiogroup" aria-label="Course colour">
          {COURSE_COLORS.map(c => (
            <button
              key={c.token}
              type="button"
              role="radio"
              aria-checked={effectiveColor === c.token}
              aria-label={c.label}
              title={c.label}
              className={[
                styles.swatch,
                effectiveColor === c.token ? styles.swatchActive : '',
              ].join(' ')}
              style={{ background: `var(${c.token})` }}
              onClick={() => setColor(c.token)}
            />
          ))}
        </div>

        <div className={styles.actions}>
          {hasOverride && (
            <button type="button" className={styles.buttonReset} onClick={reset}>
              Reset
            </button>
          )}
          <button type="button" className={styles.buttonSecondary} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={styles.buttonPrimary}>
            Save
          </button>
        </div>
      </form>
    </div>
  )
}
