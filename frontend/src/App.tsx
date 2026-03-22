import { useEffect, useState } from 'react'
import { useAuthStore } from './store/authStore'
import { AuthForm } from '@/components/ui/premium-auth'
import rumboLogo from '@/assets/rumbo-logo.png'
import { QuickAddModal } from '@/components/QuickAddModal'

async function getWindowLabelSafe(): Promise<string> {
  try {
    const mod = await import('@tauri-apps/api/window')
    const win = mod.getCurrentWindow()
    // label exists on WebviewWindow in Tauri 2
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (win as any).label ?? 'main'
  } catch {
    return 'main'
  }
}

function App() {
  const initialize = useAuthStore((s) => s.initialize)
  const initializing = useAuthStore((s) => s.initializing)
  const session = useAuthStore((s) => s.session)
  const user = useAuthStore((s) => s.user)
  const signOut = useAuthStore((s) => s.signOut)

  const [mode] = useState<'login' | 'signup'>('login')
  const [windowLabel, setWindowLabel] = useState<string>('main')

  useEffect(() => {
    void initialize()
  }, [initialize])

  useEffect(() => {
    void (async () => {
      const label = await getWindowLabelSafe()
      setWindowLabel(label)
    })()
  }, [])

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

  // Render quick-add modal UI in the quick-add window
  if (windowLabel === 'quick-add') {
    return <QuickAddModal />
  }

  return (
    <div className="min-h-screen bg-rumbo-bg text-rumbo-text p-6">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between">
          <div className="flex items-start gap-3">
            <img src={rumboLogo} alt="Rumbo" className="h-8 w-auto mt-0.5" />
            <div>
            <h1 className="mt-1 text-2xl font-semibold">Dashboard (placeholder)</h1>
            <p className="mt-1 text-sm text-black/60">
              Signed in as <span className="font-medium text-black/80">{user?.email}</span>
            </p>
            </div>
          </div>
          <button
            onClick={() => void signOut()}
            className="rounded-lg border border-black/10 bg-white px-3 py-2 text-sm font-semibold hover:bg-black/5"
          >
            Sign out
          </button>
        </div>

        <div className="mt-6 rounded-2xl border border-black/10 bg-white/70 px-6 py-5">
          <div className="text-sm text-black/70">
            Next: tasks, quick-add modal UI, and syncing with Supabase tables.
          </div>
        </div>
      </div>
    </div>
  )
}

export default App
