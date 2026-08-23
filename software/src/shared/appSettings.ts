import { HAZARD_RADIUS_DEFAULT_MI, clampHazardRadiusMi } from './hazards'
import { isValidCoordinate, type MapLocation } from './mapLocation'
import { isSatelliteProduct, type SatelliteProduct } from './satellite'

export const APP_SETTINGS_KEY = 'open-weather.app.settings'

export type TemperatureUnit = 'F' | 'C'
export type SpeedUnit = 'mph' | 'kt' | 'kmh'
export type DistanceUnit = 'mi' | 'km'
export type PressureUnit = 'inHg' | 'hPa'
export type PrecipUnit = 'in' | 'mm'
export type ThemeId = 'dark' | 'light'
export type TimeFormat = '12' | '24'
export type BandwidthProfile = 'full' | 'balanced' | 'saver'

export type OverlayDefaults = {
  pressure: boolean
  fronts: boolean
  temps: boolean
  nexrad: boolean
  satellite: boolean
  satelliteProduct: SatelliteProduct
  hazards: boolean
  spc: boolean
  stations: boolean
  frontSource: 'wpc' | 'local'
  hazardRadiusMi: number
}

export type AppSettings = {
  temperatureUnit: TemperatureUnit
  speedUnit: SpeedUnit
  distanceUnit: DistanceUnit
  pressureUnit: PressureUnit
  precipUnit: PrecipUnit
  theme: ThemeId
  timeFormat: TimeFormat
  homePin: MapLocation | null
  overlays: OverlayDefaults
  bandwidth: BandwidthProfile
  allowNexrad: boolean
  allowSatellite: boolean
  allowRadarFallback: boolean
  reduceMotion: boolean
  /** Optional Synoptic/MesoWest token. Empty keeps NWS as the station source. */
  synopticToken: string
}

export const DEFAULT_OVERLAY_DEFAULTS: OverlayDefaults = {
  pressure: true,
  fronts: true,
  temps: true,
  nexrad: true,
  satellite: true,
  satelliteProduct: 'ir',
  hazards: true,
  spc: false,
  stations: true,
  frontSource: 'wpc',
  hazardRadiusMi: HAZARD_RADIUS_DEFAULT_MI
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  temperatureUnit: 'F',
  speedUnit: 'mph',
  distanceUnit: 'mi',
  pressureUnit: 'inHg',
  precipUnit: 'in',
  theme: 'dark',
  timeFormat: '12',
  homePin: null,
  overlays: { ...DEFAULT_OVERLAY_DEFAULTS },
  bandwidth: 'full',
  allowNexrad: true,
  allowSatellite: true,
  allowRadarFallback: true,
  reduceMotion: false,
  synopticToken: ''
}

export type BandwidthCaps = {
  loopFrames: number
  hazardRefreshMs: number
  satelliteCacheMs: number
  compactGrid: boolean
}

export function bandwidthCaps(profile: BandwidthProfile): BandwidthCaps {
  if (profile === 'saver') {
    return { loopFrames: 6, hazardRefreshMs: 180_000, satelliteCacheMs: 600_000, compactGrid: true }
  }
  if (profile === 'balanced') {
    return { loopFrames: 8, hazardRefreshMs: 120_000, satelliteCacheMs: 300_000, compactGrid: false }
  }
  return { loopFrames: 16, hazardRefreshMs: 60_000, satelliteCacheMs: 300_000, compactGrid: false }
}

export function bandwidthPreset(profile: BandwidthProfile): Pick<
  AppSettings,
  'bandwidth' | 'allowNexrad' | 'allowSatellite' | 'allowRadarFallback'
> {
  if (profile === 'saver') {
    return {
      bandwidth: 'saver',
      allowNexrad: false,
      allowSatellite: false,
      allowRadarFallback: true
    }
  }
  if (profile === 'balanced') {
    return {
      bandwidth: 'balanced',
      allowNexrad: true,
      allowSatellite: true,
      allowRadarFallback: true
    }
  }
  return {
    bandwidth: 'full',
    allowNexrad: true,
    allowSatellite: true,
    allowRadarFallback: true
  }
}

export function fToC(f: number): number {
  return ((f - 32) * 5) / 9
}

export function displayTemp(tempF: number | null | undefined, unit: TemperatureUnit): number | null {
  if (tempF == null || !Number.isFinite(tempF)) return null
  return unit === 'C' ? fToC(tempF) : tempF
}

export function displaySpeed(mph: number | null | undefined, unit: SpeedUnit): number | null {
  if (mph == null || !Number.isFinite(mph)) return null
  if (unit === 'kt') return mph * 0.868976
  if (unit === 'kmh') return mph * 1.60934
  return mph
}

export function displayPressure(inHg: number | null | undefined, unit: PressureUnit): number | null {
  if (inHg == null || !Number.isFinite(inHg)) return null
  return unit === 'hPa' ? inHg * 33.8639 : inHg
}

export function displayPrecip(inches: number | null | undefined, unit: PrecipUnit): number | null {
  if (inches == null || !Number.isFinite(inches)) return null
  return unit === 'mm' ? inches * 25.4 : inches
}

export function displayDistance(miles: number, unit: DistanceUnit): number {
  return unit === 'km' ? miles * 1.60934 : miles
}

export function milesFromDistance(value: number, unit: DistanceUnit): number {
  return unit === 'km' ? value / 1.60934 : value
}

export function tempUnitLabel(unit: TemperatureUnit): string {
  return unit === 'C' ? '°C' : '°F'
}

export function speedUnitLabel(unit: SpeedUnit): string {
  if (unit === 'kt') return 'kt'
  if (unit === 'kmh') return 'km/h'
  return 'mph'
}

export function formatClock(date: Date, timeFormat: TimeFormat): string {
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: timeFormat === '12'
  })
}

export function formatRadiusLabel(miles: number, unit: DistanceUnit): string {
  const value = unit === 'km' ? Math.round(displayDistance(miles, 'km')) : Math.round(miles)
  return `${value} ${unit}`
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function readHomePin(raw: unknown): MapLocation | null {
  if (!raw || typeof raw !== 'object') return null
  const pin = raw as Partial<MapLocation>
  const lat = Number(pin.lat)
  const lon = Number(pin.lon)
  if (!isValidCoordinate(lat, lon)) return null
  return {
    lat: Number(lat.toFixed(5)),
    lon: Number(lon.toFixed(5)),
    label: typeof pin.label === 'string' && pin.label.trim() ? pin.label.trim() : 'Home',
    zoom: Number.isFinite(Number(pin.zoom)) ? Math.min(12, Math.max(3, Math.round(Number(pin.zoom)))) : 8
  }
}

export function normalizeAppSettings(raw: Partial<AppSettings> | null | undefined): AppSettings {
  const overlays = raw?.overlays
  return {
    temperatureUnit: raw?.temperatureUnit === 'C' ? 'C' : 'F',
    speedUnit: raw?.speedUnit === 'kt' || raw?.speedUnit === 'kmh' ? raw.speedUnit : 'mph',
    distanceUnit: raw?.distanceUnit === 'km' ? 'km' : 'mi',
    pressureUnit: raw?.pressureUnit === 'hPa' ? 'hPa' : 'inHg',
    precipUnit: raw?.precipUnit === 'mm' ? 'mm' : 'in',
    theme: raw?.theme === 'light' ? 'light' : 'dark',
    timeFormat: raw?.timeFormat === '24' ? '24' : '12',
    homePin: readHomePin(raw?.homePin),
    overlays: {
      pressure: asBoolean(overlays?.pressure, true),
      fronts: asBoolean(overlays?.fronts, true),
      temps: asBoolean(overlays?.temps, true),
      nexrad: asBoolean(overlays?.nexrad, true),
      satellite: asBoolean(overlays?.satellite, true),
      satelliteProduct: isSatelliteProduct(overlays?.satelliteProduct)
        ? overlays.satelliteProduct
        : 'ir',
      hazards: asBoolean(overlays?.hazards, true),
      spc: asBoolean(overlays?.spc, false),
      stations: asBoolean(overlays?.stations, true),
      frontSource: overlays?.frontSource === 'local' ? 'local' : 'wpc',
      hazardRadiusMi: clampHazardRadiusMi(
        overlays?.hazardRadiusMi ?? DEFAULT_OVERLAY_DEFAULTS.hazardRadiusMi
      )
    },
    bandwidth:
      raw?.bandwidth === 'saver' || raw?.bandwidth === 'balanced' ? raw.bandwidth : 'full',
    allowNexrad: asBoolean(raw?.allowNexrad, true),
    allowSatellite: asBoolean(raw?.allowSatellite, true),
    allowRadarFallback: asBoolean(raw?.allowRadarFallback, true),
    reduceMotion: asBoolean(raw?.reduceMotion, false),
    synopticToken: readSynopticToken(raw?.synopticToken)
  }
}

function readSynopticToken(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[^\x20-\x7E]/g, '').trim().slice(0, 200)
}

export function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme
  document.documentElement.setAttribute('data-bs-theme', theme)
  document.documentElement.style.colorScheme = theme
}
