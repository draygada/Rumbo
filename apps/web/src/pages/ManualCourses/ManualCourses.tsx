import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { listManualCourses } from '../../lib/manualCourses'
import { supabase } from '../../lib/supabase'
import { isCanvasCourseCurrent, termLabelFor, courseShortLabel } from '../../lib/courseTerm'
import { PlusIcon, EditIcon } from '../../components/icons/Icons'
import CourseEditDialog from '../../components/CourseEditDialog/CourseEditDialog'
import { useCourseOverrides, resolveCourseColor, resolveCourseName } from '../../lib/courseOverrides'
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
  /** Heading this course files under in the archive, e.g. "Winter 2026". */
  termLabel: string
  /** Orders term groups newest-first; -Infinity for courses with no term. */
  termSortMs: number
}

// -----------------------------------------------------------------------------
// Data helpers
// -----------------------------------------------------------------------------

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
    const canvasTerm = termLabelFor(rawCode || null, term || null, rawName || null)
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
      termLabel: canvasTerm.label,
      termSortMs: canvasTerm.sortMs,
    })
  }

  // Manual courses.
  for (const c of manualCourses) {
    const courseId = `manual_course_${c.id}`
    const stats = openByCourse.get(courseId)
    const manualTerm = termLabelFor(c.course_code?.trim() || null, c.term?.trim() || null, c.name)
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
      termLabel: manualTerm.label,
      termSortMs: manualTerm.sortMs,
    })
  }

  return cards
}

// -----------------------------------------------------------------------------
// Card component
// -----------------------------------------------------------------------------

/**
 * Most-pressing first: soonest deadline wins, then the bigger pile of open
 * work, then alphabetical so the order is stable when nothing is outstanding.
 */
function sortByUrgency(a: CourseCard, b: CourseCard): number {
  const at = a.nextDue ? new Date(a.nextDue.timestamp).getTime() : Infinity
  const bt = b.nextDue ? new Date(b.nextDue.timestamp).getTime() : Infinity
  if (at !== bt) return at - bt
  if (a.openTasks !== b.openTasks) return b.openTasks - a.openTasks
  return sortByCode(a, b)
}

function CourseCardView({
  card,
  wide = false,
  archived = false,
  onEdit,
}: {
  card: CourseCard
  wide?: boolean
  archived?: boolean
  onEdit: (card: CourseCard, derivedName: string) => void
}) {
  const override = useCourseOverrides(s => s.byCourseId[card.courseId])
  // "Sp26-CS-146J-01 · Full-Stack Web" is a database key, not a course name.
  // The heading is the normalised code and the descriptive title drops to the
  // subtitle rather than being thrown away. Courses with no parseable code
  // (org shells like "SUMO Tutoring") fall back to their name, and the
  // subtitle is suppressed so it can't repeat the heading.
  const code = card.courseCode?.trim() || null
  const name = card.name.trim()
  const derivedName = courseShortLabel(code, name)
  const heading = resolveCourseName(derivedName, override)
  const subtitle = [
    name.toLowerCase() === heading.toLowerCase() ? null : name,
    card.institutionOrInstructor,
  ].filter(Boolean).join(' · ')

  return (
    <li
      className={[
        styles.card,
        wide ? styles.cardWide : '',
        archived ? styles.cardArchived : '',
      ].join(' ')}
      style={{ '--course-hue': resolveCourseColor(card.courseId, override) } as React.CSSProperties}
    >
      <div className={styles.cardHeader}>
        <div className={styles.cardMeta}>
          <span className={styles.cardHeading}>{heading}</span>
          {subtitle && <span className={styles.cardSubtitle}>{subtitle}</span>}
        </div>
        <div className={styles.cardActions}>
          <span className={card.source === 'canvas' ? styles.badgeCanvas : styles.badgeManual}>
            {card.source}
          </span>
          <button
            type="button"
            className={styles.editButton}
            onClick={() => onEdit(card, derivedName)}
            aria-label={`Edit ${heading}`}
            title="Edit name and colour"
          >
            <EditIcon size={15} />
          </button>
        </div>
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
  const [editing, setEditing] = useState<{ courseId: string; derivedName: string } | null>(null)

  const openEditor = (card: CourseCard, derivedName: string) =>
    setEditing({ courseId: card.courseId, derivedName })

  useEffect(() => {
    fetchCourseCards()
      .then(setCards)
      .catch(err => setMessage(err instanceof Error ? err.message : 'Failed to load courses'))
      .finally(() => setLoading(false))
  }, [])

  // Every course, always — this used to narrow to the active space's class.
  const scoped = cards
  // Urgency order, so the one tile that gets double width is genuinely the
  // one you should look at first.
  const currentCards = useMemo(
    () => scoped.filter(c => c.isCurrent).sort(sortByUrgency),
    [scoped],
  )
  const archiveCards = useMemo(
    () => scoped.filter(c => !c.isCurrent).sort(sortByCode),
    [scoped],
  )

  // Archive grouped into terms, newest first. Seventeen undifferentiated cards
  // is a pile; the same cards under "Winter 2026" / "Fall 2025" are a history.
  const archiveTerms = useMemo(() => {
    const byTerm = new Map<string, { label: string; sortMs: number; cards: CourseCard[] }>()
    for (const card of archiveCards) {
      const group = byTerm.get(card.termLabel)
      if (group) group.cards.push(card)
      else byTerm.set(card.termLabel, { label: card.termLabel, sortMs: card.termSortMs, cards: [card] })
    }
    return [...byTerm.values()].sort((a, b) => b.sortMs - a.sortMs)
  }, [archiveCards])

  const showList = tab === 'current' ? currentCards : archiveCards
  const showEmpty = !loading && scoped.length === 0

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>My courses</h1>
        <Link
          to="/settings?add=course"
          className={styles.addButton}
          aria-label="Add a course"
          title="Add a course"
        >
          <PlusIcon size={18} />
        </Link>
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
      ) : tab === 'current' ? (
        <ul className={styles.bento}>
          {currentCards.map((card, i) => (
            // Exactly one wide tile, and only when there's actually work in
            // it. Making every busy course wide collapsed the grid back into
            // full-width rows.
            <CourseCardView
              key={card.key}
              card={card}
              wide={i === 0 && card.openTasks > 0}
              onEdit={openEditor}
            />
          ))}
        </ul>
      ) : (
        <div className={styles.termGroups}>
          {archiveTerms.map(term => (
            <section key={term.label} className={styles.termGroup}>
              <h2 className={styles.termHeading}>
                {term.label}
                <span className={styles.termCount}>{term.cards.length}</span>
              </h2>
              <ul className={styles.bento}>
                {term.cards.map(card => (
                  <CourseCardView key={card.key} card={card} archived onEdit={openEditor} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {message && <p className={styles.message} role="status" aria-live="polite">{message}</p>}

      <CourseEditDialog
        open={editing !== null}
        courseId={editing?.courseId ?? ''}
        derivedName={editing?.derivedName ?? ''}
        onClose={() => setEditing(null)}
      />
    </div>
  )
}

function sortByCode(a: CourseCard, b: CourseCard): number {
  const ac = a.courseCode ?? a.name
  const bc = b.courseCode ?? b.name
  return ac.localeCompare(bc, undefined, { numeric: true })
}
