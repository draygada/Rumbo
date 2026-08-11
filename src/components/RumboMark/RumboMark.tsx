import styles from './RumboMark.module.css'

/*
 * Rumbo mark — the node-graph identity (DESIGN.md §2).
 * Built as a component, not a flat SVG, because the site depends on the
 * animated variants. Geometry below is exact — do not "clean it up".
 */

type Pt = [number, number]

// index 0 = center hub
const HUBS: Pt[] = [
  [52, 50],
  [48, 22],
  [79, 40],
  [70, 71],
  [40, 77],
  [24, 45],
]
const SATS: Pt[] = [
  [46, 5],
  [96, 24],
  [93, 90],
  [30, 95],
  [5, 33],
  [9, 63],
  [62, 93],
  [97, 57],
  [27, 9],
  [15, 20],
]
const NODES: Pt[] = [...HUBS, ...SATS]

// [a, b] index pairs into NODES. Spokes from center render at higher opacity.
const LINKS: Pt[] = [
  [0, 1],
  [0, 2],
  [0, 3],
  [0, 4],
  [0, 5], // primary spokes (opacity .7)
  [1, 6],
  [2, 7],
  [3, 8],
  [4, 9],
  [5, 10],
  [4, 12],
  [2, 13],
  [1, 14],
  [5, 11],
  [5, 15], // hub → satellite (opacity .4)
  [1, 2],
  [4, 5],
  [3, 4], // hub → hub ring (opacity .4)
]

// three extra terracotta cross-links revealed in the "learn" variant
const LEARN_LINKS: Pt[] = [
  [2, 3],
  [1, 5],
  [3, 4],
]

// hub fills cycle by index; center (0) = ochre
const HUB_COLORS = ['var(--ochre)', 'var(--sage)', 'var(--teal)', 'var(--hero-blue)']

const CENTER: Pt = [52, 50]
const dist = (p: Pt) => Math.hypot(p[0] - CENTER[0], p[1] - CENTER[1])
const len = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1])
const MAX_DIST = Math.max(...NODES.map(dist))

export type RumboMarkVariant = 'static' | 'anim' | 'radiate' | 'pulse' | 'learn'

interface Props {
  /** rendered pixel size (viewBox is fixed at 108×108) */
  size?: number
  /** base hub radius; center hub is 1.42× this */
  hubR?: number
  /** satellite radius */
  satR?: number
  /** link stroke width */
  lw?: number
  variant?: RumboMarkVariant
  /** minimal mode: 6 hubs + 5 spokes only, for sizes < 24px */
  minimal?: boolean
  className?: string
  title?: string
}

export default function RumboMark({
  size = 44,
  hubR = 6,
  satR = 3.2,
  lw = 2.2,
  variant = 'static',
  minimal = false,
  className,
  title = 'Rumbo',
}: Props) {
  const centerR = hubR * 1.42
  const showSats = !minimal

  const nodeAnimClass =
    variant === 'anim' ? styles.popNode : variant === 'radiate' ? styles.radiateNode : ''

  const hubDelay = (i: number) => {
    if (variant === 'anim') return i * 0.09
    if (variant === 'radiate') return 0.15 + (dist(HUBS[i]) / MAX_DIST) * 0.5
    return 0
  }
  const satDelay = (i: number) => {
    if (variant === 'anim') return HUBS.length * 0.09 + i * 0.04
    if (variant === 'radiate') return 0.15 + (dist(SATS[i]) / MAX_DIST) * 0.5
    return 0
  }
  const linkDelay = (b: Pt) => {
    if (variant === 'radiate') return (dist(NODES[b[1]]) / MAX_DIST) * 0.5
    return 0
  }

  return (
    <svg
      className={[styles.mark, className].filter(Boolean).join(' ')}
      viewBox="-4 -4 108 108"
      width={size}
      height={size}
      role="img"
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* links */}
      <g stroke="var(--text3)" strokeWidth={lw} strokeLinecap="round" fill="none">
        {LINKS.map(([a, b], i) => {
          const A = NODES[a]
          const B = NODES[b]
          if (!showSats && (a > 5 || b > 5)) return null
          const isSpoke = a === 0
          const l = len(A, B)
          const drawing = variant === 'radiate'
          return (
            <line
              key={`l${i}`}
              x1={A[0]}
              y1={A[1]}
              x2={B[0]}
              y2={B[1]}
              opacity={isSpoke ? 0.7 : 0.4}
              className={drawing ? styles.drawLink : undefined}
              style={
                drawing
                  ? {
                      strokeDasharray: l,
                      animationDelay: `${linkDelay([a, b])}s`,
                      // exact dash length + preserved target opacity
                      ['--_len' as string]: l,
                      ['--link-op' as string]: isSpoke ? 0.7 : 0.4,
                    }
                  : undefined
              }
            />
          )
        })}
        {variant === 'learn' &&
          LEARN_LINKS.map(([a, b], i) => {
            const A = NODES[a]
            const B = NODES[b]
            return (
              <line
                key={`ll${i}`}
                x1={A[0]}
                y1={A[1]}
                x2={B[0]}
                y2={B[1]}
                stroke="var(--terra)"
                strokeWidth={lw}
                className={styles.learnLink}
                style={{ animationDelay: `${0.2 + i * 0.18}s` }}
              />
            )
          })}
      </g>

      {/* satellites */}
      {showSats && (
        <g fill="var(--text3)">
          {SATS.map((p, i) => (
            <circle
              key={`s${i}`}
              cx={p[0]}
              cy={p[1]}
              r={satR}
              className={nodeAnimClass || undefined}
              style={nodeAnimClass ? { animationDelay: `${satDelay(i)}s` } : undefined}
            />
          ))}
        </g>
      )}

      {/* hubs */}
      <g>
        {HUBS.map((p, i) => {
          const isCenter = i === 0
          const breathing = variant === 'pulse'
          return (
            <circle
              key={`h${i}`}
              cx={p[0]}
              cy={p[1]}
              r={isCenter ? centerR : hubR}
              fill={HUB_COLORS[i % 4]}
              className={
                breathing
                  ? styles.breatheNode
                  : nodeAnimClass
                    ? nodeAnimClass
                    : undefined
              }
              style={
                breathing
                  ? { animationDelay: `${i * 0.12}s` }
                  : nodeAnimClass
                    ? { animationDelay: `${hubDelay(i)}s` }
                    : undefined
              }
            />
          )
        })}
      </g>
    </svg>
  )
}
