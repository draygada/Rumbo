import { useState, useEffect, useRef, FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../hooks/useAuth'
import { classify } from '../../lib/classifier'
import ClassifierBadge from '../../components/ClassifierBadge/ClassifierBadge'
import { TaskType } from '../../types'
import styles from './AddTask.module.css'

const ESTIMATED_MINS_OPTIONS = [
  { label: '15 min', value: 15 },
  { label: '30 min', value: 30 },
  { label: '45 min', value: 45 },
  { label: '1 hour', value: 60 },
  { label: '1.5 hours', value: 90 },
  { label: '2 hours', value: 120 },
  { label: '3+ hours', value: 180 },
]

export default function AddTask() {
  const { session, profile } = useAuth()
  const navigate = useNavigate()
  const isPremium = profile?.tier === 'premium'

  const [title, setTitle] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [estimatedMins, setEstimatedMins] = useState<number>(60)
  const [description, setDescription] = useState('')
  const [workType, setWorkType] = useState<TaskType>('deep')
  const [userOverrode, setUserOverrode] = useState(false)
  const [classifierResult, setClassifierResult] = useState<ReturnType<typeof classify> | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Run classifier 3s after the user stops typing
  useEffect(() => {
    if (!title.trim()) {
      setClassifierResult(null)
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      const result = classify(title, estimatedMins)
      setClassifierResult(result)
      if (!userOverrode) setWorkType(result.type)
    }, 3000)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [title, estimatedMins, userOverrode])

  function handleBadgeToggle() {
    setWorkType(prev => prev === 'deep' ? 'shallow' : 'deep')
    setUserOverrode(true)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!session) return
    setError(null)
    setSaving(true)

    try {
      const { error: insertError } = await supabase.from('tasks').insert({
        user_id: session.user.id,
        title: title.trim(),
        due_date: new Date(dueDate + 'T23:59:00').toISOString(),
        estimated_mins: estimatedMins,
        work_type: workType,
        user_overrode_classifier: userOverrode,
        classifier_confidence: classifierResult?.confidence ?? null,
        shallow_score: classifierResult?.shallowScore ?? null,
        deep_score: classifierResult?.deepScore ?? null,
        description: isPremium && description.trim() ? description.trim() : null,
      })
      if (insertError) throw insertError

      navigate('/dashboard')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save task')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <Link to="/dashboard" className={styles.back}>
          ← Back
        </Link>

        <h1 className={styles.title}>Add Task</h1>

        <form onSubmit={handleSubmit} className={styles.form}>
          {/* Task name */}
          <div className={styles.field}>
            <div className={styles.labelRow}>
              <label htmlFor="title" className={styles.label}>Task name</label>
              {classifierResult && (
                <ClassifierBadge type={workType} onClick={handleBadgeToggle} />
              )}
            </div>
            <input
              id="title"
              type="text"
              className={styles.input}
              placeholder="e.g. Write essay on climate policy"
              value={title}
              onChange={e => { setTitle(e.target.value); setUserOverrode(false) }}
              required
              autoComplete="off"
              autoFocus
            />
            {classifierResult && (
              <p className={styles.classifierHint}>
                {userOverrode ? 'Manually set — click badge to toggle' : 'Classified automatically — click badge to override'}
              </p>
            )}
          </div>

          {/* Due date */}
          <div className={styles.field}>
            <label htmlFor="due-date" className={styles.label}>Due date</label>
            <input
              id="due-date"
              type="date"
              className={styles.input}
              value={dueDate}
              min={new Date().toISOString().slice(0, 10)}
              onChange={e => setDueDate(e.target.value)}
              required
            />
          </div>

          {/* Estimated time */}
          <div className={styles.field}>
            <label htmlFor="estimated-mins" className={styles.label}>Estimated time</label>
            <select
              id="estimated-mins"
              className={styles.select}
              value={estimatedMins}
              onChange={e => setEstimatedMins(Number(e.target.value))}
              required
            >
              {ESTIMATED_MINS_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          {/* Description — premium only */}
          <div className={styles.field}>
            <div className={styles.labelRow}>
              <label htmlFor="description" className={styles.label}>Description</label>
              {!isPremium && <span className={styles.premiumBadge}>Premium</span>}
            </div>
            <textarea
              id="description"
              className={[styles.textarea, !isPremium ? styles.locked : ''].join(' ')}
              placeholder={isPremium ? 'Describe the task — AI will extract subtasks and refine the time estimate' : 'Upgrade to Premium to unlock'}
              value={description}
              onChange={e => setDescription(e.target.value)}
              disabled={!isPremium}
              rows={4}
            />
          </div>

          {/* PDF upload — premium only */}
          <div className={styles.field}>
            <div className={styles.labelRow}>
              <label htmlFor="pdf" className={styles.label}>PDF attachment</label>
              {!isPremium && <span className={styles.premiumBadge}>Premium</span>}
            </div>
            <div className={[styles.fileWrap, !isPremium ? styles.locked : ''].join(' ')}>
              <input
                id="pdf"
                type="file"
                accept=".pdf"
                className={styles.fileInput}
                disabled={!isPremium}
              />
              <span className={styles.fileHint}>
                {isPremium ? 'AI parses problem list once and caches it' : 'Upgrade to Premium to unlock'}
              </span>
            </div>
          </div>

          {error && <p className={styles.error}>{error}</p>}

          <button type="submit" className={styles.button} disabled={saving || !title.trim() || !dueDate}>
            {saving ? 'Saving...' : 'Add Task'}
          </button>
        </form>
      </div>
    </div>
  )
}
