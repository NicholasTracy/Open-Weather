import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react'
import {
  bandwidthPreset,
  formatRadiusLabel,
  milesFromDistance,
  type BandwidthProfile,
  type DistanceUnit,
  type OverlayDefaults,
  type PrecipUnit,
  type PressureUnit,
  type SpeedUnit,
  type TemperatureUnit,
  type ThemeId,
  type TimeFormat
} from '@shared/appSettings'
import { HAZARD_RADIUS_DEFAULT_MI, HAZARD_RADIUS_MAX_MI, HAZARD_RADIUS_MIN_MI, clampHazardRadiusMi } from '@shared/hazards'
import type { ScreenDisplayChoice } from '@shared/ipc'
import { SATELLITE_PRODUCTS, isSatelliteProduct, type SatelliteProduct } from '@shared/satellite'
import { AGENT_EVENTS } from '../agent/agentHost'
import { LocationSearch, type LocationSearchHandle } from '../components/LocationSearch'
import { useAppSettings } from '../hooks/useAppSettings'
import { useMapPreferences } from '../hooks/useMapPreferences'

const OVERLAY_KEY = 'open-weather.map.overlays'

function applyOverlaysToMap(overlays: OverlayDefaults): void {
  const next = { ...overlays }
  localStorage.setItem(OVERLAY_KEY, JSON.stringify(next))
  window.dispatchEvent(new CustomEvent(AGENT_EVENTS.overlays, { detail: { ...next, wind: next.fronts } }))
}

function readLiveOverlays(): OverlayDefaults | null {
  try {
    const raw = localStorage.getItem(OVERLAY_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<OverlayDefaults> & { wind?: boolean }
    const fronts =
      parsed.fronts !== undefined ? parsed.fronts !== false : parsed.wind !== false
    return {
      pressure: parsed.pressure !== false,
      fronts,
      temps: parsed.temps !== false,
      nexrad: parsed.nexrad !== false,
      satellite: parsed.satellite !== false,
      satelliteProduct: isSatelliteProduct(parsed.satelliteProduct)
        ? parsed.satelliteProduct
        : 'ir',
      hazards: parsed.hazards !== false,
      spc: parsed.spc === true,
      stations: parsed.stations !== false,
      frontSource: parsed.frontSource === 'local' ? 'local' : 'wpc',
      hazardRadiusMi: clampHazardRadiusMi(parsed.hazardRadiusMi ?? HAZARD_RADIUS_DEFAULT_MI)
    }
  } catch {
    return null
  }
}

function mapPrefsDiffer(live: OverlayDefaults, defaults: OverlayDefaults): boolean {
  return (
    live.frontSource !== defaults.frontSource ||
    live.hazardRadiusMi !== defaults.hazardRadiusMi ||
    live.satelliteProduct !== defaults.satelliteProduct
  )
}

function frontSourceLabel(source: OverlayDefaults['frontSource']): string {
  return source === 'local' ? 'Local estimate' : 'WPC analyzed surface'
}

export function SettingsPage(): ReactElement {
  const { settings, updateSettings, resetSettings } = useAppSettings()
  const { location, setLocation } = useMapPreferences()
  const [displays, setDisplays] = useState<ScreenDisplayChoice[]>([])
  const homeSearchRef = useRef<LocationSearchHandle>(null)
  const [homeSearch, setHomeSearch] = useState(settings.homePin?.label ?? '')
  const [homeStatus, setHomeStatus] = useState<string | null>(null)
  const [homeBusy, setHomeBusy] = useState(false)
  const [synopticDraft, setSynopticDraft] = useState(settings.synopticToken)
  const [synopticStatus, setSynopticStatus] = useState<string | null>(null)
  const [layoutStatus, setLayoutStatus] = useState<string | null>(null)
  const [liveOverlays, setLiveOverlays] = useState<OverlayDefaults | null>(() => readLiveOverlays())

  useEffect(() => {
    void window.desktop?.listDisplays().then(setDisplays)
  }, [])

  useEffect(() => {
    const syncLive = (): void => setLiveOverlays(readLiveOverlays())
    window.addEventListener(AGENT_EVENTS.overlays, syncLive)
    window.addEventListener('storage', syncLive)
    return () => {
      window.removeEventListener(AGENT_EVENTS.overlays, syncLive)
      window.removeEventListener('storage', syncLive)
    }
  }, [])

  useEffect(() => {
    setSynopticDraft(settings.synopticToken)
  }, [settings.synopticToken])

  const saveSynopticToken = (value: string): void => {
    const next = value.trim()
    updateSettings({ synopticToken: next })
    setSynopticDraft(next)
    setSynopticStatus(next ? 'Token saved. Nearby weather will try Synoptic first.' : 'Synoptic cleared. Using NWS stations.')
  }

  const radiusDisplay = Math.round(
    settings.distanceUnit === 'km' ? settings.overlays.hazardRadiusMi * 1.60934 : settings.overlays.hazardRadiusMi
  )
  const radiusMin = settings.distanceUnit === 'km' ? 15 : HAZARD_RADIUS_MIN_MI
  const radiusMax = settings.distanceUnit === 'km' ? 400 : HAZARD_RADIUS_MAX_MI

  const setOverlayDefault = (partial: Partial<OverlayDefaults>, applyLive = false): void => {
    const overlays = { ...settings.overlays, ...partial }
    updateSettings({ overlays })
    if (applyLive) {
      const live = readLiveOverlays()
      applyOverlaysToMap({
        ...(live ?? overlays),
        ...partial
      })
      setLiveOverlays(readLiveOverlays())
    }
  }

  const onHomeSearch = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setHomeBusy(true)
    setHomeStatus(null)
    try {
      const result = await homeSearchRef.current?.resolve()
      if (!result) {
        setHomeStatus('No matching place found.')
        return
      }
      const homePin = {
        lat: result.lat,
        lon: result.lon,
        label: result.label,
        zoom: result.zoom
      }
      updateSettings({ homePin })
      setHomeSearch(result.label)
      setHomeStatus(`Home set · ${result.label}`)
    } catch (err) {
      setHomeStatus(err instanceof Error ? err.message : 'Geocoding failed')
    } finally {
      setHomeBusy(false)
    }
  }

  return (
    <section className="settings-page">
      <div className="page-heading">
        <h1>Settings</h1>
        <p>Units, map defaults, home pin, appearance, and bandwidth for limited connections.</p>
      </div>

      <div className="row g-3">
        <div className="col-12 col-xl-6">
          <div className="panel settings-panel">
            <h2>Units</h2>
            <div className="settings-grid">
              <label className="settings-field">
                <span className="form-label">Temperature</span>
                <select
                  className="form-select form-select-sm"
                  value={settings.temperatureUnit}
                  onChange={(event) =>
                    updateSettings({ temperatureUnit: event.target.value as TemperatureUnit })
                  }
                >
                  <option value="F">Fahrenheit (°F)</option>
                  <option value="C">Celsius (°C)</option>
                </select>
              </label>
              <label className="settings-field">
                <span className="form-label">Wind</span>
                <select
                  className="form-select form-select-sm"
                  value={settings.speedUnit}
                  onChange={(event) => updateSettings({ speedUnit: event.target.value as SpeedUnit })}
                >
                  <option value="mph">Miles per hour</option>
                  <option value="kt">Knots</option>
                  <option value="kmh">Kilometers per hour</option>
                </select>
              </label>
              <label className="settings-field">
                <span className="form-label">Distance</span>
                <select
                  className="form-select form-select-sm"
                  value={settings.distanceUnit}
                  onChange={(event) =>
                    updateSettings({ distanceUnit: event.target.value as DistanceUnit })
                  }
                >
                  <option value="mi">Miles</option>
                  <option value="km">Kilometers</option>
                </select>
              </label>
              <label className="settings-field">
                <span className="form-label">Pressure</span>
                <select
                  className="form-select form-select-sm"
                  value={settings.pressureUnit}
                  onChange={(event) =>
                    updateSettings({ pressureUnit: event.target.value as PressureUnit })
                  }
                >
                  <option value="inHg">Inches of mercury</option>
                  <option value="hPa">Hectopascals</option>
                </select>
              </label>
              <label className="settings-field">
                <span className="form-label">Precipitation</span>
                <select
                  className="form-select form-select-sm"
                  value={settings.precipUnit}
                  onChange={(event) => updateSettings({ precipUnit: event.target.value as PrecipUnit })}
                >
                  <option value="in">Inches</option>
                  <option value="mm">Millimeters</option>
                </select>
              </label>
              <label className="settings-field">
                <span className="form-label">Clock</span>
                <select
                  className="form-select form-select-sm"
                  value={settings.timeFormat}
                  onChange={(event) => updateSettings({ timeFormat: event.target.value as TimeFormat })}
                >
                  <option value="12">12-hour</option>
                  <option value="24">24-hour</option>
                </select>
              </label>
            </div>
            <div className="settings-actions">
              <button
                type="button"
                className="btn btn-sm btn-ow-ghost"
                onClick={() =>
                  updateSettings({
                    temperatureUnit: 'F',
                    speedUnit: 'mph',
                    distanceUnit: 'mi',
                    pressureUnit: 'inHg',
                    precipUnit: 'in'
                  })
                }
              >
                US / Imperial
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ow-ghost"
                onClick={() =>
                  updateSettings({
                    temperatureUnit: 'C',
                    speedUnit: 'kmh',
                    distanceUnit: 'km',
                    pressureUnit: 'hPa',
                    precipUnit: 'mm'
                  })
                }
              >
                Metric
              </button>
            </div>
          </div>
        </div>

        <div className="col-12 col-xl-6">
          <div className="panel settings-panel">
            <h2>Appearance</h2>
            <div className="settings-grid">
              <label className="settings-field">
                <span className="form-label">Theme</span>
                <select
                  className="form-select form-select-sm"
                  value={settings.theme}
                  onChange={(event) => updateSettings({ theme: event.target.value as ThemeId })}
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </label>
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={settings.reduceMotion}
                  onChange={(event) => updateSettings({ reduceMotion: event.target.checked })}
                />
                <span>Reduce motion (ticker scroll and extra animation)</span>
              </label>
            </div>
          </div>
        </div>

        <div className="col-12">
          <div className="panel settings-panel">
            <h2>Home pin</h2>
            <p className="panel-muted">
              Saved place for the Home button on Radar. Current map pin is {location.label}.
            </p>
            <form className="settings-home" onSubmit={(event) => void onHomeSearch(event)}>
              <label className="settings-field settings-field--wide">
                <span className="form-label">Search</span>
                <LocationSearch
                  ref={homeSearchRef}
                  value={homeSearch}
                  onChange={setHomeSearch}
                  bias={location}
                  minChars={16}
                  onSelect={(result) => {
                    updateSettings({
                      homePin: {
                        lat: result.lat,
                        lon: result.lon,
                        label: result.label,
                        zoom: result.zoom
                      }
                    })
                    setHomeSearch(result.label)
                    setHomeStatus(`Home set · ${result.label}`)
                  }}
                />
              </label>
              <button type="submit" className="btn btn-sm btn-ow-primary" disabled={homeBusy}>
                {homeBusy ? 'Searching…' : 'Set home'}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ow-ghost"
                onClick={() => {
                  updateSettings({ homePin: { ...location } })
                  setHomeSearch(location.label)
                  setHomeStatus(`Home set · ${location.label}`)
                }}
              >
                Use current pin
              </button>
              {settings.homePin ? (
                <>
                  <button
                    type="button"
                    className="btn btn-sm btn-ow-ghost"
                    onClick={() => setLocation({ ...settings.homePin! })}
                  >
                    Go home
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ow-ghost"
                    onClick={() => {
                      updateSettings({ homePin: null })
                      setHomeStatus('Home pin cleared')
                    }}
                  >
                    Clear
                  </button>
                </>
              ) : null}
            </form>
            {settings.homePin ? (
              <p className="panel-muted mb-0 small">
                {settings.homePin.label} · {settings.homePin.lat.toFixed(4)}, {settings.homePin.lon.toFixed(4)}
              </p>
            ) : null}
            {homeStatus ? <p className="panel-muted mb-0 small">{homeStatus}</p> : null}
          </div>
        </div>

        <div className="col-12 col-xl-6">
          <div className="panel settings-panel">
            <h2>Map defaults</h2>
            <p className="panel-muted">Startup overlays and the watch/warning radius around the pin.</p>
            {liveOverlays ? (
              <div
                className={`settings-live${mapPrefsDiffer(liveOverlays, settings.overlays) ? ' settings-live--mismatch' : ''}`}
              >
                <p className="settings-live__now">
                  Map now: {frontSourceLabel(liveOverlays.frontSource)} ·{' '}
                  {formatRadiusLabel(liveOverlays.hazardRadiusMi, settings.distanceUnit)} ·{' '}
                  {SATELLITE_PRODUCTS.find((entry) => entry.id === liveOverlays.satelliteProduct)?.label ??
                    liveOverlays.satelliteProduct}
                </p>
                {mapPrefsDiffer(liveOverlays, settings.overlays) ? (
                  <p className="settings-live__diff">
                    Settings still say {frontSourceLabel(settings.overlays.frontSource)} ·{' '}
                    {formatRadiusLabel(settings.overlays.hazardRadiusMi, settings.distanceUnit)}.
                  </p>
                ) : (
                  <p className="settings-live__diff">Front source, radius, and satellite product match the map.</p>
                )}
              </div>
            ) : null}
            <div className="settings-toggles">
              {(
                [
                  ['pressure', 'Pressure'],
                  ['fronts', 'Fronts'],
                  ['temps', 'Temps'],
                  ['nexrad', 'NEXRAD L2'],
                  ['satellite', 'GOES'],
                  ['hazards', 'Hazards'],
                  ['spc', 'SPC Day 1'],
                  ['stations', 'Stations']
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="settings-check">
                  <input
                    type="checkbox"
                    checked={settings.overlays[key]}
                    onChange={(event) =>
                      setOverlayDefault({ [key]: event.target.checked } as Partial<OverlayDefaults>)
                    }
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            <div className="settings-grid mt-3">
              <label className="settings-field">
                <span className="form-label">Satellite product</span>
                <select
                  className="form-select form-select-sm"
                  value={settings.overlays.satelliteProduct}
                  onChange={(event) =>
                    setOverlayDefault({ satelliteProduct: event.target.value as SatelliteProduct }, true)
                  }
                >
                  {SATELLITE_PRODUCTS.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="settings-field">
                <span className="form-label">Front source</span>
                <select
                  className="form-select form-select-sm"
                  value={settings.overlays.frontSource}
                  onChange={(event) =>
                    setOverlayDefault(
                      {
                        frontSource: event.target.value === 'local' ? 'local' : 'wpc'
                      },
                      true
                    )
                  }
                >
                  <option value="wpc">WPC analyzed surface</option>
                  <option value="local">Local estimate</option>
                </select>
              </label>
              <label className="settings-field settings-field--wide">
                <span className="form-label">
                  Hazard radius {formatRadiusLabel(settings.overlays.hazardRadiusMi, settings.distanceUnit)}
                </span>
                <input
                  type="range"
                  min={radiusMin}
                  max={radiusMax}
                  step={settings.distanceUnit === 'km' ? 5 : 5}
                  value={radiusDisplay}
                  onChange={(event) => {
                    const miles = clampHazardRadiusMi(
                      milesFromDistance(Number(event.target.value), settings.distanceUnit)
                    )
                    setOverlayDefault({ hazardRadiusMi: miles }, true)
                  }}
                />
              </label>
            </div>
            <div className="settings-actions">
              <button
                type="button"
                className="btn btn-sm btn-ow-primary"
                onClick={() => {
                  applyOverlaysToMap(settings.overlays)
                  setLiveOverlays(readLiveOverlays())
                }}
              >
                Apply defaults to map
              </button>
              <button
                type="button"
                className={`btn btn-sm ${
                  liveOverlays && mapPrefsDiffer(liveOverlays, settings.overlays)
                    ? 'btn-ow-primary'
                    : 'btn-ow-ghost'
                }`}
                onClick={() => {
                  const live = readLiveOverlays()
                  if (!live) return
                  updateSettings({ overlays: { ...settings.overlays, ...live } })
                  setLiveOverlays(live)
                }}
              >
                Copy current map overlays
              </button>
            </div>
          </div>
        </div>

        <div className="col-12 col-xl-6">
          <div className="panel settings-panel">
            <h2>Bandwidth</h2>
            <p className="panel-muted">
              Limit heavy internet use on metered or weak connections. Saver turns off Level II and GOES
              tiles; RainViewer stays available as a lighter fallback.
            </p>
            <label className="settings-field">
              <span className="form-label">Profile</span>
              <select
                className="form-select form-select-sm"
                value={settings.bandwidth}
                onChange={(event) =>
                  updateSettings(bandwidthPreset(event.target.value as BandwidthProfile))
                }
              >
                <option value="full">Full · all products, fastest refresh</option>
                <option value="balanced">Balanced · fewer radar frames, slower alerts</option>
                <option value="saver">Saver · no NEXRAD / GOES, lightest use</option>
              </select>
            </label>
            <div className="settings-toggles mt-3">
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={settings.allowNexrad}
                  onChange={(event) => updateSettings({ allowNexrad: event.target.checked })}
                />
                <span>Allow NEXRAD Level II downloads</span>
              </label>
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={settings.allowSatellite}
                  onChange={(event) => updateSettings({ allowSatellite: event.target.checked })}
                />
                <span>Allow GOES satellite tiles</span>
              </label>
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={settings.allowRadarFallback}
                  onChange={(event) => updateSettings({ allowRadarFallback: event.target.checked })}
                />
                <span>Allow RainViewer worldwide radar</span>
              </label>
            </div>
          </div>
        </div>

        <div className="col-12 col-xl-6">
          <div className="panel settings-panel">
            <h2>Displays</h2>
            <p className="panel-muted">
              Put Dashboard on one monitor and Radar on another, then save it as the ops layout.
            </p>
            <ul className="list-unstyled mb-0">
              {displays.map((display) => (
                <li key={display.id} className="mb-2 d-flex justify-content-between gap-2 align-items-center">
                  <span>
                    {display.label}
                    {display.isPrimary ? ' · Primary' : ''}
                  </span>
                  <span className="d-flex gap-1">
                    <button
                      type="button"
                      className="btn btn-sm btn-ow-ghost"
                      onClick={() => void window.desktop?.placeMainOnDisplay(display.id)}
                    >
                      Dashboard
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ow-ghost"
                      onClick={() => void window.desktop?.openPageWindow('Radar', { displayId: display.id })}
                    >
                      Radar
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ow-ghost"
                      onClick={() =>
                        void window.desktop?.openPageWindow('Settings', { displayId: display.id })
                      }
                    >
                      Settings
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <div className="settings-actions">
              <button
                type="button"
                className="btn btn-sm btn-ow-primary"
                onClick={() => {
                  void window.desktop?.saveOpsLayout().then((layout) => {
                    if (!layout) return
                    setLayoutStatus(
                      `Saved ops layout · Dashboard display ${layout.dashboardDisplayId ?? '—'} · Radar display ${layout.radarDisplayId ?? '—'}`
                    )
                  })
                }}
              >
                Save this layout
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ow-ghost"
                onClick={() => {
                  void window.desktop?.applyOpsLayout().then((ok) => {
                    setLayoutStatus(ok ? 'Ops layout applied.' : 'No saved ops layout yet.')
                  })
                }}
              >
                Restore ops layout
              </button>
            </div>
            {layoutStatus ? <p className="panel-muted mb-0 small">{layoutStatus}</p> : null}
            {displays.length === 0 ? (
              <p className="panel-muted mb-0">No displays reported yet.</p>
            ) : null}
          </div>
        </div>

        <div className="col-12">
          <div className="panel settings-panel">
            <h2>Community stations</h2>
            <p className="panel-muted">
              Live conditions use nearby NWS stations around the pin, with Open-Meteo as fallback. Paste a
              Synoptic / MesoWest API token to add CWOP and other mesonets. Tokens stay on this computer.
            </p>
            <div className="settings-grid">
              <label className="settings-field settings-field--wide">
                <span className="form-label">Synoptic API token</span>
                <input
                  type="password"
                  className="form-control form-control-sm"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Optional — paste token to activate Synoptic"
                  value={synopticDraft}
                  onChange={(event) => setSynopticDraft(event.target.value)}
                  onBlur={() => {
                    if (synopticDraft.trim() !== settings.synopticToken) {
                      saveSynopticToken(synopticDraft)
                    }
                  }}
                />
              </label>
            </div>
            <p className="panel-muted small mb-0 mt-2">
              {settings.synopticToken
                ? 'Token on file. Synoptic is tried first; NWS and Open-Meteo remain fallbacks.'
                : 'No token — NWS stations only.'}
            </p>
            {synopticStatus ? <p className="panel-muted small mb-0">{synopticStatus}</p> : null}
            <div className="settings-actions">
              <button
                type="button"
                className="btn btn-sm btn-ow-primary"
                onClick={() => saveSynopticToken(synopticDraft)}
              >
                Save token
              </button>
              {settings.synopticToken ? (
                <button
                  type="button"
                  className="btn btn-sm btn-ow-ghost"
                  onClick={() => saveSynopticToken('')}
                >
                  Clear token
                </button>
              ) : null}
              <a
                className="btn btn-sm btn-ow-ghost"
                href="https://customer.synopticdata.com"
                target="_blank"
                rel="noreferrer"
              >
                Get a Synoptic token
              </a>
            </div>
          </div>
        </div>

        <div className="col-12 col-xl-6">
          <div className="panel settings-panel">
            <h2>Reset</h2>
            <p className="panel-muted">Restore units, theme, home pin, map defaults, bandwidth, and the Synoptic token.</p>
            <button type="button" className="btn btn-sm btn-ow-ghost" onClick={() => resetSettings()}>
              Reset all settings
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
