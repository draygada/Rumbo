import { CoursesIcon } from '../../components/icons/Icons'
import styles from './Courses.module.css'

/*
 * Stub. Course spaces don't exist yet — this teaches what the section will
 * hold and previews the semantic course-color system (DESIGN.md §3). Wire to
 * real course data (Canvas connection) later.
 */
const PREVIEW = [
  { code: 'CS 107', name: 'Computer Organization & Systems', color: 'var(--teal)' },
  { code: 'ECON 105', name: 'Data & Development', color: 'var(--dblue)' },
  { code: 'MKTG 220', name: 'Marketing Management', color: 'var(--ochre)' },
  { code: 'EDUC 475', name: 'Entrepreneurship in Education', color: 'var(--sage)' },
]

export default function Courses() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Courses</h1>
        <p className={styles.subtitle}>
          Each course becomes a space Rumbo studies alongside you.
        </p>
      </header>

      <div className={styles.empty}>
        <span className={styles.emptyIcon}>
          <CoursesIcon size={26} />
        </span>
        <p className={styles.emptyTitle}>No courses connected yet</p>
        <p className={styles.emptyBody}>
          Connect Canvas and Rumbo will build a space for each class — its files,
          concepts, and deadlines, all one color.
        </p>
        <button type="button" className={styles.connect} disabled>
          Connect courses
          <span className={styles.soon}>soon</span>
        </button>
      </div>

      <p className={styles.previewLabel}>Preview</p>
      <ul className={styles.grid}>
        {PREVIEW.map(c => (
          <li key={c.code} className={styles.card}>
            <span className={styles.swatch} style={{ background: c.color }} />
            <span className={styles.code}>{c.code}</span>
            <span className={styles.name}>{c.name}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
