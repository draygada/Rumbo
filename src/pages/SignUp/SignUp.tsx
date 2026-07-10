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
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)

    if (!firstName.trim() || !lastName.trim()) {
      setError('Please enter both a first and last name.')
      return
    }

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
        hasFirst: Boolean(firstName.trim()),
        hasLast: Boolean(lastName.trim()),
        passwordLength: password.length,
      })
      await signUp(email, password, firstName, lastName)
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
      <main className={styles.card} aria-labelledby="signup-heading">
        <RumboLogo variant="auth" />
        <h1 id="signup-heading" className={styles.subtitle}>Create your account</h1>

        <form onSubmit={handleSubmit} className={styles.form}>
          <div className={styles.nameRow}>
            <div className={styles.field}>
              <label htmlFor="first-name" className={styles.label}>First name</label>
              <input
                id="first-name"
                type="text"
                className={styles.input}
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                required
                autoComplete="given-name"
              />
            </div>

            <div className={styles.field}>
              <label htmlFor="last-name" className={styles.label}>Last name</label>
              <input
                id="last-name"
                type="text"
                className={styles.input}
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                required
                autoComplete="family-name"
              />
            </div>
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
      </main>
    </div>
  )
}
