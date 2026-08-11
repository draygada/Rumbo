import { useEffect, useMemo, useState } from 'react'
import { useCourses } from '../hooks/useCourses'
import { useSpaces } from './useSpaces'
import { useSpaceStore } from './spaceStore'
import styles from './NewSpaceDialog.module.css'

/*
 * Create a space by hand.
 *
 * Active courses already have one, so what's left to offer is (a) a course that
 * has ended or isn't picked up automatically, and (b) an unscoped space — a
 * named workspace that still searches every class, useful for something like
 * "Grad apps" that spans courses.
 */
export default function NewSpaceDialog({ onClose }: { onClose: () => void }) {
  const { data: courses } = useCourses()
  const spaces = useSpaces()
  const createSpace = useSpaceStore(s => s.createSpace)

  const [name, setName] = useState('')
  const [courseId, setCourseId] = useState<string>('all')
  // Once the student types a name, stop overwriting it with the course label.
  const [nameTouched, setNameTouched] = useState(false)

  // Courses that don't already have a space.
  const available = useMemo(() => {
    const taken = new Set(spaces.map(s => s.courseId).filter(Boolean))
    return (courses ?? []).filter(c => !taken.has(c.id))
  }, [courses, spaces])

  // Picking a class pre-fills the name, which is what you want ~every time.
  useEffect(() => {
    if (nameTouched) return
    const course = available.find(c => c.id === courseId)
    setName(course ? course.label : '')
  }, [courseId, available, nameTouched])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    createSpace(trimmed, courseId === 'all' ? null : courseId)
    onClose()
  }

  return (
    <div className={styles.backdrop} onMouseDown={onClose}>
      <form
        className={styles.dialog}
        onMouseDown={e => e.stopPropagation()}
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-label="New space"
      >
        <h2 className={styles.title}>New space</h2>
        <p className={styles.blurb}>
          A space keeps its own conversations and scopes everything Rumbo
          searches to one class.
        </p>

        <label className={styles.field}>
          <span className={styles.label}>Class</span>
          <select
            className={styles.select}
            value={courseId}
            onChange={e => setCourseId(e.target.value)}
          >
            <option value="all">All classes</option>
            {available.map(c => (
              <option key={c.id} value={c.id}>
                {c.label}
                {c.isCurrent ? '' : ' (ended)'}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Name</span>
          <input
            className={styles.input}
            value={name}
            onChange={e => {
              setNameTouched(true)
              setName(e.target.value)
            }}
            placeholder="Grad apps"
            autoFocus
            maxLength={32}
          />
        </label>

        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={styles.create} disabled={!name.trim()}>
            Create space
          </button>
        </div>
      </form>
    </div>
  )
}
