import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CalendarDays,
  ListTodo,
  Settings,
  Plus,
  Lock,
  Calendar,
  CheckCircle2,
  Clock,
  XCircle,
} from 'lucide-react'
import rumboLogo from '@/assets/rumbo-logo.png'
import { useAuthStore } from '@/store/authStore'
import { classifyTaskTitle } from '@/lib/classifier'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import {
  fetchTasks,
  insertTask,
  fetchTodayBlocks,
  updateWorkBlockStatus,
  fetchCalendarConnections,
  TASKS_QUERY_KEY,
  WORK_BLOCKS_QUERY_KEY,
  CALENDAR_CONNECTIONS_QUERY_KEY,
  type InsertTaskPayload,
  type WorkBlock,
  type WorkBlockStatus,
} from '@/lib/queries'
import type { ClassifierResult, Task, WorkType } from '@/types'
import { CalendarDueDateTime, type DueDateTimeValue } from '@/components/ui/calendar-date-and-time-range'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { ReflectionModal } from '@/components/ReflectionModal'

type View = 'today' | 'tasks' | 'settings'
type EstimatedTimeMode = 'preset' | 'custom'

const FREE_TIER_TASK_LIMIT = 5
const REFLECTION_SKIP_KEY = 'rumbo:reflection_skips'
const REFLECTION_NUDGE_KEY = 'rumbo:nudge_dismissed'
const CALENDAR_BANNER_KEY = 'rumbo:calendar_banner_dismissed'

function badgeColor(workType: WorkType | 'deep' | 'shallow' | null) {
  if (!workType) return '#D1D5DB'
  return workType === 'deep' ? 'var(--rumbo-block-deep)' : 'var(--rumbo-block-shallow)'
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function formatDueDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function formatEstimatedMins(mins: number): string {
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export function Dashboard() {
  const user = useAuthStore((s) => s.user)
  const signOut = useAuthStore((s) => s.signOut)
  const [view, setView] = useState<View>('today')
  const [showAddTask, setShowAddTask] = useState(false)

  // Reflection state
  const [reflectionBlock, setReflectionBlock] = useState<WorkBlock | null>(null)
  const skipCountRef = useRef(
    parseInt(localStorage.getItem(REFLECTION_SKIP_KEY) ?? '0', 10),
  )
  const [showNudge, setShowNudge] = useState(
    skipCountRef.current >= 3 && !localStorage.getItem(REFLECTION_NUDGE_KEY),
  )

  const queryClient = useQueryClient()

  // ── Queries ────────────────────────────────────────────────────────────────

  const { data: tasks = [], isLoading: tasksLoading, error: tasksError } = useQuery({
    queryKey: TASKS_QUERY_KEY,
    queryFn: () => fetchTasks(user!.id),
    enabled: !!user?.id,
  })

  const { data: todayBlocks = [], isLoading: blocksLoading } = useQuery({
    queryKey: WORK_BLOCKS_QUERY_KEY,
    queryFn: () => fetchTodayBlocks(user!.id),
    enabled: !!user?.id,
    refetchInterval: 60_000, // refresh every minute (for missed auto-flip)
  })

  const { data: hasCalendar } = useQuery({
    queryKey: CALENDAR_CONNECTIONS_QUERY_KEY,
    queryFn: () => fetchCalendarConnections(user!.id),
    enabled: !!user?.id,
    staleTime: 1000 * 60 * 5,
  })

  // ── Realtime subscriptions ─────────────────────────────────────────────────

  useEffect(() => {
    if (!supabase || !user?.id) return
    const channel = supabase
      .channel('dashboard-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'work_blocks', filter: `user_id=eq.${user.id}` },
        () => void queryClient.invalidateQueries({ queryKey: WORK_BLOCKS_QUERY_KEY }),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tasks', filter: `user_id=eq.${user.id}` },
        () => void queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY }),
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [user?.id, queryClient])

  // ── Missed block auto-flip ─────────────────────────────────────────────────

  const flipMissedMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: WorkBlockStatus }) =>
      updateWorkBlockStatus(id, status),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: WORK_BLOCKS_QUERY_KEY }),
  })

  useEffect(() => {
    const check = () => {
      const now = new Date()
      todayBlocks.forEach((b) => {
        if (
          (b.status === 'upcoming' || b.status === 'active') &&
          new Date(b.end_time) < now
        ) {
          flipMissedMutation.mutate({ id: b.id, status: 'missed' })
        }
      })
    }
    check() // run immediately on block change
    const interval = setInterval(check, 60_000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todayBlocks])

  useEffect(() => {
    if (!showAddTask) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowAddTask(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [showAddTask])

  // ── Start / stop block mutations ───────────────────────────────────────────

  const updateStatusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: WorkBlockStatus }) =>
      updateWorkBlockStatus(id, status),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: WORK_BLOCKS_QUERY_KEY }),
  })

  const handleStartBlock = (block: WorkBlock) => {
    updateStatusMutation.mutate({ id: block.id, status: 'active' })
  }

  const handleStopBlock = (block: WorkBlock) => {
    updateStatusMutation.mutate(
      { id: block.id, status: 'done' },
      { onSuccess: () => setReflectionBlock(block) },
    )
  }

  // ── Reflection handlers ────────────────────────────────────────────────────

  const handleReflectionClose = () => setReflectionBlock(null)

  const handleReflectionSkip = () => {
    const next = skipCountRef.current + 1
    skipCountRef.current = next
    localStorage.setItem(REFLECTION_SKIP_KEY, String(next))
    if (next >= 3 && !localStorage.getItem(REFLECTION_NUDGE_KEY)) {
      setShowNudge(true)
    }
    setReflectionBlock(null)
  }

  // ── Free tier / at-risk ────────────────────────────────────────────────────

  const activeTasks = tasks.filter((t) => t.deleted_at === null)
  const isFreeTier = user?.tier === 'free'
  const atFreeCap = isFreeTier && activeTasks.length >= FREE_TIER_TASK_LIMIT

  const atRiskTasks = useMemo(() => {
    const cutoff = new Date(Date.now() + 24 * 60 * 60 * 1000) // 24h from now
    return activeTasks.filter(
      (t) => t.due_date && new Date(t.due_date) <= cutoff && t.status !== 'complete',
    )
  }, [activeTasks])

  // Calendar banner — show if no calendar and not dismissed
  const calendarBannerDismissed = !!localStorage.getItem(CALENDAR_BANNER_KEY)
  const showCalendarBanner = !hasCalendar && !calendarBannerDismissed

  const dismissCalendarBanner = () => {
    localStorage.setItem(CALENDAR_BANNER_KEY, '1')
    // Force re-render via state
    setView((v) => v)
  }

  // ── Task grouping (Tasks view) ─────────────────────────────────────────────

  const now = new Date()
  const endOfWeek = new Date(now)
  endOfWeek.setDate(now.getDate() + (6 - now.getDay()))
  endOfWeek.setHours(23, 59, 59, 999)
  const endOfToday = new Date(now)
  endOfToday.setHours(23, 59, 59, 999)

  const todayTasks = activeTasks.filter((t) => {
    if (!t.due_date) return false
    const d = new Date(t.due_date)
    return d <= endOfToday
  })
  const thisWeekTasks = activeTasks.filter((t) => {
    if (!t.due_date) return false
    const d = new Date(t.due_date)
    return d > endOfToday && d <= endOfWeek
  })
  const laterTasks = activeTasks.filter((t) => {
    if (!t.due_date) return false
    return new Date(t.due_date) > endOfWeek
  })
  const noDateTasks = activeTasks.filter((t) => !t.due_date)

  return (
    <>
      <div
        className="flex h-screen w-screen overflow-hidden"
        style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' }}
      >
        {/* ── Sidebar ──────────────────────────────────────────────── */}
        <aside
          className="flex h-full flex-col"
          style={{ width: 240, minWidth: 240, background: '#FFFFFF', borderRight: '1px solid #E8E8EC' }}
        >
          <div style={{ padding: '20px 20px 0' }}>
            <img src={rumboLogo} alt="Rumbo" style={{ height: 28, width: 'auto' }} />
          </div>
          <div style={{ height: 1, background: '#E8E8EC', margin: '16px 0' }} />
          <nav className="flex-1 px-3">
            <NavItem
              icon={<CalendarDays size={16} />}
              label="Today"
              active={view === 'today'}
              onClick={() => { setView('today'); setShowAddTask(false) }}
            />
            <NavItem
              icon={<ListTodo size={16} />}
              label="Tasks"
              active={view === 'tasks'}
              onClick={() => { setView('tasks'); setShowAddTask(false) }}
            />
            <NavItem
              icon={<Settings size={16} />}
              label="Settings"
              active={view === 'settings'}
              onClick={() => { setView('settings'); setShowAddTask(false) }}
            />
          </nav>
          <div style={{ padding: '16px 20px', borderTop: '1px solid #E8E8EC' }}>
            <p
              className="truncate"
              style={{ fontSize: 12, color: '#8A8A9A', marginBottom: 6 }}
              title={user?.email ?? ''}
            >
              {user?.email ?? '—'}
            </p>
            <button
              onClick={() => void signOut()}
              style={{ fontSize: 12, color: '#8A8A9A', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
              className="hover:text-rumbo-text transition-colors"
            >
              Sign out
            </button>
          </div>
        </aside>

        {/* ── Main content ─────────────────────────────────────────── */}
        <main className="flex flex-1 flex-col overflow-y-auto" style={{ background: '#F5F5F3' }}>
          <>
              {/* ── Today view ─────────────────────────────────────── */}
              {view === 'today' && (
                <div className="flex-1 p-8">
                  <div className="mb-5 flex items-center justify-between">
                    <h1 style={{ fontSize: 22, fontWeight: 600, color: '#1A1A2E', margin: 0 }}>
                      Today
                    </h1>
                    <AddTaskButton onClick={() => setShowAddTask(true)} disabled={atFreeCap} />
                  </div>

                  {/* Banners */}
                  <div className="space-y-3 mb-5">
                    {showCalendarBanner && (
                      <CalendarBanner onDismiss={dismissCalendarBanner} />
                    )}
                    {atRiskTasks.length > 0 && (
                      <AtRiskBanner count={atRiskTasks.length} onViewTasks={() => setView('tasks')} />
                    )}
                    {atFreeCap && <FreeTierCapBanner />}
                    {showNudge && (
                      <ReflectionNudge
                        onDismiss={() => {
                          localStorage.setItem(REFLECTION_NUDGE_KEY, '1')
                          setShowNudge(false)
                        }}
                      />
                    )}
                  </div>

                  {/* Work blocks */}
                  {blocksLoading && <LoadingState />}
                  {!blocksLoading && todayBlocks.length === 0 && (
                    <EmptyState
                      message="No sessions scheduled for today."
                      subtext="Add a task and Rumbo will build your schedule."
                      onAdd={() => setShowAddTask(true)}
                      disabled={atFreeCap}
                    />
                  )}
                  {!blocksLoading && todayBlocks.length > 0 && (
                    <div className="space-y-3">
                      {todayBlocks.map((block) => (
                        <WorkBlockCard
                          key={block.id}
                          block={block}
                          tasks={tasks}
                          onStart={() => handleStartBlock(block)}
                          onStop={() => handleStopBlock(block)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── Tasks view ─────────────────────────────────────── */}
              {view === 'tasks' && (
                <div className="flex-1 p-8">
                  <div className="mb-5 flex items-center justify-between">
                    <h1 style={{ fontSize: 22, fontWeight: 600, color: '#1A1A2E', margin: 0 }}>
                      All Tasks
                    </h1>
                    <AddTaskButton onClick={() => setShowAddTask(true)} disabled={atFreeCap} />
                  </div>

                  {atFreeCap && <div className="mb-4"><FreeTierCapBanner /></div>}

                  {tasksLoading && <LoadingState />}
                  {tasksError && <ErrorState message={(tasksError as Error).message} />}

                  {!tasksLoading && !tasksError && activeTasks.length === 0 && (
                    <EmptyState
                      message="No tasks yet."
                      subtext="Add your first task to get started."
                      onAdd={() => setShowAddTask(true)}
                      disabled={atFreeCap}
                    />
                  )}

                  {!tasksLoading && (
                    <div className="space-y-6">
                      {todayTasks.length > 0 && (
                        <TaskSection label="Today" tasks={todayTasks} />
                      )}
                      {thisWeekTasks.length > 0 && (
                        <TaskSection label="This Week" tasks={thisWeekTasks} />
                      )}
                      {laterTasks.length > 0 && (
                        <TaskSection label="Later" tasks={laterTasks} />
                      )}
                      {noDateTasks.length > 0 && (
                        <TaskSection label="No Date" tasks={noDateTasks} />
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ── Settings view ──────────────────────────────────── */}
              {view === 'settings' && (
                <div className="flex flex-1 items-center justify-center p-8">
                  <p style={{ fontSize: 14, color: '#8A8A9A' }}>Settings coming soon.</p>
                </div>
              )}
            </>
        </main>
      </div>

      {/* Add task modal — rendered above dashboard content */}
      {showAddTask && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.18)' }}
          onPointerDown={(e) => { if (e.target === e.currentTarget) setShowAddTask(false) }}
        >
          <AddTaskForm
            onBack={() => setShowAddTask(false)}
            onSuccess={() => setShowAddTask(false)}
            userId={user?.id ?? ''}
            atFreeCap={atFreeCap}
            taskCount={activeTasks.length}
          />
        </div>
      )}

      {/* Reflection modal — rendered above everything */}
      {reflectionBlock && (
        <ReflectionModal
          block={reflectionBlock}
          tasks={tasks}
          userId={user?.id ?? ''}
          onClose={handleReflectionClose}
          onSkip={handleReflectionSkip}
        />
      )}
    </>
  )
}

// ── WorkBlockCard ─────────────────────────────────────────────────────────────

interface WorkBlockCardProps {
  block: WorkBlock
  tasks: Task[]
  onStart: () => void
  onStop: () => void
}

function WorkBlockCard({ block, tasks, onStart, onStop }: WorkBlockCardProps) {
  const task = tasks.find((t) => t.id === block.task_id)
  const isActive = block.status === 'active'
  const isDone = block.status === 'done'
  const isMissed = block.status === 'missed'

  // Timer — counts up from start_time when active
  const [elapsedSeconds, setElapsedSeconds] = useState(() => {
    if (!isActive) return 0
    return Math.floor((Date.now() - new Date(block.start_time).getTime()) / 1000)
  })

  useEffect(() => {
    if (!isActive) { setElapsedSeconds(0); return }
    const base = Math.floor((Date.now() - new Date(block.start_time).getTime()) / 1000)
    setElapsedSeconds(base)
    const interval = setInterval(() => setElapsedSeconds((s) => s + 1), 1000)
    return () => clearInterval(interval)
  }, [isActive, block.start_time])

  const statusConfig: Record<WorkBlockStatus, { label: string; color: string }> = {
    upcoming: { label: 'Upcoming', color: '#8A8A9A' },
    active: { label: 'Active', color: '#6B7FBE' },
    done: { label: 'Done', color: '#34D399' },
    missed: { label: 'Missed', color: '#EF4444' },
  }
  const { label: statusLabel, color: statusColor } = statusConfig[block.status]

  return (
    <div
      className="rounded-2xl bg-white transition-shadow"
      style={{
        border: isActive ? '1.5px solid #6B7FBE' : '1px solid #E8E8EC',
        boxShadow: isActive ? '0 0 0 3px rgba(107,127,190,0.12)' : undefined,
        opacity: isMissed || isDone ? 0.7 : 1,
      }}
    >
      {/* Main row */}
      <div className="flex items-center gap-4 px-5 py-4">
        {/* Work type dot */}
        <span
          style={{
            width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
            background: badgeColor(block.work_type),
          }}
        />

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="truncate font-semibold"
              style={{ fontSize: 14, color: '#1A1A2E' }}
            >
              {task?.title ?? 'Unknown task'}
            </span>
            <span
              className="shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold"
              style={{ background: `${statusColor}18`, color: statusColor }}
            >
              {statusLabel}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2" style={{ fontSize: 12, color: '#8A8A9A' }}>
            <Clock size={11} />
            <span>{formatTime(block.start_time)} – {formatTime(block.end_time)}</span>
            <span>·</span>
            <span>{block.duration_mins}m</span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">
          {block.status === 'upcoming' && (
            <button
              onClick={onStart}
              className="rounded-xl bg-[#6B7FBE] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition-opacity"
              style={{ border: 'none', cursor: 'pointer' }}
            >
              Start
            </button>
          )}
          {block.status === 'active' && (
            <button
              onClick={onStop}
              className="rounded-xl border border-[#6B7FBE] bg-white px-4 py-2 text-sm font-semibold text-[#6B7FBE] hover:bg-[#EEF0FA] transition-colors"
              style={{ cursor: 'pointer' }}
            >
              Done
            </button>
          )}
          {isDone && <CheckCircle2 size={20} className="text-[#34D399]" />}
          {isMissed && <XCircle size={20} className="text-[#EF4444]" />}
        </div>
      </div>

      {/* Active expansion — timer */}
      {isActive && (
        <div
          className="border-t border-[#EEF0FA] px-5 pb-4 pt-3 flex items-center gap-3"
        >
          <div
            className="font-mono text-2xl font-bold tabular-nums"
            style={{ color: '#6B7FBE', letterSpacing: '-0.02em' }}
          >
            {formatElapsed(elapsedSeconds)}
          </div>
          <div style={{ fontSize: 12, color: '#8A8A9A' }}>
            elapsed · target {block.duration_mins}m
          </div>
        </div>
      )}
    </div>
  )
}

// ── Task list UI ──────────────────────────────────────────────────────────────

function TaskSection({ label, tasks }: { label: string; tasks: Task[] }) {
  return (
    <div>
      <h2 style={{ fontSize: 11, fontWeight: 600, color: '#8A8A9A', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 8 }}>
        {label}
      </h2>
      <div className="space-y-2">
        {tasks.map((task) => (
          <TaskRow key={task.id} task={task} />
        ))}
      </div>
    </div>
  )
}

function TaskRow({ task }: { task: Task }) {
  const isOptimistic = task.id.startsWith('optimistic-')
  return (
    <div
      className="flex items-center gap-3 rounded-xl bg-white px-4 py-3"
      style={{ border: '1px solid #E8E8EC', opacity: isOptimistic ? 0.6 : 1 }}
    >
      <span
        style={{
          width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
          background: task.work_type ? badgeColor(task.work_type) : '#D1D5DB',
        }}
      />
      <span className="flex-1 truncate font-medium" style={{ fontSize: 14, color: '#1A1A2E', minWidth: 0 }}>
        {task.title}
      </span>
      <div className="flex items-center gap-3 shrink-0" style={{ fontSize: 12, color: '#8A8A9A' }}>
        {task.due_date && <span>{formatDueDate(task.due_date)}</span>}
        <span>{formatEstimatedMins(task.estimated_mins)}</span>
        {task.work_type && (
          <span
            className="rounded-full px-2 py-0.5 text-white"
            style={{ fontSize: 11, background: badgeColor(task.work_type) }}
          >
            {task.work_type === 'deep' ? 'Deep' : 'Shallow'}
          </span>
        )}
      </div>
    </div>
  )
}

// ── Banners ───────────────────────────────────────────────────────────────────

function CalendarBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-blue-200/80 bg-blue-50 px-4 py-3" style={{ fontSize: 13 }}>
      <Calendar size={14} className="shrink-0 text-blue-500" />
      <span style={{ color: '#1E40AF', flex: 1 }}>
        Connect your calendar so Rumbo can schedule around your commitments.
      </span>
      <button
        onClick={onDismiss}
        className="shrink-0 text-xs font-semibold text-blue-400 hover:text-blue-600 transition-colors"
        style={{ background: 'none', border: 'none', cursor: 'pointer' }}
      >
        Dismiss
      </button>
    </div>
  )
}

function AtRiskBanner({ count, onViewTasks }: { count: number; onViewTasks: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-red-200/80 bg-red-50 px-4 py-3" style={{ fontSize: 13 }}>
      <AlertTriangle size={14} className="shrink-0 text-red-500" />
      <span style={{ color: '#991B1B', flex: 1 }}>
        {count === 1
          ? '1 task is due within 24 hours.'
          : `${count} tasks are due within 24 hours.`}
      </span>
      <button
        onClick={onViewTasks}
        className="shrink-0 text-xs font-semibold text-red-500 hover:text-red-700 transition-colors"
        style={{ background: 'none', border: 'none', cursor: 'pointer' }}
      >
        View tasks
      </button>
    </div>
  )
}

function FreeTierCapBanner() {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-amber-300/60 bg-amber-50 px-4 py-3" style={{ fontSize: 13 }}>
      <Lock size={14} className="shrink-0 text-amber-600" />
      <span style={{ color: '#92400E' }}>
        You've reached the 5-task limit on the free plan. Upgrade to add more tasks.
      </span>
    </div>
  )
}

function ReflectionNudge({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-neutral-200 bg-white px-4 py-3" style={{ fontSize: 13 }}>
      <span style={{ color: '#4A4A5A', flex: 1 }}>
        Reflections help Rumbo learn what works for you — they take about 30 seconds.
      </span>
      <button
        onClick={onDismiss}
        className="shrink-0 text-xs font-semibold text-neutral-400 hover:text-neutral-600 transition-colors"
        style={{ background: 'none', border: 'none', cursor: 'pointer' }}
      >
        Got it
      </button>
    </div>
  )
}

// ── Shared UI ─────────────────────────────────────────────────────────────────

function AddTaskButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold text-white transition-opacity disabled:opacity-50"
      style={{ background: '#6B7FBE', border: 'none', cursor: disabled ? 'not-allowed' : 'pointer' }}
    >
      {disabled ? <Lock size={14} /> : <Plus size={14} />}
      Add task
    </button>
  )
}

function EmptyState({
  message,
  subtext,
  onAdd,
  disabled,
}: {
  message: string
  subtext?: string
  onAdd: () => void
  disabled?: boolean
}) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <p style={{ fontSize: 15, fontWeight: 500, color: '#4A4A5A', marginBottom: 4 }}>{message}</p>
      {subtext && <p style={{ fontSize: 13, color: '#8A8A9A', marginBottom: 20 }}>{subtext}</p>}
      {!disabled && (
        <button
          onClick={onAdd}
          className="h-10 rounded-xl bg-[#6B7FBE] px-5 text-sm font-semibold text-white"
        >
          Add your first task
        </button>
      )}
    </div>
  )
}

function LoadingState() {
  return (
    <div className="py-16 text-center">
      <p style={{ fontSize: 13, color: '#8A8A9A' }}>Loading…</p>
    </div>
  )
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-red-500/20 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-center gap-2">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  )
}

// ── AddTaskForm ───────────────────────────────────────────────────────────────

interface AddTaskFormProps {
  onBack: () => void
  onSuccess: () => void
  userId: string
  atFreeCap: boolean
  taskCount: number
}

function AddTaskForm({ onBack, onSuccess, userId, atFreeCap, taskCount }: AddTaskFormProps) {
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const isFreeTier = user?.tier === 'free'
  const titleRef = useRef<HTMLInputElement | null>(null)

  const [title, setTitle] = useState('')
  const [dueDateTime, setDueDateTime] = useState<DueDateTimeValue>({ date: undefined, time: '23:59' })
  const [estimatedMins, setEstimatedMins] = useState(30)
  const [estimatedTimeMode, setEstimatedTimeMode] = useState<EstimatedTimeMode>('preset')
  const [customHoursDraft, setCustomHoursDraft] = useState('1')
  const [overrideWorkType, setOverrideWorkType] = useState<WorkType | null>(null)
  const [description, setDescription] = useState('')
  const [descriptionOpen, setDescriptionOpen] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    const t = window.setTimeout(() => titleRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [])

  const classifier: ClassifierResult = useMemo(
    () => classifyTaskTitle(title, estimatedMins),
    [title, estimatedMins],
  )

  const effectiveWorkType: WorkType = overrideWorkType ?? classifier.work_type
  const hasTitle = title.trim().length > 0

  const customHoursParsed = parseInt(customHoursDraft, 10)
  const customHoursOk =
    estimatedTimeMode !== 'custom' ||
    (customHoursDraft.trim() !== '' && Number.isFinite(customHoursParsed) && customHoursParsed > 0)

  const mutation = useMutation({
    mutationFn: insertTask,
    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: TASKS_QUERY_KEY })
      const previous = queryClient.getQueryData<Task[]>(TASKS_QUERY_KEY) ?? []
      const optimistic: Task = {
        id: `optimistic-${Date.now()}`,
        created_at: new Date().toISOString(),
        deleted_at: null,
        description_hash: null,
        pdf_url: null,
        pdf_hash: null,
        calendar_color: null,
        ...payload,
      }
      queryClient.setQueryData<Task[]>(TASKS_QUERY_KEY, [...previous, optimistic])
      return { previous }
    },
    onError: (_err, _payload, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(TASKS_QUERY_KEY, ctx.previous)
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY }),
  })

  const canSubmit = !!userId && hasTitle && !!dueDateTime.date && customHoursOk && !mutation.isPending && !atFreeCap
  const estimatedSelectValue = estimatedTimeMode === 'custom' ? 'other' : String(estimatedMins)

  const onEstimatedSelectChange = (v: string) => {
    if (v === 'other') {
      setEstimatedTimeMode('custom')
      setCustomHoursDraft(String(Math.max(1, Math.ceil(estimatedMins / 60))))
      return
    }
    setEstimatedTimeMode('preset')
    setEstimatedMins(Number(v))
  }

  const onSubmit = () => {
    setLocalError(null)
    if (!userId) { setLocalError('You must be signed in.'); return }
    if (!title.trim() || !dueDateTime.date) return
    if (atFreeCap) { setLocalError(`Free plan limit is ${FREE_TIER_TASK_LIMIT} tasks.`); return }

    const due_date = (() => {
      const d = dueDateTime.date!
      const [hh, mm] = dueDateTime.time.split(':').map(Number)
      const dt = new Date(d)
      dt.setHours(Number.isFinite(hh) ? hh : 23, Number.isFinite(mm) ? mm : 59, 0, 0)
      return dt.toISOString()
    })()

    const final_mins =
      estimatedTimeMode === 'custom'
        ? Math.min(Math.max(1, customHoursParsed * 60), 10080)
        : estimatedMins

    const payload: InsertTaskPayload = {
      user_id: userId,
      title: title.trim(),
      due_date,
      estimated_mins: final_mins,
      work_type: effectiveWorkType,
      classifier_confidence: classifier.confidence,
      shallow_score: classifier.shallow_score,
      deep_score: classifier.deep_score,
      user_overrode_classifier: overrideWorkType != null && overrideWorkType !== classifier.work_type,
      description: description.trim() || null,
      status: 'pending',
      urgency_ratio: 0,
    }

    mutation.mutate(payload, { onSuccess })
  }

  const displayError = localError ?? (mutation.isError ? (mutation.error as Error).message : null)

  return (
    <div className="w-full" style={{ maxWidth: 560 }}>
      <div className={cn(
        'relative w-full rounded-[42px] bg-white',
        'border border-solid border-neutral-200/90',
      )}>
        <div className="overflow-hidden rounded-[42px]">
        <div className="p-7">
        <div className="mb-4 flex items-start justify-between">
          <div className="text-[22px] leading-tight font-bold tracking-tight text-rumbo-text">
            What do you need to get done?
          </div>
          <div className="flex items-center gap-3 flex-shrink-0 ml-3">
            {isFreeTier && (
              <span style={{ fontSize: 11, color: '#8A8A9A', paddingTop: 4 }}>
                {taskCount}/{FREE_TIER_TASK_LIMIT} tasks
              </span>
            )}
            <button
              onClick={onBack}
              className="flex items-center justify-center transition-colors hover:bg-black/5 rounded-lg"
              style={{ width: 32, height: 32, background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginTop: 2 }}
              aria-label="Close"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4A4A5A" strokeWidth="2.5" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {atFreeCap && <div className="mb-4"><FreeTierCapBanner /></div>}

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-bold text-black/70">Title</label>
            <input
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Finish PSET 6"
              disabled={atFreeCap}
              className="mt-1 box-border w-full rounded-xl border-0 bg-white px-3 py-3 text-sm outline-none ring-1 ring-inset ring-neutral-300/90 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-rumbo-primary/35 disabled:opacity-50"
            />
          </div>

          {hasTitle && (
            <div className="flex items-center gap-2 -mt-1">
              <span className="text-xs font-semibold text-black/50">Work type</span>
              <Select
                value={effectiveWorkType}
                onValueChange={(v) => {
                  const next = (v as WorkType) || classifier.work_type
                  setOverrideWorkType(next === classifier.work_type ? null : next)
                }}
              >
                <SelectTrigger
                  variant="borderless"
                  className="min-w-0 h-8 px-3 text-white hover:opacity-95"
                  style={{ backgroundColor: badgeColor(effectiveWorkType) }}
                />
                <SelectContent highlightStyle="clear">
                  <SelectItem index={0} value="deep">Deep work</SelectItem>
                  <SelectItem index={1} value="shallow">Shallow work</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          <div
            className={cn(
              'transition-all duration-500 ease-in-out overflow-hidden',
              hasTitle ? 'max-h-[700px] opacity-100 translate-y-0' : 'max-h-0 opacity-0 -translate-y-1 pointer-events-none',
            )}
            aria-hidden={!hasTitle}
          >
            <div className="grid grid-cols-2 gap-4 pt-1">
              <div className="min-w-0">
                <CalendarDueDateTime value={dueDateTime} onChange={setDueDateTime} />
              </div>
              <div className="min-w-0">
                <label className="block text-sm font-bold text-black/70">Estimated time</label>
                <div className="mt-1">
                  <Select value={estimatedSelectValue} onValueChange={onEstimatedSelectChange}>
                    {estimatedTimeMode === 'custom' ? (
                      <div className={cn(
                        'flex h-11 min-w-0 overflow-hidden rounded-xl bg-white',
                        'ring-1 ring-inset ring-neutral-300/90',
                        'focus-within:ring-2 focus-within:ring-inset focus-within:ring-rumbo-primary/35',
                        '[&>div]:contents',
                      )}>
                        <input
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          maxLength={3}
                          placeholder="Hours"
                          className="min-h-0 min-w-0 flex-1 border-0 bg-transparent px-3 py-2 text-sm outline-none"
                          value={customHoursDraft}
                          onKeyDown={(e) => {
                            const ctrl = ['Backspace','Delete','ArrowLeft','ArrowRight','Tab','Home','End'].includes(e.key)
                            if (!ctrl && !/^\d$/.test(e.key)) e.preventDefault()
                          }}
                          onChange={(e) => {
                            const digits = e.target.value.replace(/\D+/g, '')
                            setCustomHoursDraft(digits)
                            if (!digits) return
                            const h = parseInt(digits, 10)
                            if (Number.isFinite(h) && h > 0) {
                              const clamped = Math.min(h, 168)
                              setEstimatedMins(clamped * 60)
                              if (h !== clamped) setCustomHoursDraft(String(clamped))
                            }
                          }}
                        />
                        <SelectTrigger
                          showLabel={false}
                          placeholder="Presets"
                          variant="borderless"
                          className="h-11 w-11 shrink-0 rounded-none rounded-r-xl border-0 bg-transparent ring-0 min-w-0 px-0 hover:bg-neutral-50 focus-visible:ring-0"
                        />
                      </div>
                    ) : (
                      <SelectTrigger
                        placeholder="Select…"
                        className="w-full min-w-0 h-11 rounded-xl border-0 bg-white px-3 text-sm outline-none ring-1 ring-inset ring-neutral-300/90 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-rumbo-primary/35"
                      />
                    )}
                    <SelectContent highlightStyle="clear">
                      <SelectItem index={0} value="15">15 minutes</SelectItem>
                      <SelectItem index={1} value="30">30 minutes</SelectItem>
                      <SelectItem index={2} value="60">1 hour</SelectItem>
                      <SelectItem index={3} value="180">3 hours</SelectItem>
                      <SelectItem index={4} value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            {/* Collapsible description */}
            <div className="mt-4">
              <button
                type="button"
                onClick={() => setDescriptionOpen((o) => !o)}
                className="flex items-center gap-1.5 text-sm font-semibold text-black/50 hover:text-black/70 transition-colors"
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
              >
                <svg
                  width="12" height="12" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                  style={{ transition: 'transform 0.2s', transform: descriptionOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
                >
                  <path d="M9 18l6-6-6-6" />
                </svg>
                Description
              </button>
              <div
                className={cn(
                  'transition-all duration-300 ease-in-out overflow-hidden',
                  descriptionOpen ? 'max-h-48 opacity-100 mt-2' : 'max-h-0 opacity-0',
                )}
              >
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value.slice(0, 500))}
                  placeholder="Add details or paste instructions..."
                  rows={3}
                  className="box-border w-full resize-none rounded-xl border-0 bg-white px-3 py-3 text-sm outline-none ring-1 ring-inset ring-neutral-300/90 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-rumbo-primary/35"
                />
                <p className="mt-1 text-right text-xs text-black/30">{description.length}/500</p>
              </div>
            </div>
          </div>

          {displayError && (
            <div className="rounded-xl border border-red-500/20 bg-red-50 px-3 py-2 text-sm text-red-700 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{displayError}</span>
            </div>
          )}

          {hasTitle && (
            <button
              type="button"
              onClick={onSubmit}
              disabled={!canSubmit}
              style={{
                width: '100%', height: 44, borderRadius: 8,
                background: '#6B7FBE', color: '#FFFFFF',
                fontSize: 14, fontWeight: 600, border: 'none',
                cursor: canSubmit ? 'pointer' : 'not-allowed',
                opacity: canSubmit ? 1 : 0.5,
              }}
            >
              {mutation.isPending ? 'Adding…' : 'Add task'}
            </button>
          )}
        </div>
        </div>
        </div>
      </div>
    </div>
  )
}

// ── NavItem ───────────────────────────────────────────────────────────────────

interface NavItemProps {
  icon: React.ReactNode
  label: string
  active?: boolean
  onClick?: () => void
}

function NavItem({ icon, label, active = false, onClick }: NavItemProps) {
  return (
    <div
      className="flex cursor-pointer items-center gap-2.5 transition-colors"
      style={{
        padding: '8px 10px', borderRadius: 8,
        background: active ? '#EEF0FA' : 'transparent',
        color: active ? '#6B7FBE' : '#4A4A5A',
        fontSize: 14,
      }}
      onClick={onClick}
      onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = '#F5F5F3' }}
      onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
    >
      {icon}
      <span style={{ fontWeight: active ? 500 : 400 }}>{label}</span>
    </div>
  )
}
