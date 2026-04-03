'use client'

import { Steps } from '@ark-ui/react'
import { Check } from 'lucide-react'

import { cn } from '@/lib/utils'

const STEP_COUNT = 4

export type OnboardingProgressStepsProps = {
  /** Current main onboarding step (1–4). */
  currentStep: 1 | 2 | 3 | 4
  /** Furthest step the user has unlocked (for pill navigation). */
  maxStepReached: 1 | 2 | 3 | 4
  onStepChange: (step: 1 | 2 | 3 | 4) => void
  disabled?: boolean
}

/**
 * Rumbo-styled horizontal stepper using Ark UI Steps.
 * Matches onboarding spec: primary #6B7FBE, completed pill #EEF0FA, upcoming #F5F5F3.
 */
export function OnboardingProgressSteps({
  currentStep,
  maxStepReached,
  onStepChange,
  disabled,
}: OnboardingProgressStepsProps) {
  const stepIndex = currentStep - 1

  return (
    <Steps.Root
      count={STEP_COUNT}
      step={stepIndex}
      linear={false}
      isStepValid={(index) => index + 1 <= maxStepReached}
      onStepChange={(d) => {
        const next = (d.step + 1) as 1 | 2 | 3 | 4
        if (next !== currentStep) onStepChange(next)
      }}
      className="w-full"
    >
      <Steps.List className="flex w-full items-center justify-between gap-1">
        {Array.from({ length: STEP_COUNT }, (_, index) => (
          <Steps.Item
            key={index}
            index={index}
            className={cn(
              'relative flex min-w-0 items-center',
              index < STEP_COUNT - 1 ? 'flex-1' : 'shrink-0',
            )}
          >
            <Steps.Trigger
              disabled={disabled}
              aria-label={`Step ${index + 1} of ${STEP_COUNT}`}
              className="flex w-full min-w-0 max-w-full flex-1 items-center justify-center rounded-md transition-opacity duration-300 ease-in-out disabled:opacity-50"
            >
              <Steps.Indicator
                className={cn(
                  'group relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold transition-colors duration-300 ease-in-out',
                  'data-[current]:border-[#6B7FBE] data-[current]:bg-[#6B7FBE] data-[current]:text-white',
                  'data-[complete]:border-[#6B7FBE] data-[complete]:bg-[#EEF0FA] data-[complete]:text-[#6B7FBE]',
                  'data-[incomplete]:border-[#E8E8EC] data-[incomplete]:bg-[#F5F5F3] data-[incomplete]:text-[#8A8A9A]',
                )}
              >
                <span className="group-data-[complete]:hidden">{index + 1}</span>
                <Check
                  strokeWidth={2.5}
                  className="absolute hidden h-4 w-4 group-data-[complete]:block"
                  aria-hidden
                />
              </Steps.Indicator>
            </Steps.Trigger>
            <Steps.Separator
              hidden={index === STEP_COUNT - 1}
              className="mx-2 h-0.5 min-w-[8px] flex-1 bg-[#E8E8EC] transition-colors duration-300 data-[complete]:bg-[#6B7FBE]"
            />
          </Steps.Item>
        ))}
      </Steps.List>
    </Steps.Root>
  )
}

/** Demo-only primitive (matches Ark docs pattern); prefer `OnboardingProgressSteps` in app screens. */
export function BasicSteps() {
  const steps = [1, 2, 3, 4]

  return (
    <div className="flex w-full items-center justify-center rounded-xl bg-white px-4 py-12 dark:bg-gray-800">
      <Steps.Root count={4} defaultStep={0} className="w-full max-w-2xl">
        <Steps.List className="flex items-center justify-between">
          {steps.map((step, index) => (
            <Steps.Item key={step} index={index} className="relative flex flex-1 items-center not-last:min-w-0">
              <Steps.Trigger className="flex items-center gap-3 rounded-md text-left">
                <Steps.Indicator className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-sm font-semibold border-gray-200 text-gray-500 data-[complete]:border-blue-600 data-[complete]:bg-blue-600 data-[complete]:text-white data-[current]:border-blue-600 data-[current]:bg-blue-600 data-[current]:text-white dark:border-gray-600 dark:text-gray-300 dark:data-[incomplete]:border-gray-600 dark:data-[incomplete]:bg-gray-700">
                  {step}
                </Steps.Indicator>
              </Steps.Trigger>
              <Steps.Separator
                hidden={index === steps.length - 1}
                className="mx-3 h-0.5 flex-1 bg-gray-200 data-[complete]:bg-blue-600 dark:bg-gray-700"
              />
            </Steps.Item>
          ))}
        </Steps.List>
      </Steps.Root>
    </div>
  )
}
