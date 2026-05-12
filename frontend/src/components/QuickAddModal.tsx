import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEventHandler,
} from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalSize } from '@tauri-apps/api/dpi'
import { AlertTriangle, Lock, Paperclip } from 'lucide-react'

import { classifyTaskTitle } from '@/lib/classifier'
import type { ClassifierResult, WorkType } from '@/types'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/store/authStore'
import { cn } from '@/lib/utils'
import { fetchTasks, insertTask, TASKS_QUERY_KEY, type InsertTaskPayload } from '@/lib/queries'
import { CalendarDueDateTime, type DueDateTimeValue } from '@/components/ui/calendar-date-and-time-range'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'

/** Quick-add window width is fixed. Only two heights: compact (title only) vs expanded (full form). */
const QUICK_ADD_WIDTH = 760
const QUICK_ADD_HEIGHT_COMPACT = 280
/** Tall enough for date popover + estimated select when flipped; fixed-position menus still clip at webview edge. */
const QUICK_ADD_HEIGHT_EXPANDED = 680
/** Keep just a thin clickable backdrop around the card. */
const QUICK_ADD_OUTER_PADDING_PX = 8
/** Extra room for the portaled calendar popover while it is open. */
const QUICK_ADD_CALENDAR_OPEN_EXTRA_PX = 250

const FREE_TIER_TASK_LIMIT = 5

type EstimatedTimeMode = 'preset' | 'custom'

function badgeColor(workType: WorkType) {
  return workType === 'deep' ? '#6B7FBE' : '#5BBFB5'
}

export function QuickAddModal() {
  const session = useAuthStore((s) => s.session)
  const user = useAuthStore((s) => s.user)
  const userId = session?.user?.id ?? ''

  const queryClient = useQueryClient()

  // ── Free tier task count ────────────────────────────────────────────────────
  const { data: tasks = [] } = useQuery({
    queryKey: TASKS_QUERY_KEY,
    queryFn: () => fetchTasks(userId),
    enabled: !!userId,
    staleTime: 1000 * 10,
  })
  const activeTasks = tasks.filter((t) => t.deleted_at === null)
  const isFreeTier = user?.tier === 'free'
  const atFreeCap = isFreeTier && activeTasks.length >= FREE_TIER_TASK_LIMIT

  // ── Mutation ────────────────────────────────────────────────────────────────
  const mutation = useMutation({
    mutationFn: insertTask,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY })
    },
  })

  // ── Form state ──────────────────────────────────────────────────────────────
  const titleRef = useRef<HTMLInputElement | null>(null)
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const measureRef = useRef<HTMLDivElement | null>(null)
  const [title, setTitle] = useState('')
  const [dueDateTime, setDueDateTime] = useState<DueDateTimeValue>({ date: undefined, time: '23:59' })
  const [estimatedMins, setEstimatedMins] = useState<number>(30)
  const [estimatedTimeMode, setEstimatedTimeMode] = useState<EstimatedTimeMode>('preset')
  const [customHoursDraft, setCustomHoursDraft] = useState('1')
  const [isDatePickerOpen, setIsDatePickerOpen] = useState(false)
  const [overrideWorkType, setOverrideWorkType] = useState<WorkType | null>(null)
  const [description, setDescription] = useState('')
  const [descriptionOpen, setDescriptionOpen] = useState(false)
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── Window management ───────────────────────────────────────────────────────
  const hideQuickAdd = useCallback(async () => {
    try {
      await getCurrentWindow().hide()
    } catch {
      // ignore
    }
  }, [])

  const hideQuickAddRef = useRef(hideQuickAdd)
  hideQuickAddRef.current = hideQuickAdd

  useEffect(() => {
    const t = window.setTimeout(() => titleRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void hideQuickAdd()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [hideQuickAdd])

  const isOverlayPointerTarget = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return false
    const el = target
    if (el.closest('[role="listbox"]')) return true
    if (el.closest('[role="dialog"]')) return true
    if (el.closest('[data-radix-popper-content-wrapper]')) return true
    return false
  }

  const onRootPointerDownCapture: PointerEventHandler<HTMLDivElement> = (e) => {
    if (!surfaceRef.current) return
    const t = e.target
    if (!(t instanceof Node)) return
    if (surfaceRef.current.contains(t)) return
    if (isOverlayPointerTarget(t)) return
    void hideQuickAddRef.current()
  }

  useEffect(() => {
    document.documentElement.style.outline = 'none'
    document.documentElement.style.border = 'none'
    const root = document.getElementById('root')
    if (root) {
      root.style.outline = 'none'
      root.style.border = 'none'
    }
    return () => {
      document.documentElement.style.outline = ''
      document.documentElement.style.border = ''
      if (root) {
        root.style.outline = ''
        root.style.border = ''
      }
    }
  }, [])

  const classifier: ClassifierResult = useMemo(
    () => classifyTaskTitle(title, estimatedMins),
    [title, estimatedMins],
  )

  const effectiveWorkType: WorkType = overrideWorkType ?? classifier.work_type

  const hasTitle = title.trim().length > 0
  const hasTitleRef = useRef(hasTitle)
  hasTitleRef.current = hasTitle
  const isDatePickerOpenRef = useRef(isDatePickerOpen)
  isDatePickerOpenRef.current = isDatePickerOpen

  const lastWindowModeRef = useRef<'compact' | 'expanded' | null>(null)
  const lastAppliedHeightRef = useRef<number | null>(null)
  const didInitialWindowSizeRef = useRef(false)
  const isResizingRef = useRef(false)

  const applyQuickAddWindowSize = useCallback(
    async (
      mode: 'compact' | 'expanded',
      options?: { center?: boolean; focusTitle?: boolean },
    ) => {
      const center = options?.center ?? false
      const focusTitle = options?.focusTitle ?? true
      const fallbackH = mode === 'compact' ? QUICK_ADD_HEIGHT_COMPACT : QUICK_ADD_HEIGHT_EXPANDED
      const measuredCardH = surfaceRef.current
        ? Math.ceil(surfaceRef.current.getBoundingClientRect().height)
        : null
      const baseH = measuredCardH
        ? Math.max(
            mode === 'compact' ? 210 : 420,
            measuredCardH + QUICK_ADD_OUTER_PADDING_PX * 2,
          )
        : fallbackH
      const targetH =
        baseH +
        (mode === 'expanded' && isDatePickerOpenRef.current
          ? QUICK_ADD_CALENDAR_OPEN_EXTRA_PX
          : 0)
      if (
        !center &&
        lastWindowModeRef.current === mode &&
        lastAppliedHeightRef.current === targetH
      ) {
        return
      }
      lastWindowModeRef.current = mode
      lastAppliedHeightRef.current = targetH
      isResizingRef.current = true
      try {
        const win = getCurrentWindow()
        await win.setSize(new LogicalSize(QUICK_ADD_WIDTH, targetH))
        if (center) await win.center()
        if (focusTitle) window.setTimeout(() => titleRef.current?.focus(), 0)
      } catch {
        // ignore
      } finally {
        window.setTimeout(() => { isResizingRef.current = false }, 150)
      }
    },
    [],
  )

  const applyQuickAddWindowSizeRef = useRef(applyQuickAddWindowSize)
  applyQuickAddWindowSizeRef.current = applyQuickAddWindowSize

  useEffect(() => {
    let unlisten: undefined | (() => void)
    let cancelled = false

    void (async () => {
      try {
        unlisten = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
          if (cancelled) return
          if (focused) {
            if (!isResizingRef.current) {
              void applyQuickAddWindowSizeRef.current(
                hasTitleRef.current ? 'expanded' : 'compact',
                { center: true },
              )
            }
            return
          }
          void hideQuickAddRef.current()
        })
      } catch {
        // ignore
      }
    })()

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void applyQuickAddWindowSizeRef.current(hasTitleRef.current ? 'expanded' : 'compact', {
          center: true,
        })
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      try { unlisten?.() } catch { /* ignore */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onWindowBlur = () => void hideQuickAdd()
    window.addEventListener('blur', onWindowBlur)
    return () => window.removeEventListener('blur', onWindowBlur)
  }, [hideQuickAdd])

  useEffect(() => {
    document.documentElement.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
    document.body.style.background = 'transparent'
    return () => {
      document.documentElement.style.overflow = ''
      document.body.style.overflow = ''
      document.body.style.background = ''
    }
  }, [])

  useEffect(() => {
    const center = !didInitialWindowSizeRef.current
    didInitialWindowSizeRef.current = true
    void applyQuickAddWindowSize(hasTitle ? 'expanded' : 'compact', { center })
  }, [hasTitle, applyQuickAddWindowSize])

  useEffect(() => {
    void applyQuickAddWindowSize(hasTitleRef.current ? 'expanded' : 'compact', {
      focusTitle: false,
    })
  }, [isDatePickerOpen, descriptionOpen, applyQuickAddWindowSize])

  useEffect(() => {
    const el = surfaceRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let raf = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        void applyQuickAddWindowSizeRef.current(hasTitleRef.current ? 'expanded' : 'compact')
      })
    })
    observer.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [])

  // ── Submit ──────────────────────────────────────────────────────────────────
  const customHoursParsed = parseInt(customHoursDraft, 10)
  const customHoursOk =
    estimatedTimeMode !== 'custom' ||
    (customHoursDraft.trim() !== '' &&
      Number.isFinite(customHoursParsed) &&
      customHoursParsed > 0)

  const canSubmit =
    !!userId &&
    hasTitle &&
    !!dueDateTime.date &&
    customHoursOk &&
    !mutation.isPending &&
    !atFreeCap

  const estimatedSelectValue =
    estimatedTimeMode === 'custom' ? 'other' : String(estimatedMins)

  const onEstimatedSelectChange = (v: string) => {
    if (v === 'other') {
      setEstimatedTimeMode('custom')
      setCustomHoursDraft(String(Math.max(1, Math.ceil(estimatedMins / 60))))
      return
    }
    setEstimatedTimeMode('preset')
    setEstimatedMins(Number(v))
  }

  const resetForm = () => {
    setTitle('')
    setDueDateTime({ date: undefined, time: '23:59' })
    setEstimatedMins(30)
    setEstimatedTimeMode('preset')
    setCustomHoursDraft('1')
    setOverrideWorkType(null)
    setDescription('')
    setDescriptionOpen(false)
    setPdfFile(null)
    setLocalError(null)
  }

  const onSubmit = () => {
    setLocalError(null)
    if (!userId) { setLocalError('You must be signed in to add a task.'); return }
    if (!title.trim() || !dueDateTime.date) return
    if (atFreeCap) { setLocalError(`You've reached the ${FREE_TIER_TASK_LIMIT}-task limit. Upgrade to add more.`); return }

    const due_date = (() => {
      const d = dueDateTime.date!
      const [hh, mm] = dueDateTime.time.split(':').map((v) => Number(v))
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

    mutation.mutate(payload, {
      onSuccess: () => {
        void hideQuickAdd()
        resetForm()
      },
      onError: (err) => {
        setLocalError(err.message)
      },
    })
  }

  const displayError = localError ?? (mutation.isError ? (mutation.error as Error).message : null)

  return (
    <div
      data-rumbo-quick-add-root
      className="w-full h-full min-h-0 bg-transparent overflow-visible px-2 py-2 outline-none pointer-events-auto"
      onPointerDownCapture={onRootPointerDownCapture}
    >
      <div
        ref={measureRef}
        className="relative box-border flex min-h-0 w-full items-center justify-center outline-none pointer-events-auto"
      >
        <div
          ref={surfaceRef}
          className={cn(
            'relative w-full rounded-[42px] bg-white outline-none pointer-events-auto',
            'border border-solid border-neutral-200/90',
            'antialiased [transform:translateZ(0)]',
          )}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="overflow-hidden rounded-[42px]">
            <div className="p-7 min-w-0">
              <div className="mb-4 flex items-start justify-between">
                <div className="text-[22px] leading-tight font-bold tracking-tight text-rumbo-text">
                  What do you need to get done?
                </div>
                {isFreeTier && (
                  <span style={{ fontSize: 11, color: '#8A8A9A', flexShrink: 0, marginLeft: 12, paddingTop: 4 }}>
                    {activeTasks.length}/{FREE_TIER_TASK_LIMIT} tasks
                  </span>
                )}
              </div>

              {atFreeCap && (
                <div className="mb-4 flex items-center gap-2 rounded-2xl border border-amber-300/60 bg-amber-50 px-4 py-3" style={{ fontSize: 13 }}>
                  <Lock size={14} className="shrink-0 text-amber-600" />
                  <span style={{ color: '#92400E' }}>
                    You've reached the free plan limit. Upgrade to add more tasks.
                  </span>
                </div>
              )}

              <div className="space-y-4 min-w-0">
                {/* Title */}
                <div className="w-full min-w-0">
                  <label className="block text-sm font-bold text-black/70">Title</label>
                  <input
                    ref={titleRef}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Finish PSET 6"
                    disabled={atFreeCap}
                    className="mt-1 box-border min-w-0 w-full rounded-xl border-0 bg-white px-3 py-3 text-sm outline-none ring-1 ring-inset ring-neutral-300/90 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-rumbo-primary/35 focus-visible:ring-offset-0 disabled:opacity-50"
                  />
                </div>

                {/* Work type badge */}
                {hasTitle ? (
                  <div className="-mt-1 flex items-center gap-2">
                    <div className="text-xs font-semibold text-black/50">Work type</div>
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
                ) : null}

                {/* Expanded fields */}
                <div
                  className={cn(
                    'transition-all duration-500 ease-in-out overflow-hidden',
                    hasTitle ? 'max-h-[min(560px,90vh)] opacity-100 translate-y-0' : 'max-h-0 opacity-0 -translate-y-1 pointer-events-none',
                  )}
                  aria-hidden={!hasTitle}
                >
                  <div className="grid min-w-0 grid-cols-2 gap-4 pt-1">
                    {/* Due date */}
                    <div className="min-w-0">
                      <CalendarDueDateTime
                        value={dueDateTime}
                        onChange={setDueDateTime}
                        onCalendarOpenChange={setIsDatePickerOpen}
                      />
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
                                  const allow = ['Backspace','Delete','ArrowLeft','ArrowRight','Tab','Home','End'].includes(e.key)
                                  if (!allow && !/^\d$/.test(e.key)) e.preventDefault()
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
                                className="h-11 w-11 shrink-0 rounded-none rounded-r-xl border-0 bg-transparent shadow-none ring-0 min-w-0 px-0 hover:bg-neutral-50 focus-visible:ring-0"
                              />
                            </div>
                          ) : (
                            <SelectTrigger
                              placeholder="Select…"
                              className="w-full min-w-0 h-11 rounded-xl border-0 bg-white px-3 text-sm outline-none ring-1 ring-inset ring-neutral-300/90 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-rumbo-primary/35 focus-visible:ring-offset-0"
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

                  {/* Description + PDF — collapsible section */}
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
                      Description &amp; attachments
                    </button>

                    <div
                      className={cn(
                        'transition-all duration-300 ease-in-out overflow-hidden',
                        descriptionOpen ? 'max-h-72 opacity-100 mt-2' : 'max-h-0 opacity-0',
                      )}
                    >
                      {/* Description textarea */}
                      <textarea
                        value={description}
                        onChange={(e) => setDescription(e.target.value.slice(0, 500))}
                        placeholder="Add details or paste instructions..."
                        rows={3}
                        className="box-border w-full resize-none rounded-xl border-0 bg-white px-3 py-3 text-sm outline-none ring-1 ring-inset ring-neutral-300/90 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-rumbo-primary/35"
                      />
                      <p className="mt-1 text-right text-xs text-black/30">{description.length}/500</p>

                      {/* PDF upload — premium gated */}
                      <div className="mt-3">
                        {isFreeTier ? (
                          <div
                            className="flex items-center gap-2 rounded-xl border border-dashed border-neutral-300 px-4 py-3 opacity-60 cursor-not-allowed"
                            title="Upgrade to premium to attach PDFs"
                          >
                            <Lock size={14} className="text-neutral-400 shrink-0" />
                            <span style={{ fontSize: 13, color: '#8A8A9A' }}>Attach PDF</span>
                            <span
                              className="ml-auto rounded-full px-2 py-0.5 text-white"
                              style={{ fontSize: 10, fontWeight: 600, background: '#6B7FBE' }}
                            >
                              Premium
                            </span>
                          </div>
                        ) : (
                          <>
                            <input
                              ref={fileInputRef}
                              type="file"
                              accept=".pdf"
                              className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0] ?? null
                                setPdfFile(file)
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => fileInputRef.current?.click()}
                              className="flex w-full items-center gap-2 rounded-xl border border-dashed border-neutral-300 px-4 py-3 text-sm text-neutral-500 hover:border-neutral-400 hover:text-neutral-700 transition-colors"
                              style={{ background: 'none', cursor: 'pointer' }}
                            >
                              <Paperclip size={14} className="shrink-0" />
                              {pdfFile ? pdfFile.name : 'Attach PDF'}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Error */}
                {displayError ? (
                  <div className="rounded-xl border border-red-500/20 bg-red-50 px-3 py-2 text-sm text-red-700 flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4" />
                    <span>{displayError}</span>
                  </div>
                ) : null}

                {/* Submit */}
                {hasTitle ? (
                  <button
                    type="button"
                    onClick={onSubmit}
                    disabled={!canSubmit}
                    className="w-full rounded-xl bg-rumbo-primary px-3 py-3 text-sm font-semibold text-white disabled:opacity-50 shadow-sm"
                  >
                    {mutation.isPending ? 'Adding…' : 'Add task'}
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
