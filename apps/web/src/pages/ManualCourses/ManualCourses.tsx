import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { listManualCourses } from '../../lib/manualCourses'
import { supabase } from '../../lib/supabase'
import styles from './ManualCourses.module.css'

// A single unified course card, whether the underlying record came from
// Canvas ingest or was added manually. Fields are chosen for scannability.
interface CourseCard {
  key: string                        // stable id used for react keys and dedup
  source: 'canvas' | 'manual'
  courseId: string                   // course_id used to look up assignments
  name: string
  courseCode: string | null
  term: string | null
  institutionOrInstructor: string | null
  openTasks: number
  nextDue: { name: string; timestamp: string } | null
  isCurrent: boolean
}

// -----------------------------------------------------------------------------
// Data helpers
// -----------------------------------------------------------------------------

// Parse Stanford-style term prefix from course_code — F24, W25, Sp26, Su26.
// Returns the approximate term end date (year, month=season-end, day=15) or
// null if the code doesn't match. Conservative on year rollover.
function parseTermPrefix(code: string): { endMs: number; year: number; season: string } | null {
  const m = code.match(/^(F|W|Sp|Su)(\d{2})/i)
  if (!m) return null
  const season = m[1].toLowerCase()
  const year = 2000 + parseInt(m[2], 10)
  let endMonthZeroBased: number
  let endDay = 15
  switch (season) {
    case 'f':  endMonthZeroBased = 11; endDay = 20; break  // Fall ~ Dec 20
    case 'w':  endMonthZeroBased = 2;  endDay = 20; break  // Winter ~ Mar 20
    case 'sp': endMonthZeroBased = 5;  endDay = 20; break  // Spring ~ Jun 20
    case 'su': endMonthZeroBased = 7;  endDay = 30; break  // Summer ~ Aug 30
    default: return null
  }
  return { season, year, endMs: new Date(year, endMonthZeroBased, endDay).getTime() }
}

// Detect "2024-25", "2024-2025", "2024/25", "24-25" — an academic-year range
// embedded in a course name or code, common for admin shells that don't have
// a real Canvas term. Returns the end year (Aug of that year) as ms.
function parseAcademicYearRange(text: string): number | null {
  const m = text.match(/(20\d{2}|\b\d{2})[\s\-\/](20\d{2}|\d{2})\b/)
  if (!m) return null
  const raw = m[2]
  const endYear = raw.length === 2 ? 2000 + parseInt(raw, 10) : parseInt(raw, 10)
  if (endYear < 2000 || endYear > 2100) return null
  // Academic year ends August 31 of the second year.
  return new Date(endYear, 7, 31).getTime()
}

// The term is the single most reliable signal: if the term has ended, the
// course belongs in the archive. Everything else (workflow_state, enrollment
// state, course.end_at) is used as a fallback when no term info is present,
// because Canvas leaves many of those fields stale.
function isCanvasCourseCurrent(payload: Record<string, unknown>): boolean {
  const now = Date.now()
  const code = typeof payload.course_code === 'string' ? payload.course_code : ''
  const name = typeof payload.name === 'string' ? payload.name : ''

  // 1. Stanford-style term prefix in course_code — canonical for Stanford
  //    (F24-CS-107, Sp26-CS-146J, Su26-…).
  const prefix = parseTermPrefix(code)
  if (prefix) return prefix.endMs >= now

  // 2. Canvas term object (?include=term) with a real end_at. Canvas returns
  //    "Default Term" for admin shells and its end_at is usually null, so
  //    that case falls through to the year-range heuristic below.
  const term = (payload.term as Record<string, unknown> | undefined) ?? {}
  const termName = (typeof term.name === 'string' ? term.name : '').toLowerCase()
  if (typeof term.end_at === 'string') {
    const termEnd = new Date(term.end_at).getTime()
    if (!Number.isNaN(termEnd)) return termEnd >= now
  }

  // 3. Embedded academic-year range in the course name or code — catches admin
  //    shells like "…2024-2025" and "…2025-26" that don't have a proper term.
  const yearEnd = parseAcademicYearRange(name) ?? parseAcademicYearRange(code)
  if (yearEnd !== null) return yearEnd >= now

  // 4. Fall back to per-course dates + explicit states.
  const state = (typeof payload.workflow_state === 'string' ? payload.workflow_state : '').toLowerCase()
  if (state === 'completed' || state === 'deleted' || state === 'unpublished') return false

  const enrollments = Array.isArray(payload.enrollments) ? payload.enrollments as Array<Record<string, unknown>> : []
  if (enrollments.length > 0 && enrollments.every(e => e.enrollment_state === 'completed')) return false

  if (typeof payload.end_at === 'string') {
    const endAt = new Date(payload.end_at).getTime()
    if (!Number.isNaN(endAt) && endAt < now) return false
  }
  if (typeof payload.start_at === 'string') {
    const startAt = new Date(payload.start_at).getTime()
    if (!Number.isNaN(startAt) && startAt > now + 60 * 24 * 60 * 60 * 1000) return false
  }

  // 5. Final safety net: if Canvas gave us essentially nothing (Default Term,
  //    no dates, no year in the name), archive it. These are admin shells —
  //    they should stay out of the current view, and if a real course somehow
  //    landed here without term info, the user can find it in Archive.
  if (termName === 'default term' || termName === '') return false

  return true
}

// Human-friendly relative time — "in 2 days", "tomorrow", "today", "next week".
function relativeDue(iso: string): string {
  const target = new Date(iso).getTime()
  const now = Date.now()
  const diffMs = target - now
  const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000))
  if (diffMs < 0) return 'overdue'
  if (diffDays === 0) return 'today'
  if (diffDays === 1) return 'tomorrow'
  if (diffDays < 7) return `in ${diffDays} days`
  if (diffDays < 14) return 'next week'
  if (diffDays < 30) return `in ${Math.round(diffDays / 7)} weeks`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

async function fetchCourseCards(): Promise<CourseCard[]> {
  const [canvasCourses, manualCourses, assignments] = await Promise.all([
    supabase
      .from('normalized_events')
      .select('external_id, raw_payload')
      .eq('source_type', 'canvas_course')
      .is('cancelled_at', null),
    listManualCourses(),
    supabase
      .from('normalized_events')
      .select('course_id, timestamp, raw_payload, source_type')
      .in('source_type', ['canvas_assignment', 'manual_assignment'])
      .eq('classification', 'academic')
      .is('cancelled_at', null)
      .gte('timestamp', new Date().toISOString())
      .order('timestamp', { ascending: true }),
  ])

  // Bucket assignments by course_id for O(1) lookup per course.
  const openByCourse = new Map<string, { count: number; next: { name: string; timestamp: string } }>()
  for (const a of assignments.data ?? []) {
    const cid = a.course_id
    if (!cid || !a.timestamp) continue
    const payload = (a.raw_payload ?? {}) as Record<string, unknown>
    const name = typeof payload.name === 'string' && payload.name
      ? payload.name
      : typeof payload.title === 'string' && payload.title
      ? payload.title
      : 'Assignment'
    const existing = openByCourse.get(cid)
    if (!existing) {
      openByCourse.set(cid, { count: 1, next: { name, timestamp: a.timestamp } })
    } else {
      existing.count += 1
      // Timestamps are ascending, so `existing.next` is already the earliest.
    }
  }

  const cards: CourseCard[] = []

  // Canvas courses.
  for (const row of canvasCourses.data ?? []) {
    const payload = (row.raw_payload ?? {}) as Record<string, unknown>
    const state = typeof payload.workflow_state === 'string' ? payload.workflow_state : ''
    if (state === 'deleted' || state === 'unpublished') continue
    const rawName = typeof payload.name === 'string' ? payload.name.trim() : ''
    const rawCode = typeof payload.course_code === 'string' ? payload.course_code.trim() : ''
    const term = (payload.term as { name?: string } | undefined)?.name?.trim() ?? ''
    if (!rawName && !rawCode && !term) continue

    const courseId = row.external_id as string
    const stats = openByCourse.get(courseId)
    cards.push({
      key: `canvas:${courseId}`,
      source: 'canvas',
      courseId,
      name: rawName || rawCode || term || 'Untitled course',
      courseCode: rawCode || null,
      term: term || null,
      institutionOrInstructor: null,
      openTasks: stats?.count ?? 0,
      nextDue: stats?.next ?? null,
      isCurrent: isCanvasCourseCurrent(payload),
    })
  }

  // Manual courses.
  for (const c of manualCourses) {
    const courseId = `manual_course_${c.id}`
    const stats = openByCourse.get(courseId)
    cards.push({
      key: `manual:${c.id}`,
      source: 'manual',
      courseId,
      name: c.name,
      courseCode: c.course_code?.trim() || null,
      term: c.term?.trim() || null,
      institutionOrInstructor: c.instructor_name?.trim() || c.institution?.trim() || null,
      openTasks: stats?.count ?? 0,
      nextDue: stats?.next ?? null,
      isCurrent: true,  // Manual courses default to current unless archived_at is set — listManualCourses already filtered those out.
    })
  }

  return cards
}

// -----------------------------------------------------------------------------
// Card component
// -----------------------------------------------------------------------------

function CourseCardView({ card }: { card: CourseCard }) {
  // Avoid "SUMO Tutoring · SUMO Tutoring" — some Canvas orgs set course_code
  // and name to the same string.
  const code = card.courseCode?.trim() ?? ''
  const name = card.name.trim()
  const heading = code && code.toLowerCase() !== name.toLowerCase()
    ? `${code} · ${name}`
    : name
  const subtitle = [card.term, card.institutionOrInstructor].filter(Boolean).join(' · ')

  return (
    <li className={styles.card}>
      <div className={styles.cardHeader}>
        <div className={styles.cardMeta}>
          <span className={styles.cardHeading}>{heading}</span>
          {subtitle && <span className={styles.cardSubtitle}>{subtitle}</span>}
        </div>
        <span className={card.source === 'canvas' ? styles.badgeCanvas : styles.badgeManual}>
          {card.source}
        </span>
      </div>
      <div className={styles.cardFooter}>
        <span className={styles.taskCount}>
          {card.openTasks === 0
            ? <span className={styles.allCaughtUp}>All caught up</span>
            : (card.openTasks > 9
              ? '9+ open tasks'
              : `${card.openTasks} open task${card.openTasks === 1 ? '' : 's'}`)}
        </span>
        {card.nextDue && (
          <span className={styles.nextDue}>
            Next due: <span className={styles.nextDueName}>{card.nextDue.name}</span> {relativeDue(card.nextDue.timestamp)}
          </span>
        )}
      </div>
    </li>
  )
}

// -----------------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------------

export default function ManualCourses() {
  const [cards, setCards] = useState<CourseCard[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<string | null>(null)
  const [tab, setTab] = useState<'current' | 'archive'>('current')

  useEffect(() => {
    fetchCourseCards()
      .then(setCards)
      .catch(err => setMessage(err instanceof Error ? err.message : 'Failed to load courses'))
      .finally(() => setLoading(false))
  }, [])

  const currentCards = useMemo(
    () => cards.filter(c => c.isCurrent).sort(sortByCode),
    [cards],
  )
  const archiveCards = useMemo(
    () => cards.filter(c => !c.isCurrent).sort(sortByCode),
    [cards],
  )

  const showList = tab === 'current' ? currentCards : archiveCards
  const showEmpty = !loading && cards.length === 0

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>My courses</h1>
        </div>
      </header>

      {archiveCards.length > 0 && (
        <div role="tablist" aria-label="Course filter" className={styles.tabs}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'current'}
            className={[styles.tab, tab === 'current' ? styles.tabActive : ''].join(' ')}
            onClick={() => setTab('current')}
          >
            Current
            <span className={styles.tabCount}>{currentCards.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'archive'}
            className={[styles.tab, tab === 'archive' ? styles.tabActive : ''].join(' ')}
            onClick={() => setTab('archive')}
          >
            Archive
            <span className={styles.tabCount}>{archiveCards.length}</span>
          </button>
        </div>
      )}

      {loading ? (
        <div className={styles.list} aria-busy="true" aria-label="Loading courses">
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
        </div>
      ) : showEmpty ? (
        <div className={styles.empty}>
          <h2 className={styles.emptyTitle}>No courses connected</h2>
          <p className={styles.emptyAction}>
            <Link to="/settings?add=course" className={styles.emptyActionLink}>
              Add a course in Settings →
            </Link>
          </p>
        </div>
      ) : showList.length === 0 ? (
        <div className={styles.empty}>
          <h2 className={styles.emptyTitle}>
            {tab === 'current' ? 'No current courses' : 'Nothing archived'}
          </h2>
        </div>
      ) : (
        <ul className={styles.list}>
          {showList.map(card => <CourseCardView key={card.key} card={card} />)}
        </ul>
      )}

      {tab === 'current' && !loading && cards.length > 0 && (
        <p className={styles.subtleAdd}>
          <Link to="/settings?add=course" className={styles.emptyActionLink}>
            + Add another course
          </Link>
        </p>
      )}

      {message && <p className={styles.message} role="status" aria-live="polite">{message}</p>}
    </div>
  )
}

function sortByCode(a: CourseCard, b: CourseCard): number {
  const ac = a.courseCode ?? a.name
  const bc = b.courseCode ?? b.name
  return ac.localeCompare(bc, undefined, { numeric: true })
}
