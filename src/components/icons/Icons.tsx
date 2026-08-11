/*
 * Line icons — drawn to match the node/graph visual language (DESIGN.md §9
 * bans icon sets that don't). Consistent 24 viewBox, currentColor stroke,
 * rounded caps. Keep new icons in this file so the stroke stays uniform.
 */
interface IconProps {
  size?: number
  strokeWidth?: number
  className?: string
}

function Svg({
  size = 20,
  strokeWidth = 1.7,
  className,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export function MenuIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Svg>
  )
}

/** Home / chat — a speech node */
export function ChatIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 12a8 8 0 1 1 3.5 6.6L4 20l1-3.2A7.9 7.9 0 0 1 4 12Z" />
      <circle cx="9" cy="12" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="12" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="16" cy="12" r="0.9" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/** Tasks — checklist */
export function TasksIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M4 6l1 1 1.6-1.8M4 12l1 1 1.6-1.8M4 18l1 1 1.6-1.8" />
    </Svg>
  )
}

/** Courses — stacked spaces */
export function CoursesIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 4 3 8.5l9 4.5 9-4.5L12 4Z" />
      <path d="M3 13.5 12 18l9-4.5" />
    </Svg>
  )
}

/** Settings — sliders */
export function SettingsIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 8h9M17 8h3M4 16h3M11 16h9" />
      <circle cx="15" cy="8" r="2.2" />
      <circle cx="9" cy="16" r="2.2" />
    </Svg>
  )
}

/** Account — user */
export function UserIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5.5 19a6.5 6.5 0 0 1 13 0" />
    </Svg>
  )
}

/** Send — arrow up */
export function SendIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </Svg>
  )
}
