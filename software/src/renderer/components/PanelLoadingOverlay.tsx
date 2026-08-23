import type { ReactElement } from 'react'

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

export function PanelLoadingOverlay({
  progress,
  label,
  stage
}: {
  progress: number
  label: string
  stage?: string
}): ReactElement {
  const percent = Math.round(clamp01(progress) * 100)
  return (
    <div className="panel-boot" role="status" aria-live="polite" aria-busy={percent < 100}>
      <div className="panel-boot__card">
        <div className="panel-boot__spinner" aria-hidden="true" />
        <div className="panel-boot__copy">
          <strong>{label}</strong>
          <span>{stage ?? (percent < 100 ? 'Loading' : 'Ready')}</span>
        </div>
        <div className="panel-boot__bar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div className="panel-boot__fill" style={{ width: `${percent}%` }} />
        </div>
        <span className="panel-boot__pct">{percent}%</span>
      </div>
    </div>
  )
}
