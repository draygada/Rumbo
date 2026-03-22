import { useMemo, useState } from 'react'
import { useAuthStore } from '../store/authStore'

type Props = {
  onGoToLogin: () => void
}

export function SignupScreen({ onGoToLogin }: Props) {
  const signUp = useAuthStore((s) => s.signUp)
  const error = useAuthStore((s) => s.error)
  const initializing = useAuthStore((s) => s.initializing)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const canSubmit = useMemo(
    () => email.trim().length > 0 && password.length >= 6 && !submitting && !initializing,
    [email, password, submitting, initializing],
  )

  return (
    <div className="min-h-screen bg-rumbo-bg text-rumbo-text flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-black/10 bg-white/70 backdrop-blur px-6 py-7 shadow-sm">
        <div className="mb-6">
          <div className="text-sm font-semibold tracking-wide text-rumbo-primary">Rumbo</div>
          <h1 className="mt-1 text-2xl font-semibold">Create account</h1>
          <p className="mt-1 text-sm text-black/60">Start building your schedule.</p>
        </div>

        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault()
            if (!canSubmit) return
            setSubmitting(true)
            try {
              await signUp(email.trim(), password)
            } finally {
              setSubmitting(false)
            }
          }}
        >
          <div>
            <label className="block text-sm font-medium">Email</label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              autoComplete="email"
              className="mt-1 w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rumbo-primary/40"
              placeholder="you@school.edu"
            />
          </div>

          <div>
            <label className="block text-sm font-medium">Password</label>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              autoComplete="new-password"
              className="mt-1 w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rumbo-primary/40"
              placeholder="••••••••"
            />
            <div className="mt-1 text-xs text-black/50">Minimum 6 characters.</div>
          </div>

          {error ? (
            <div className="rounded-lg border border-red-500/20 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full rounded-lg bg-rumbo-primary px-3 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {submitting ? 'Creating…' : 'Sign up'}
          </button>
        </form>

        <div className="mt-5 text-sm text-black/60">
          Already have an account?{' '}
          <button
            type="button"
            onClick={onGoToLogin}
            className="font-semibold text-rumbo-primary hover:underline"
          >
            Log in
          </button>
        </div>
      </div>
    </div>
  )
}

