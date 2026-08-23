import type { ReactElement } from 'react'

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

export function RadarLoadingOverlay({
  progress,
  label = 'Loading NEXRAD'
}: {
  progress: number
  label?: string
}): ReactElement {
  const percent = Math.round(clamp01(progress) * 100)
  const stage = percent < 78 ? 'Fetching volumes' : percent < 100 ? 'Processing keyframes' : 'Ready'
  return (
    <div className="radar-boot" role="status" aria-live="polite" aria-busy={percent < 100}>
      <div className="radar-boot__card">
        <div className="radar-boot__spinner" aria-hidden="true" />
        <div className="radar-boot__copy">
          <strong>{label}</strong>
          <span>{stage}</span>
        </div>
        <div className="radar-boot__bar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div className="radar-boot__fill" style={{ width: `${percent}%` }} />
        </div>
        <span className="radar-boot__pct">{percent}%</span>
      </div>
    </div>
  )
}
