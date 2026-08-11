import { useState, useEffect, useRef, FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../hooks/useAuth'
import { classify } from '../../lib/classifier'
import TaskClassifierRow from '../../components/TaskClassifierRow/TaskClassifierRow'
import { TaskType } from '../../types'
import styles from './AddTask.module.css'

const ESTIMATED_MINS_OPTIONS = [
  { label: '15 min', value: 15 },
  { label: '30 min', value: 30 },
  { label: '1 hour', value: 60 },
  { label: '2 hours', value: 120 },
]


export default function AddTask() {
  const { session, profile } = useAuth()
  const navigate = useNavigate()
  const isPremium = profile?.tier === 'premium'

  const [title, setTitle] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [dueTime, setDueTime] = useState('23:59')
  const [estimatedMins, setEstimatedMins] = useState<number>(60)
  const [description, setDescription] = useState('')
  const [workType, setWorkType] = useState<TaskType>('deep')
  const [userOverrode, setUserOverrode] = useState(false)
  const [classifierResult, setClassifierResult] = useState<ReturnType<typeof classify> | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [estimatedIsOther, setEstimatedIsOther] = useState(false)
  const [customHours, setCustomHours] = useState('')
  const [showEstimatedDropdown, setShowEstimatedDropdown] = useState(false)
  const estimatedDropdownRef = useRef<HTMLDivElement>(null)
  const customHoursInputRef = useRef<HTMLInputElement>(null)
  const prevTitleRef = useRef(title)

  const customHoursNum = parseFloat(customHours)
  const estimatedValid =
    !estimatedIsOther || (!Number.isNaN(customHoursNum) && customHoursNum > 2)

  const selectedPresetLabel =
    ESTIMATED_MINS_OPTIONS.find(opt => opt.value === estimatedMins)?.label ?? ''

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        estimatedDropdownRef.current &&
        !estimatedDropdownRef.current.contains(e.target as Node)
      ) {
        setShowEstimatedDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (estimatedIsOther && !showEstimatedDropdown) {
      customHoursInputRef.current?.focus()
    }
  }, [estimatedIsOther, showEstimatedDropdown])

  useEffect(() => {
    const trimmed = title.trim()
    const titleChanged = prevTitleRef.current !== title
    prevTitleRef.current = title

    if (!trimmed) {
      setClassifierResult(null)
      return
    }

    const result = classify(trimmed)
    setClassifierResult(result)

    // Title edit always re-runs classifier and clears a manual override
    if (titleChanged) {
      setUserOverrode(false)
      setWorkType(result.type)
    } else if (!userOverrode) {
      setWorkType(result.type)
    }
  }, [title, userOverrode])

  function handleToggleWorkType() {
    setWorkType(prev => (prev === 'deep' ? 'shallow' : 'deep'))
    setUserOverrode(true)
  }

  function handleCustomHoursChange(value: string) {
    const sanitized = value.replace(/[^\d.]/g, '')
    setCustomHours(sanitized)
    const hours = parseFloat(sanitized)
    if (!Number.isNaN(hours) && hours > 0) {
      setEstimatedMins(Math.round(hours * 60))
    }
  }

  function handleSelectOther(e: React.MouseEvent) {
    e.preventDefault()
    setEstimatedIsOther(true)
    setCustomHours('')
    setShowEstimatedDropdown(false)
  }

  function handleSelectPreset(value: number) {
    setEstimatedIsOther(false)
    setCustomHours('')
    setEstimatedMins(value)
    setShowEstimatedDropdown(false)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!session) {
      console.warn('[AddTask] Submit blocked: no session')
      return
    }
    setError(null)
    setSaving(true)

    const dueDateIso = new Date(`${dueDate}T${dueTime}:00`).toISOString()
    const payload = {
      id: crypto.randomUUID(),
      user_id: session.user.id,
      title: title.trim(),
      due_date: dueDateIso,
      estimated_mins: estimatedMins,
      work_type: workType,
      user_overrode_classifier: userOverrode,
      classifier_confidence: classifierResult?.confidence ?? null,
      shallow_score: classifierResult?.shallowScore ?? null,
      deep_score: classifierResult?.deepScore ?? null,
      description: isPremium && description.trim() ? description.trim() : null,
    }

    console.log('[AddTask] Submit started', {
      userId: session.user.id,
      title: payload.title,
      dueDate,
      dueTime,
      dueDateIso,
      estimatedMins,
      workType,
    })

    try {
      const { data: inserted, error: insertError } = await supabase
        .from('tasks')
        .insert(payload)
        .select('id')
        .single()

      if (insertError) {
        console.error('[AddTask] Task insert failed', {
          message: insertError.message,
          code: insertError.code,
          details: insertError.details,
          hint: insertError.hint,
          fullError: insertError,
        })
        throw insertError
      }

      console.log('[AddTask] Task inserted', { taskId: inserted.id })

      // Navigate immediately. The DB trigger fires schedule-generator automatically;
      // the Realtime subscription on work_blocks updates the dashboard when blocks arrive.
      navigate('/tasks')
    } catch (err) {
      console.error('[AddTask] Submit failed', err)
      setError(err instanceof Error ? err.message : 'Failed to save task')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <Link to="/tasks" className={styles.back}>
          ← Back
        </Link>

        <h1 className={styles.title}>Add Task</h1>

        <form onSubmit={handleSubmit} className={styles.form}>
          {/* Task name */}
          <div className={styles.field}>
            <label htmlFor="title" className={styles.label}>Task name</label>
            <input
              id="title"
              type="text"
              className={styles.input}
              placeholder="e.g. Write essay on climate policy"
              value={title}
              onChange={e => setTitle(e.target.value)}
              required
              autoComplete="off"
              autoFocus
            />
            {title.trim() && (
              <TaskClassifierRow
                workType={workType}
                userOverrode={userOverrode}
                onToggle={handleToggleWorkType}
              />
            )}
          </div>

          {/* Due date & time */}
          <div className={styles.field}>
            <span className={styles.label}>Due date & time</span>
            <div className={styles.dateTimeRow}>
              <input
                id="due-date"
                type="date"
                className={styles.input}
                value={dueDate}
                min={new Date().toISOString().slice(0, 10)}
                onChange={e => setDueDate(e.target.value)}
                required
                aria-label="Due date"
              />
              <input
                id="due-time"
                type="time"
                className={styles.input}
                value={dueTime}
                onChange={e => setDueTime(e.target.value)}
                required
                aria-label="Due time"
              />
            </div>
          </div>

          {/* Estimated time */}
          <div className={styles.field}>
            <span className={styles.label} id="estimated-mins-label">Estimated time</span>
            <div className={styles.selectWrap} ref={estimatedDropdownRef}>
              <div className={styles.selectTrigger}>
                {estimatedIsOther ? (
                  <div className={styles.triggerOther}>
                    <input
                      ref={customHoursInputRef}
                      id="estimated-mins"
                      type="text"
                      inputMode="decimal"
                      className={styles.triggerInput}
                      placeholder="e.g. 4"
                      value={customHours}
                      onChange={e => handleCustomHoursChange(e.target.value)}
                      aria-label="Custom hours"
                    />
                    <span className={styles.customHoursSuffix}>hours</span>
                  </div>
                ) : (
                  <button
                    type="button"
                    className={styles.triggerLabel}
                    aria-labelledby="estimated-mins-label"
                    aria-expanded={showEstimatedDropdown}
                    aria-haspopup="listbox"
                    aria-controls={showEstimatedDropdown ? 'estimated-mins-listbox' : undefined}
                    onClick={() => setShowEstimatedDropdown(prev => !prev)}
                  >
                    {selectedPresetLabel}
                  </button>
                )}
                {estimatedIsOther && (
                  <button
                    type="button"
                    className={styles.selectChevronBtn}
                    aria-label="Open estimated time options"
                    aria-expanded={showEstimatedDropdown}
                    aria-haspopup="listbox"
                    aria-controls={showEstimatedDropdown ? 'estimated-mins-listbox' : undefined}
                    onClick={() => setShowEstimatedDropdown(prev => !prev)}
                  >
                    <svg
                      className={styles.selectChevronIcon}
                      viewBox="0 0 16 16"
                      aria-hidden="true"
                    >
                      <path
                        d="M4 6l4 4 4-4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                )}
              </div>
              {showEstimatedDropdown && (
                <ul
                  id="estimated-mins-listbox"
                  className={styles.dropdown}
                  role="listbox"
                  aria-labelledby="estimated-mins-label"
                >
                  {ESTIMATED_MINS_OPTIONS.map(opt => (
                    <li
                      key={opt.value}
                      role="option"
                      aria-selected={!estimatedIsOther && estimatedMins === opt.value}
                      className={[
                        styles.dropdownItem,
                        !estimatedIsOther && estimatedMins === opt.value
                          ? styles.dropdownItemSelected
                          : '',
                      ].filter(Boolean).join(' ')}
                      onMouseDown={e => {
                        e.preventDefault()
                        handleSelectPreset(opt.value)
                      }}
                    >
                      {opt.label}
                    </li>
                  ))}
                  <li
                    role="option"
                    aria-selected={estimatedIsOther}
                    className={[
                      styles.dropdownItem,
                      styles.dropdownItemOther,
                      estimatedIsOther ? styles.dropdownItemSelected : '',
                    ].filter(Boolean).join(' ')}
                    onMouseDown={handleSelectOther}
                  >
                    Other
                  </li>
                </ul>
              )}
            </div>
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

          <button
            type="submit"
            className={styles.button}
            disabled={saving || !title.trim() || !dueDate || !estimatedValid}
          >
            {saving ? 'Saving...' : 'Add Task'}
          </button>
        </form>
      </div>
    </div>
  )
}
