import { useState, useRef, useEffect, FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../hooks/useAuth'
import { startGoogleCalendarConnect, getGoogleCalendarConnected } from '../../lib/calendar'
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

function parseHour(hhmm: string): number {
  return parseInt(hhmm.split(':')[0], 10)
}

function buildPeakHourMap(
  workerType: WorkerType,
  unavailableBeforeHour: number,
  unavailableAfterHour: number,
): { hour: number; score: number }[] {
  const peakHours = new Set(PEAK_HOUR_SEEDS[workerType])
  return Array.from({ length: 24 }, (_, hour) => {
    if (hour < unavailableBeforeHour || hour >= unavailableAfterHour) return { hour, score: 0 }
    if (peakHours.has(hour)) return { hour, score: 0.7 }
    return { hour, score: 0.3 }
  })
}

const WORKER_OPTIONS: { value: WorkerType; label: string; hours: string }[] = [
  { value: 'early_bird', label: 'Early Bird', hours: '5am – 9am' },
  { value: 'morning', label: 'Morning', hours: '9am – 12pm' },
  { value: 'afternoon', label: 'Afternoon', hours: '12pm – 7pm' },
  { value: 'night_owl', label: 'Night Owl', hours: '7pm – 12am' },
]

function mapOnboardingDbError(err: unknown): string {
  if (!(err instanceof Error)) return 'Something went wrong'
  const message = err.message.toLowerCase()
  if (
    message.includes('relation') && message.includes('does not exist') ||
    message.includes('learning_profile')
  ) {
    return 'Database setup incomplete: learning_profile table is missing. Run Supabase migrations, then retry onboarding.'
  }
  return err.message
}

export default function Onboarding() {
  const { session } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()

  const [stage, setStage] = useState(1)
  const [calendarConnected, setCalendarConnected] = useState(false)
  const [calendarBusy, setCalendarBusy] = useState(false)
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
  const [finalizing, setFinalizing] = useState(false)

  const comboboxRef = useRef<HTMLDivElement>(null)
  const finalizedRef = useRef(false)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (comboboxRef.current && !comboboxRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  useEffect(() => {
    getGoogleCalendarConnected().then(setCalendarConnected)
  }, [])

  useEffect(() => {
    if (searchParams.get('stage') === 'calendar') {
      setStage(4)
      const next = new URLSearchParams(searchParams)
      next.delete('stage')
      setSearchParams(next, { replace: true })
    }
  }, [searchParams, setSearchParams])

  useEffect(() => {
    if (searchParams.get('calendar') === 'connected') {
      setCalendarConnected(true)
      setStage(4)
      if (!finalizedRef.current) {
        finalizedRef.current = true
        void finalizeOnboarding()
      }
      const next = new URLSearchParams(searchParams)
      next.delete('calendar')
      next.delete('reason')
      setSearchParams(next, { replace: true })
    }
  }, [searchParams, setSearchParams])

  async function handleGoogleConnect() {
    setCalendarBusy(true)
    setError(null)
    try {
      await startGoogleCalendarConnect('/onboarding?stage=calendar')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect calendar')
    } finally {
      setCalendarBusy(false)
    }
  }

  const filteredFields = FIELDS_OF_STUDY.filter(f =>
    f.toLowerCase().includes(fieldQuery.toLowerCase())
  )
  const showOtherOption =
    !fieldQuery || OTHER_FIELD.toLowerCase().includes(fieldQuery.toLowerCase())

  async function persistOnboardingData() {
    if (!session) throw new Error('Session expired — please sign in again.')
    if (!workerType) throw new Error('Please select your worker type.')

    const studyValue = fieldIsOther
      ? otherField.trim() || null
      : fieldOfStudy || fieldQuery.trim() || null

    const unavailableBeforeHour = parseHour(unavailableBefore)
    const unavailableAfterHour = parseHour(unavailableAfter)

    const profilePayload = {
      user_id: session.user.id,
      unavailable_before: unavailableBeforeHour,
      unavailable_after: unavailableAfterHour,
      peak_hour_map: buildPeakHourMap(workerType, unavailableBeforeHour, unavailableAfterHour),
      block_ceiling_mins: 60,
      target_block_mins: 45,
      distribution_preference: 'even',
      deadline_proximity_buckets: {
        early_avg: 3.0, middle_avg: 3.0, late_avg: 3.0,
        early_count: 0, middle_count: 0, late_count: 0,
      },
      urgency_threshold: 2.0,
      shallow_before_deep: true,
      profile_stage: 1,
      total_reflections: 0,
      ceiling_last_adjusted_at: null,
      ceiling_adjustment_sessions: 0,
    }

    // Avoid relying on DB-specific upsert constraints during onboarding:
    // try update first, then insert if the user has no profile row yet.
    const { data: updatedRows, error: updateError } = await supabase
      .from('learning_profile')
      .update(profilePayload)
      .eq('user_id', session.user.id)
      .select('id')

    if (updateError) throw updateError

    if (!updatedRows || updatedRows.length === 0) {
      const { error: insertError } = await supabase
        .from('learning_profile')
        .insert(profilePayload)
      if (insertError) throw insertError
    }

    await ensureUserRow()

    const { data: userRows, error: userError } = await supabase
      .from('users')
      .update({
        onboarding_q1: workerType,
        onboarding_q2_before: unavailableBefore,
        onboarding_q2_after: unavailableAfter,
        field_of_study: studyValue,
        onboarding_step: 'calendar',
        onboarding_completed: false,
      })
      .eq('id', session.user.id)
      .select('id')
    if (userError) throw userError
    if (!userRows || userRows.length === 0) {
      throw new Error('Could not update user onboarding state')
    }
  }

  async function ensureUserRow() {
    if (!session) throw new Error('Session expired — please sign in again.')
    const { data: existing, error: existingError } = await supabase
      .from('users')
      .select('id')
      .eq('id', session.user.id)
      .maybeSingle()
    if (existingError) throw existingError
    if (existing) return

    const email = session.user.email ?? null
    const name =
      typeof session.user.user_metadata?.name === 'string'
        ? (session.user.user_metadata.name as string)
        : null

    const { error: insertError } = await supabase.from('users').insert({
      id: session.user.id,
      email,
      name,
      tier: 'free',
      onboarding_step: 'start',
      onboarding_completed: false,
    })
    if (insertError) throw insertError
  }

  async function finalizeOnboarding() {
    if (!session) throw new Error('Session expired — please sign in again.')
    setFinalizing(true)
    await ensureUserRow()
    const { data: userRows, error: userError } = await supabase
      .from('users')
      .update({
        onboarding_step: 'complete',
        onboarding_completed: true,
      })
      .eq('id', session.user.id)
      .select('id')
    if (userError) throw userError
    if (!userRows || userRows.length === 0) {
      throw new Error('Could not complete onboarding for this user')
    }
    window.location.replace('/home')
  }

  async function handleStudySubmit(e: FormEvent) {
    e.preventDefault()
    if (!session) {
      setError('Session expired — please sign in again.')
      setSaving(false)
      return
    }
    setError(null)
    setSaving(true)

    try {
      await persistOnboardingData()
      setStage(4)
    } catch (err) {
      setError(mapOnboardingDbError(err))
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

        {/* Stage 3 — Field of study */}
        {stage === 3 && (
          <form onSubmit={handleStudySubmit} className={styles.stage}>
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
              <button type="button" className={styles.buttonSecondary} onClick={() => setStage(2)}>Back</button>
              <button type="submit" className={styles.button} disabled={saving}>
                {saving ? 'Saving...' : 'Continue'}
              </button>
            </div>
          </form>
        )}

        {/* Stage 4 — Calendar connect (final step) */}
        {stage === 4 && (
          <div className={styles.stage}>
            <h1 className={styles.title}>Connect your calendar</h1>
            <p className={styles.subtitle}>
              Last step. Rumbo reads your existing events so scheduled blocks don't conflict.
            </p>
            <div className={styles.calendarOptions}>
              <button
                type="button"
                className={[
                  styles.calendarButton,
                  calendarConnected ? styles.calendarButtonDone : '',
                ].filter(Boolean).join(' ')}
                onClick={handleGoogleConnect}
                disabled={calendarBusy || calendarConnected || finalizing}
              >
                <span>Google Calendar</span>
                <span className={styles.comingSoon}>
                  {calendarConnected ? 'Connected' : calendarBusy ? 'Opening…' : 'Connect'}
                </span>
              </button>
              <button type="button" className={styles.calendarButton} disabled>
                <span>Microsoft Outlook</span>
                <span className={styles.comingSoon}>Coming soon</span>
              </button>
            </div>
            {error && <p className={styles.error}>{error}</p>}
            <div className={styles.actions}>
              <button type="button" className={styles.buttonSecondary} onClick={() => setStage(3)} disabled={finalizing}>
                Back
              </button>
              <button
                type="button"
                className={styles.button}
                disabled={finalizing}
                onClick={async () => {
                  setError(null)
                  try {
                    await finalizeOnboarding()
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Something went wrong')
                    finalizedRef.current = false
                    setFinalizing(false)
                  }
                }}
              >
                {finalizing ? 'Finishing...' : calendarConnected ? 'Go to dashboard' : 'Finish for now'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
