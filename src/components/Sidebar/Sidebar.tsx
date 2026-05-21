import { NavLink } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { getInitials } from '../../lib/initials'
import RumboLogo from '../RumboLogo/RumboLogo'
import styles from './Sidebar.module.css'

export default function Sidebar() {
  const { profile } = useAuth()

  const initials = getInitials(profile?.name)

  return (
    <aside className={styles.sidebar}>
      <div className={styles.upper}>
        <NavLink to="/dashboard" className={styles.logo}>
          <RumboLogo variant="sidebar" />
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
      </div>

      <div className={styles.user}>
        <div className={styles.avatar}>{initials}</div>
        <span className={styles.username}>{profile?.name ?? ''}</span>
      </div>
    </aside>
  )
}
