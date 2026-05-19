import { NavLink } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { getInitials } from '../../lib/initials'
import styles from './Sidebar.module.css'

export default function Sidebar() {
  const { profile } = useAuth()

  const initials = getInitials(profile?.name)

  return (
    <aside className={styles.sidebar}>
      <NavLink to="/dashboard" className={styles.logo}>
        <img src="/logo.png" alt="Rumbo" className={styles.logoImage} />
      </NavLink>

      <nav className={styles.nav}>
        <NavLink
          to="/dashboard"
          className={({ isActive }) => [styles.navLink, isActive ? styles.navLinkActive : ''].join(' ')}
        >
          Tasks
        </NavLink>
        <NavLink
          to="/settings"
          className={({ isActive }) => [styles.navLink, isActive ? styles.navLinkActive : ''].join(' ')}
        >
          Settings
        </NavLink>
        <NavLink
          to="/account"
          className={({ isActive }) => [styles.navLink, isActive ? styles.navLinkActive : ''].join(' ')}
        >
          Account
        </NavLink>
      </nav>

      <div className={styles.user}>
        <div className={styles.avatar}>{initials}</div>
        <span className={styles.username}>{profile?.name ?? ''}</span>
      </div>
    </aside>
  )
}
