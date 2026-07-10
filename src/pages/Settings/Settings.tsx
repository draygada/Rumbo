import { FormEvent, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  disconnectGoogleCalendar,
  getGoogleCalendarConnected,
  getGoogleCalendarScopesOk,
  startGoogleCalendarConnect,
} from '../../lib/calendar'
import {
  disconnectCanvas,
  getCanvasConnected,
  getCanvasDomain,
} from '../../lib/canvas'
import CanvasConnect from '../../components/CanvasConnect/CanvasConnect'
import ConnectionModal from '../../components/ConnectionModal/ConnectionModal'
import { useTheme, type ThemePreference } from '../../hooks/useTheme'
import {
  createManualCourse,
  listManualCourses,
  type ManualCourse,
  type ManualCourseInput,
} from '../../lib/manualCourses'
import styles from './Settings.module.css'

const TERM_SEASONS = ['Fall', 'Spring', 'Summer', 'Winter'] as const

function currentAcademicYear(): number {
  const d = new Date()
  return d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1
}

function defaultManualInput(): ManualCourseInput {
  return {
    name: '',
    institution: '',
    term: `Fall ${currentAcademicYear()}`,
    course_code: '',
    instructor_name: '',
  }
}

// V0 Settings — see Rumbo-Design-Docs/Frontend/page-flows.md.
// Sections:
//   1. Sources (Canvas, Google, Manual courses)
// Field-of-study lives on /account. Scheduler-era editors are removed
// (Legacy/scheduler.md).

export default function Settings() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { preference: theme, setPreference: setTheme } = useTheme()

  const [canvasConnected, setCanvasConnected] = useState(false)
  const [canvasDomain, setCanvasDomain] = useState<string | null>(null)
  const [googleConnected, setGoogleConnected] = useState(false)
  const [googleScopesOk, setGoogleScopesOk] = useState(true)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  // Canvas connect form
  const [showCanvasForm, setShowCanvasForm] = useState(false)

  // Manual courses
  const [manualCourses, setManualCourses] = useState<ManualCourse[]>([])
  const [showManualForm, setShowManualForm] = useState(false)
  const [manualInput, setManualInput] = useState<ManualCourseInput>(defaultManualInput)

  const calendarParam = searchParams.get('calendar')

  useEffect(() => {
    Promise.all([
      getCanvasConnected().catch(() => false),
      getCanvasDomain().catch(() => null),
      getGoogleCalendarConnected().catch(() => false),
      getGoogleCalendarScopesOk().catch(() => true),
      listManualCourses().catch(() => []),
    ])
      .then(([canvas, domain, google, scopesOk, manual]) => {
        setCanvasConnected(canvas)
        setCanvasDomain(domain)
        setGoogleConnected(google)
        setGoogleScopesOk(scopesOk)
        setManualCourses(manual)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (searchParams.get('add') === 'course') {
      setShowManualForm(true)
      const next = new URLSearchParams(searchParams)
      next.delete('add')
      setSearchParams(next, { replace: true })
    }
  }, [searchParams, setSearchParams])

  useEffect(() => {
    if (calendarParam === 'connected') {
      setGoogleConnected(true)
      setGoogleScopesOk(true)
      setMessage('Google Calendar connected.')
      setSearchParams({}, { replace: true })
    } else if (calendarParam === 'error') {
      const rawReason = searchParams.get('reason')
      const reason = rawReason ? decodeURIComponent(rawReason) : null
      setMessage(reason ? `Could not connect Google: ${reason}` : 'Could not connect Google. Try again.')
      setSearchParams({}, { replace: true })
    }
  }, [calendarParam, searchParams, setSearchParams])

  // -----------------------------------------------------------------
  // Canvas handlers
  // -----------------------------------------------------------------

  function handleCanvasConnected(domain: string) {
    setCanvasConnected(true)
    setCanvasDomain(domain)
    setShowCanvasForm(false)
    setMessage('Canvas connected. Rumbo will start ingesting on the next 6h cycle.')
  }

  async function handleCanvasDisconnect() {
    setBusy(true)
    setMessage(null)
    try {
      await disconnectCanvas()
      setCanvasConnected(false)
      setCanvasDomain(null)
      setMessage('Canvas disconnected.')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed to disconnect Canvas')
    } finally {
      setBusy(false)
    }
  }

  // -----------------------------------------------------------------
  // Google handlers
  // -----------------------------------------------------------------

  async function handleGoogleConnect() {
    setBusy(true)
    setMessage(null)
    try {
      await startGoogleCalendarConnect('/settings?calendar=connected')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed to start Google OAuth')
    } finally {
      setBusy(false)
    }
  }

  async function handleGoogleDisconnect() {
    setBusy(true)
    setMessage(null)
    try {
      await disconnectGoogleCalendar()
      setGoogleConnected(false)
      setMessage('Google disconnected.')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed to disconnect Google')
    } finally {
      setBusy(false)
    }
  }

  // -----------------------------------------------------------------
  // Manual courses
  // -----------------------------------------------------------------

  async function handleManualCreate(e: FormEvent) {
    e.preventDefault()
    if (!manualInput.name.trim() || !manualInput.institution.trim()) return
    setBusy(true)
    setMessage(null)
    try {
      const created = await createManualCourse({
        ...manualInput,
        name: manualInput.name.trim(),
        institution: manualInput.institution.trim(),
        course_code: manualInput.course_code?.trim() || undefined,
        instructor_name: manualInput.instructor_name?.trim() || undefined,
      })
      setManualCourses(prev => [created, ...prev])
      setManualInput(defaultManualInput())
      setShowManualForm(false)
      setMessage('Course added. Upload the syllabus or add a website URL from My courses.')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not add course')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Settings</h1>
      </div>

      <div className={styles.sections}>
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Sources</h2>
          <p className={styles.sectionDesc}>
            Rumbo pulls in your academic activity from connected sources. All ingestion runs on
            a 6-hour cycle.
          </p>

          {/* Canvas */}
          <div className={styles.sourceRow}>
            <div className={styles.sourceInfo}>
              <span className={styles.sourceName}>Canvas</span>
              <span className={styles.sourceStatus}>
                {loading
                  ? 'Checking…'
                  : canvasConnected
                  ? `Connected · ${canvasDomain ?? ''}`
                  : 'Not connected'}
              </span>
            </div>
            <div className={styles.sourceActions}>
              {canvasConnected ? (
                <button
                  type="button"
                  className={styles.buttonSecondary}
                  onClick={handleCanvasDisconnect}
                  disabled={busy}
                >
                  Disconnect
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.buttonPrimary}
                  onClick={() => setShowCanvasForm(true)}
                  disabled={busy}
                >
                  Connect
                </button>
              )}
            </div>
          </div>

          {/* Google */}
          <div className={styles.sourceRow}>
            <div className={styles.sourceInfo}>
              <span className={styles.sourceName}>Google (Calendar + Drive)</span>
              <span className={styles.sourceStatus}>
                {loading
                  ? 'Checking…'
                  : googleConnected && !googleScopesOk
                  ? 'Connected · Reconnect to grant updated permissions'
                  : googleConnected
                  ? 'Connected'
                  : 'Not connected'}
              </span>
            </div>
            <div className={styles.sourceActions}>
              {googleConnected && !googleScopesOk ? (
                <>
                  <button
                    type="button"
                    className={styles.buttonPrimary}
                    onClick={handleGoogleConnect}
                    disabled={busy}
                  >
                    Reconnect
                  </button>
                  <button
                    type="button"
                    className={styles.buttonSecondary}
                    onClick={handleGoogleDisconnect}
                    disabled={busy}
                  >
                    Disconnect
                  </button>
                </>
              ) : googleConnected ? (
                <button
                  type="button"
                  className={styles.buttonSecondary}
                  onClick={handleGoogleDisconnect}
                  disabled={busy}
                >
                  Disconnect
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.buttonPrimary}
                  onClick={handleGoogleConnect}
                  disabled={busy}
                >
                  Connect
                </button>
              )}
            </div>
          </div>

          {/* Manual courses */}
          <div className={styles.sourceRow}>
            <div className={styles.sourceInfo}>
              <span className={styles.sourceName}>Manual courses</span>
              <span className={styles.sourceStatus}>
                {loading
                  ? 'Checking…'
                  : manualCourses.length === 0
                  ? "For courses Canvas doesn't cover"
                  : `${manualCourses.length} course${manualCourses.length === 1 ? '' : 's'} added`}
              </span>
            </div>
            <div className={styles.sourceActions}>
              {manualCourses.length > 0 && (
                <a href="/courses" className={styles.buttonSecondary} style={{ textDecoration: 'none' }}>
                  Manage
                </a>
              )}
              <button
                type="button"
                className={styles.buttonPrimary}
                onClick={() => setShowManualForm(true)}
                disabled={busy}
              >
                Add course
              </button>
            </div>
          </div>

        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Appearance</h2>
          <p className={styles.sectionDesc}>
            Choose light, dark, or follow your device's system setting.
          </p>
          <div className={styles.themeRow} role="radiogroup" aria-label="Theme preference">
            {(['light', 'dark', 'system'] as ThemePreference[]).map(option => (
              <label key={option} className={[
                styles.themeOption,
                theme === option ? styles.themeOptionActive : '',
              ].filter(Boolean).join(' ')}>
                <input
                  type="radio"
                  name="theme"
                  value={option}
                  checked={theme === option}
                  onChange={() => setTheme(option)}
                  className={styles.themeRadio}
                />
                <span className={styles.themeSwatch} data-theme-preview={option} aria-hidden="true" />
                <span className={styles.themeLabel}>
                  {option === 'light' ? 'Light' : option === 'dark' ? 'Dark' : 'System'}
                </span>
              </label>
            ))}
          </div>
        </section>

      </div>

      {message && (
        <p className={styles.message} role="status" aria-live="polite">
          {message}
        </p>
      )}

      {/* Canvas connect modal */}
      <ConnectionModal
        open={showCanvasForm && !canvasConnected}
        onClose={() => setShowCanvasForm(false)}
        title="Connect Canvas"
        subtitle="Rumbo will pull in your courses, assignments, and syllabi. Read-only. Revoke anytime from Canvas."
      >
        <CanvasConnect
          onConnected={handleCanvasConnected}
          onCancel={() => setShowCanvasForm(false)}
        />
      </ConnectionModal>

      {/* Manual course modal */}
      <ConnectionModal
        open={showManualForm}
        onClose={() => { setShowManualForm(false); setManualInput(defaultManualInput()) }}
        title="Add a course"
        subtitle="For any class Canvas doesn't cover — community college, dual-enrollment, bootcamp, anything with its own syllabus or class website."
      >
        <form onSubmit={handleManualCreate} className={styles.modalForm}>
          <label className={styles.label} htmlFor="manual-course-name">Course name</label>
          <input
            id="manual-course-name"
            type="text"
            className={styles.input}
            placeholder="e.g. Introduction to Sociology"
            value={manualInput.name}
            onChange={e => setManualInput({ ...manualInput, name: e.target.value })}
            autoComplete="off"
            required
          />
          <label className={styles.label} htmlFor="manual-course-institution">Institution</label>
          <input
            id="manual-course-institution"
            type="text"
            className={styles.input}
            placeholder="e.g. San Diego Community College"
            value={manualInput.institution}
            onChange={e => setManualInput({ ...manualInput, institution: e.target.value })}
            autoComplete="off"
            required
          />
          <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
            <div style={{ flex: 1 }}>
              <label className={styles.label} htmlFor="manual-course-term">Term</label>
              <select
                id="manual-course-term"
                className={styles.input}
                value={manualInput.term.split(' ')[0]}
                onChange={e => setManualInput({ ...manualInput, term: `${e.target.value} ${manualInput.term.split(' ')[1] ?? currentAcademicYear()}` })}
              >
                {TERM_SEASONS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label className={styles.label} htmlFor="manual-course-year">Year</label>
              <input
                id="manual-course-year"
                type="number"
                className={styles.input}
                value={manualInput.term.split(' ')[1] ?? currentAcademicYear()}
                onChange={e => setManualInput({ ...manualInput, term: `${manualInput.term.split(' ')[0]} ${e.target.value}` })}
                min={2020}
                max={2035}
              />
            </div>
          </div>
          <label className={styles.label} htmlFor="manual-course-code">Course code (optional)</label>
          <input
            id="manual-course-code"
            type="text"
            className={styles.input}
            placeholder="e.g. SOC 101"
            value={manualInput.course_code ?? ''}
            onChange={e => setManualInput({ ...manualInput, course_code: e.target.value })}
            autoComplete="off"
          />
          <label className={styles.label} htmlFor="manual-course-instructor">Instructor (optional)</label>
          <input
            id="manual-course-instructor"
            type="text"
            className={styles.input}
            placeholder="e.g. Dr. Maria Lopez"
            value={manualInput.instructor_name ?? ''}
            onChange={e => setManualInput({ ...manualInput, instructor_name: e.target.value })}
            autoComplete="off"
          />
          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.buttonSecondary}
              onClick={() => { setShowManualForm(false); setManualInput(defaultManualInput()) }}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={styles.buttonPrimary}
              disabled={busy || !manualInput.name.trim() || !manualInput.institution.trim()}
            >
              {busy ? 'Adding…' : 'Save course'}
            </button>
          </div>
        </form>
      </ConnectionModal>
    </div>
  )
}
