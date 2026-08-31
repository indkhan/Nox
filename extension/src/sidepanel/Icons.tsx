interface IconProps {
  className?: string
  'data-active'?: boolean
}

export function GearIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className={className} aria-hidden="true">
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3" strokeLinecap="round" />
    </svg>
  )
}

export function PlusCircleIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className={className} aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 5.2v5.6M5.2 8h5.6" strokeLinecap="round" />
    </svg>
  )
}

export function ChevronDownIcon({ className = 'h-3 w-3' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
      <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function ArrowUpIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className={className} aria-hidden="true">
      <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function StopIcon({ className = 'h-3 w-3' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
    </svg>
  )
}

export function SlidersIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className={className} aria-hidden="true">
      <path d="M2.5 5h11M2.5 11h11" strokeLinecap="round" />
      <circle cx="6" cy="5" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="10" cy="11" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function MicIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className={className} aria-hidden="true">
      <rect x="6" y="1.8" width="4" height="7.4" rx="2" />
      <path d="M3.5 7.8a4.5 4.5 0 0 0 9 0M8 12.3v1.9" strokeLinecap="round" />
    </svg>
  )
}

export function PlusIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className={className} aria-hidden="true">
      <path d="M8 2.5v11M2.5 8h11" strokeLinecap="round" />
    </svg>
  )
}

export function PageIcon({ className = 'h-3.5 w-3.5' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className={className} aria-hidden="true">
      <rect x="3" y="2" width="10" height="12" rx="1.5" />
      <path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" strokeLinecap="round" />
    </svg>
  )
}

export function PencilIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className={className} aria-hidden="true">
      <path d="M9.5 3.5l3 3L6 13H3v-3l6.5-6.5z" strokeLinejoin="round" />
      <path d="M8 5l3 3" />
    </svg>
  )
}

export function SparkleIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className={className} aria-hidden="true">
      <path d="M6 2.5l1.2 3.3L10.5 7l-3.3 1.2L6 11.5 4.8 8.2 1.5 7l3.3-1.2L6 2.5z" strokeLinejoin="round" />
      <path d="M11.5 9.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z" strokeLinejoin="round" />
    </svg>
  )
}

export function SearchIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className={className} aria-hidden="true">
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2L14 14" strokeLinecap="round" />
    </svg>
  )
}

export function SignalBarsIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
      <rect x="2.5" y="10" width="2" height="3.5" rx="0.8" />
      <rect x="6.5" y="7" width="2" height="6.5" rx="0.8" opacity="0.55" />
      <rect x="10.5" y="4" width="2" height="9.5" rx="0.8" opacity="0.25" />
    </svg>
  )
}

/** Nox mark: hexagon flower used as avatar/logo across the panel. */
export function NoxMark({ className = 'h-5 w-5', ...props }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true" {...props}>
      <path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9L12 3z" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="2.4" />
    </svg>
  )
}
