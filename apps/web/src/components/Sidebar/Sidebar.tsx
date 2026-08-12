import { useEffect, useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { getInitials } from '../../lib/initials'
import { resolveDisplayName } from '../../lib/displayName'
import RumboMark from '../RumboMark/RumboMark'
import {
  ChatIcon, TasksIcon, CoursesIcon, SettingsIcon, UserIcon,
} from '../icons/Icons'
import styles from './Sidebar.module.css'

// Brain is intentionally not in the rail. The /brain route still works for
// direct links — it's just not surfaced while the demo focuses on chat.
const PRIMARY = [
  { to: '/home', label: 'Chat', icon: ChatIcon },
  { to: '/tasks', label: 'Tasks', icon: TasksIcon },
  { to: '/courses', label: 'Courses', icon: CoursesIcon },
]

const ACCOUNT_MENU = [
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
  { to: '/account', label: 'Account', icon: UserIcon },
]

export default function Sidebar() {
  const { profile, session } = useAuth()
  // Same resolution as the greeting and the account page — see lib/displayName.
  const displayName = resolveDisplayName(profile, session?.user?.user_metadata)
  const initials = getInitials(displayName, profile?.email)
  const avatarUrl =
    profile?.avatar_url ??
    (typeof session?.user?.user_metadata?.avatar_url === 'string'
      ? session.user.user_metadata.avatar_url
      : null)
  const name = displayName || profile?.email?.split('@')[0] || ''
  const email = profile?.email ?? ''

  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    function onPointerDown(e: MouseEvent) {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      setMenuOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  return (
    <aside className={styles.rail} data-rail>
      <NavLink to="/home" className={styles.brand} aria-label="Rumbo home">
        <span className={styles.brandMark}>
          <RumboMark size={30} variant="anim" hubR={6} />
        </span>
        <span className={styles.brandWord}>Rumbo</span>
      </NavLink>

      <nav className={styles.nav}>
        <ul className={styles.group}>
          {PRIMARY.map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <NavLink
                to={to}
                className={({ isActive }) => [styles.item, isActive ? styles.itemActive : ''].join(' ')}
              >
                <span className={styles.itemIcon}>
                  <Icon size={20} />
                </span>
                <span className={styles.itemLabel}>{label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className={styles.footer}>
        <button
          ref={triggerRef}
          type="button"
          className={[styles.account, menuOpen ? styles.accountOpen : ''].join(' ')}
          onClick={() => setMenuOpen(o => !o)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Account menu"
        >
          {avatarUrl
            ? <img className={styles.avatarImage} src={avatarUrl} alt="" />
            : <span className={styles.avatar}>{initials}</span>}
          <span className={styles.username}>{name}</span>
        </button>

        {menuOpen && (
          <div ref={menuRef} className={styles.menu} role="menu">
            <div className={styles.menuHeader}>
              <span className={styles.menuName}>{name}</span>
              {email && <span className={styles.menuEmail}>{email}</span>}
            </div>
            <div className={styles.menuList}>
              {ACCOUNT_MENU.map(({ to, label, icon: Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  role="menuitem"
                  className={styles.menuItem}
                  onClick={() => setMenuOpen(false)}
                >
                  <Icon size={18} />
                  {label}
                </NavLink>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
