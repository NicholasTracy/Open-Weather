import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type { HazardAlert } from '@shared/hazards'
import { hazardAbbrev, tickerText } from '@shared/hazards'
import { useAppSettings } from '../../hooks/useAppSettings'

const TICKER_PX_PER_SEC = 42

function TickerItems({
  alerts,
  selectedId,
  onSelect
}: {
  alerts: HazardAlert[]
  selectedId: string | null
  onSelect: (id: string) => void
}): ReactElement {
  return (
    <>
      {alerts.map((alert) => (
        <button
          key={alert.id}
          type="button"
          className={`hazard-ticker__item${selectedId === alert.id ? ' is-selected' : ''}`}
          style={{ '--hazard-color': alert.color } as CSSProperties}
          onClick={() => onSelect(alert.id)}
          title={alert.headline}
        >
          <span className="hazard-ticker__chip">{hazardAbbrev(alert.event)}</span>
          <span className="hazard-ticker__text">{tickerText(alert)}</span>
        </button>
      ))}
    </>
  )
}

export function HazardTicker({
  alerts,
  compact,
  selectedId,
  onSelect
}: {
  alerts: HazardAlert[]
  compact: boolean
  selectedId: string | null
  onSelect: (id: string) => void
}): ReactElement | null {
  const { settings } = useAppSettings()
  const top = alerts[0]
  const scroll = alerts.length > 0 && !settings.reduceMotion
  const viewportRef = useRef<HTMLDivElement>(null)
  const itemsRef = useRef<HTMLDivElement>(null)
  const [metrics, setMetrics] = useState({ from: 0, to: 0, group: 0, distance: 0 })

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const items = itemsRef.current
    if (!viewport || !items || !scroll) return
    const measure = (): void => {
      const view = viewport.clientWidth
      const content = items.scrollWidth
      if (view <= 0 || content <= 0) return
      if (content >= view) {
        setMetrics({ from: 0, to: -content, group: content, distance: content })
      } else {
        setMetrics({
          from: view,
          to: -content,
          group: content + view,
          distance: view + content
        })
      }
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(items)
    return () => observer.disconnect()
  }, [alerts, scroll])

  if (alerts.length === 0) return null

  const ready = scroll && metrics.distance > 0
  const durationSec = ready ? Math.max(8, metrics.distance / TICKER_PX_PER_SEC) : 20

  return (
    <div
      className={`hazard-ticker${compact ? ' hazard-ticker--compact' : ''}${
        scroll ? ' hazard-ticker--scroll' : ''
      }`}
      style={top ? { borderColor: `${top.color}88` } : undefined}
      role="status"
      aria-live="polite"
    >
      <div ref={viewportRef} className={`hazard-ticker__viewport${scroll ? ' is-scroll' : ''}`}>
        <div
          className={`hazard-ticker__track${ready ? ' is-scroll' : ''}`}
          style={
            ready
              ? ({
                  '--ticker-from': `${metrics.from}px`,
                  '--ticker-to': `${metrics.to}px`,
                  animationDuration: `${durationSec}s`
                } as CSSProperties)
              : undefined
          }
        >
          <div className="hazard-ticker__group" style={ready ? { minWidth: metrics.group } : undefined}>
            <div ref={itemsRef} className="hazard-ticker__items">
              <TickerItems alerts={alerts} selectedId={selectedId} onSelect={onSelect} />
            </div>
          </div>
          {scroll ? (
            <div
              className="hazard-ticker__group"
              style={ready ? { minWidth: metrics.group } : undefined}
              aria-hidden="true"
            >
              <div className="hazard-ticker__items">
                <TickerItems alerts={alerts} selectedId={selectedId} onSelect={onSelect} />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
