import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, ChevronLeft, Loader2 } from 'lucide-react'

import rumboLogo from '@/assets/rumbo-logo.png'
import googleCalendarLogo from '@/assets/google-calendar-logo.png'
import outlookLogo from '@/assets/outlook-logo.png'
import { OnboardingProgressSteps } from '@/components/ui/steps'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/store/authStore'
import type { DayFragmentation, HourScore, PeakWindow } from '@/types'

type OnboardingProps = {
  onComplete: () => void
  /** Resume at a specific step (from users.onboarding_step). Defaults to 1. */
  initialStep?: Step
}

type Step = 1 | 2 | 3 | 4
type PrefSubStep = 1 | 2 | 3
type Q4Option = 'none' | '1-2' | '3-4' | '5+'

/** Native inputs: drop WebKit/system green focus halo; optional accent for time controls. */
const ONBOARDING_PREF_INPUT =
  'border border-[#E8E8EC] bg-white px-3 text-[#1A1A2E] outline-none focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 shadow-none focus:shadow-none focus-visible:shadow-none accent-[#6B7FBE]'

// Q3: session length → target_block_mins per spec (25 / 35 / 50 / 75)
const Q3_OPTIONS = [
  { id: 'lt_30', label: 'Less than 30 min', sub: 'Under 30 minutes', mins: 25 },
  { id: '30_45', label: '30–45 min', sub: '30 to 45 minutes', mins: 35 },
  { id: '45_60', label: '45–60 min', sub: '45 to 60 minutes', mins: 50 },
  { id: '60_90', label: '60–90 min', sub: '60 to 90 minutes', mins: 75 },
] as const

// Q4: commitment count → day_fragmentation per spec
const Q4_OPTIONS: { id: Q4Option; label: string; sub: string; fragmentation: DayFragmentation }[] = [
  { id: 'none', label: 'None', sub: 'No fixed commitments', fragmentation: 'low' },
  { id: '1-2', label: '1–2', sub: '1 to 2 commitments', fragmentation: 'medium' },
  { id: '3-4', label: '3–4', sub: '3 to 4 commitments', fragmentation: 'high' },
  { id: '5+', label: '5 or more', sub: '5 or more commitments', fragmentation: 'very_high' },
]

/**
 * Seeds peak_hour_map from the student's self-reported work window.
 * Hour ranges and scores per build reference:
 *   Early Bird  → hours 5–9   scored 0.8
 *   Morning     → hours 8–12  scored 0.8
 *   Afternoon   → hours 12–17 scored 0.8
 *   Night Owl   → hours 19–23 scored 0.8
 *   All others  → 0.3
 * Early Bird and Morning overlap at 8–9am intentionally.
 */
function seededPeakMap(window: PeakWindow): HourScore[] {
  return Array.from({ length: 24 }, (_, hour) => {
    const inWindow =
      (window === 'early_bird' && hour >= 5 && hour <= 9) ||
      (window === 'morning' && hour >= 8 && hour <= 12) ||
      (window === 'afternoon' && hour >= 12 && hour <= 17) ||
      (window === 'night_owl' && hour >= 19)
    return { hour, score: inWindow ? 0.8 : 0.3 }
  })
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

export function Onboarding({ onComplete, initialStep = 1 }: OnboardingProps) {
  const session = useAuthStore((s) => s.session)
  const userId = session?.user?.id ?? null

  const [step, setStep] = useState<Step>(initialStep)
  const [direction, setDirection] = useState<1 | -1>(1)
  const [maxStepReached, setMaxStepReached] = useState<Step>(initialStep)

  // Step 2 sub-steps: Q1 (peak time), Q2 (unavailable hours), Q3 (session length)
  const [prefSubStep, setPrefSubStep] = useState<PrefSubStep>(1)
  const prevMainStepRef = useRef<Step>(1)

  // Calendar connect (step 4)
  const [googleConnected, setGoogleConnected] = useState(false)
  const [outlookConnected, setOutlookConnected] = useState(false)
  const [calendarLoading, setCalendarLoading] = useState<'google' | 'outlook' | null>(null)

  // Q1 — peak work window
  const [peakWindow, setPeakWindow] = useState<PeakWindow | null>(null)
  // Q2 — unavailable hours
  const [unavailableBefore, setUnavailableBefore] = useState('08:00')
  const [unavailableAfter, setUnavailableAfter] = useState('23:00')
  // Q3 — session length → target_block_mins
  const [targetBlockMins, setTargetBlockMins] = useState<number | null>(null)
  // Q4 — commitment count → day_fragmentation
  const [q4Option, setQ4Option] = useState<Q4Option | null>(null)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset sub-step when entering/leaving step 2
  useEffect(() => {
    const prev = prevMainStepRef.current
    if (step === 2) {
      if (prev === 1) setPrefSubStep(1)
      else if (prev === 3) setPrefSubStep(3)
      else if (prev !== 2) setPrefSubStep(1)
    }
    prevMainStepRef.current = step
  }, [step])

  const canAdvancePrefSub = (() => {
    if (prefSubStep === 1) return peakWindow != null
    if (prefSubStep === 2) return unavailableBefore.trim() !== '' && unavailableAfter.trim() !== ''
    return targetBlockMins != null
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

  // Step 1 → 2: persist onboarding_step = '2'
  const onWelcomeContinue = async () => {
    if (!userId || !supabase) return
    const { error: updateError } = await supabase
      .from('users')
      .update({ onboarding_step: '2' })
      .eq('id', userId)
    if (updateError) {
      setError(updateError.message)
      return
    }
    advanceToStep(2)
  }

  // Step 2 sub-steps
  const onPreferencesNext = () => {
    if (prefSubStep < 3) {
      if (!canAdvancePrefSub) return
      setPrefSubStep((s) => (s < 3 ? ((s + 1) as PrefSubStep) : s))
      return
    }
    void saveQ1Q2Q3AndAdvance()
  }

  const onPreferencesBack = () => {
    if (prefSubStep > 1) {
      setPrefSubStep((s) => (s > 1 ? ((s - 1) as PrefSubStep) : s))
      return
    }
    goToStep(1)
  }

  // Step 2 → 3: save Q1/Q2/Q3 to users + persist step = '3'
  const saveQ1Q2Q3AndAdvance = async () => {
    if (!userId || !peakWindow || !targetBlockMins || !supabase) return
    setSaving(true)
    setError(null)
    const { error: updateError } = await supabase
      .from('users')
      .update({
        onboarding_q1: peakWindow,
        onboarding_q2_before: unavailableBefore,
        onboarding_q2_after: unavailableAfter,
        onboarding_q3: targetBlockMins,
        onboarding_step: '3',
      })
      .eq('id', userId)
    setSaving(false)
    if (updateError) {
      setError(updateError.message)
      return
    }
    advanceToStep(3)
  }

  // Step 3 → 4: save Q4 to users + seed learning_profile + persist step = '4'
  const saveQ4AndAdvance = async () => {
    if (!userId || !peakWindow || !targetBlockMins || !q4Option || !supabase) return
    setSaving(true)
    setError(null)

    const q4Entry = Q4_OPTIONS.find((o) => o.id === q4Option)!

    const { error: userError } = await supabase
      .from('users')
      .update({
        onboarding_q4: q4Option,
        onboarding_step: '4',
      })
      .eq('id', userId)

    if (userError) {
      setSaving(false)
      setError(userError.message)
      return
    }

    // Seed learning_profile with all cold-start values per build reference
    const { error: profileError } = await supabase
      .from('learning_profile')
      .upsert(
        {
          user_id: userId,
          peak_hour_map: seededPeakMap(peakWindow),
          target_block_mins: targetBlockMins,
          deadline_strategy: 'even',
          shallow_before_deep: true,
          unavailable_before: unavailableBefore,
          unavailable_after: unavailableAfter,
          day_fragmentation: q4Entry.fragmentation,
          peak_hour_confidence: 0.0,
          reflection_count: 0,
        },
        { onConflict: 'user_id' },
      )

    setSaving(false)
    if (profileError) {
      setError(profileError.message)
      return
    }

    advanceToStep(4)
  }

  // Calendar connect — placeholder OAuth (real implementation in Phase 4)
  const handleCalendarConnect = (provider: 'google' | 'outlook') => {
    setCalendarLoading(provider)
    window.setTimeout(() => {
      if (provider === 'google') setGoogleConnected(true)
      else setOutlookConnected(true)
      setCalendarLoading(null)
    }, 2000)
  }

  // Step 4 → complete: persist onboarding_step = 'complete'
  const finishOnboarding = async () => {
    if (!userId || !supabase) return
    setSaving(true)
    setError(null)
    const { error: updateError } = await supabase
      .from('users')
      .update({ onboarding_step: 'complete' })
      .eq('id', userId)
    setSaving(false)
    if (updateError) {
      setError(updateError.message)
      return
    }
    onComplete()
  }

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
              {/* Step 1 — Welcome */}
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
                    onClick={() => void onWelcomeContinue()}
                  >
                    Get started →
                  </button>
                </div>
              ) : null}

              {/* Step 2 — Q1 / Q2 / Q3 */}
              {step === 2 ? (
                <div className="pt-2">
                  <h2 className="text-[24px] font-semibold leading-tight text-[#1A1A2E] sm:text-[28px]">
                    How do you work?
                  </h2>
                  <p className="mt-2 text-xs font-medium text-[#8A8A9A]">
                    Question {prefSubStep} of 3
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
                      {/* Q1 — When do you work best? */}
                      {prefSubStep === 1 ? (
                        <div>
                          <div className="mb-3 text-sm font-semibold text-[#1A1A2E]">
                            When do you usually work best?
                          </div>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            {[
                              { id: 'early_bird' as const, label: 'Early bird', sub: 'Before 6am' },
                              { id: 'morning' as const, label: 'Morning', sub: '6am–12pm' },
                              { id: 'afternoon' as const, label: 'Afternoon', sub: '12pm–5pm' },
                              { id: 'night_owl' as const, label: 'Night owl', sub: '7pm onwards' },
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

                      {/* Q2 — Unavailable hours */}
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
                          <p className="mt-3 text-xs text-[#8A8A9A]">
                            Rumbo will never schedule work outside these hours.
                          </p>
                        </div>
                      ) : null}

                      {/* Q3 — Session length */}
                      {prefSubStep === 3 ? (
                        <div>
                          <div className="mb-3 text-sm font-semibold text-[#1A1A2E]">
                            How long do you usually study at one time?
                          </div>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            {Q3_OPTIONS.map((opt) => (
                              <button
                                key={opt.id}
                                type="button"
                                onClick={() => setTargetBlockMins(opt.mins)}
                                className={cn(
                                  'flex w-full min-h-[3rem] flex-col items-start justify-center rounded-xl border-[1.5px] px-4 py-3 text-left transition-colors',
                                  targetBlockMins === opt.mins
                                    ? 'border-[#6B7FBE] bg-[#6B7FBE] text-white'
                                    : 'border-[#E8E8EC] bg-white text-[#4A4A5A] hover:border-[#6B7FBE] hover:text-[#1A1A2E]',
                                )}
                              >
                                <span className="text-sm font-semibold">{opt.label}</span>
                                <span
                                  className={cn(
                                    'mt-0.5 text-xs',
                                    targetBlockMins === opt.mins ? 'text-white/85' : 'text-[#8A8A9A]',
                                  )}
                                >
                                  {opt.sub}
                                </span>
                              </button>
                            ))}
                          </div>
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
                      disabled={saving || !canAdvancePrefSub}
                      onClick={() => void onPreferencesNext()}
                    >
                      {saving ? (
                        <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                      ) : prefSubStep < 3 ? (
                        'Next'
                      ) : (
                        'Continue →'
                      )}
                    </button>
                  </div>
                </div>
              ) : null}

              {/* Step 3 — Q4: How many commitments? */}
              {step === 3 ? (
                <div className="pt-2">
                  <h2 className="text-[24px] font-semibold leading-tight text-[#1A1A2E] sm:text-[28px]">
                    How do you work?
                  </h2>
                  <p className="mt-2 text-xs font-medium text-[#8A8A9A]">Question 4 of 4</p>
                  <div className="mt-5">
                    <div className="mb-3 text-sm font-semibold text-[#1A1A2E]">
                      How many classes or commitments do you have most days?
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {Q4_OPTIONS.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => setQ4Option(opt.id)}
                          className={cn(
                            'flex w-full min-h-[3rem] flex-col items-start justify-center rounded-xl border-[1.5px] px-4 py-3 text-left transition-colors',
                            q4Option === opt.id
                              ? 'border-[#6B7FBE] bg-[#6B7FBE] text-white'
                              : 'border-[#E8E8EC] bg-white text-[#4A4A5A] hover:border-[#6B7FBE] hover:text-[#1A1A2E]',
                          )}
                        >
                          <span className="text-sm font-semibold">{opt.label}</span>
                          <span
                            className={cn(
                              'mt-0.5 text-xs',
                              q4Option === opt.id ? 'text-white/85' : 'text-[#8A8A9A]',
                            )}
                          >
                            {opt.sub}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-stretch">
                    <button
                      type="button"
                      className="order-2 flex h-12 shrink-0 items-center justify-center gap-2 rounded-xl border-[1.5px] border-[#E8E8EC] px-4 text-sm font-semibold text-[#4A4A5A] transition-colors hover:border-[#6B7FBE] hover:text-[#1A1A2E] disabled:opacity-50 sm:order-1"
                      onClick={() => {
                        setDirection(-1)
                        setStep(2)
                        setPrefSubStep(3)
                        setError(null)
                      }}
                      disabled={saving}
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Back
                    </button>
                    <button
                      type="button"
                      className="order-1 h-12 flex-1 rounded-xl bg-[#6B7FBE] text-white font-semibold disabled:opacity-60 sm:order-2"
                      disabled={saving || q4Option == null}
                      onClick={() => void saveQ4AndAdvance()}
                    >
                      {saving ? <Loader2 className="mx-auto h-5 w-5 animate-spin" /> : 'Continue →'}
                    </button>
                  </div>
                </div>
              ) : null}

              {/* Step 4 — Calendar Connect (skippable) */}
              {step === 4 ? (
                <div className="pt-4">
                  <h2 className="text-[28px] font-semibold text-[#1A1A2E]">Connect your calendar</h2>
                  <p className="mt-3 text-base text-[#4A4A5A]">
                    Rumbo works best when it can see your existing schedule. You can always connect later.
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
                        <img src={googleCalendarLogo} alt="" className="h-10 w-10 shrink-0 object-contain" />
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
                        <img src={outlookLogo} alt="" className="h-10 w-auto max-w-[100px] shrink-0 object-contain" />
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
                        hasCalendarConnection ? 'order-2 sm:order-1' : 'order-1 w-28 justify-center',
                      )}
                      onClick={() => goToStep(3)}
                      disabled={calendarLoading !== null || saving}
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Back
                    </button>

                    {hasCalendarConnection ? (
                      <button
                        type="button"
                        className="order-1 h-12 flex-1 rounded-xl bg-[#6B7FBE] text-white font-semibold disabled:opacity-60 sm:order-2"
                        onClick={() => void finishOnboarding()}
                        disabled={saving}
                      >
                        {saving ? <Loader2 className="mx-auto h-5 w-5 animate-spin" /> : 'Go to dashboard →'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="order-2 flex h-12 w-28 shrink-0 items-center justify-center rounded-xl border-[1.5px] border-[#E8E8EC] bg-white px-4 text-sm font-semibold text-[#4A4A5A] transition-colors hover:border-[#6B7FBE] hover:text-[#1A1A2E] disabled:opacity-50"
                        onClick={() => void finishOnboarding()}
                        disabled={calendarLoading !== null || saving}
                      >
                        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Skip'}
                      </button>
                    )}
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
