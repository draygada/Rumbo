import { useEffect, useState } from 'react'
import { useAuthStore } from './store/authStore'
import { AuthForm } from '@/components/ui/premium-auth'
import { QuickAddModal } from '@/components/QuickAddModal'
import { Dashboard } from '@/components/Dashboard'
import { Onboarding } from '@/components/Onboarding'
import { supabase } from '@/lib/supabase'

async function getWindowLabelSafe(): Promise<string> {
  try {
    const mod = await import('@tauri-apps/api/window')
    const win = mod.getCurrentWindow()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (win as any).label ?? 'main'
  } catch {
    return 'main'
  }
}

type OnboardingStep = '1' | '2' | '3' | '4' | 'complete' | null

function stepToNum(s: OnboardingStep): 1 | 2 | 3 | 4 {
  if (s === '2') return 2
  if (s === '3') return 3
  if (s === '4') return 4
  return 1
}

function App() {
  const initialize = useAuthStore((s) => s.initialize)
  const initializing = useAuthStore((s) => s.initializing)
  const session = useAuthStore((s) => s.session)
  const signOut = useAuthStore((s) => s.signOut)

  const [mode] = useState<'login' | 'signup'>('login')
  const [windowLabel, setWindowLabel] = useState<string>('main')
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep>(null)

  useEffect(() => {
    void initialize()
  }, [initialize])

  useEffect(() => {
    void (async () => {
      const label = await getWindowLabelSafe()
      setWindowLabel(label)
    })()
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const { emit } = await import('@tauri-apps/api/event')
        await emit('rumbo:onboarding-status', onboardingStep === 'complete')
      } catch {
        // not in Tauri runtime
      }
    })()
  }, [onboardingStep])

  useEffect(() => {
    if (!session?.user?.id) {
      setOnboardingStep(null)
      return
    }
    let cancelled = false
    void (async () => {
      if (!supabase) {
        if (!cancelled) setOnboardingStep('complete')
        return
      }
      const { data, error } = await supabase
        .from('users')
        .select('onboarding_step')
        .eq('id', session.user.id)
        .maybeSingle()

      if (cancelled) return
      if (error) {
        setOnboardingStep('1')
        return
      }
      // No users row found — auth session is stale (user was deleted from DB).
      // Sign out immediately so they land on the login screen instead of hitting RLS errors.
      if (data === null) {
        void signOut()
        return
      }
      setOnboardingStep((data.onboarding_step as OnboardingStep) ?? '1')
    })()

    return () => {
      cancelled = true
    }
  }, [session?.user?.id])

  if (initializing) {
    return (
      <div className="min-h-screen bg-rumbo-bg text-rumbo-text flex items-center justify-center">
        <div className="text-sm text-black/60">Loading…</div>
      </div>
    )
  }

  if (!session) {
    return (
      <div className="min-h-screen bg-rumbo-bg text-rumbo-text flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl border border-black/10 bg-white px-6 py-7 shadow-sm">
          <AuthForm initialMode={mode} />
        </div>
      </div>
    )
  }

  if (windowLabel === 'quick-add') {
    return <QuickAddModal />
  }

  if (onboardingStep === null) {
    return (
      <div className="min-h-screen bg-rumbo-bg text-rumbo-text flex items-center justify-center">
        <div className="text-sm text-black/60">Loading…</div>
      </div>
    )
  }

  if (onboardingStep !== 'complete') {
    return (
      <Onboarding
        initialStep={stepToNum(onboardingStep)}
        onComplete={() => setOnboardingStep('complete')}
      />
    )
  }

  return <Dashboard />
}

export default App
