import { TaskType } from '../../types'
import styles from './TaskClassifierRow.module.css'

interface Props {
  workType: TaskType
  userOverrode: boolean
  onToggle: () => void
}

function SwitchIcon() {
  return (
    <svg
      className={styles.switchIcon}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3 4.5h7M8.5 2.5 10.5 4.5 8.5 6.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M11 9.5H4M5.5 7.5 3.5 9.5 5.5 11.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export default function TaskClassifierRow({ workType, userOverrode, onToggle }: Props) {
  return (
    <div className={styles.row} role="group" aria-label="Work type classification">
      <span
        className={[styles.badge, workType === 'deep' ? styles.deep : styles.shallow].join(' ')}
        title={userOverrode ? 'Manually set' : 'Auto-detected'}
      >
        {workType === 'deep' ? 'Deep' : 'Shallow'}
      </span>
      <button
        type="button"
        className={[styles.switchBtn, userOverrode ? styles.switchActive : ''].join(' ')}
        onClick={onToggle}
        aria-label={`Switch to ${workType === 'deep' ? 'shallow' : 'deep'} work`}
        title="Toggle work type"
      >
        <SwitchIcon />
      </button>
    </div>
  )
}
