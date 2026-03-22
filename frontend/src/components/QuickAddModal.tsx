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
  const [customMinsDraft, setCustomMinsDraft] = useState('30')
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

  /** Tracks which of the two sizes we last applied (skip redundant setSize). */
  const lastWindowModeRef = useRef<'compact' | 'expanded' | null>(null)
  const didInitialWindowSizeRef = useRef(false)

  const applyQuickAddWindowSize = useCallback(
    async (mode: 'compact' | 'expanded', options?: { center?: boolean }) => {
      const center = options?.center ?? false
      const targetH = mode === 'compact' ? QUICK_ADD_HEIGHT_COMPACT : QUICK_ADD_HEIGHT_EXPANDED
      if (!center && lastWindowModeRef.current === mode) return
      lastWindowModeRef.current = mode
      try {
        const win = getCurrentWindow()
        // Single jump to final size — no stepped animation.
        await win.setSize(new LogicalSize(QUICK_ADD_WIDTH, targetH))
        if (center) await win.center()
        window.setTimeout(() => titleRef.current?.focus(), 0)
      } catch {
        // ignore (permissions/runtime)
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
            void applyQuickAddWindowSizeRef.current(
              hasTitleRef.current ? 'expanded' : 'compact',
              { center: true },
            )
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
    // - no scrolling ever
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

  const customMinsParsed = parseInt(customMinsDraft, 10)
  const customMinsOk =
    estimatedTimeMode !== 'custom' ||
    (customMinsDraft.trim() !== '' &&
      Number.isFinite(customMinsParsed) &&
      customMinsParsed > 0)

  const canSubmit =
    !!session?.user?.id &&
    hasTitle &&
    !!dueDateTime.date &&
    customMinsOk &&
    !submitting

  const estimatedSelectValue =
    estimatedTimeMode === 'custom' ? 'other' : String(estimatedMins)

  const onEstimatedSelectChange = (v: string) => {
    if (v === 'other') {
      setEstimatedTimeMode('custom')
      setCustomMinsDraft(String(estimatedMins))
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
            ? Math.min(Math.max(1, customMinsParsed), 10080)
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
      setCustomMinsDraft('30')
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
      className="w-full h-full min-h-0 bg-transparent overflow-visible px-5 py-4 outline-none pointer-events-none"
      onPointerDownCapture={onRootPointerDownCapture}
    >
      <div
        ref={measureRef}
        className="relative box-border flex min-h-0 w-full items-center justify-center outline-none pointer-events-none"
      >
        {/* pointer-events-none on the wrappers lets clicks on the transparent padding
            pass through to the app below. The card re-enables pointer events so it
            stays fully interactive. onFocusChanged handles dismissal when the user
            clicks on another app (OS focus change fires → hideQuickAdd). */}
        <div
          ref={surfaceRef}
          className={cn(
            'relative w-full rounded-[42px] bg-white outline-none pointer-events-auto',
            /* Real border draws evenly on L/R; 1px box-shadow hairline often looks weak on vertical edges at large radius */
            'border border-solid border-neutral-200/90',
            'shadow-[0_1px_2px_rgba(0,0,0,0.03),0_8px_28px_rgba(0,0,0,0.07),0_28px_56px_rgba(0,0,0,0.05)]',
            'antialiased [transform:translateZ(0)]',
          )}
          onMouseDown={(e) => e.stopPropagation()}
        >
        {/* overflow-hidden on inner only so box-shadow on parent isn’t clipped */}
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
              <SelectContent>
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
                <CalendarDueDateTime value={dueDateTime} onChange={setDueDateTime} />
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
                          type="number"
                          min={1}
                          max={10080}
                          inputMode="numeric"
                          aria-label="Estimated time in minutes"
                          placeholder="Minutes"
                          className="min-h-0 min-w-0 flex-1 border-0 bg-transparent px-3 py-2 text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                          value={customMinsDraft}
                          onChange={(e) => {
                            const next = e.target.value
                            setCustomMinsDraft(next)
                            if (next.trim() === '') return
                            const n = parseInt(next, 10)
                            if (Number.isFinite(n) && n > 0) {
                              const clamped = Math.min(n, 10080)
                              setEstimatedMins(clamped)
                              if (n !== clamped) setCustomMinsDraft(String(clamped))
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
                    <SelectContent>
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

