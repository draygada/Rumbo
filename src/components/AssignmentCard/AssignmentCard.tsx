import styles from './AssignmentCard.module.css'

interface Props {
  name: string
  courseName: string
  dueAt: string | null
  points?: number | null
  sourceBadge: string
  stale?: boolean
}

function formatDue(iso: string | null): string {
  if (!iso) return 'No due date'
  const date = new Date(iso)
  const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return `Due ${dateStr} at ${timeStr}`
}

export default function AssignmentCard({ name, courseName, dueAt, points, sourceBadge, stale = false }: Props) {
  return (
    <div className={stale ? `${styles.card} ${styles.cardStale}` : styles.card}>
      <div className={styles.top}>
        <span className={styles.title} title={name}>{name}</span>
        <span className={styles.sourceBadge}>{sourceBadge}</span>
      </div>
      <div className={styles.meta}>
        <span className={styles.metaItem}>{courseName}</span>
        <span className={styles.dot}>·</span>
        <span className={styles.metaItem}>{formatDue(dueAt)}</span>
        {points != null && (
          <>
            <span className={styles.dot}>·</span>
            <span className={styles.metaItem}>{points} pts</span>
          </>
        )}
      </div>
    </div>
  )
}
