import { useEffect, type CSSProperties, type ReactElement } from 'react'
import type { HazardAlert } from '@shared/hazards'
import { formatHazardWhen, hazardAbbrev } from '@shared/hazards'

function cleanText(value: string | null): string {
  if (!value) return ''
  return value.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function HazardInspectPanel({
  alert,
  compact,
  onClose
}: {
  alert: HazardAlert
  compact: boolean
  onClose: () => void
}): ReactElement {
  const until = formatHazardWhen(alert.ends ?? alert.expires)
  const productExpires =
    alert.ends && alert.expires && alert.ends !== alert.expires
      ? formatHazardWhen(alert.expires)
      : ''
  const instruction = cleanText(alert.instruction)
  const description = cleanText(alert.description)
  const tags = [
    alert.emergency ? 'Emergency' : null,
    alert.pds ? 'PDS' : null,
    alert.tornado,
    alert.wind,
    alert.hail ? `${alert.hail}" hail` : null
  ].filter(Boolean)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <aside
      className={`hazard-inspect${compact ? ' hazard-inspect--compact' : ''}`}
      style={{ '--hazard-color': alert.color } as CSSProperties}
      role="dialog"
      aria-label={alert.event}
    >
      <header className="hazard-inspect__head">
        <span className="hazard-inspect__chip">{hazardAbbrev(alert.event)}</span>
        <div className="hazard-inspect__titles">
          <h2 className="hazard-inspect__event">{alert.event}</h2>
          {until ? <p className="hazard-inspect__until">Until {until}</p> : null}
        </div>
        <button type="button" className="hazard-inspect__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      {alert.headline ? <p className="hazard-inspect__headline">{alert.headline}</p> : null}
      <dl className="hazard-inspect__meta">
        {alert.area ? (
          <>
            <dt>Area</dt>
            <dd>{alert.area}</dd>
          </>
        ) : null}
        {productExpires ? (
          <>
            <dt>Product expires</dt>
            <dd>{productExpires}</dd>
          </>
        ) : null}
        {alert.sender ? (
          <>
            <dt>Source</dt>
            <dd>{alert.sender}</dd>
          </>
        ) : null}
        {tags.length > 0 ? (
          <>
            <dt>Tags</dt>
            <dd>{tags.join(' · ')}</dd>
          </>
        ) : null}
      </dl>
      <div className="hazard-inspect__body">
        {instruction ? (
          <section>
            <h3>What to do</h3>
            <p>{instruction}</p>
          </section>
        ) : null}
        {description ? (
          <section>
            <h3>Details</h3>
            <p>{description}</p>
          </section>
        ) : null}
      </div>
    </aside>
  )
}
