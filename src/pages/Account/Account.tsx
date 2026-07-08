import { useNavigate } from 'react-router-dom'
import { useAuth, signOut } from '../../hooks/useAuth'
import { useTasks } from '../../hooks/useTasks'
import { getInitials } from '../../lib/initials'
import styles from './Account.module.css'

const FREE_TASK_LIMIT = 5

export default function Account() {
  const { profile } = useAuth()
  const { data: tasks } = useTasks()
  const navigate = useNavigate()

  const taskCount = tasks?.length ?? 0
  const initials = getInitials(profile?.name, profile?.email)

  async function handleSignOut() {
    await signOut()
    navigate('/signin')
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Account</h1>
      </div>

      <div className={styles.sections}>
        <section className={styles.section}>
          <div className={styles.userRow}>
            <div className={styles.avatar}>{initials}</div>
            <div>
              <p className={styles.username}>{profile?.name}</p>
              <p className={styles.email}>{profile?.email}</p>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Plan</h2>
          {profile?.tier === 'free' ? (
            <div className={styles.tierCard}>
              <div className={styles.tierRow}>
                <span className={styles.tierBadge}>Free</span>
                <span className={styles.tierUsage}>{taskCount} / {FREE_TASK_LIMIT} tasks used</span>
              </div>
              <div className={styles.usageBar}>
                <div
                  className={styles.usageFill}
                  style={{ width: `${Math.min((taskCount / FREE_TASK_LIMIT) * 100, 100)}%` }}
                />
              </div>
              <button className={styles.upgradeButton}>
                Upgrade to Premium — $6.99/mo
              </button>
            </div>
          ) : (
            <div className={styles.tierCard}>
              <span className={styles.tierBadgePremium}>Premium</span>
              <p className={styles.premiumNote}>Unlimited tasks. AI features unlocked.</p>
            </div>
          )}
        </section>

        <section className={styles.section}>
          <button className={styles.signOutButton} onClick={handleSignOut}>
            Sign out
          </button>
        </section>
      </div>
    </div>
  )
}
