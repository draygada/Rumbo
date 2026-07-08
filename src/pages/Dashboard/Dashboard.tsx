import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  useTasks,
  useDeleteTask,
  useWorkBlocksRealtime,
  getNextBlock,
  TaskWithBlocks,
} from '../../hooks/useTasks'
import { useAuth } from '../../hooks/useAuth'
import TaskCard from '../../components/TaskCard/TaskCard'
import TaskSkeleton from '../../components/TaskSkeleton/TaskSkeleton'
import ConfirmDialog from '../../components/ConfirmDialog/ConfirmDialog'
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

/** Group by next scheduled block date, or due date if not yet scheduled. */
function scheduleDateKey(task: TaskWithBlocks): string {
  const block = getNextBlock(task)
  if (block) return localDateKey(new Date(block.starts_at))
  return localDateKey(new Date(task.due_at))
}

function groupTasks(tasks: TaskWithBlocks[]) {
  const overdue: TaskWithBlocks[] = []
  const today: TaskWithBlocks[] = []
  const upcoming: TaskWithBlocks[] = []
  for (const task of tasks) {
    const key = scheduleDateKey(task)
    if (key < TODAY) {
      overdue.push(task)
    } else if (key === TODAY) {
      today.push(task)
    } else {
      upcoming.push(task)
    }
  }
  return { overdue, today, upcoming }
}

function renderTaskCard(
  task: TaskWithBlocks,
  onDeleteClick: (task: TaskWithBlocks) => void,
  deletingId: string | null,
  overdue?: boolean,
) {
  return (
    <TaskCard
      key={task.id}
      title={task.title}
      workType={task.work_type}
      dueDate={task.due_at}
      estimatedMins={task.estimated_mins}
      nextBlock={getNextBlock(task)}
      overdue={overdue}
      onDelete={() => onDeleteClick(task)}
      deleting={deletingId === task.id}
    />
  )
}

export default function Dashboard() {
  const { session } = useAuth()
  const { data: tasks, isLoading, isError } = useTasks()
  const deleteTask = useDeleteTask()
  useWorkBlocksRealtime(session?.user.id)

  const [taskToDelete, setTaskToDelete] = useState<TaskWithBlocks | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const { overdue, today, upcoming } = groupTasks(tasks ?? [])
  const isEmpty = !isLoading && (tasks ?? []).length === 0
  const deletingId = deleteTask.isPending
    ? (deleteTask.variables?.taskId ?? null)
    : null

  function handleDeleteClick(task: TaskWithBlocks) {
    setTaskToDelete(task)
  }

  function confirmDelete() {
    if (!taskToDelete || !session) return
    deleteTask.mutate(
      { taskId: taskToDelete.id },
      {
        onSuccess: () => setTaskToDelete(null),
        onError: err => {
          setTaskToDelete(null)
          setDeleteError(err instanceof Error ? err.message : 'Failed to delete task')
        },
      },
    )
  }

  return (
    <div className={styles.page}>
      <ConfirmDialog
        open={taskToDelete !== null}
        title="Delete task?"
        message={
          taskToDelete
            ? `"${taskToDelete.title}" will be removed permanently. This cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        confirmTone="danger"
        loading={deleteTask.isPending}
        onConfirm={confirmDelete}
        onCancel={() => setTaskToDelete(null)}
      />

      <ConfirmDialog
        open={deleteError !== null}
        title="Could not delete task"
        message={deleteError ?? ''}
        variant="alert"
        confirmLabel="OK"
        onConfirm={() => setDeleteError(null)}
        onCancel={() => setDeleteError(null)}
      />
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
            {today.map(task => renderTaskCard(task, handleDeleteClick, deletingId))}
          </div>
        </section>
      )}

      {!isLoading && upcoming.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Upcoming</h2>
          <div className={styles.list}>
            {upcoming.map(task => renderTaskCard(task, handleDeleteClick, deletingId))}
          </div>
        </section>
      )}

      {!isLoading && overdue.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Overdue</h2>
          <div className={styles.list}>
            {overdue.map(task => renderTaskCard(task, handleDeleteClick, deletingId, true))}
          </div>
        </section>
      )}
      </div>
    </div>
  )
}
