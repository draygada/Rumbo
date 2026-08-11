import { useState } from 'react'
import { useSpaces, useActiveSpaceIndex } from './useSpaces'
import { useSpaceStore } from './spaceStore'
import { useSpaceSwipe } from './useSpaceSwipe'
import NewSpaceDialog from './NewSpaceDialog'
import styles from './SpaceSwitcher.module.css'

/*
 * The space switcher, docked at the top of the rail under the wordmark.
 *
 * Collapsed the rail is 64px, so only the active space's dot and the position
 * pips are visible; the names ride in with the rail's hover expansion, matching
 * how the nav labels already behave.
 *
 * Two-finger swipe anywhere in this block moves between spaces (see
 * useSpaceSwipe), and the strip tracks the fingers before snapping.
 */
export default function SpaceSwitcher() {
  const spaces = useSpaces()
  const index = useActiveSpaceIndex()
  const enterSpace = useSpaceStore(s => s.enterSpace)
  const [dialogOpen, setDialogOpen] = useState(false)

  const go = (next: number) => {
    const space = spaces[next]
    if (space) enterSpace(space.id, space.courseId)
  }

  const { ref, dragX } = useSpaceSwipe<HTMLDivElement>({
    count: spaces.length,
    index,
    onChange: go,
  })

  const active = spaces[index]

  return (
    <>
      <div
        ref={ref}
        className={styles.switcher}
        role="group"
        aria-label="Spaces — swipe with two fingers, or press Cmd+Option+Arrow"
      >
        <div className={styles.viewport}>
          <div
            className={[styles.strip, dragX !== 0 ? styles.stripDragging : ''].join(' ')}
            style={{ transform: `translateX(calc(${-index * 100}% + ${dragX}px))` }}
          >
            {spaces.map(space => (
              <div className={styles.slide} key={space.id} aria-hidden={space.id !== active?.id}>
                <span className={styles.dot} style={{ background: space.bright }} />
                <span className={styles.name}>{space.name}</span>
              </div>
            ))}
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

      {dialogOpen && <NewSpaceDialog onClose={() => setDialogOpen(false)} />}
    </>
  )
}
