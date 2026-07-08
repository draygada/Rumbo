import { Link, useSearchParams } from 'react-router-dom'
import RumboLogo from '../../components/RumboLogo/RumboLogo'
import styles from './ConfirmEmail.module.css'

export default function ConfirmEmail() {
  const [searchParams] = useSearchParams()
  const email = searchParams.get('email') ?? ''

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <RumboLogo variant="auth" />
        <h1 className={styles.title}>Confirm your email</h1>
        <p className={styles.subtitle}>
          We sent a confirmation link to{' '}
          <span className={styles.email}>{email || 'your inbox'}</span>.
        </p>
        <p className={styles.helper}>
          Open that email and confirm your account, then return here and sign in.
        </p>

        <div className={styles.actions}>
          <Link to="/signin" className={styles.button}>
            Back to sign in
          </Link>
          <Link to="/signup" className={styles.link}>
            Use a different email
          </Link>
        </div>
      </div>
    </div>
  )
}
