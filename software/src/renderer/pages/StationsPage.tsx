import type { ReactElement } from 'react'
import {
  displayDistance,
  displaySpeed,
  displayTemp,
  formatClock,
  speedUnitLabel,
  tempUnitLabel
} from '@shared/appSettings'
import { NEARBY_MAX_RADIUS_MI, networkDisplayName } from '@shared/nearbyStations'
import { useAppSettings } from '../hooks/useAppSettings'
import { useLocalWeather } from '../hooks/useLocalWeather'
import { useMapPreferences } from '../hooks/useMapPreferences'
import { getStationConnection } from '../lib/stationConnection'
import { windDirectionLabel } from '../lib/localWeather'

function formatObs(iso: string | null, timeFormat: '12' | '24'): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return '—'
  return formatClock(date, timeFormat)
}

export function StationsPage(): ReactElement {
  const { location, setLocation } = useMapPreferences()
  const { settings } = useAppSettings()
  const { weather, loading, error, refresh } = useLocalWeather(location)
  const own = getStationConnection()
  const stations = weather?.stations ?? []
  const used = weather?.usedStationCount ?? 0
  const source =
    weather?.source === 'synoptic' ? 'Synoptic / MesoWest' : weather?.source === 'nws' ? 'NWS' : 'Open-Meteo'
  const radiusLabel =
    settings.distanceUnit === 'km'
      ? `${Math.round(displayDistance(NEARBY_MAX_RADIUS_MI, 'km'))} km`
      : `${NEARBY_MAX_RADIUS_MI} mi`

  return (
    <section className="stations-page">
      <div className="page-heading d-flex flex-wrap justify-content-between align-items-start gap-2">
        <div>
          <h1>Stations</h1>
          <p>
            Nearby public stations around {location.label}. Open Weather hardware pairing will land here
            later.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-ow-ghost"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="panel stations-panel">
        <h2>Nearby public stations</h2>
        <p className="panel-muted">
          {used > 0
            ? `Averaging ${used} ${source} station${used === 1 ? '' : 's'} within ${radiusLabel} of the pin. Click a row to fly the map there.`
            : `No usable station observations within ${radiusLabel}. Live metrics fall back to Open-Meteo.`}
          {settings.synopticToken
            ? ' Synoptic token is saved in Settings and is tried first.'
            : ' Add a Synoptic token in Settings to include CWOP and other mesonets.'}
        </p>
        {error ? (
          <p className="inline-alert inline-alert--warn" role="status">
            {error}
          </p>
        ) : null}
        {weather?.stationError ? (
          <p className="panel-muted small">{weather.stationError}. Using the next available source.</p>
        ) : null}

        {stations.length === 0 && !loading ? (
          <div className="empty-state empty-state--compact">
            <strong>No public stations in range</strong>
            <span>Move the map pin or add a Synoptic token for a denser community network.</span>
          </div>
        ) : (
          <div className="table-responsive">
            <table className="table table-ow table-sm table-hover align-middle">
              <thead>
                <tr>
                  <th>Station</th>
                  <th>Network</th>
                  <th>Distance</th>
                  <th>Observed</th>
                  <th>Temp</th>
                  <th>Wind</th>
                  <th>Blend</th>
                </tr>
              </thead>
              <tbody>
                {stations.map((station) => {
                  const dist = displayDistance(station.distanceMi, settings.distanceUnit)
                  const temp = displayTemp(station.temperatureF, settings.temperatureUnit)
                  const wind = displaySpeed(station.windMph, settings.speedUnit)
                  const dir = windDirectionLabel(station.windDirectionDeg)
                  return (
                    <tr
                      key={`${station.network}-${station.id}`}
                      className="stations-page__row"
                      onClick={() =>
                        setLocation({
                          lat: station.lat,
                          lon: station.lon,
                          label: station.name ? `${station.id} · ${station.name}` : station.id,
                          zoom: 10
                        })
                      }
                    >
                      <td>
                        <strong>{station.id}</strong>
                        <div className="stations-page__name">{station.name}</div>
                      </td>
                      <td>{station.networkLabel || networkDisplayName(station.network)}</td>
                      <td>
                        {dist.toFixed(1)} {settings.distanceUnit}
                      </td>
                      <td>{formatObs(station.observedAt, settings.timeFormat)}</td>
                      <td>
                        {temp == null ? '—' : `${temp.toFixed(1)}${tempUnitLabel(settings.temperatureUnit)}`}
                      </td>
                      <td>
                        {wind == null
                          ? '—'
                          : `${wind.toFixed(0)} ${speedUnitLabel(settings.speedUnit)}${
                              dir !== '—' ? ` ${dir}` : ''
                            }`}
                      </td>
                      <td>
                        {station.usedInAverage ? (
                          <span className="stations-page__badge stations-page__badge--ok">In average</span>
                        ) : (
                          <span className="stations-page__badge">
                            {station.excludeReason ?? (station.stale ? 'Stale' : 'Held out')}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel stations-panel">
        <h2>Open Weather hardware</h2>
        {own.connected && own.stations.length > 0 ? (
          <div className="table-responsive">
            <table className="table table-ow table-sm align-middle">
              <thead>
                <tr>
                  <th>Station</th>
                  <th>Link</th>
                  <th>Battery</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {own.stations.map((station) => (
                  <tr key={station.id}>
                    <td>{station.name}</td>
                    <td>{station.link}</td>
                    <td>{station.batteryPct == null ? '—' : `${station.batteryPct}%`}</td>
                    <td>{station.lastSeenLabel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state empty-state--compact">
            <strong>No personal station linked</strong>
            <span>Discovery, pairing, and firmware targets will plug into this section.</span>
          </div>
        )}
      </div>
    </section>
  )
}
