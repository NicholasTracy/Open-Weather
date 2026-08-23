import type { ReactElement } from 'react'

type MetricCardProps = {
  label: string
  value: string
  unit?: string
  meta?: string
  status?: 'ok' | 'warn' | 'danger'
}

export function MetricCard({
  label,
  value,
  unit,
  meta,
  status = 'ok'
}: MetricCardProps): ReactElement {
  return (
    <article className="metric-card">
      <div className="metric-label">
        <span>{label}</span>
        {status !== 'ok' ? <span className={`status-dot ${status}`} aria-hidden="true" /> : null}
      </div>
      <div className="metric-value">
        {value}
        {unit ? <span className="metric-unit">{unit}</span> : null}
      </div>
      {meta ? <div className="metric-meta">{meta}</div> : null}
    </article>
  )
}
