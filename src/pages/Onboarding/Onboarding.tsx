import { useState, useRef, useEffect, FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../hooks/useAuth'
import { startGoogleCalendarConnect, getGoogleCalendarConnected, getGoogleCalendarScopesOk } from '../../lib/calendar'
import CanvasConnect from '../../components/CanvasConnect/CanvasConnect'
import styles from './Onboarding.module.css'

// V0 onboarding — see Rumbo-Design-Docs/Frontend/onboarding.md.
// Stage 1: Field of study
// Stage 2: Canvas PAT + base URL (calls canvas-verify with save:true)
// Stage 3: Google Calendar connect (reuses existing OAuth)
// Stage 4: Manual courses (skippable stub for V0)
//
// The scheduler-era worker-type + unavailable-hours stages are removed.
// A learning_profile row is still created with default scheduler values as a
// compatibility carry (LLD §13, Legacy/scheduler.md).

const FIELDS_OF_STUDY = [
  'Anthropology', 'Architecture', 'Art', 'Biology', 'Business',
  'Chemistry', 'Communications', 'Computer Science', 'Economics',
  'Education', 'Engineering', 'Environmental Science', 'History',
  'Law', 'Literature', 'Mathematics', 'Medicine', 'Music',
  'Nursing', 'Philosophy', 'Physics', 'Political Science',
  'Psychology', 'Sociology',
]

const OTHER_FIELD = 'Other'

function mapOnboardingDbError(err: unknown): string {
  if (!(err instanceof Error)) return 'Something went wrong'
  const message = err.message.toLowerCase()
  if (
    (message.includes('relation') && message.includes('does not exist')) ||
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

  // Stage 1 — field of study
  const [fieldQuery, setFieldQuery] = useState('')
  const [fieldOfStudy, setFieldOfStudy] = useState('')
  const [fieldIsOther, setFieldIsOther] = useState(false)
  const [otherField, setOtherField] = useState('')
  const [showDropdown, setShowDropdown] = useState(false)

  // Stage 2 — Canvas (form state owned by <CanvasConnect />)
  const [, setCanvasConnected] = useState(false)

  // Stage 3 — Google
  const [calendarConnected, setCalendarConnected] = useState(false)
  const [calendarBusy, setCalendarBusy] = useState(false)

  // General
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
    // Onboarding treats a scopes-deficient connection as not-connected: the
    // user re-consents to grant Drive scope before moving forward.
    Promise.all([
      getGoogleCalendarConnected().catch(() => false),
      getGoogleCalendarScopesOk().catch(() => true),
    ]).then(([connected, scopesOk]) => setCalendarConnected(connected && scopesOk))
  }, [])

  // Return path from Google OAuth: land back on stage 3 with connected=true.
  useEffect(() => {
    if (searchParams.get('calendar') === 'connected') {
      setCalendarConnected(true)
      setStage(3)
      const next = new URLSearchParams(searchParams)
      next.delete('calendar')
      next.delete('reason')
      setSearchParams(next, { replace: true })
    }
    if (searchParams.get('stage') === 'calendar') {
      setStage(3)
      const next = new URLSearchParams(searchParams)
      next.delete('stage')
      setSearchParams(next, { replace: true })
    }
  }, [searchParams, setSearchParams])

  const filteredFields = FIELDS_OF_STUDY.filter(f =>
    f.toLowerCase().includes(fieldQuery.toLowerCase()),
  )
  const showOtherOption =
    !fieldQuery || OTHER_FIELD.toLowerCase().includes(fieldQuery.toLowerCase())

  // -----------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------

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
    const meta = session.user.user_metadata ?? {}
    const first =
      typeof meta.first_name === 'string' && meta.first_name.trim()
        ? meta.first_name.trim()
        : typeof meta.name === 'string'
        ? meta.name.trim().split(/\s+/)[0] ?? null
        : null
    const last =
      typeof meta.last_name === 'string' && meta.last_name.trim()
        ? meta.last_name.trim()
        : typeof meta.name === 'string' && meta.name.trim().includes(' ')
        ? meta.name.trim().split(/\s+/).slice(1).join(' ')
        : null

    const { error: insertError } = await supabase.from('users').insert({
      id: session.user.id,
      email,
      first_name: first,
      last_name: last,
      onboarding_step: 'start',
      onboarding_completed: false,
    })
    if (insertError) throw insertError
  }

  // Ensure a learning_profile row exists with default scheduler values.
  // Compat carry per LLD §13 — the row is not used in V0 but downstream code
  // expecting it should not blow up.
  async function ensureLearningProfileRow() {
    if (!session) throw new Error('Session expired — please sign in again.')

    const { data: existing, error: selectError } = await supabase
      .from('learning_profile')
      .select('id')
      .eq('user_id', session.user.id)
      .maybeSingle()
    if (selectError) throw selectError
    if (existing) return

    const defaultPeakHours = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      score: hour >= 9 && hour < 22 ? 0.5 : 0,
    }))

    const { error: insertError } = await supabase.from('learning_profile').insert({
      user_id: session.user.id,
      unavailable_before: 8,
      unavailable_after: 22,
      peak_hour_map: defaultPeakHours,
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
    })
    if (insertError) throw insertError
  }

  async function persistFieldOfStudy() {
    if (!session) throw new Error('Session expired — please sign in again.')
    const studyValue = fieldIsOther
      ? otherField.trim() || null
      : fieldOfStudy || fieldQuery.trim() || null

    if (!studyValue) throw new Error('Please choose or enter a field of study.')

    await ensureUserRow()

    const { error: updateError } = await supabase
      .from('users')
      .update({
        field_of_study: studyValue,
        onboarding_step: 'canvas',
      })
      .eq('id', session.user.id)
    if (updateError) throw updateError
  }

  async function handleStudySubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSaving(true)
    try {
      await persistFieldOfStudy()
      setStage(2)
    } catch (err) {
      setError(mapOnboardingDbError(err))
    } finally {
      setSaving(false)
    }
  }

  // -----------------------------------------------------------------
  // Stage 2 — Canvas connect (delegated to CanvasConnect component)
  // -----------------------------------------------------------------

  function handleCanvasConnected() {
    setCanvasConnected(true)
    setStage(3)
  }

  // -----------------------------------------------------------------
  // Stage 3 — Google Calendar (existing OAuth)
  // -----------------------------------------------------------------

  async function handleGoogleConnect() {
    setError(null)
    setCalendarBusy(true)
    try {
      await startGoogleCalendarConnect('/onboarding?calendar=connected')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect Google')
    } finally {
      setCalendarBusy(false)
    }
  }

  // -----------------------------------------------------------------
  // Finalize
  // -----------------------------------------------------------------

  async function finalizeOnboarding() {
    if (!session) throw new Error('Session expired — please sign in again.')
    setFinalizing(true)
    try {
      await ensureUserRow()
      // Compat carry: create learning_profile row here (not at stage 1) so
      // abandoned onboardings don't leave orphan rows.
      await ensureLearningProfileRow()
      const { error: userError } = await supabase
        .from('users')
        .update({
          onboarding_step: 'complete',
          onboarding_completed: true,
        })
        .eq('id', session.user.id)
      if (userError) throw userError
      window.location.replace('/dashboard')
    } catch (err) {
      setFinalizing(false)
      finalizedRef.current = false
      throw err
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <div
          className={styles.progress}
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={4}
          aria-valuenow={stage}
          aria-label={`Onboarding step ${stage} of 4`}
        >
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

        {/* Stage 1 — Field of study */}
        {stage === 1 && (
          <form onSubmit={handleStudySubmit} className={styles.stage}>
            <h1 className={styles.title}>What do you study?</h1>
            <p className={styles.subtitle}>
              Used to personalize your experience. Doesn't affect what Rumbo ingests.
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
              <button type="submit" className={styles.button} disabled={saving}>
                {saving ? 'Saving…' : 'Continue'}
              </button>
            </div>
          </form>
        )}

        {/* Stage 2 — Canvas PAT */}
        {stage === 2 && (
          <div className={styles.stage}>
            <h1 className={styles.title}>Connect Canvas</h1>
            <p className={styles.subtitle}>
              Canvas is where most of your assignments live. Rumbo needs a personal access token
              to read them — it stays on your account and you can revoke it anytime.
            </p>
            <CanvasConnect
              onConnected={handleCanvasConnected}
              onCancel={() => setStage(1)}
              cancelLabel="Back"
            />
            <div className={styles.actions} style={{ marginTop: 'var(--space-md)' }}>
              <button
                type="button"
                className={styles.buttonLink}
                onClick={() => setStage(3)}
              >
                I don't use Canvas
              </button>
            </div>
          </div>
        )}

        {/* Stage 3 — Google Calendar */}
        {stage === 3 && (
          <div className={styles.stage}>
            <h1 className={styles.title}>Connect Google</h1>
            <p className={styles.subtitle}>
              Rumbo reads your academic calendar events. Highly recommended.
            </p>
            <div className={styles.calendarOptions}>
              <button
                type="button"
                className={[
                  styles.calendarButton,
                  calendarConnected ? styles.calendarButtonDone : '',
                ].filter(Boolean).join(' ')}
                onClick={handleGoogleConnect}
                disabled={calendarBusy || calendarConnected}
              >
                <span>Google Calendar</span>
                <span className={styles.comingSoon}>
                  {calendarConnected ? 'Connected' : calendarBusy ? 'Opening…' : 'Connect'}
                </span>
              </button>
            </div>
            {error && <p className={styles.error}>{error}</p>}
            <div className={styles.actions}>
              <button type="button" className={styles.buttonSecondary} onClick={() => setStage(2)}>
                Back
              </button>
              <button type="button" className={styles.button} onClick={() => setStage(4)}>
                {calendarConnected ? 'Continue' : 'Skip for now'}
              </button>
            </div>
          </div>
        )}

        {/* Stage 4 — Manual courses (stub for V0) */}
        {stage === 4 && (
          <div className={styles.stage}>
            <h1 className={styles.title}>Anything Canvas doesn't have?</h1>
            <p className={styles.subtitle}>
              You can add courses Canvas doesn't cover — seminars, self-study, courses at another
              institution. Optional — you can do this later in Settings.
            </p>
            <p className={styles.helpText}>
              Manual course entry is coming soon. For now you can skip this and add courses later.
            </p>
            {error && <p className={styles.error}>{error}</p>}
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.buttonSecondary}
                onClick={() => setStage(3)}
                disabled={finalizing}
              >
                Back
              </button>
              <button
                type="button"
                className={styles.button}
                disabled={finalizing}
                onClick={async () => {
                  setError(null)
                  try {
                    if (!finalizedRef.current) {
                      finalizedRef.current = true
                      await finalizeOnboarding()
                    }
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Something went wrong')
                  }
                }}
              >
                {finalizing ? 'Finishing…' : 'Finish'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
