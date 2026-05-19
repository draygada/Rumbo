import { TaskType } from '../../types'
import styles from './ClassifierBadge.module.css'

interface Props {
  type: TaskType
  onClick?: () => void
}

export default function ClassifierBadge({ type, onClick }: Props) {
  return (
    <span
      className={[styles.badge, type === 'deep' ? styles.deep : styles.shallow, onClick ? styles.clickable : ''].join(' ')}
      onClick={onClick}
      title={onClick ? 'Click to toggle' : undefined}
    >
      {type === 'deep' ? 'Deep' : 'Shallow'}
    </span>
  )
}
