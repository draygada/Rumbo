import { Link } from 'react-router-dom'
import { useTasks } from '../../hooks/useTasks'
import TaskCard from '../../components/TaskCard/TaskCard'
import TaskSkeleton from '../../components/TaskSkeleton/TaskSkeleton'
import { Task } from '../../types'
import styles from './Dashboard.module.css'

const TODAY_LABEL = new Date().toLocaleDateString('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
})

function localDateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const TODAY = localDateKey(new Date())

function groupTasks(tasks: Task[]) {
  const overdue: Task[] = []
  const today: Task[] = []
  const upcoming: Task[] = []
  for (const task of tasks) {
    const taskDate = localDateKey(new Date(task.due_date))
    if (taskDate < TODAY) {
      overdue.push(task)
    } else if (taskDate === TODAY) {
      today.push(task)
    } else {
      upcoming.push(task)
    }
  }
  return { overdue, today, upcoming }
}

export default function Dashboard() {
  const { data: tasks, isLoading, isError } = useTasks()

  const { overdue, today, upcoming } = groupTasks(tasks ?? [])
  const isEmpty = !isLoading && (tasks ?? []).length === 0

  return (
    <div className={styles.page}>
      <header className={styles.toolbar}>
        <div className={styles.toolbarInner}>
          <div className={styles.heading}>
            <h1 className={styles.title}>Tasks</h1>
            <p className={styles.date}>{TODAY_LABEL}</p>
          </div>
          <Link to="/add-task" className={styles.addButton}>
            + Add Task
          </Link>
        </div>
      </header>

      <div className={styles.content}>
      {isLoading && (
        <div className={styles.list} aria-busy="true" aria-label="Loading tasks">
          <TaskSkeleton />
          <TaskSkeleton />
          <TaskSkeleton />
        </div>
      )}

      {isError && (
        <p className={styles.error} role="alert">
          Could not load tasks. Check your connection and try again.
        </p>
      )}

      {isEmpty && (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>Nothing scheduled yet</p>
          <p className={styles.emptySubtitle}>
            Add a task and Rumbo will place it on your calendar.
          </p>
          <Link to="/add-task" className={styles.emptyButton}>
            Add task
          </Link>
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

      {!isLoading && overdue.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Overdue</h2>
          <div className={styles.list}>
            {overdue.map(task => <TaskCard key={task.id} task={task} overdue />)}
          </div>
        </section>
      )}
      </div>
    </div>
  )
}
