import { useEffect, useState } from 'react'
import { useAuthStore } from './store/authStore'
import { AuthForm } from '@/components/ui/premium-auth'
import { QuickAddModal } from '@/components/QuickAddModal'
import { Dashboard } from '@/components/Dashboard'

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

  return <Dashboard />
}

export default App
