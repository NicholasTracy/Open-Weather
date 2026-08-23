import type { ReactElement } from 'react'

/** Light-on-dark wordmark mark — always visible in the command center chrome. */
export function BrandMark({ className = '' }: { className?: string }): ReactElement {
  return (
    <svg
      className={`brand-mark ${className}`.trim()}
      width="36"
      height="36"
      viewBox="0 0 36 36"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle cx="18" cy="18" r="17" stroke="rgba(154,171,189,0.45)" strokeWidth="1.25" fill="rgba(18,24,33,0.9)" />
      <path
        d="M20.5 7.5 12 19h5.2L15 28.5 24.5 16h-5.4L20.5 7.5Z"
        fill="var(--ow-accent, #e8b44c)"
      />
    </svg>
  )
}
