/*
 * Is a Canvas course still running?
 *
 * Extracted from ManualCourses.tsx so the same test decides three things that
 * must agree: which courses show under "Current", which courses get a space,
 * and which ones the scope picker offers. Canvas leaves workflow_state and
 * enrollment state stale on plenty of shells, so the term is the signal we
 * trust first and the per-course dates are the fallback.
 */

// Parse a Stanford-style term prefix from course_code — F24, W25, Sp26, Su26.
// Returns the approximate term end date, or null if the code doesn't match.
export function parseTermPrefix(code: string): { endMs: number; year: number; season: string } | null {
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
// embedded in a course name or code, common for admin shells with no real
// Canvas term. Returns the end year (Aug 31) as ms.
export function parseAcademicYearRange(text: string): number | null {
  const m = text.match(/(20\d{2}|\b\d{2})[\s\-\/](20\d{2}|\d{2})\b/)
  if (!m) return null
  const raw = m[2]
  const endYear = raw.length === 2 ? 2000 + parseInt(raw, 10) : parseInt(raw, 10)
  if (endYear < 2000 || endYear > 2100) return null
  return new Date(endYear, 7, 31).getTime()
}

/**
 * When this course's term ends, in ms, or null if Canvas gave us nothing
 * usable. Same precedence as isCanvasCourseCurrent — code prefix, then the
 * Canvas term object, then a year range in the name.
 */
export function courseTermEnd(payload: Record<string, unknown>): number | null {
  const code = typeof payload.course_code === 'string' ? payload.course_code : ''
  const name = typeof payload.name === 'string' ? payload.name : ''

  const prefix = parseTermPrefix(code)
  if (prefix) return prefix.endMs

  const term = (payload.term as Record<string, unknown> | undefined) ?? {}
  if (typeof term.end_at === 'string') {
    const end = new Date(term.end_at).getTime()
    if (!Number.isNaN(end)) return end
  }

  return parseAcademicYearRange(name) ?? parseAcademicYearRange(code)
}

/** A term ending further out than this isn't a term — it's a placeholder. */
const FAR_FUTURE_MS = 400 * 24 * 60 * 60 * 1000

/**
 * Administrative shells — tutoring orgs, department pages, standing committees
 * — rather than classes the student takes.
 *
 * Two tells, both present in real data: no resolvable term at all, or a term
 * whose end_at is parked far in the future (Canvas hands these out as
 * 2099-12-31). The second matters because such a course looks permanently "in
 * session", so without this check the only spaces that ever appeared were the
 * shells, while every real class was filtered out.
 */
export function isAdminShell(payload: Record<string, unknown>): boolean {
  const end = courseTermEnd(payload)
  if (end === null) return true
  return end > Date.now() + FAR_FUTURE_MS
}

// The term is the single most reliable signal: if the term has ended, the
// course is archived. Everything else is a fallback for shells with no term.
export function isCanvasCourseCurrent(payload: Record<string, unknown>): boolean {
  const now = Date.now()
  const code = typeof payload.course_code === 'string' ? payload.course_code : ''
  const name = typeof payload.name === 'string' ? payload.name : ''

  // 1. Stanford-style term prefix in course_code — canonical here.
  const prefix = parseTermPrefix(code)
  if (prefix) return prefix.endMs >= now

  // 2. Canvas term object (?include=term) with a real end_at. Admin shells come
  //    back as "Default Term" with a null end_at and fall through to (3).
  const term = (payload.term as Record<string, unknown> | undefined) ?? {}
  const termName = (typeof term.name === 'string' ? term.name : '').toLowerCase()
  if (typeof term.end_at === 'string') {
    const termEnd = new Date(term.end_at).getTime()
    if (!Number.isNaN(termEnd)) return termEnd >= now
  }

  // 3. Embedded academic-year range in the name or code.
  const yearEnd = parseAcademicYearRange(name) ?? parseAcademicYearRange(code)
  if (yearEnd !== null) return yearEnd >= now

  // 4. Per-course dates + explicit states.
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

  // 5. Canvas gave us essentially nothing — an admin shell. Archive it.
  if (termName === 'default term' || termName === '') return false

  return true
}
