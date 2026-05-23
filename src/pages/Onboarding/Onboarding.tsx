import { useState, useRef, useEffect, FormEvent } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../hooks/useAuth'
import { WorkerType } from '../../types'
import styles from './Onboarding.module.css'

const FIELDS_OF_STUDY = [
  'Anthropology', 'Architecture', 'Art', 'Biology', 'Business',
  'Chemistry', 'Communications', 'Computer Science', 'Economics',
  'Education', 'Engineering', 'Environmental Science', 'History',
  'Law', 'Literature', 'Mathematics', 'Medicine', 'Music',
  'Nursing', 'Philosophy', 'Physics', 'Political Science',
  'Psychology', 'Sociology',
]

const OTHER_FIELD = 'Other'

const PEAK_HOUR_SEEDS: Record<WorkerType, number[]> = {
  early_bird: [5, 6, 7, 8],
  morning: [9, 10, 11],
  afternoon: [12, 13, 14, 15, 16, 17, 18],
  night_owl: [19, 20, 21, 22, 23],
}

function buildPeakHourMap(workerType: WorkerType): Record<string, number> {
  const peakHours = new Set(PEAK_HOUR_SEEDS[workerType])
  const map: Record<string, number> = {}
  for (let h = 0; h < 24; h++) {
    map[String(h)] = peakHours.has(h) ? 1.0 : 0.1
  }
  return map
}

const WORKER_OPTIONS: { value: WorkerType; label: string; hours: string }[] = [
  { value: 'early_bird', label: 'Early Bird', hours: '5am – 9am' },
  { value: 'morning', label: 'Morning', hours: '9am – 12pm' },
  { value: 'afternoon', label: 'Afternoon', hours: '12pm – 7pm' },
  { value: 'night_owl', label: 'Night Owl', hours: '7pm – 12am' },
]

export default function Onboarding() {
  const { session } = useAuth()

  const [stage, setStage] = useState(1)
  const [workerType, setWorkerType] = useState<WorkerType | null>(null)
  const [unavailableBefore, setUnavailableBefore] = useState('08:00')
  const [unavailableAfter, setUnavailableAfter] = useState('22:00')
  const [fieldQuery, setFieldQuery] = useState('')
  const [fieldOfStudy, setFieldOfStudy] = useState('')
  const [fieldIsOther, setFieldIsOther] = useState(false)
  const [otherField, setOtherField] = useState('')
  const [showDropdown, setShowDropdown] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const comboboxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (comboboxRef.current && !comboboxRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const filteredFields = FIELDS_OF_STUDY.filter(f =>
    f.toLowerCase().includes(fieldQuery.toLowerCase())
  )
  const showOtherOption =
    !fieldQuery || OTHER_FIELD.toLowerCase().includes(fieldQuery.toLowerCase())

  async function handleComplete(e: FormEvent) {
    e.preventDefault()
    if (!session) { setError('Session expired — please sign in again.'); setSaving(false); return }
    setError(null)
    setSaving(true)

    const studyValue = fieldIsOther
      ? otherField.trim() || null
      : fieldOfStudy || fieldQuery.trim() || null

    try {
      const { error: profileError } = await supabase.from('learning_profile').insert({
        user_id: session.user.id,
        worker_type: workerType,
        unavailable_before: unavailableBefore,
        unavailable_after: unavailableAfter,
        peak_hour_map: buildPeakHourMap(workerType!),
      })
      if (profileError) throw profileError

      const { error: userError } = await supabase
        .from('users')
        .update({
          onboarding_q1: workerType,
          onboarding_q2_before: unavailableBefore,
          onboarding_q2_after: unavailableAfter,
          field_of_study: studyValue,
          onboarding_step: 'complete',
          onboarding_completed: true,
        })
        .eq('id', session.user.id)
      if (userError) throw userError

      window.location.replace('/dashboard')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <div className={styles.progress}>
          {[1, 2, 3, 4].map(s => (
            <div
              key={s}
              className={[
                styles.dot,
                s === stage ? styles.dotActive : '',
                s < stage ? styles.dotDone : '',
              ].join(' ')}
            />
          ))}
        </div>

        {/* Stage 1 — Worker type */}
        {stage === 1 && (
          <div className={styles.stage}>
            <h1 className={styles.title}>When do you work best?</h1>
            <p className={styles.subtitle}>
              We'll use this to seed your schedule. Rumbo learns your real patterns over time.
            </p>
            <div className={styles.cards}>
              {WORKER_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  className={[styles.card, workerType === opt.value ? styles.cardSelected : ''].join(' ')}
                  onClick={() => setWorkerType(opt.value)}
                >
                  <span className={styles.cardLabel}>{opt.label}</span>
                  <span className={styles.cardHours}>{opt.hours}</span>
                </button>
              ))}
            </div>
            <button className={styles.button} disabled={!workerType} onClick={() => setStage(2)}>
              Continue
            </button>
          </div>
        )}

        {/* Stage 2 — Unavailable hours */}
        {stage === 2 && (
          <div className={styles.stage}>
            <h1 className={styles.title}>Set your work window</h1>
            <p className={styles.subtitle}>
              Rumbo will never schedule blocks outside this range.
            </p>
            <div className={styles.timeFields}>
              <div className={styles.timeField}>
                <label className={styles.label}>I never work before</label>
                <input
                  type="time"
                  className={styles.timeInput}
                  value={unavailableBefore}
                  onChange={e => setUnavailableBefore(e.target.value)}
                />
              </div>
              <div className={styles.timeField}>
                <label className={styles.label}>I never work after</label>
                <input
                  type="time"
                  className={styles.timeInput}
                  value={unavailableAfter}
                  onChange={e => setUnavailableAfter(e.target.value)}
                />
              </div>
            </div>
            <div className={styles.actions}>
              <button className={styles.buttonSecondary} onClick={() => setStage(1)}>Back</button>
              <button className={styles.button} onClick={() => setStage(3)}>Continue</button>
            </div>
          </div>
        )}

        {/* Stage 3 — Calendar connect (skippable) */}
        {stage === 3 && (
          <div className={styles.stage}>
            <h1 className={styles.title}>Connect your calendar</h1>
            <p className={styles.subtitle}>
              <strong>Highly recommended.</strong> Rumbo reads your existing events so scheduled blocks don't conflict.
            </p>
            <div className={styles.calendarOptions}>
              <button type="button" className={styles.calendarButton} disabled>
                <span>Google Calendar</span>
                <span className={styles.comingSoon}>Coming soon</span>
              </button>
              <button type="button" className={styles.calendarButton} disabled>
                <span>Microsoft Outlook</span>
                <span className={styles.comingSoon}>Coming soon</span>
              </button>
            </div>
            <div className={styles.actions}>
              <button className={styles.buttonSecondary} onClick={() => setStage(2)}>Back</button>
              <button className={styles.buttonLink} onClick={() => setStage(4)}>Skip for now</button>
            </div>
          </div>
        )}

        {/* Stage 4 — Field of study */}
        {stage === 4 && (
          <form onSubmit={handleComplete} className={styles.stage}>
            <h1 className={styles.title}>What do you study?</h1>
            <p className={styles.subtitle}>
              Used to personalize your experience. Doesn't affect scheduling.
            </p>
            {fieldIsOther ? (
              <div className={styles.otherField}>
                <label className={styles.label} htmlFor="other-major">
                  Your field of study
                </label>
                <input
                  id="other-major"
                  type="text"
                  className={styles.input}
                  placeholder="e.g. Astrophysics, Graphic Design"
                  value={otherField}
                  autoComplete="off"
                  autoFocus
                  onChange={e => setOtherField(e.target.value)}
                />
                <button
                  type="button"
                  className={styles.buttonLink}
                  onClick={() => {
                    setFieldIsOther(false)
                    setOtherField('')
                  }}
                >
                  Choose from list
                </button>
              </div>
            ) : (
              <div className={styles.comboboxWrap} ref={comboboxRef}>
                <input
                  type="text"
                  className={styles.input}
                  placeholder="e.g. Computer Science"
                  value={fieldQuery}
                  autoComplete="off"
                  onChange={e => {
                    setFieldQuery(e.target.value)
                    setFieldOfStudy('')
                    setShowDropdown(true)
                  }}
                  onFocus={() => setShowDropdown(true)}
                />
                {showDropdown && (filteredFields.length > 0 || showOtherOption) && (
                  <ul className={styles.dropdown}>
                    {filteredFields.map(f => (
                      <li
                        key={f}
                        className={styles.dropdownItem}
                        onMouseDown={() => {
                          setFieldOfStudy(f)
                          setFieldQuery(f)
                          setShowDropdown(false)
                        }}
                      >
                        {f}
                      </li>
                    ))}
                    {showOtherOption && (
                      <li
                        className={[styles.dropdownItem, styles.dropdownItemOther].join(' ')}
                        onMouseDown={() => {
                          setFieldIsOther(true)
                          setFieldOfStudy('')
                          setFieldQuery('')
                          setShowDropdown(false)
                        }}
                      >
                        {OTHER_FIELD}
                      </li>
                    )}
                  </ul>
                )}
              </div>
            )}
            {error && <p className={styles.error}>{error}</p>}
            <div className={styles.actions}>
              <button type="button" className={styles.buttonSecondary} onClick={() => setStage(3)}>Back</button>
              <button type="submit" className={styles.button} disabled={saving}>
                {saving ? 'Setting up...' : 'Finish'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
