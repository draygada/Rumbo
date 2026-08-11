import { useMemo, useState } from 'react'
import { useActiveSpace } from '../../spaces/useSpaces'
import {
  useUpcomingAssignments,
  useStillOpenAssignments,
  useRecentlyAdded,
  useTodaysCalendar,
  useHasConnectedSources,
  useCanvasSyncState,
  useCourses,
  groupByCourse,
  courseNameFromEvent,
  assignmentNameFromEvent,
  pointsFromEvent,
  sourceBadge,
  type CourseInfo,
  type NormalizedEvent,
} from '../../hooks/useNormalizedEvents'
import AssignmentCard from '../../components/AssignmentCard/AssignmentCard'
import TaskSkeleton from '../../components/TaskSkeleton/TaskSkeleton'
import styles from './Dashboard.module.css'

const TODAY_LABEL = new Date().toLocaleDateString('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
})

function renderCard(event: NormalizedEvent, courses: Map<string, CourseInfo> | undefined, stale = false) {
  return (
    <AssignmentCard
      key={event.id}
      name={assignmentNameFromEvent(event)}
      courseName={courseNameFromEvent(event, courses)}
      dueAt={event.timestamp}
      points={pointsFromEvent(event)}
      sourceBadge={sourceBadge(event.source_type)}
      stale={stale}
    />
  )
}

function formatCalendarTime(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

/** Restrict a list of events to the active space's class. */
function scopeEvents(events: NormalizedEvent[] | undefined, courseId: string | null): NormalizedEvent[] {
  const all = events ?? []
  return courseId ? all.filter(e => e.course_id === courseId) : all
}

export default function Dashboard() {
  const space = useActiveSpace()
  const upcoming = useUpcomingAssignments()
  const coursesQuery = useCourses()
  const courses = coursesQuery.data
  const stillOpen = useStillOpenAssignments()
  const recentlyAdded = useRecentlyAdded()
  const todaysCalendar = useTodaysCalendar()
  const sources = useHasConnectedSources()
  const canvasSync = useCanvasSyncState()

  const [stillOpenExpanded, setStillOpenExpanded] = useState(false)

  // Everything on this page is scoped to the space you're in. In a class space
  // the calendar list scopes to empty (calendar events carry no course_id) and
  // its section drops out, which is right — "Today" is a cross-class view.
  const scope = space.courseId
  const upcomingList = useMemo(() => scopeEvents(upcoming.data, scope), [upcoming.data, scope])
  const stillOpenList = useMemo(() => scopeEvents(stillOpen.data, scope), [stillOpen.data, scope])
  const recentList = useMemo(() => scopeEvents(recentlyAdded.data, scope), [recentlyAdded.data, scope])
  const calendarList = useMemo(() => scopeEvents(todaysCalendar.data, scope), [todaysCalendar.data, scope])

  const isLoading =
    upcoming.isLoading || stillOpen.isLoading || recentlyAdded.isLoading || todaysCalendar.isLoading || sources.isLoading
  const isError = upcoming.isError || stillOpen.isError || recentlyAdded.isError || todaysCalendar.isError

  const upcomingCount = upcomingList.length
  const stillOpenCount = stillOpenList.length
  const recentCount = recentList.length
  const calendarCount = calendarList.length

  const hasAnyEvents = upcomingCount + stillOpenCount + recentCount + calendarCount > 0
  const hasSources = sources.data?.any ?? false
  const canvasTokenExpired = canvasSync.data?.token_status === 'expired'
  const canvasPending = sources.data?.canvas && !canvasSync.data?.last_polled_at

  const showNoSources = !isLoading && !hasSources && !hasAnyEvents
  const showIngestionPending = !isLoading && hasSources && !hasAnyEvents && canvasPending
  const showCaughtUp = !isLoading && hasSources && !hasAnyEvents && !canvasPending

  const grouped = groupByCourse(upcomingList)

  return (
    <div className={styles.page}>
      <header className={styles.toolbar}>
        <div className={styles.toolbarInner}>
          <div className={styles.heading}>
            <h1 className={styles.title}>This week</h1>
            <p className={styles.date}>{TODAY_LABEL}</p>
          </div>
        </div>
      </header>

      <div className={styles.content}>
        {isLoading && (
          <div className={styles.list} aria-busy="true" aria-label="Loading">
            <TaskSkeleton />
            <TaskSkeleton />
            <TaskSkeleton />
          </div>
        )}

        {isError && (
          <p className={styles.error} role="alert">
            Could not load your data. Check your connection and try again.
          </p>
        )}

        {canvasTokenExpired && (
          <div className={styles.alert} role="alert">
            Your Canvas connection needs to be refreshed. Reconnect in Settings.
          </div>
        )}

        {showNoSources && (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>Connect a source to get started</p>
            <p className={styles.emptySubtitle}>
              Head to Settings to connect Canvas or Google. Rumbo will start pulling in
              your courses — it can take a few minutes after connecting.
            </p>
          </div>
        )}

        {showIngestionPending && (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>We're pulling in your courses</p>
            <p className={styles.emptySubtitle}>
              This usually takes a few minutes — check back shortly.
            </p>
          </div>
        )}

        {showCaughtUp && (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>You're all caught up</p>
            <p className={styles.emptySubtitle}>
              Nothing due in the next 14 days.
            </p>
          </div>
        )}

        {!isLoading && recentCount > 0 && (
          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Recently added</h2>
            <div className={styles.list}>
              {recentList.map(event => renderCard(event, courses))}
            </div>
          </section>
        )}

        {!isLoading && calendarCount > 0 && (
          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Today</h2>
            <div className={styles.list}>
              {calendarList.map(event => {
                const payload = event.raw_payload as Record<string, unknown>
                const title = (typeof payload.summary === 'string' && payload.summary)
                  || (typeof payload.title === 'string' && payload.title)
                  || 'Calendar event'
                return (
                  <div key={event.id} className={styles.calendarItem}>
                    <span className={styles.calendarTime}>{formatCalendarTime(event.timestamp)}</span>
                    <span className={styles.calendarTitle}>{title}</span>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {!isLoading && upcomingCount > 0 && (
          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Upcoming</h2>
            {Array.from(grouped.entries()).map(([courseKey, events]) => {
              const items = events as NormalizedEvent[]
              return (
                <div key={courseKey} className={styles.courseGroup}>
                  <h3 className={styles.courseTitle}>{courseNameFromEvent(items[0], courses)}</h3>
                  <div className={styles.list}>
                    {items.map(event => renderCard(event, courses))}
                  </div>
                </div>
              )
            })}
          </section>
        )}

        {!isLoading && stillOpenCount > 0 && (
          <section className={styles.section}>
            <button
              type="button"
              className={styles.stillOpenToggle}
              onClick={() => setStillOpenExpanded(v => !v)}
              aria-expanded={stillOpenExpanded}
            >
              <span className={styles.sectionTitle}>Still open ({stillOpenCount})</span>
              <span className={styles.stillOpenChevron}>{stillOpenExpanded ? '−' : '+'}</span>
            </button>
            {stillOpenExpanded && (
              <div className={styles.list}>
                {stillOpenList.map(event => renderCard(event, courses, true))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
