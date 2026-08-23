import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'

export type RadarLoadTask = {
  id: string
  label: string
  /** 0–1 */
  fraction: number
  weight: number
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function formatEta(ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000))
  if (sec < 60) return `~${sec}s left`
  const min = Math.ceil(sec / 60)
  return min === 1 ? '~1 min left' : `~${min} min left`
}

function weightedFraction(tasks: RadarLoadTask[]): number {
  const active = tasks.filter((task) => task.weight > 0)
  if (active.length === 0) return 1
  let sum = 0
  let weight = 0
  for (const task of active) {
    sum += clamp01(task.fraction) * task.weight
    weight += task.weight
  }
  return weight > 0 ? sum / weight : 1
}

export function RadarLoadBar({
  tasks,
  compact = false
}: {
  tasks: RadarLoadTask[]
  compact?: boolean
}): ReactElement | null {
  const fraction = weightedFraction(tasks)
  const percent = Math.round(fraction * 100)
  const done = fraction >= 0.995
  const [visible, setVisible] = useState(!done)
  const startedAtRef = useRef<number | null>(done ? null : Date.now())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (done) {
      startedAtRef.current = null
      const hide = window.setTimeout(() => setVisible(false), 700)
      return () => window.clearTimeout(hide)
    }
    setVisible(true)
    if (startedAtRef.current == null) startedAtRef.current = Date.now()
    const tick = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(tick)
  }, [done])

  const etaLabel = useMemo(() => {
    const startedAt = startedAtRef.current
    if (done || startedAt == null || fraction < 0.06) return null
    const elapsed = now - startedAt
    if (elapsed < 600) return null
    const remaining = (elapsed * (1 - fraction)) / fraction
    if (!Number.isFinite(remaining) || remaining < 400) return null
    if (remaining > 8 * 60 * 1000) return null
    return formatEta(remaining)
  }, [done, fraction, now])

  const label = useMemo(() => {
    const pending = tasks
      .filter((task) => task.weight > 0 && task.fraction < 0.995)
      .sort((a, b) => (1 - b.fraction) * b.weight - (1 - a.fraction) * a.weight)
    return pending[0]?.label ?? 'Ready'
  }, [tasks])

  if (!visible) return null

  return (
    <div
      className={`radar-loadbar${compact ? ' radar-loadbar--compact' : ''}${done ? ' is-done' : ''}`}
      role="status"
      aria-live="polite"
    >
      <div className="radar-loadbar__meta">
        <span className="radar-loadbar__label">{done ? 'Map data ready' : label}</span>
        <span className="radar-loadbar__stats">
          {percent}%
          {!done && etaLabel ? <span className="radar-loadbar__eta">{etaLabel}</span> : null}
        </span>
      </div>
      <div className="radar-loadbar__track" aria-hidden="true">
        <div className="radar-loadbar__fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}
