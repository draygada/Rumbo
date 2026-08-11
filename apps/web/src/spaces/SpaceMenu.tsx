import { useEffect } from 'react'
import { SPACE_BACKGROUNDS, type Space } from './useSpaces'
import { useSpaceStore } from './spaceStore'
import styles from './SpaceMenu.module.css'

/*
 * Per-space options, popped from the space name in the rail.
 *
 * Fixed-position because the rail clips its own overflow. Course spaces can't
 * be deleted — they exist as long as the course is running — so only spaces the
 * student created offer it.
 */
export default function SpaceMenu({ space, onClose }: { space: Space; onClose: () => void }) {
  const setBackground = useSpaceStore(s => s.setBackground)
  const deleteSpace = useSpaceStore(s => s.deleteSpace)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      <div className={styles.scrim} onMouseDown={onClose} aria-hidden="true" />
      <div className={styles.menu} role="menu" aria-label={`${space.name} options`}>
        <p className={styles.heading}>Background</p>
        <div className={styles.swatches}>
          {SPACE_BACKGROUNDS.map(bg => {
            // 'auto' means the space is on its own hue and hasn't been chosen
            // for explicitly; show that as the matching swatch.
            const selected =
              space.backgroundId === bg.id ||
              (space.backgroundId === 'auto' && bg.tint === space.tint)
            return (
              <button
                key={bg.id}
                type="button"
                className={[styles.swatch, selected ? styles.swatchActive : ''].join(' ')}
                style={{ background: bg.tint === 'transparent' ? 'var(--base)' : bg.tint }}
                onClick={() => setBackground(space.id, bg.id)}
                aria-label={bg.label}
                aria-pressed={selected}
                title={bg.label}
              />
            )
          })}
        </div>

        {space.kind === 'custom' && (
          <button
            type="button"
            className={styles.destructive}
            onClick={() => {
              deleteSpace(space.id)
              onClose()
            }}
          >
            Delete space
          </button>
        )}
      </div>
    </>
  )
}
