import { Task } from '../../types'
import ClassifierBadge from '../ClassifierBadge/ClassifierBadge'
import styles from './TaskCard.module.css'

interface Props {
  task: Task
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

export default function TaskCard({ task }: Props) {
  return (
    <div className={styles.card}>
      <div className={styles.top}>
        <span className={styles.title}>{task.title}</span>
        {task.work_type && <ClassifierBadge type={task.work_type} />}
      </div>
      <div className={styles.meta}>
        <span className={styles.metaItem}>Due {formatDue(task.due_date)}</span>
        <span className={styles.dot}>·</span>
        <span className={styles.metaItem}>{formatMins(task.estimated_mins)}</span>
      </div>
    </div>
  )
}
