import type { ReactElement } from 'react'
import {
  displayPressure,
  displaySpeed,
  displayTemp,
  formatClock,
  speedUnitLabel,
  tempUnitLabel,
  type AppSettings
} from '@shared/appSettings'
import { useAppSettings } from '../hooks/useAppSettings'
import { useLocalWeather } from '../hooks/useLocalWeather'
import { useMapPreferences } from '../hooks/useMapPreferences'
import { usePinHistory, type HistorySeriesPoint } from '../hooks/usePinHistory'

type SeriesKey = 'temperatureF' | 'pressureInHg' | 'windMph'

function Sparkline({
  points,
  read,
  convert,
  color,
  nowValue
}: {
  points: HistorySeriesPoint[]
  read: SeriesKey
  convert: (value: number) => number
  color: string
  nowValue: number | null
}): ReactElement {
  const width = 640
  const height = 120
  const pad = 8
  const values = points
    .map((point) => {
      const raw = point[read]
      return raw != null && Number.isFinite(raw) ? convert(raw) : null
    })
    .filter((value): value is number => value != null)
  if (values.length < 2) {
    return <p className="panel-muted mb-0">Not enough samples yet.</p>
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const step = (width - pad * 2) / (values.length - 1)
  const coords = values.map((value, index) => {
    const x = pad + index * step
    const y = pad + ((max - value) / span) * (height - pad * 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const nowX =
    nowValue != null && Number.isFinite(nowValue)
      ? pad + ((values.length - 1) * step)
      : null
  const nowY =
    nowValue != null && Number.isFinite(nowValue)
      ? pad + ((max - convert(nowValue)) / span) * (height - pad * 2)
      : null

  return (
    <svg className="history-spark" viewBox={`0 0 ${width} ${height}`} role="img">
      <polyline fill="none" stroke={color} strokeWidth="2.2" points={coords.join(' ')} />
      {nowX != null && nowY != null ? (
        <circle cx={nowX} cy={nowY} r="4.2" fill="#f4d27a" stroke="#070b12" strokeWidth="1.2" />
      ) : null}
    </svg>
  )
}

function lastFinite(points: HistorySeriesPoint[], key: SeriesKey): number | null {
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const value = points[i]?.[key]
    if (value != null && Number.isFinite(value)) return value
  }
  return null
}

function formatRange(points: HistorySeriesPoint[], timeFormat: AppSettings['timeFormat']): string {
  if (points.length === 0) return ''
  const first = points[0]!
  const last = points[points.length - 1]!
  return `${formatClock(new Date(first.time), timeFormat)} – ${formatClock(new Date(last.time), timeFormat)}`
}

export function HistoryPage(): ReactElement {
  const { location } = useMapPreferences()
  const { settings } = useAppSettings()
  const { weather } = useLocalWeather(location)
  const { points, loading, error, refresh } = usePinHistory(location)
  const blendTemp = weather?.temperatureF ?? null
  const blendWind = weather?.windMph ?? null
  const blendPressure = weather?.pressureInHg ?? null
  const modelTemp = lastFinite(points, 'temperatureF')
  const modelWind = lastFinite(points, 'windMph')
  const modelPressure = lastFinite(points, 'pressureInHg')

  return (
    <section className="history-page">
      <div className="page-heading d-flex flex-wrap justify-content-between align-items-start gap-2">
        <div>
          <h1>History</h1>
          <p>
            Last 48 hours at {location.label}. Yellow dots are the current NWS station blend when it is
            available.
          </p>
        </div>
        <button type="button" className="btn btn-sm btn-ow-ghost" onClick={() => void refresh()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error ? (
        <p className="inline-alert inline-alert--warn" role="status">
          {error}
        </p>
      ) : null}

      <div className="panel history-panel">
        <h2>Temperature</h2>
        <p className="panel-muted">
          {formatRange(points, settings.timeFormat)}
          {blendTemp != null
            ? ` · blend now ${displayTemp(blendTemp, settings.temperatureUnit)?.toFixed(1)}${tempUnitLabel(settings.temperatureUnit)}`
            : modelTemp != null
              ? ` · model now ${displayTemp(modelTemp, settings.temperatureUnit)?.toFixed(1)}${tempUnitLabel(settings.temperatureUnit)}`
              : ''}
        </p>
        {loading && points.length === 0 ? (
          <p className="panel-muted">Loading series…</p>
        ) : (
          <Sparkline
            points={points}
            read="temperatureF"
            convert={(value) => displayTemp(value, settings.temperatureUnit) ?? value}
            color="#ff8a4a"
            nowValue={blendTemp}
          />
        )}
      </div>

      <div className="panel history-panel">
        <h2>Wind</h2>
        <p className="panel-muted">
          {blendWind != null
            ? `Blend now ${displaySpeed(blendWind, settings.speedUnit)?.toFixed(0)} ${speedUnitLabel(settings.speedUnit)}`
            : modelWind != null
              ? `Model now ${displaySpeed(modelWind, settings.speedUnit)?.toFixed(0)} ${speedUnitLabel(settings.speedUnit)}`
              : 'Hourly 10 m wind'}
        </p>
        {loading && points.length === 0 ? (
          <p className="panel-muted">Loading series…</p>
        ) : (
          <Sparkline
            points={points}
            read="windMph"
            convert={(value) => displaySpeed(value, settings.speedUnit) ?? value}
            color="#5aa2ff"
            nowValue={blendWind}
          />
        )}
      </div>

      <div className="panel history-panel">
        <h2>Pressure</h2>
        <p className="panel-muted">
          {blendPressure != null
            ? `Blend now ${displayPressure(blendPressure, settings.pressureUnit)?.toFixed(settings.pressureUnit === 'hPa' ? 0 : 2)} ${settings.pressureUnit}`
            : modelPressure != null
              ? `Model now ${displayPressure(modelPressure, settings.pressureUnit)?.toFixed(settings.pressureUnit === 'hPa' ? 0 : 2)} ${settings.pressureUnit}`
              : 'Mean sea-level pressure'}
        </p>
        {loading && points.length === 0 ? (
          <p className="panel-muted">Loading series…</p>
        ) : (
          <Sparkline
            points={points}
            read="pressureInHg"
            convert={(value) => displayPressure(value, settings.pressureUnit) ?? value}
            color="#c9a227"
            nowValue={blendPressure}
          />
        )}
      </div>
    </section>
  )
}
