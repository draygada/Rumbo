import styles from './TaskSkeleton.module.css'

export default function TaskSkeleton() {
  return (
    <div className={styles.card} aria-hidden="true">
      <div className={styles.row}>
        <span className={styles.title} />
        <span className={styles.badge} />
      </div>
      <span className={styles.meta} />
    </div>
  )
}
