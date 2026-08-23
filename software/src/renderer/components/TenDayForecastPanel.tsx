import { useState, type ReactElement } from 'react'
import {
  formatWeatherCode,
  type DailyForecastDay,
  type ForecastConfidence,
  type MonthlyOutlookPeriod,
  type OpenMeteoDayCompare,
  type TenDayForecast
} from '../lib/localWeather'
import { displayTemp } from '@shared/appSettings'
import { useAppSettings } from '../hooks/useAppSettings'
import { PanelLoadingOverlay } from './PanelLoadingOverlay'
import { WeatherGlyph } from './WeatherGlyph'

type ForecastView = 'blend' | 'open-meteo' | 'compare'

function fmtTemp(value: number | null, toC: boolean): string {
  const shown = displayTemp(value, toC ? 'C' : 'F')
  if (shown == null) return '—'
  return `${Math.round(shown)}°`
}

function fmtRainChance(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${Math.round(value)}%`
}

function shortWeekday(label: string): string {
  if (label === 'Today' || label === 'Tomorrow') return label
  return label.slice(0, 3)
}

function confidenceLabel(confidence: ForecastConfidence): string {
  if (confidence === 'high') return 'High agreement'
  if (confidence === 'medium') return 'Moderate agreement'
  return 'Lower confidence'
}

function periodTemp(period: MonthlyOutlookPeriod, toC: boolean): string {
  const shown = displayTemp(period.meanF, toC ? 'C' : 'F')
  if (shown == null) return '—'
  return `${Math.round(shown)}°`
}

function deltaClass(blend: number | null, baseline: number | null): string {
  if (blend == null || baseline == null || !Number.isFinite(blend) || !Number.isFinite(baseline)) {
    return ''
  }
  const delta = Math.round(blend) - Math.round(baseline)
  if (delta > 0) return ' is-up'
  if (delta < 0) return ' is-down'
  return ' is-same'
}

function dayTitle(day: DailyForecastDay, toC: boolean): string {
  const parts = [
    `${day.modelCount} model${day.modelCount === 1 ? '' : 's'}`,
    confidenceLabel(day.confidence)
  ]
  const t = (value: number): number => Math.round(displayTemp(value, toC ? 'C' : 'F') ?? value)
  if (day.highRangeF) {
    parts.push(`high ${t(day.highRangeF.min)}–${t(day.highRangeF.max)}°`)
  }
  if (day.lowRangeF) {
    parts.push(`low ${t(day.lowRangeF.min)}–${t(day.lowRangeF.max)}°`)
  }
  if (day.openMeteo?.highF != null) {
    parts.push(`Open-Meteo high ${t(day.openMeteo.highF)}°`)
  }
  if (day.openMeteo?.lowF != null) {
    parts.push(`Open-Meteo low ${t(day.openMeteo.lowF)}°`)
  }
  return parts.join(' · ')
}

function displayDay(
  day: DailyForecastDay,
  view: ForecastView
): {
  dayCode: number | null
  nightCode: number | null
  highF: number | null
  lowF: number | null
  rain: number | null
  compare: OpenMeteoDayCompare | null
} {
  const om = day.openMeteo
  if (view === 'open-meteo' && om) {
    return {
      dayCode: om.dayWeatherCode,
      nightCode: om.nightWeatherCode,
      highF: om.highF,
      lowF: om.lowF,
      rain: om.precipChancePct,
      compare: null
    }
  }
  return {
    dayCode: day.dayWeatherCode,
    nightCode: day.nightWeatherCode,
    highF: day.highF,
    lowF: day.lowF,
    rain: day.precipChancePct,
    compare: view === 'compare' ? om : null
  }
}

export function TenDayForecastPanel({
  forecast,
  loading,
  progress = 0,
  error
}: {
  forecast: TenDayForecast | null
  loading: boolean
  progress?: number
  error: string | null
}): ReactElement {
  const { settings } = useAppSettings()
  const toC = settings.temperatureUnit === 'C'
  const [view, setView] = useState<ForecastView>('compare')
  const days = forecast?.days ?? []
  const monthly = forecast?.monthly?.periods ?? []
  const hasBaseline = days.some((day) => day.openMeteo != null)

  return (
    <div className="panel panel--tight forecast-panel">
      {loading ? (
        <PanelLoadingOverlay
          progress={progress}
          label="10-day outlook"
          stage={
            progress < 0.5
              ? 'Blending AIFS, IFS, GFS, ICON…'
              : progress < 0.8
                ? 'Adding Open-Meteo baseline…'
                : 'Loading monthly outlook…'
          }
        />
      ) : null}
      <div className="forecast-panel__head">
        <div className="forecast-panel__title">
          <h2>10-day outlook</h2>
          <span className="forecast-panel__model">
            {view === 'open-meteo'
              ? (forecast?.baselineModel ?? 'Open-Meteo best match')
              : (forecast?.model ?? (loading ? 'Loading models…' : 'Ensemble'))}
          </span>
        </div>
        {hasBaseline ? (
          <div className="forecast-panel__views" role="tablist" aria-label="Forecast source">
            {(
              [
                ['blend', 'Blend'],
                ['open-meteo', 'Open-Meteo'],
                ['compare', 'Compare']
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={view === id}
                className={`forecast-panel__view${view === id ? ' is-active' : ''}`}
                onClick={() => setView(id)}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {forecast?.stationAdjusted && view !== 'open-meteo' ? (
        <p className="forecast-panel__bias">Today adjusted with local observation</p>
      ) : null}

      {error && days.length === 0 ? (
        <p className="forecast-panel__empty">{error}</p>
      ) : null}

      {days.length > 0 ? (
        <div className="forecast-table-wrap">
          <div className="forecast-table__head" aria-hidden="true">
            <span className="forecast-table__cell forecast-table__cell--day">Day</span>
            <span className="forecast-table__cell forecast-table__cell--sky">Daytime</span>
            <span className="forecast-table__cell forecast-table__cell--temp">High</span>
            <span className="forecast-table__cell forecast-table__cell--sky">Night</span>
            <span className="forecast-table__cell forecast-table__cell--temp">Low</span>
            <span className="forecast-table__cell forecast-table__cell--rain">Rain</span>
          </div>
          <ul className="forecast-rows" aria-label="Ten day forecast">
            {days.map((day) => {
              const shown = displayDay(day, view)
              const daySky = formatWeatherCode(shown.dayCode)
              const nightSky = formatWeatherCode(shown.nightCode)
              return (
                <li key={day.date} className="forecast-row" title={dayTitle(day, toC)}>
                  <span className="forecast-table__cell forecast-table__cell--day">
                    <span className="forecast-row__weekday">
                      <span
                        className={`forecast-row__confidence forecast-row__confidence--${day.confidence}`}
                        aria-label={confidenceLabel(day.confidence)}
                      />
                      {shortWeekday(day.weekday)}
                    </span>
                    <span className="forecast-row__date">
                      {new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric'
                      })}
                    </span>
                  </span>

                  <span className="forecast-table__cell forecast-table__cell--sky forecast-table__cell--daytime">
                    <WeatherGlyph
                      code={shown.dayCode}
                      period="day"
                      label={`${day.weekday} day: ${daySky}`}
                    />
                    <span className="forecast-row__cond">{daySky}</span>
                  </span>

                  <span className="forecast-table__cell forecast-table__cell--temp forecast-table__cell--high">
                    <span>{fmtTemp(shown.highF, toC)}</span>
                    {shown.compare ? (
                      <span className={`forecast-row__om${deltaClass(shown.highF, shown.compare.highF)}`}>
                        OM {fmtTemp(shown.compare.highF, toC)}
                      </span>
                    ) : null}
                  </span>

                  <span className="forecast-table__cell forecast-table__cell--sky forecast-table__cell--nighttime">
                    <WeatherGlyph
                      code={shown.nightCode}
                      period="night"
                      label={`${day.weekday} night: ${nightSky}`}
                    />
                    <span className="forecast-row__cond">{nightSky}</span>
                  </span>

                  <span className="forecast-table__cell forecast-table__cell--temp forecast-table__cell--low">
                    <span>{fmtTemp(shown.lowF, toC)}</span>
                    {shown.compare ? (
                      <span className={`forecast-row__om${deltaClass(shown.lowF, shown.compare.lowF)}`}>
                        OM {fmtTemp(shown.compare.lowF, toC)}
                      </span>
                    ) : null}
                  </span>

                  <span className="forecast-table__cell forecast-table__cell--rain">
                    <span className="forecast-row__rain-value">{fmtRainChance(shown.rain)}</span>
                    {shown.compare ? (
                      <span
                        className={`forecast-row__om${deltaClass(shown.rain, shown.compare.precipChancePct)}`}
                      >
                        OM {fmtRainChance(shown.compare.precipChancePct)}
                      </span>
                    ) : (
                      <span className="forecast-row__rain-label">Chance of rain</span>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}

      {monthly.length > 0 ? (
        <div className="forecast-month">
          <div className="forecast-month__head">
            <h3>Monthly outlook</h3>
            <span>{forecast?.monthly?.model ?? 'ECMWF seasonal'} · lower confidence</span>
          </div>
          <ul className="forecast-month__list" aria-label="Monthly weather outlook">
            {monthly.map((period) => (
              <li
                key={period.id}
                className={`forecast-month__item forecast-month__item--${period.kind}`}
                title={period.narrative}
              >
                <span className="forecast-month__label">{period.label}</span>
                <span className="forecast-month__temp">{periodTemp(period, toC)}</span>
                <span className="forecast-month__note">{period.narrative}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
