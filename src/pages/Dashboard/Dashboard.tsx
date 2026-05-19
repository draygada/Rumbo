import { Link } from 'react-router-dom'
import { useTasks } from '../../hooks/useTasks'
import TaskCard from '../../components/TaskCard/TaskCard'
import { Task } from '../../types'
import styles from './Dashboard.module.css'

const TODAY = new Date().toISOString().slice(0, 10)

const TODAY_LABEL = new Date().toLocaleDateString('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
})

function groupTasks(tasks: Task[]) {
  const today: Task[] = []
  const upcoming: Task[] = []
  for (const task of tasks) {
    const taskDate = task.due_date.slice(0, 10)
    if (taskDate === TODAY) {
      today.push(task)
    } else if (taskDate > TODAY) {
      upcoming.push(task)
    }
  }
  return { today, upcoming }
}

export default function Dashboard() {
  const { data: tasks, isLoading, isError } = useTasks()

  const { today, upcoming } = groupTasks(tasks ?? [])
  const isEmpty = !isLoading && (tasks ?? []).length === 0

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Tasks</h1>
          <p className={styles.date}>{TODAY_LABEL}</p>
        </div>
        <Link to="/add-task" className={styles.addButton}>
          + Add Task
        </Link>
      </div>

      {isLoading && <p className={styles.status}>Loading tasks...</p>}
      {isError && <p className={styles.error}>Failed to load tasks.</p>}

      {isEmpty && (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No tasks yet</p>
          <p className={styles.emptySubtitle}>Add your first task to get started.</p>
        </div>
      )}

      {!isLoading && today.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Scheduled today</h2>
          <div className={styles.list}>
            {today.map(task => <TaskCard key={task.id} task={task} />)}
          </div>
        </section>
      )}

      {!isLoading && upcoming.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Upcoming</h2>
          <div className={styles.list}>
            {upcoming.map(task => <TaskCard key={task.id} task={task} />)}
          </div>
        </section>
      )}
    </div>
  )
}
