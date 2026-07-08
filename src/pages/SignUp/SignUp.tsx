import { useState, FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { signUp } from '../../hooks/useAuth'
import RumboLogo from '../../components/RumboLogo/RumboLogo'
import styles from './SignUp.module.css'

function getSignupErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return 'Sign up failed'

  const authError = err as Error & { code?: string; status?: number }
  if (
    authError.code === 'over_email_send_rate_limit' ||
    authError.status === 429
  ) {
    return 'Too many signup attempts right now. Please wait a few minutes and try again.'
  }

  return err.message
}

export default function SignUp() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)

    if (password !== confirm) {
      setError('Passwords do not match')
      return
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    setLoading(true)
    try {
      console.log('[SignUp] Submit started', {
        email: email.trim(),
        hasName: Boolean(name.trim()),
        passwordLength: password.length,
      })
      await signUp(email, password, name)
      console.log('[SignUp] Navigate to onboarding')
      navigate('/onboarding')
    } catch (err) {
      console.error('[SignUp] Submit failed', err)
      setError(getSignupErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <RumboLogo variant="auth" />
        <p className={styles.subtitle}>Create your account</p>

        <form onSubmit={handleSubmit} className={styles.form}>
          <div className={styles.field}>
            <label htmlFor="name" className={styles.label}>Name</label>
            <input
              id="name"
              type="text"
              className={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="name"
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="email" className={styles.label}>Email</label>
            <input
              id="email"
              type="email"
              className={styles.input}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="password" className={styles.label}>Password</label>
            <input
              id="password"
              type="password"
              className={styles.input}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="confirm" className={styles.label}>Confirm password</label>
            <input
              id="confirm"
              type="password"
              className={styles.input}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              autoComplete="new-password"
            />
          </div>

          {error && <p className={styles.error}>{error}</p>}

          <button type="submit" className={styles.button} disabled={loading}>
            {loading ? 'Creating account...' : 'Create account'}
          </button>
        </form>

        <p className={styles.footer}>
          Already have an account? <Link to="/signin" className={styles.link}>Sign in</Link>
        </p>
      </div>
    </div>
  )
}
