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
/* Past chats — the node cluster (Rumbo's "brain") wrapped in a history arc, so
   the affordance reads as "everything Rumbo remembers" rather than a generic
   clock. Distinct from BrainIcon, which is the graph destination in the rail. */
export function HistoryIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="12" cy="6.4" r="1.1" />
      <circle cx="16.8" cy="14.6" r="1.1" />
      <circle cx="7.2" cy="14.6" r="1.1" />
      <path d="M12 10.2V7.5M13 12.9l2.9 1.1M11 12.9l-2.9 1.1" />
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M17.6 2.9v3.4h-3.4" />
    </Svg>
  )
}

export function ExpandIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9 4H4v5M15 4h5v5M15 20h5v-5M9 20H4v-5" />
    </Svg>
  )
}

export function CollapseIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 9h5V4M20 9h-5V4M20 15h-5v5M4 15h5v5" />
    </Svg>
  )
}

/* Brain — the knowledge graph itself: a hub with linked satellites, echoing
   RumboMark's node language. */
export function BrainIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="2.4" />
      <circle cx="5" cy="6.5" r="1.5" />
      <circle cx="19" cy="7" r="1.5" />
      <circle cx="6" cy="18" r="1.5" />
      <circle cx="18.5" cy="17.5" r="1.5" />
      <path d="M10.3 10.6 6.3 7.6M13.8 10.7l3.8-2.4M10.4 13.6 7.1 16.7M13.8 13.5l3.3 3" />
    </Svg>
  )
}

/* Tutor — a chat bubble with a spark, distinct from the plain ChatIcon used
   for Home. */
export function TutorIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M20 14.5a2.5 2.5 0 0 1-2.5 2.5H9l-4 3v-3H6.5A2.5 2.5 0 0 1 4 14.5v-7A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5Z" />
      <path d="M12 8.2v5.2M9.4 10.8h5.2" />
    </Svg>
  )
}

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
