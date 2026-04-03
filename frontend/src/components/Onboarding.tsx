import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, ChevronLeft, Loader2, X } from 'lucide-react'

import rumboLogo from '@/assets/rumbo-logo.png'
import googleCalendarLogo from '@/assets/google-calendar-logo.png'
import outlookLogo from '@/assets/outlook-logo.png'
import { OnboardingProgressSteps } from '@/components/ui/steps'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/store/authStore'
import type { LearningProfile, PeakWindow, RecurringBlock } from '@/types'

type OnboardingProps = {
  onComplete: () => void
}

type FocusLength = 'up_to_1h' | '1_to_2h' | '2_to_4h' | '4h_plus'
type Step = 1 | 2 | 3 | 4
type PrefSubStep = 1 | 2 | 3 | 4

/** Native inputs: drop WebKit/system green focus halo; optional accent for time controls. */
const ONBOARDING_PREF_INPUT =
  'border border-[#E8E8EC] bg-white px-3 text-[#1A1A2E] outline-none focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 shadow-none focus:shadow-none focus-visible:shadow-none accent-[#6B7FBE]'

const DAY_OPTIONS = [
  { key: 'monday', short: 'M', label: 'Mon' },
  { key: 'tuesday', short: 'T', label: 'Tue' },
  { key: 'wednesday', short: 'W', label: 'Wed' },
  { key: 'thursday', short: 'T', label: 'Thu' },
  { key: 'friday', short: 'F', label: 'Fri' },
  { key: 'saturday', short: 'S', label: 'Sat' },
  { key: 'sunday', short: 'S', label: 'Sun' },
] as const

function seededPeakMap(window: PeakWindow) {
  return Array.from({ length: 24 }, (_, hour) => {
    const inWindow =
      (window === 'early_bird' && hour < 6) ||
      (window === 'morning' && hour >= 6 && hour < 12) ||
      (window === 'afternoon' && hour >= 12 && hour < 21) ||
      (window === 'night' && (hour >= 21 || hour < 2))
    return { hour, score: inWindow ? 0.92 : 0.38 }
  })
}

/** Representative block length (minutes) for the scheduler from onboarding choice. */
function targetBlockMins(length: FocusLength): number {
  if (length === 'up_to_1h') return 45
  if (length === '1_to_2h') return 90
  if (length === '2_to_4h') return 180
  return 240
}

function formatTime12h(value: string) {
  const [hhRaw, mmRaw] = value.split(':')
  const hh = Number(hhRaw)
  const mm = Number(mmRaw)
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return value
  const suffix = hh >= 12 ? 'PM' : 'AM'
  const hour12 = hh % 12 === 0 ? 12 : hh % 12
  return `${hour12}:${String(mm).padStart(2, '0')} ${suffix}`
}

export function Onboarding({ onComplete }: OnboardingProps) {
  const session = useAuthStore((s) => s.session)
  const userId = session?.user?.id ?? null

  const [step, setStep] = useState<Step>(1)
  const [direction, setDirection] = useState<1 | -1>(1)
  /** Highest step the user has reached; used so progress pills can jump back/forth among visited steps. */
  const [maxStepReached, setMaxStepReached] = useState<Step>(1)

  /** Preferences (step 3) sub-steps — one question per screen to avoid scrolling. */
  const [prefSubStep, setPrefSubStep] = useState<PrefSubStep>(1)
  const prevMainStepRef = useRef<Step>(1)

  const [googleConnected, setGoogleConnected] = useState(false)
  const [outlookConnected, setOutlookConnected] = useState(false)
  const [calendarLoading, setCalendarLoading] = useState<'google' | 'outlook' | null>(null)

  const [peakWindow, setPeakWindow] = useState<PeakWindow | null>(null)
  const [unavailableBefore, setUnavailableBefore] = useState('08:00')
  const [unavailableAfter, setUnavailableAfter] = useState('23:00')
  const [focusLength, setFocusLength] = useState<FocusLength | null>(null)
  const [recurringDays, setRecurringDays] = useState<string[]>([])
  const [recurringStart, setRecurringStart] = useState('15:00')
  const [recurringEnd, setRecurringEnd] = useState('17:00')
  const [recurringLabel, setRecurringLabel] = useState('')
  const [recurringBlocks, setRecurringBlocks] = useState<RecurringBlock[]>([])

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canContinuePrefs =
    peakWindow != null && focusLength != null && unavailableBefore.trim() !== '' && unavailableAfter.trim() !== ''

  useEffect(() => {
    const prev = prevMainStepRef.current
    if (step === 3) {
      if (prev === 2) setPrefSubStep(1)
      else if (prev === 4) setPrefSubStep(4)
      else if (prev !== 3) setPrefSubStep(1)
    }
    prevMainStepRef.current = step
  }, [step])

  const canAdvancePrefSub = (() => {
    if (prefSubStep === 1) return peakWindow != null
    if (prefSubStep === 2)
      return unavailableBefore.trim() !== '' && unavailableAfter.trim() !== ''
    if (prefSubStep === 3) return focusLength != null
    return true
  })()

  const hasCalendarConnection = googleConnected || outlookConnected

  const goToStep = (next: Step) => {
    if (next === step) return
    if (next > maxStepReached) return
    setDirection(next > step ? 1 : -1)
    setStep(next)
    setError(null)
  }

  const advanceToStep = (next: Step) => {
    if (next === step) return
    setDirection(next > step ? 1 : -1)
    setStep(next)
    setMaxStepReached((m) => (next > m ? next : m))
    setError(null)
  }

  const handleCalendarConnect = (provider: 'google' | 'outlook') => {
    setCalendarLoading(provider)
    console.log('Initiating OAuth for', provider)
    window.setTimeout(() => {
      if (provider === 'google') setGoogleConnected(true)
      else setOutlookConnected(true)
      setCalendarLoading(null)
    }, 2000)
  }

  const onCalendarContinue = async () => {
    if (!userId || !supabase) return
    if (!googleConnected && !outlookConnected) return
    setSaving(true)
    setError(null)
    const { error: updateError } = await supabase
      .from('users')
      .update({
        google_calendar_connected: googleConnected,
        outlook_connected: outlookConnected,
        google_oauth_tokens: googleConnected ? {} : null,
        outlook_oauth_tokens: outlookConnected ? {} : null,
      })
      .eq('id', userId)
    setSaving(false)
    if (updateError) {
      setError(updateError.message)
      return
    }
    advanceToStep(3)
  }

  const onCalendarSkip = async () => {
    if (!userId || !supabase) return
    setSaving(true)
    setError(null)
    const { error: updateError } = await supabase
      .from('users')
      .update({
        google_calendar_connected: false,
        outlook_connected: false,
        google_oauth_tokens: null,
        outlook_oauth_tokens: null,
      })
      .eq('id', userId)
    setSaving(false)
    if (updateError) {
      setError(updateError.message)
      return
    }
    advanceToStep(3)
  }

  const toggleRecurringDay = (day: string) => {
    setRecurringDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day],
    )
  }

  const addRecurringBlock = () => {
    if (recurringDays.length === 0 || !recurringStart || !recurringEnd) return
    const next: RecurringBlock = {
      days: recurringDays,
      start_time: recurringStart,
      end_time: recurringEnd,
      label: recurringLabel.trim(),
    }
    setRecurringBlocks((prev) => [...prev, next])
    setRecurringDays([])
    setRecurringLabel('')
  }

  const savePreferences = async () => {
    if (!userId || !peakWindow || !focusLength || !supabase) return
    setSaving(true)
    setError(null)

    const payload: LearningProfile = {
      user_id: userId,
      peak_hour_map: seededPeakMap(peakWindow),
      target_block_mins: targetBlockMins(focusLength),
      unavailable_before: unavailableBefore,
      unavailable_after: unavailableAfter,
      recurring_blocks: recurringBlocks,
    }

    const { error: upsertError } = await supabase
      .from('learning_profile')
      .upsert(payload, { onConflict: 'user_id' })
    setSaving(false)
    if (upsertError) {
      setError(upsertError.message)
      return
    }
    advanceToStep(4)
  }

  const finishOnboarding = async () => {
    if (!userId || !supabase) return
    setSaving(true)
    setError(null)
    const { error: updateError } = await supabase
      .from('users')
      .update({ onboarding_complete: true })
      .eq('id', userId)
    setSaving(false)
    if (updateError) {
      setError(updateError.message)
      return
    }
    onComplete()
  }

  const onPreferencesNext = () => {
    if (prefSubStep < 4) {
      if (!canAdvancePrefSub) return
      setPrefSubStep((s) => (s < 4 ? ((s + 1) as PrefSubStep) : s))
      return
    }
    void savePreferences()
  }

  const onPreferencesBack = () => {
    if (prefSubStep > 1) {
      setPrefSubStep((s) => (s > 1 ? ((s - 1) as PrefSubStep) : s))
      return
    }
    goToStep(2)
  }

  const recurringPreview = useMemo(
    () =>
      recurringBlocks.map((b, idx) => ({
        id: idx,
        text: `${b.days
          .map((d) => DAY_OPTIONS.find((x) => x.key === d)?.label ?? d)
          .join(', ')} · ${formatTime12h(b.start_time)}–${formatTime12h(b.end_time)} · ${
          b.label || 'No label'
        }`,
      })),
    [recurringBlocks],
  )

  return (
    <div className="min-h-screen bg-[#F5F5F3] flex items-center justify-center p-6">
      <div className="w-full max-w-[600px] rounded-[20px] bg-white p-12 shadow-sm">
        <img src={rumboLogo} alt="Rumbo" className="h-8 w-auto" />

        <div className="mt-8 mb-6">
          <OnboardingProgressSteps
            currentStep={step}
            maxStepReached={maxStepReached}
            onStepChange={(s) => goToStep(s)}
            disabled={saving}
          />
        </div>

        <div className="relative min-h-[320px] overflow-hidden sm:min-h-[380px]">
          <AnimatePresence mode="wait" custom={direction}>
            <motion.div
              key={step}
              custom={direction}
              initial={{ x: direction > 0 ? 70 : -70, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: direction > 0 ? -70 : 70, opacity: 0 }}
              transition={{ duration: 0.35, ease: 'easeInOut' }}
            >
              {step === 1 ? (
                <div className="pt-8 text-center">
                  <h1 className="text-[28px] font-semibold text-[#1A1A2E]">Let&apos;s build your schedule.</h1>
                  <p className="mx-auto mt-4 max-w-[420px] text-base text-[#4A4A5A]">
                    Takes about 2 minutes. We&apos;ll ask a few questions to set up a schedule that
                    actually fits how you work.
                  </p>
                  <button
                    type="button"
                    className="mt-10 h-12 w-full rounded-xl bg-[#6B7FBE] text-white font-semibold"
                    onClick={() => advanceToStep(2)}
                  >
                    Get started →
                  </button>
                </div>
              ) : null}

              {step === 2 ? (
                <div className="pt-4">
                  <h2 className="text-[28px] font-semibold text-[#1A1A2E]">Connect your Calendar of Choice</h2>
                  <p className="mt-3 text-base text-[#4A4A5A]">
                    Rumbo works best when we can work with your existing calendar.
                  </p>

                  <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <button
                      type="button"
                      className={`rounded-xl border-[1.5px] p-5 text-left transition-colors hover:border-[#6B7FBE] disabled:opacity-60 ${
                        googleConnected ? 'border-[#5BBFB5] bg-[#FAFDFC]' : 'border-[#E8E8EC]'
                      }`}
                      disabled={calendarLoading !== null}
                      onClick={() => handleCalendarConnect('google')}
                    >
                      <div className="flex items-start gap-3">
                        <img
                          src={googleCalendarLogo}
                          alt=""
                          className="h-10 w-10 shrink-0 object-contain"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-semibold text-[#1A1A2E]">Google Calendar</div>
                          {googleConnected ? (
                            <div className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-[#5BBFB5]">
                              <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
                              Connected
                            </div>
                          ) : (
                            <div className="mt-1 text-xs text-[#8A8A9A]">Connect your account</div>
                          )}
                        </div>
                        {calendarLoading === 'google' ? (
                          <Loader2 className="h-5 w-5 shrink-0 animate-spin text-[#6B7FBE]" aria-hidden />
                        ) : null}
                      </div>
                    </button>
                    <button
                      type="button"
                      className={`rounded-xl border-[1.5px] p-5 text-left transition-colors hover:border-[#6B7FBE] disabled:opacity-60 ${
                        outlookConnected ? 'border-[#5BBFB5] bg-[#FAFDFC]' : 'border-[#E8E8EC]'
                      }`}
                      disabled={calendarLoading !== null}
                      onClick={() => handleCalendarConnect('outlook')}
                    >
                      <div className="flex items-start gap-3">
                        <img
                          src={outlookLogo}
                          alt=""
                          className="h-10 w-auto max-w-[100px] shrink-0 object-contain"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-semibold text-[#1A1A2E]">Outlook</div>
                          {outlookConnected ? (
                            <div className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-[#5BBFB5]">
                              <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
                              Connected
                            </div>
                          ) : (
                            <div className="mt-1 text-xs text-[#8A8A9A]">Connect your account</div>
                          )}
                        </div>
                        {calendarLoading === 'outlook' ? (
                          <Loader2 className="h-5 w-5 shrink-0 animate-spin text-[#6B7FBE]" aria-hidden />
                        ) : null}
                      </div>
                    </button>
                  </div>

                  {calendarLoading ? (
                    <div className="mt-4 flex items-center gap-2 text-sm text-[#4A4A5A]">
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      <span>Waiting for browser authorization...</span>
                    </div>
                  ) : null}

                  <div
                    className={cn(
                      'mt-8 flex w-full gap-3',
                      hasCalendarConnection
                        ? 'flex-col sm:flex-row sm:items-stretch'
                        : 'flex-row items-center justify-between',
                    )}
                  >
                    <button
                      type="button"
                      className={cn(
                        'flex h-12 shrink-0 items-center justify-center gap-2 rounded-xl border-[1.5px] border-[#E8E8EC] px-4 text-sm font-semibold text-[#4A4A5A] transition-colors hover:border-[#6B7FBE] hover:text-[#1A1A2E] disabled:opacity-50',
                        hasCalendarConnection
                          ? 'order-2 sm:order-1'
                          : 'order-1 w-28 justify-center',
                      )}
                      onClick={() => goToStep(1)}
                      disabled={calendarLoading !== null || saving}
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Back
                    </button>
                    {hasCalendarConnection ? (
                      <button
                        type="button"
                        className="order-1 h-12 flex-1 rounded-xl bg-[#6B7FBE] text-white font-semibold disabled:opacity-60 sm:order-2"
                        onClick={() => void onCalendarContinue()}
                        disabled={saving}
                      >
                        Continue →
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="order-2 flex h-12 w-28 shrink-0 items-center justify-center rounded-xl border-[1.5px] border-[#E8E8EC] bg-white px-4 text-sm font-semibold text-[#4A4A5A] transition-colors hover:border-[#6B7FBE] hover:text-[#1A1A2E] disabled:opacity-50"
                        onClick={() => void onCalendarSkip()}
                        disabled={calendarLoading !== null || saving}
                      >
                        Skip
                      </button>
                    )}
                  </div>
                </div>
              ) : null}

              {step === 3 ? (
                <div className="pt-2">
                  <h2 className="text-[24px] font-semibold leading-tight text-[#1A1A2E] sm:text-[28px]">
                    How do you work?
                  </h2>
                  <p className="mt-1 text-sm text-[#4A4A5A] sm:text-base">
                  </p>
                  <p className="mt-2 text-xs font-medium text-[#8A8A9A]">
                    Question {prefSubStep} of 4
                  </p>

                  <AnimatePresence mode="wait">
                    <motion.div
                      key={prefSubStep}
                      initial={{ opacity: 0, x: 16 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -16 }}
                      transition={{ duration: 0.22, ease: 'easeOut' }}
                      className="mt-5"
                    >
                      {prefSubStep === 1 ? (
                        <div>
                          <div className="mb-3 text-sm font-semibold text-[#1A1A2E]">
                            When do you usually work best?
                          </div>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            {[
                              { id: 'early_bird' as const, label: 'Early bird', sub: 'Before 6am' },
                              { id: 'morning' as const, label: 'Morning', sub: '6am–12pm' },
                              { id: 'afternoon' as const, label: 'Afternoon', sub: '12pm–9pm' },
                              { id: 'night' as const, label: 'Night owl', sub: '9pm–2am' },
                            ].map((opt) => (
                              <button
                                key={opt.id}
                                type="button"
                                onClick={() => setPeakWindow(opt.id)}
                                className={cn(
                                  'flex w-full min-h-[3rem] flex-col items-start justify-center rounded-xl border-[1.5px] px-4 py-3 text-left transition-colors',
                                  peakWindow === opt.id
                                    ? 'border-[#6B7FBE] bg-[#6B7FBE] text-white'
                                    : 'border-[#E8E8EC] bg-white text-[#4A4A5A] hover:border-[#6B7FBE] hover:text-[#1A1A2E]',
                                )}
                              >
                                <span className="text-sm font-semibold">{opt.label}</span>
                                <span
                                  className={cn(
                                    'mt-0.5 text-xs',
                                    peakWindow === opt.id ? 'text-white/85' : 'text-[#8A8A9A]',
                                  )}
                                >
                                  {opt.sub}
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {prefSubStep === 2 ? (
                        <div>
                          <div className="mb-3 text-sm font-semibold text-[#1A1A2E]">
                            When are you never available?
                          </div>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div>
                              <div className="mb-1 text-[13px] font-bold text-[#1A1A2E]">Never before</div>
                              <input
                                type="time"
                                value={unavailableBefore}
                                onChange={(e) => setUnavailableBefore(e.target.value)}
                                className={cn(ONBOARDING_PREF_INPUT, 'h-11 w-full rounded-xl')}
                              />
                            </div>
                            <div>
                              <div className="mb-1 text-[13px] font-bold text-[#1A1A2E]">Never after</div>
                              <input
                                type="time"
                                value={unavailableAfter}
                                onChange={(e) => setUnavailableAfter(e.target.value)}
                                className={cn(ONBOARDING_PREF_INPUT, 'h-11 w-full rounded-xl')}
                              />
                            </div>
                          </div>
                        </div>
                      ) : null}

                      {prefSubStep === 3 ? (
                        <div>
                          <div className="mb-3 text-sm font-semibold text-[#1A1A2E]">
                            How long do you usually study at one time?
                          </div>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            {[
                              { id: 'up_to_1h' as const, label: 'An hour or less', sub: '≤ 1 hour' },
                              { id: '1_to_2h' as const, label: '1–2 hours', sub: '60–120 min' },
                              { id: '2_to_4h' as const, label: '2–4 hours', sub: '120–240 min' },
                              { id: '4h_plus' as const, label: '4 hours or more', sub: '240+ min' },
                            ].map((opt) => (
                              <button
                                key={opt.id}
                                type="button"
                                onClick={() => setFocusLength(opt.id)}
                                className={cn(
                                  'flex w-full min-h-[3rem] flex-col items-start justify-center rounded-xl border-[1.5px] px-4 py-3 text-left transition-colors',
                                  focusLength === opt.id
                                    ? 'border-[#6B7FBE] bg-[#6B7FBE] text-white'
                                    : 'border-[#E8E8EC] bg-white text-[#4A4A5A] hover:border-[#6B7FBE] hover:text-[#1A1A2E]',
                                )}
                              >
                                <span className="text-sm font-semibold">{opt.label}</span>
                                <span
                                  className={cn(
                                    'mt-0.5 text-xs',
                                    focusLength === opt.id ? 'text-white/85' : 'text-[#8A8A9A]',
                                  )}
                                >
                                  {opt.sub}
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {prefSubStep === 4 ? (
                        <div>
                          <div className="text-sm font-semibold text-[#1A1A2E]">
                            Any recurring commitments not on your calendar?
                          </div>
                          <div className="mt-1 text-xs text-[#8A8A9A]">
                            Optional — e.g. gym, work shift. Rumbo will not schedule over these.
                          </div>
                          <div className="mt-3 flex flex-wrap gap-1">
                            {DAY_OPTIONS.map((d) => {
                              const selected = recurringDays.includes(d.key)
                              return (
                                <button
                                  key={d.key}
                                  type="button"
                                  onClick={() => toggleRecurringDay(d.key)}
                                  className="h-8 min-w-8 rounded-full border px-2 text-xs font-semibold"
                                  style={{
                                    background: selected ? '#6B7FBE' : '#fff',
                                    color: selected ? '#fff' : '#1A1A2E',
                                    borderColor: selected ? '#6B7FBE' : '#E8E8EC',
                                  }}
                                >
                                  {d.short}
                                </button>
                              )
                            })}
                          </div>
                          <div className="mt-3 grid grid-cols-2 gap-2">
                            <input
                              type="time"
                              value={recurringStart}
                              onChange={(e) => setRecurringStart(e.target.value)}
                              className={cn(ONBOARDING_PREF_INPUT, 'h-10 rounded-xl')}
                            />
                            <input
                              type="time"
                              value={recurringEnd}
                              onChange={(e) => setRecurringEnd(e.target.value)}
                              className={cn(ONBOARDING_PREF_INPUT, 'h-10 rounded-xl')}
                            />
                          </div>
                          <div className="mt-2 flex gap-2">
                            <input
                              type="text"
                              placeholder="e.g. Gym, Work"
                              value={recurringLabel}
                              onChange={(e) => setRecurringLabel(e.target.value)}
                              className={cn(ONBOARDING_PREF_INPUT, 'h-10 min-w-0 flex-1 rounded-xl')}                            />
                            <button
                              type="button"
                              onClick={addRecurringBlock}
                              className="h-10 shrink-0 rounded-xl border border-[#6B7FBE] px-4 text-sm font-semibold text-[#6B7FBE]"
                            >
                              Add
                            </button>
                          </div>
                          {recurringPreview.length > 0 ? (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {recurringPreview.map((item) => (
                                <button
                                  key={item.id}
                                  type="button"
                                  className="inline-flex max-w-full items-center gap-2 rounded-full bg-[#EEF0FA] px-3 py-1.5 text-left text-xs text-[#6B7FBE]"
                                  onClick={() =>
                                    setRecurringBlocks((prev) => prev.filter((_, idx) => idx !== item.id))
                                  }
                                >
                                  <span className="truncate">{item.text}</span>
                                  <X className="h-3.5 w-3.5 shrink-0" />
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </motion.div>
                  </AnimatePresence>

                  <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-stretch">
                    <button
                      type="button"
                      className="order-2 flex h-12 shrink-0 items-center justify-center gap-2 rounded-xl border-[1.5px] border-[#E8E8EC] px-4 text-sm font-semibold text-[#4A4A5A] transition-colors hover:border-[#6B7FBE] hover:text-[#1A1A2E] disabled:opacity-50 sm:order-1"
                      onClick={onPreferencesBack}
                      disabled={saving}
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Back
                    </button>
                    <button
                      type="button"
                      className="order-1 h-12 flex-1 rounded-xl bg-[#6B7FBE] text-white font-semibold disabled:opacity-60 sm:order-2"
                      disabled={
                        saving ||
                        (prefSubStep < 4 ? !canAdvancePrefSub : !canContinuePrefs)
                      }
                      onClick={() => void onPreferencesNext()}
                    >
                      {prefSubStep < 4 ? 'Next' : 'Continue →'}
                    </button>
                  </div>
                </div>
              ) : null}

              {step === 4 ? (
                <div className="pt-10 text-center">
                  <svg viewBox="0 0 64 64" className="mx-auto h-16 w-16">
                    <motion.path
                      d="M14 34L27 47L50 20"
                      fill="none"
                      stroke="#5BBFB5"
                      strokeWidth="6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      initial={{ pathLength: 0 }}
                      animate={{ pathLength: 1 }}
                      transition={{ duration: 0.6, ease: 'easeInOut' }}
                    />
                  </svg>
                  <h2 className="mt-5 text-[28px] font-semibold text-[#1A1A2E]">You&apos;re all set.</h2>
                  <p className="mx-auto mt-3 max-w-[430px] text-base text-[#4A4A5A]">
                    Add your first task to see Rumbo in action. Your schedule will build itself around
                    how you work.
                  </p>
                  <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-stretch">
                    <button
                      type="button"
                      className="order-2 flex h-12 shrink-0 items-center justify-center gap-2 rounded-xl border-[1.5px] border-[#E8E8EC] px-4 text-sm font-semibold text-[#4A4A5A] transition-colors hover:border-[#6B7FBE] hover:text-[#1A1A2E] disabled:opacity-50 sm:order-1"
                      onClick={() => goToStep(3)}
                      disabled={saving}
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Back
                    </button>
                    <button
                      type="button"
                      className="order-1 h-12 flex-1 rounded-xl bg-[#6B7FBE] text-white font-semibold disabled:opacity-60 sm:order-2"
                      onClick={() => void finishOnboarding()}
                      disabled={saving}
                    >
                      Go to dashboard →
                    </button>
                  </div>
                </div>
              ) : null}
            </motion.div>
          </AnimatePresence>
        </div>

        {error ? <div className="mt-4 text-sm text-red-600">{error}</div> : null}
      </div>
    </div>
  )
}

