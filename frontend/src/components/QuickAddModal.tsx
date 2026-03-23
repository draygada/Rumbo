import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEventHandler,
} from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalSize } from '@tauri-apps/api/dpi'
import { AlertTriangle } from 'lucide-react'

import { classifyTaskTitle } from '@/lib/classifier'
import type { ClassifierResult, Task, WorkType } from '@/types'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/store/authStore'
import { cn } from '@/lib/utils'
import { CalendarDueDateTime, type DueDateTimeValue } from '@/components/ui/calendar-date-and-time-range'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'

/** Quick-add window width is fixed. Only two heights: compact (title only) vs expanded (full form). */
const QUICK_ADD_WIDTH = 760
const QUICK_ADD_HEIGHT_COMPACT = 280
/** Tall enough for date popover + estimated select when flipped; fixed-position menus still clip at webview edge. */
const QUICK_ADD_HEIGHT_EXPANDED = 640
/** Keep just a thin clickable backdrop around the card. */
const QUICK_ADD_OUTER_PADDING_PX = 8
/** Extra room for the portaled calendar popover while it is open. */
const QUICK_ADD_CALENDAR_OPEN_EXTRA_PX = 250

type EstimatedTimeMode = 'preset' | 'custom'

function badgeColor(workType: WorkType) {
  return workType === 'deep' ? '#6B7FBE' : '#5BBFB5'
}

export function QuickAddModal() {
  const session = useAuthStore((s) => s.session)

  const titleRef = useRef<HTMLInputElement | null>(null)
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const measureRef = useRef<HTMLDivElement | null>(null)
  const [title, setTitle] = useState('')
  const [dueDateTime, setDueDateTime] = useState<DueDateTimeValue>({
    date: undefined,
    time: '23:59',
  })
  const [estimatedMins, setEstimatedMins] = useState<number>(30)
  const [estimatedTimeMode, setEstimatedTimeMode] = useState<EstimatedTimeMode>('preset')
  const [customHoursDraft, setCustomHoursDraft] = useState('1')
  const [isDatePickerOpen, setIsDatePickerOpen] = useState(false)
  const [overrideWorkType, setOverrideWorkType] = useState<WorkType | null>(null)

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hideQuickAdd = useCallback(async () => {
    try {
      await getCurrentWindow().hide()
    } catch {
      // ignore
    }
  }, [])

  /** Always call through refs in Tauri listeners so HMR never leaves a stale closure (e.g. old `requestResize`). */
  const hideQuickAddRef = useRef(hideQuickAdd)
  hideQuickAddRef.current = hideQuickAdd

  useEffect(() => {
    // autofocus when window opens
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
    // Remove stray WebKit / focus outlines on the root (transparent window often shows a 1px edge).
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

  /** Tracks which of the two sizes we last applied (skip redundant setSize). */
  const lastWindowModeRef = useRef<'compact' | 'expanded' | null>(null)
  const lastAppliedHeightRef = useRef<number | null>(null)
  const didInitialWindowSizeRef = useRef(false)
  /** True while setSize is in flight — suppresses the spurious onFocusChanged that macOS fires after a programmatic resize. */
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
        // Single jump to final size — no stepped animation.
        await win.setSize(new LogicalSize(QUICK_ADD_WIDTH, targetH))
        if (center) await win.center()
        if (focusTitle) window.setTimeout(() => titleRef.current?.focus(), 0)
      } catch {
        // ignore (permissions/runtime)
      } finally {
        // Give macOS a moment to fire (and discard) any focus event caused by setSize.
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
            // Skip if we're already mid-resize — macOS fires a spurious focus
            // event after every programmatic setSize, which would cause a second resize.
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
        // ignore (non-tauri runtime)
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
      try {
        unlisten?.()
      } catch {
        // ignore
      }
    }
    // Intentionally []: listener must only call refs so Fast Refresh / HMR never keeps a dead `requestResize` closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onWindowBlur = () => void hideQuickAdd()
    window.addEventListener('blur', onWindowBlur)
    return () => window.removeEventListener('blur', onWindowBlur)
  }, [hideQuickAdd])

  useEffect(() => {
    // Ensure the transparent window really looks like a rounded modal:
    // - no page background showing through
    // - no scrolling ever1
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
    // One jump between the only two window heights; first paint also centers the window.
    const center = !didInitialWindowSizeRef.current
    didInitialWindowSizeRef.current = true
    void applyQuickAddWindowSize(hasTitle ? 'expanded' : 'compact', { center })
  }, [hasTitle, applyQuickAddWindowSize])

  useEffect(() => {
    void applyQuickAddWindowSize(hasTitleRef.current ? 'expanded' : 'compact', {
      focusTitle: false,
    })
  }, [isDatePickerOpen, applyQuickAddWindowSize])

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

  const customHoursParsed = parseInt(customHoursDraft, 10)
  const customHoursOk =
    estimatedTimeMode !== 'custom' ||
    (customHoursDraft.trim() !== '' &&
      Number.isFinite(customHoursParsed) &&
      customHoursParsed > 0)

  const canSubmit =
    !!session?.user?.id &&
    hasTitle &&
    !!dueDateTime.date &&
    customHoursOk &&
    !submitting

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

  const onSubmit = async () => {
    setError(null)
    if (!supabase) {
      setError('Supabase is not configured.')
      return
    }
    const userId = session?.user?.id
    if (!userId) {
      setError('You must be signed in to add a task.')
      return
    }
    if (!title.trim() || !dueDateTime.date) return

    setSubmitting(true)
    try {
      const nowIso = new Date().toISOString()

      const insert: Omit<Task, 'id'> = {
        user_id: userId,
        title: title.trim(),
        description: null,

        work_type: effectiveWorkType,
        classifier_confidence: classifier.confidence,
        user_overrode_classifier: overrideWorkType != null && overrideWorkType !== classifier.work_type,

        status: 'pending',
        due_at: (() => {
          const d = dueDateTime.date!
          const [hh, mm] = dueDateTime.time.split(':').map((v) => Number(v))
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

      // Insert only the columns we expect in the DB (server will set defaults for many fields if configured).
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

      if (insertError) {
        setError(insertError.message)
        return
      }

      // Close the quick-add window after successful insert
      await hideQuickAdd()

      // reset form for next open
      setTitle('')
      setDueDateTime({ date: undefined, time: '23:59' })
      setEstimatedMins(30)
      setEstimatedTimeMode('preset')
      setCustomHoursDraft('1')
      setOverrideWorkType(null)
    } catch (e) {
      setError((e as Error).message ?? 'Failed to add task.')
    } finally {
      setSubmitting(false)
    }
  }

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
        {/* Transparent backdrop is intentionally clickable so any click outside the card
            closes quick-add immediately. The card itself stops propagation and remains interactive. */}
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
          <div className="mb-4">
            <div className="text-[22px] leading-tight font-bold tracking-tight text-rumbo-text">
              What do you need to get done?
            </div>
          </div>

          <div className="space-y-4 min-w-0">
        <div className="w-full min-w-0">
          <div className="min-w-0">
            <label className="block text-sm font-bold text-black/70">Title</label>
            <input
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Finish PSET 6"
              className="mt-1 box-border min-w-0 w-full rounded-xl border-0 bg-white px-3 py-3 text-sm outline-none ring-1 ring-inset ring-neutral-300/90 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-rumbo-primary/35 focus-visible:ring-offset-0"
            />
          </div>
        </div>

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
                <SelectItem index={0} value="deep">
                  Deep work
                </SelectItem>
                <SelectItem index={1} value="shallow">
                  Shallow work
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        ) : null}

          <div
            className={cn(
              'transition-all duration-500 ease-in-out overflow-hidden',
              hasTitle ? 'max-h-[min(520px,90vh)] opacity-100 translate-y-0' : 'max-h-0 opacity-0 -translate-y-1 pointer-events-none',
            )}
            aria-hidden={!hasTitle}
          >
            <div className="grid min-w-0 grid-cols-2 gap-4 pt-1">
              <div className="min-w-0">
                <CalendarDueDateTime
                  value={dueDateTime}
                  onChange={setDueDateTime}
                  onCalendarOpenChange={setIsDatePickerOpen}
                />
              </div>

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
                          /* SelectTrigger wraps a column div; flatten so the chevron button sits in this row */
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
                            const allowControl =
                              e.key === 'Backspace' ||
                              e.key === 'Delete' ||
                              e.key === 'ArrowLeft' ||
                              e.key === 'ArrowRight' ||
                              e.key === 'Tab' ||
                              e.key === 'Home' ||
                              e.key === 'End'
                            if (allowControl) return
                            if (!/^\d$/.test(e.key)) e.preventDefault()
                          }}
                          onChange={(e) => {
                            const digitsOnly = e.target.value.replace(/\D+/g, '')
                            setCustomHoursDraft(digitsOnly)
                            if (digitsOnly === '') return
                            const h = parseInt(digitsOnly, 10)
                            if (Number.isFinite(h) && h > 0) {
                              const clampedHours = Math.min(h, 168)
                              setEstimatedMins(clampedHours * 60)
                              if (h !== clampedHours) setCustomHoursDraft(String(clampedHours))
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
                      <SelectItem index={0} value="15">
                        15 minutes
                      </SelectItem>
                      <SelectItem index={1} value="30">
                        30 minutes
                      </SelectItem>
                      <SelectItem index={2} value="60">
                        1 hour
                      </SelectItem>
                      <SelectItem index={3} value="180">
                        3 hours
                      </SelectItem>
                      <SelectItem index={4} value="other">
                        Other
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          </div>

          {error ? (
            <div className="rounded-xl border border-red-500/20 bg-red-50 px-3 py-2 text-sm text-red-700 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              <span>{error}</span>
            </div>
          ) : null}

        {hasTitle ? (
          <button
            type="button"
            onClick={() => void onSubmit()}
            disabled={!canSubmit}
            className="w-full rounded-xl bg-rumbo-primary px-3 py-3 text-sm font-semibold text-white disabled:opacity-50 shadow-sm"
          >
            {submitting ? 'Adding…' : 'Add task'}
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

