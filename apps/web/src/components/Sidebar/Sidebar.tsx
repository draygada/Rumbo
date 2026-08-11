import { useEffect, useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { getInitials } from '../../lib/initials'
import RumboMark from '../RumboMark/RumboMark'
import SpaceSwitcher from '../../spaces/SpaceSwitcher'
import { useActiveSpace, useApplySpaceAccent } from '../../spaces/useSpaces'
import {
  ChatIcon, TasksIcon, CoursesIcon, SettingsIcon, UserIcon, BrainIcon,
} from '../icons/Icons'
import styles from './Sidebar.module.css'

// Brain and Tutor exist only on this branch (the design-spec branch was cut
// from the pre-pivot codebase), so they're added to the rail here rather than
// coming across in the port.
const PRIMARY = [
  { to: '/home', label: 'Chat', icon: ChatIcon },
  { to: '/brain', label: 'Brain', icon: BrainIcon },
  { to: '/tasks', label: 'Tasks', icon: TasksIcon },
  { to: '/courses', label: 'Courses', icon: CoursesIcon },
]

const ACCOUNT_MENU = [
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
  { to: '/account', label: 'Account', icon: UserIcon },
]

export default function Sidebar() {
  const { profile } = useAuth()
  // The rail is the one component mounted on every signed-in screen, so it's
  // where the space's hue gets applied to <html>.
  const activeSpace = useActiveSpace()
  useApplySpaceAccent(activeSpace)
  const initials = getInitials(profile?.name, profile?.email)
  const name = profile?.name?.trim() || profile?.email?.split('@')[0] || ''
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

      <SpaceSwitcher />

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
          <span className={styles.avatar}>{initials}</span>
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
