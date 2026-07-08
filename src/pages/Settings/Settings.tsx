import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  disconnectGoogleCalendar,
  getGoogleCalendarConnected,
  startGoogleCalendarConnect,
} from '../../lib/calendar'
import { runCalendarSync, runScheduleGenerator } from '../../lib/scheduling'
import styles from './Settings.module.css'

export default function Settings() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const calendarParam = searchParams.get('calendar')

  useEffect(() => {
    getGoogleCalendarConnected()
      .then(setConnected)
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (calendarParam === 'connected') {
      setConnected(true)
      setMessage('Google Calendar connected.')
      setSearchParams({}, { replace: true })
    } else if (calendarParam === 'error') {
      const rawReason = searchParams.get('reason')
      const reason = rawReason ? decodeURIComponent(rawReason) : null
      setMessage(reason ? `Could not connect calendar: ${reason}` : 'Could not connect calendar. Try again.')
      setSearchParams({}, { replace: true })
    }
  }, [calendarParam, searchParams, setSearchParams])

  async function handleConnect() {
    setBusy(true)
    setMessage(null)
    try {
      await startGoogleCalendarConnect('/settings')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed to start OAuth')
    } finally {
      setBusy(false)
    }
  }

  async function handleSyncCalendar() {
    setBusy(true)
    setMessage(null)
    try {
      const result = await runCalendarSync()
      if (result.errors?.length) {
        setMessage(`Sync failed: ${result.errors[0]}`)
      } else if (result.synced && result.synced > 0) {
        setMessage(`Synced ${result.synced} block${result.synced === 1 ? '' : 's'} to Google Calendar.`)
      } else if (result.message) {
        setMessage(result.message)
      } else {
        setMessage('No new blocks to sync. Add a task first, or blocks may already be synced.')
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Calendar sync failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleReschedule() {
    setBusy(true)
    setMessage(null)
    try {
      await runScheduleGenerator()
      setMessage('Tasks rescheduled and synced to Google Calendar.')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Scheduling failed — check edge function logs')
    } finally {
      setBusy(false)
    }
  }

  async function handleDisconnect() {
    setBusy(true)
    setMessage(null)
    try {
      await disconnectGoogleCalendar()
      setConnected(false)
      setMessage('Calendar disconnected.')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed to disconnect')
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
          <h2 className={styles.sectionTitle}>Work hours</h2>
          <p className={styles.sectionDesc}>
            Rumbo never schedules blocks outside this window. Set during onboarding — editing coming soon.
          </p>
          <div className={styles.stub}>Editable in a future update</div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Calendar</h2>
          <p className={styles.sectionDesc}>
            Connect your calendar so Rumbo can schedule around existing events and push study blocks to Google Calendar.
          </p>
          {loading ? (
            <div className={styles.stub}>Checking connection…</div>
          ) : connected ? (
            <div className={styles.calendarRow}>
              <span className={styles.connectedBadge}>Google Calendar connected</span>
              <button
                type="button"
                className={styles.buttonSecondary}
                onClick={handleReschedule}
                disabled={busy}
              >
                Reschedule tasks
              </button>
              <button
                type="button"
                className={styles.buttonSecondary}
                onClick={handleSyncCalendar}
                disabled={busy}
              >
                Sync now
              </button>
              <button
                type="button"
                className={styles.buttonSecondary}
                onClick={handleDisconnect}
                disabled={busy}
              >
                Disconnect
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={styles.buttonPrimary}
              onClick={handleConnect}
              disabled={busy}
            >
              Connect Google Calendar
            </button>
          )}
          <p className={styles.comingSoonNote}>Microsoft Outlook — coming soon</p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Peak hours</h2>
          <p className={styles.sectionDesc}>
            Your preferred working style. Rumbo refines this automatically over time.
          </p>
          <div className={styles.stub}>Editable in a future update</div>
        </section>
      </div>

      {message && <p className={styles.message}>{message}</p>}
    </div>
  )
}
