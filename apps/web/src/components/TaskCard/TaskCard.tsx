import { WorkBlock } from '../../types'
import ClassifierBadge from '../ClassifierBadge/ClassifierBadge'
import styles from './TaskCard.module.css'

interface Props {
  title: string
  workType: 'deep' | 'shallow' | null
  dueDate: string
  estimatedMins: number
  nextBlock?: WorkBlock | null
  overdue?: boolean
  onDelete?: () => void
  deleting?: boolean
}

function formatMins(mins: number): string {
  if (mins < 60) return `${mins} min`
  if (mins === 60) return '1 hr'
  if (mins % 60 === 0) return `${mins / 60} hrs`
  return `${mins / 60} hrs`
}

function formatDue(isoDate: string): string {
  const date = new Date(isoDate)
  const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return `${dateStr} at ${timeStr}`
}

function formatBlockTime(isoDate: string): string {
  const date = new Date(isoDate)
  return date.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export default function TaskCard({
  title,
  workType,
  dueDate,
  estimatedMins,
  nextBlock = null,
  overdue = false,
  onDelete,
  deleting = false,
}: Props) {
  return (
    <div className={overdue ? `${styles.card} ${styles.cardOverdue}` : styles.card}>
      <div className={styles.top}>
        <span className={styles.title}>{title}</span>
        <div className={styles.topActions}>
          {workType && <ClassifierBadge type={workType} />}
          {onDelete && (
            <button
              type="button"
              className={styles.deleteButton}
              onClick={onDelete}
              disabled={deleting}
              aria-label={`Delete ${title}`}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          )}
        </div>
      </div>
      <div className={styles.meta}>
        {nextBlock ? (
          <span className={styles.scheduled}>
            Scheduled {formatBlockTime(nextBlock.starts_at)}
          </span>
        ) : (
          <span className={styles.metaItem}>Due {formatDue(dueDate)}</span>
        )}
        <span className={styles.dot}>·</span>
        <span className={styles.metaItem}>{formatMins(estimatedMins)}</span>
      </div>
    </div>
  )
}
