import { useState } from 'react'
import { useSpaces, useActiveSpaceIndex } from './useSpaces'
import { useSpaceStore } from './spaceStore'
import NewSpaceDialog from './NewSpaceDialog'
import SpaceMenu from './SpaceMenu'
import { useMotionTrack } from './spaceMotion'
import styles from './SpaceSwitcher.module.css'

/*
 * The space switcher, docked at the top of the rail under the wordmark.
 *
 * Collapsed the rail is 64px, so only the active space's dot and the position
 * pips are visible; the name rides in with the rail's hover expansion, matching
 * how the nav labels already behave.
 *
 * The swipe gesture itself lives on the rail (see Sidebar.tsx) so the whole
 * column is the target rather than this block. The strip registers as a motion
 * track and its transform is written directly by the animation loop — never
 * from React — so a gesture doesn't re-render this component per wheel event.
 */
export default function SpaceSwitcher() {
  const spaces = useSpaces()
  const index = useActiveSpaceIndex()
  const enterSpace = useSpaceStore(s => s.enterSpace)
  const stripRef = useMotionTrack('strip')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  const go = (next: number) => {
    const space = spaces[next]
    if (space) enterSpace(space.id, space.courseId)
  }

  const active = spaces[index]

  return (
    <>
      <div
        className={styles.switcher}
        role="group"
        aria-label="Spaces — swipe the sidebar with two fingers, or press Cmd+Option+Arrow"
      >
        <div className={styles.viewport}>
          <div className={styles.strip} ref={stripRef}>
            {spaces.map(space => {
              const isActive = space.id === active?.id
              return (
                <div className={styles.slide} key={space.id} aria-hidden={!isActive}>
                  <span className={styles.dot} style={{ background: space.bright }} />
                  {isActive ? (
                    <button
                      type="button"
                      className={styles.nameButton}
                      onClick={() => setMenuOpen(o => !o)}
                      aria-haspopup="menu"
                      aria-expanded={menuOpen}
                      title="Space options"
                    >
                      {space.name}
                    </button>
                  ) : (
                    <span className={styles.name}>{space.name}</span>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div className={styles.pips}>
          {spaces.map((space, i) => (
            <button
              key={space.id}
              type="button"
              className={[styles.pip, i === index ? styles.pipActive : ''].join(' ')}
              style={i === index ? { background: space.bright } : undefined}
              onClick={() => go(i)}
              aria-label={`Switch to ${space.name}`}
              aria-current={i === index ? 'true' : undefined}
            />
          ))}
          <button
            type="button"
            className={styles.addPip}
            onClick={() => setDialogOpen(true)}
            aria-label="New space"
            title="New space"
          >
            +
          </button>
        </div>
      </div>

      {menuOpen && active && <SpaceMenu space={active} onClose={() => setMenuOpen(false)} />}
      {dialogOpen && <NewSpaceDialog onClose={() => setDialogOpen(false)} />}
    </>
  )
}
