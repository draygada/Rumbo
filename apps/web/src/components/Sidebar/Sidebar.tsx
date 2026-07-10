import { NavLink } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { getInitials } from '../../lib/initials'
import RumboLogo from '../RumboLogo/RumboLogo'
import styles from './Sidebar.module.css'

export default function Sidebar() {
  const { session, profile } = useAuth()

  const composedName = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ').trim()
  const meta = session?.user?.user_metadata ?? {}
  const metaComposed = [meta.first_name, meta.last_name].filter((p): p is string => typeof p === 'string' && Boolean(p.trim())).join(' ').trim()
  const displayName =
    composedName ||
    profile?.name?.trim() ||
    metaComposed ||
    (typeof meta.name === 'string' ? meta.name : '') ||
    (typeof meta.full_name === 'string' ? meta.full_name : '') ||
    ''
  const initials = getInitials(displayName, profile?.email ?? session?.user?.email ?? null)

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
          to="/courses"
          className={({ isActive }) => [styles.navLink, isActive ? styles.navLinkActive : ''].join(' ')}
        >
          Courses
        </NavLink>
        <NavLink
          to="/brain"
          className={({ isActive }) => [styles.navLink, isActive ? styles.navLinkActive : ''].join(' ')}
        >
          Brain
        </NavLink>
        <NavLink
          to="/tutor"
          className={({ isActive }) => [styles.navLink, isActive ? styles.navLinkActive : ''].join(' ')}
        >
          Tutor
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
        <span className={styles.username}>
          {displayName || profile?.email?.split('@')[0] || session?.user?.email?.split('@')[0] || ''}
        </span>
      </div>
    </aside>
  )
}
