import type { ReactElement } from 'react'
import { MetricCard } from '../components/MetricCard'
import { PanelLoadingOverlay } from '../components/PanelLoadingOverlay'
import { TenDayForecastPanel } from '../components/TenDayForecastPanel'
import {
  displayPrecip,
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
import { useTenDayForecast } from '../hooks/useTenDayForecast'
import { AGENT_EVENTS } from '../agent/agentHost'
import { getStationConnection, getStationObservation } from '../lib/stationConnection'
import {
  formatUvDescriptor,
  formatWeatherCode,
  windDirectionLabel,
  type LocalWeatherSnapshot
} from '../lib/localWeather'

type MetricView = {
  label: string
  value: string
  unit?: string
  meta?: string
  status: 'ok' | 'warn' | 'danger'
}

function fmt(value: number | null | undefined, digits: number): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return value.toFixed(digits)
}

function formatObserved(iso: string | null, timeFormat: AppSettings['timeFormat']): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return null
  return formatClock(date, timeFormat)
}

function metricsFromLocalWeather(
  weather: LocalWeatherSnapshot | null,
  loading: boolean,
  units: AppSettings
): MetricView[] {
  if (!weather && loading) {
    return [
      { label: 'Temperature', value: '…', unit: tempUnitLabel(units.temperatureUnit), meta: 'Loading…', status: 'ok' },
      { label: 'Humidity', value: '…', unit: '%', meta: 'Relative', status: 'ok' },
      { label: 'Pressure', value: '…', unit: units.pressureUnit, meta: 'Sea level', status: 'ok' },
      { label: 'Wind', value: '…', unit: speedUnitLabel(units.speedUnit), meta: 'Surface', status: 'ok' },
      { label: 'Rain (24h)', value: '…', unit: units.precipUnit, meta: 'Estimated', status: 'ok' },
      { label: 'UV Index', value: '…', unit: '', meta: 'Now', status: 'ok' }
    ]
  }

  if (!weather) {
    return [
      { label: 'Temperature', value: '—', unit: tempUnitLabel(units.temperatureUnit), meta: 'No local data', status: 'danger' },
      { label: 'Humidity', value: '—', unit: '%', meta: 'No local data', status: 'danger' },
      { label: 'Pressure', value: '—', unit: units.pressureUnit, meta: 'No local data', status: 'danger' },
      { label: 'Wind', value: '—', unit: speedUnitLabel(units.speedUnit), meta: 'No local data', status: 'danger' },
      { label: 'Rain (24h)', value: '—', unit: units.precipUnit, meta: 'No local data', status: 'danger' },
      { label: 'UV Index', value: '—', unit: '', meta: 'No local data', status: 'danger' }
    ]
  }

  const dir = windDirectionLabel(weather.windDirectionDeg)
  const gust = weather.windGustMph
  const windMetaParts = [
    dir !== '—' ? dir : null,
    gust != null && gust > 0
      ? `gusts ${fmt(displaySpeed(gust, units.speedUnit), 0)}`
      : null
  ].filter(Boolean)
  const windStatus: MetricView['status'] =
    (weather.windMph != null && weather.windMph >= 25) || (gust != null && gust >= 35)
      ? 'warn'
      : 'ok'

  const precip = weather.precip24hIn
  const rainStatus: MetricView['status'] =
    precip != null && precip >= 1.5 ? 'danger' : precip != null && precip >= 0.5 ? 'warn' : 'ok'

  const uv = weather.isDay === false ? 0 : weather.uvIndex
  const uvPeak = weather.uvPeakToday
  const uvStatus: MetricView['status'] =
    weather.isDay === false
      ? 'ok'
      : uv != null && uv >= 11
        ? 'danger'
        : uv != null && uv >= 8
          ? 'warn'
          : 'ok'
  const uvMeta =
    weather.isDay === false
      ? uvPeak != null && uvPeak >= 1
        ? `Night · peak ${Math.round(uvPeak)}`
        : 'Night'
      : formatUvDescriptor(uv)

  const sky = formatWeatherCode(weather.weatherCode)

  return [
    {
      label: 'Temperature',
      value: fmt(displayTemp(weather.temperatureF, units.temperatureUnit), 1),
      unit: tempUnitLabel(units.temperatureUnit),
      meta: sky !== '—' ? sky : 'Outdoor',
      status: 'ok'
    },
    {
      label: 'Humidity',
      value: fmt(weather.humidityPct, 0),
      unit: '%',
      meta: 'Relative',
      status: 'ok'
    },
    {
      label: 'Pressure',
      value: fmt(displayPressure(weather.pressureInHg, units.pressureUnit), units.pressureUnit === 'hPa' ? 0 : 2),
      unit: units.pressureUnit,
      meta: 'MSL',
      status: 'ok'
    },
    {
      label: 'Wind',
      value: fmt(displaySpeed(weather.windMph, units.speedUnit), 1),
      unit: speedUnitLabel(units.speedUnit),
      meta: windMetaParts.length > 0 ? windMetaParts.join(' · ') : 'Surface',
      status: windStatus
    },
    {
      label: 'Rain (24h)',
      value: fmt(precip == null ? null : displayPrecip(precip, units.precipUnit), units.precipUnit === 'mm' ? 1 : 2),
      unit: units.precipUnit,
      meta: precip != null && precip > 0 ? 'Last 24 hours' : 'None',
      status: rainStatus
    },
    {
      label: 'UV Index',
      value: uv == null ? '—' : fmt(uv, 0),
      unit: '',
      meta: uvMeta,
      status: uvStatus
    }
  ]
}

function formatSyncLabel(refreshedAt: Date | null, timeFormat: AppSettings['timeFormat']): string {
  if (!refreshedAt) return 'Updating…'
  return formatClock(refreshedAt, timeFormat)
}

export function DashboardPage(): ReactElement {
  const stationLink = getStationConnection()
  const stationObs = getStationObservation()
  const { location } = useMapPreferences()
  const { settings } = useAppSettings()
  const { weather, loading, progress: weatherProgress, error, refreshedAt } = useLocalWeather(location)
  const weatherForPin =
    weather &&
    Math.abs(weather.lat - location.lat) < 0.03 &&
    Math.abs(weather.lon - location.lon) < 0.03
      ? weather
      : null
  const forecast = useTenDayForecast(location, stationObs ?? weatherForPin)

  const usingPublicWeather = !stationLink.connected
  const metrics = usingPublicWeather
    ? metricsFromLocalWeather(weatherForPin, loading, settings)
    : metricsFromLocalWeather(null, false, settings)

  const sourceLabel = !usingPublicWeather
    ? 'Station live'
    : error
      ? 'Weather offline'
      : loading && !weatherForPin
        ? 'Loading weather'
        : weatherForPin?.source === 'nws'
          ? `NWS · ${weatherForPin.usedStationCount} stn`
          : weatherForPin?.source === 'synoptic'
            ? `Synoptic · ${weatherForPin.usedStationCount} stn`
            : 'Open-Meteo'

  const sky = weatherForPin
    ? weatherForPin.skyText || formatWeatherCode(weatherForPin.weatherCode)
    : null
  const observed = weatherForPin ? formatObserved(weatherForPin.observedAt, settings.timeFormat) : null
  const pinLabel = location.label

  return (
    <>
      <aside className="dashboard-side">
          <section className="dashboard-metrics-wrap conditions-panel">
            {usingPublicWeather && loading ? (
              <PanelLoadingOverlay
                progress={weatherProgress}
                label="Current conditions"
                stage={weatherProgress < 0.5 ? 'Fetching observation' : 'Updating panel'}
              />
            ) : null}
            <header className="conditions-glance">
              <div className="conditions-glance__copy">
                <h2 className="conditions-glance__place">{pinLabel}</h2>
                <p className="conditions-glance__now">
                  {usingPublicWeather ? (
                    <>
                      {sky && sky !== '—' ? <span>{sky}</span> : <span>Current conditions</span>}
                      {observed ? <span className="conditions-glance__sep">·</span> : null}
                      {observed ? <span>as of {observed}</span> : null}
                    </>
                  ) : (
                    <span>Live radar and station status</span>
                  )}
                </p>
              </div>
              <div className="conditions-glance__aside">
                <span
                  className={`sync-pill${error ? ' sync-pill--warn' : ''}${
                    !error && weatherForPin ? ' sync-pill--ok' : ''
                  }`}
                  data-weather-source={weatherForPin?.source ?? 'none'}
                  data-station-count={weatherForPin?.usedStationCount ?? 0}
                  title={
                    error ??
                    (weatherForPin?.observedAt
                      ? `${weatherForPin.source} · ${weatherForPin.usedStationCount} stations · ${weatherForPin.observedAt}`
                      : undefined)
                  }
                >
                  {sourceLabel}
                  {usingPublicWeather && !error && weatherForPin
                    ? ` · ${formatSyncLabel(refreshedAt, settings.timeFormat)}`
                    : null}
                </span>
              </div>
            </header>
            {error && usingPublicWeather ? (
              <div className="inline-alert inline-alert--warn mb-2" role="status">
                {error}. Showing last known values when available.
              </div>
            ) : null}
            <div className="row g-2 dashboard-metrics">
              {metrics.map((metric) => (
                <div key={metric.label} className="col-6 col-md-4 col-xl-4">
                  <MetricCard {...metric} />
                </div>
              ))}
            </div>
          </section>

          <TenDayForecastPanel
            forecast={forecast.forecast}
            loading={forecast.loading}
            progress={forecast.progress}
            error={forecast.error}
          />

          {stationLink.connected && stationLink.stations.length > 0 ? (
            <div className="panel panel--tight">
              <h2>Station health</h2>
              <div className="table-responsive">
                <table className="table table-ow table-sm table-hover align-middle">
                  <thead>
                    <tr>
                      <th>Station</th>
                      <th>Link</th>
                      <th>Battery</th>
                      <th>Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stationLink.stations.map((station) => (
                      <tr key={station.id}>
                        <td>{station.name}</td>
                        <td>
                          <span
                            className={`status-dot ${
                              station.link === 'online'
                                ? 'ok'
                                : station.link === 'degraded'
                                  ? 'warn'
                                  : 'danger'
                            } me-2`}
                          />
                          {station.link === 'online'
                            ? 'Online'
                            : station.link === 'degraded'
                              ? 'Degraded'
                              : 'Offline'}
                        </td>
                        <td>{station.batteryPct == null ? '—' : `${station.batteryPct}%`}</td>
                        <td>{station.lastSeenLabel}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="station-note station-note--compact" role="status">
              <span
                className={`status-dot ${weatherForPin && weatherForPin.usedStationCount > 0 ? 'ok' : 'warn'}`}
                aria-hidden="true"
              />
              <span>
                {weatherForPin && weatherForPin.usedStationCount > 0
                  ? `${weatherForPin.usedStationCount} nearby ${
                      weatherForPin.source === 'synoptic' ? 'Synoptic' : 'NWS'
                    } stations`
                  : 'No station linked · Open-Meteo at pin'}
              </span>
              <button
                type="button"
                className="btn btn-sm btn-ow-ghost"
                onClick={() =>
                  window.dispatchEvent(new CustomEvent(AGENT_EVENTS.navigate, { detail: 'Stations' }))
                }
              >
                Stations
              </button>
            </div>
          )}
      </aside>
    </>
  )
}
