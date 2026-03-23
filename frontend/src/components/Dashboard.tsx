import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, AlertTriangle, PlusCircle } from 'lucide-react'
import rumboLogo from '@/assets/rumbo-logo.png'
import { useAuthStore } from '@/store/authStore'
import { classifyTaskTitle } from '@/lib/classifier'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import type { ClassifierResult, Task, WorkType } from '@/types'
import { CalendarDueDateTime, type DueDateTimeValue } from '@/components/ui/calendar-date-and-time-range'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'

type View = 'home' | 'addTask'
type EstimatedTimeMode = 'preset' | 'custom'

function badgeColor(workType: WorkType) {
  return workType === 'deep' ? '#6B7FBE' : '#5BBFB5'
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export function Dashboard() {
  const user = useAuthStore((s) => s.user)
  const signOut = useAuthStore((s) => s.signOut)
  const [view, setView] = useState<View>('home')

  return (
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
            icon={<PlusCircle size={16} color="#6B7FBE" />}
            label="Add task"
            active={view === 'addTask'}
            onClick={() => setView('addTask')}
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
      <main
        className="flex flex-1 items-center justify-center overflow-y-auto"
        style={{ background: '#F5F5F3', padding: 32 }}
      >
        {view === 'home' && (
          <p style={{ fontSize: 14, color: '#8A8A9A' }}>Your schedule will appear here</p>
        )}

        {view === 'addTask' && (
          <AddTaskForm onBack={() => setView('home')} onSuccess={() => setView('home')} />
        )}
      </main>
    </div>
  )
}

// ── AddTaskForm ───────────────────────────────────────────────────────────────

interface AddTaskFormProps {
  onBack: () => void
  onSuccess: () => void
}

function AddTaskForm({ onBack, onSuccess }: AddTaskFormProps) {
  const session = useAuthStore((s) => s.session)
  const titleRef = useRef<HTMLInputElement | null>(null)

  const [title, setTitle] = useState('')
  const [dueDateTime, setDueDateTime] = useState<DueDateTimeValue>({ date: undefined, time: '23:59' })
  const [estimatedMins, setEstimatedMins] = useState(30)
  const [estimatedTimeMode, setEstimatedTimeMode] = useState<EstimatedTimeMode>('preset')
  const [customHoursDraft, setCustomHoursDraft] = useState('1')
  const [overrideWorkType, setOverrideWorkType] = useState<WorkType | null>(null)
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Auto-focus title when form mounts
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

  const canSubmit = !!session?.user?.id && hasTitle && !!dueDateTime.date && customHoursOk && !submitting

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

  const onSubmit = async () => {
    setError(null)
    if (!supabase) { setError('Supabase is not configured.'); return }
    const userId = session?.user?.id
    if (!userId) { setError('You must be signed in to add a task.'); return }
    if (!title.trim() || !dueDateTime.date) return

    setSubmitting(true)
    try {
      const nowIso = new Date().toISOString()

      const insert: Omit<Task, 'id'> = {
        user_id: userId,
        title: title.trim(),
        description: description.trim() || null,
        work_type: effectiveWorkType,
        classifier_confidence: classifier.confidence,
        user_overrode_classifier: overrideWorkType != null && overrideWorkType !== classifier.work_type,
        status: 'pending',
        due_at: (() => {
          const d = dueDateTime.date!
          const [hh, mm] = dueDateTime.time.split(':').map(Number)
          const dt = new Date(d)
          dt.setHours(Number.isFinite(hh) ? hh : 23, Number.isFinite(mm) ? mm : 59, 0, 0)
          return dt.toISOString()
        })(),
        estimated_mins:
          estimatedTimeMode === 'custom'
            ? Math.min(Math.max(1, customHoursParsed * 60), 10080)
            : estimatedMins,
        actual_mins: null,
        file_url: null,
        problems_parsed: false,
        priority: 2,
        urgency_ratio: 0,
        created_at: nowIso,
        updated_at: nowIso,
      }

      const { error: insertError } = await supabase.from('tasks').insert({
        user_id: insert.user_id,
        title: insert.title,
        due_at: insert.due_at,
        estimated_mins: insert.estimated_mins,
        work_type: insert.work_type,
        classifier_confidence: insert.classifier_confidence,
        user_overrode_classifier: insert.user_overrode_classifier,
        status: insert.status,
        description: insert.description,
      })

      if (insertError) { setError(insertError.message); return }

      onSuccess()
    } catch (e) {
      setError((e as Error).message ?? 'Failed to add task.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={{ width: '100%', maxWidth: 520 }}>
      <div
        style={{
          background: '#FFFFFF',
          borderRadius: 16,
          padding: 32,
        }}
      >
        {/* Back button + heading */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={onBack}
            className="flex items-center justify-center transition-colors hover:bg-black/5 rounded-lg"
            style={{ width: 32, height: 32, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            aria-label="Back"
          >
            <ArrowLeft size={16} color="#4A4A5A" />
          </button>
          <h2 style={{ fontSize: 20, fontWeight: 600, color: '#1A1A2E', margin: 0 }}>
            Add a task
          </h2>
        </div>

        <div className="space-y-4">
          {/* Title */}
          <div>
            <label className="block text-sm font-bold text-black/70">Title</label>
            <input
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Finish PSET 6"
              className="mt-1 box-border w-full rounded-xl border-0 bg-white px-3 py-3 text-sm outline-none ring-1 ring-inset ring-neutral-300/90 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-rumbo-primary/35"
            />
          </div>

          {/* Work type badge — only once title is present */}
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

          {/* Due date + estimated time — only once title is present */}
          <div
            className={cn(
              'transition-all duration-500 ease-in-out overflow-hidden',
              hasTitle
                ? 'max-h-[600px] opacity-100 translate-y-0'
                : 'max-h-0 opacity-0 -translate-y-1 pointer-events-none',
            )}
            aria-hidden={!hasTitle}
          >
            <div className="grid grid-cols-2 gap-4 pt-1">
              {/* Due date */}
              <div className="min-w-0">
                <CalendarDueDateTime value={dueDateTime} onChange={setDueDateTime} />
              </div>

              {/* Estimated time */}
              <div className="min-w-0">
                <label className="block text-sm font-bold text-black/70">Estimated time</label>
                <div className="mt-1">
                  <Select value={estimatedSelectValue} onValueChange={onEstimatedSelectChange}>
                    {estimatedTimeMode === 'custom' ? (
                      <div
                        className={cn(
                          'flex h-11 min-w-0 overflow-hidden rounded-xl bg-white',
                          'ring-1 ring-inset ring-neutral-300/90',
                          'focus-within:ring-2 focus-within:ring-inset focus-within:ring-rumbo-primary/35',
                          '[&>div]:contents',
                        )}
                      >
                        <input
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          maxLength={3}
                          aria-label="Estimated time in hours"
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
                          aria-label="Choose a preset duration"
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

            {/* Description */}
            <div className="mt-4">
              <label className="block text-sm font-bold text-black/70">Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value.slice(0, 500))}
                placeholder="Add details or paste instructions..."
                rows={3}
                className="mt-1 box-border w-full resize-none rounded-xl border-0 bg-white px-3 py-3 text-sm outline-none ring-1 ring-inset ring-neutral-300/90 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-rumbo-primary/35"
              />
              <p className="mt-1 text-right text-xs text-black/30">{description.length}/500</p>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="rounded-xl border border-red-500/20 bg-red-50 px-3 py-2 text-sm text-red-700 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Submit */}
          {hasTitle && (
            <button
              type="button"
              onClick={() => void onSubmit()}
              disabled={!canSubmit}
              style={{
                width: '100%',
                height: 44,
                borderRadius: 8,
                background: '#6B7FBE',
                color: '#FFFFFF',
                fontSize: 14,
                fontWeight: 600,
                border: 'none',
                cursor: canSubmit ? 'pointer' : 'not-allowed',
                opacity: canSubmit ? 1 : 0.5,
              }}
            >
              {submitting ? 'Adding…' : 'Add task'}
            </button>
          )}
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
        padding: '8px 10px',
        borderRadius: 8,
        background: active ? '#EEF0FA' : 'transparent',
        color: active ? '#6B7FBE' : '#4A4A5A',
        fontSize: 14,
      }}
      onClick={onClick}
      onMouseEnter={(e) => {
        if (!active) (e.currentTarget as HTMLElement).style.background = '#F5F5F3'
      }}
      onMouseLeave={(e) => {
        if (!active) (e.currentTarget as HTMLElement).style.background = active ? '#EEF0FA' : 'transparent'
      }}
    >
      {icon}
      <span style={{ fontWeight: active ? 500 : 400 }}>{label}</span>
    </div>
  )
}
