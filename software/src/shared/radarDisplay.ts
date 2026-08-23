import {
  MOSAIC_REFLECTIVITY_STOPS,
  NEXRAD_COMPOSITE_SITES,
  NEXRAD_COMPOSITE_SITES_WIDE,
  NWS_REFLECTIVITY_STOPS,
  type PaletteStop
} from './nexrad'

export const RADAR_DISPLAY_KEY = 'open-weather.radar.display'
export const NEXRAD_LOOP_FRAMES_MIN = 6
export const NEXRAD_LOOP_FRAMES_MAX = 16

export type RadarMosaicMode = 'merged' | 'merged4' | 'single'

export function isMergedMosaic(mode: RadarMosaicMode): boolean {
  return mode === 'merged' || mode === 'merged4'
}

export function mosaicSiteLimit(mode: RadarMosaicMode): number {
  if (mode === 'merged4') return NEXRAD_COMPOSITE_SITES_WIDE
  if (mode === 'merged') return NEXRAD_COMPOSITE_SITES
  return 1
}

export type RadarPaletteId = 'nws' | 'awips' | 'storm' | 'universal'
export type RadarProductId = 'reflectivity' | 'hca'

export type RadarDisplayPrefs = {
  mosaicMode: RadarMosaicMode
  siteId: string | null
  palette: RadarPaletteId
  product: RadarProductId
  /** 0 = show weaker echo, 1 = stricter near-radar / noise floor. */
  threshold: number
  /** 0 = raw gates, 1 = strongest cell merge / AA. */
  cohesion: number
  loopFrames: number
  /** 0.4–2.5 playback rate. */
  speed: number
  opacity: number
  /** Slide echo between keyframes using estimated storm motion. */
  drift: boolean
}

export const DEFAULT_RADAR_DISPLAY: RadarDisplayPrefs = {
  mosaicMode: 'merged',
  siteId: null,
  palette: 'universal',
  product: 'hca',
  threshold: 0.45,
  cohesion: 0.65,
  loopFrames: 12,
  speed: 1,
  opacity: 1,
  drift: true
}

/** AWIPS-style reflectivity (public 88D-like table). */
export const AWIPS_REFLECTIVITY_STOPS: PaletteStop[] = [
  { dbz: -10, color: [0, 0, 0, 0] },
  { dbz: 5, color: [0, 0, 0, 0] },
  { dbz: 10, color: [4, 233, 231, 255] },
  { dbz: 15, color: [1, 159, 244, 255] },
  { dbz: 20, color: [3, 0, 244, 255] },
  { dbz: 25, color: [2, 253, 2, 255] },
  { dbz: 30, color: [1, 197, 1, 255] },
  { dbz: 35, color: [0, 142, 0, 255] },
  { dbz: 40, color: [253, 248, 2, 255] },
  { dbz: 45, color: [229, 188, 0, 255] },
  { dbz: 50, color: [253, 139, 0, 255] },
  { dbz: 55, color: [212, 0, 0, 255] },
  { dbz: 60, color: [188, 0, 0, 255] },
  { dbz: 65, color: [248, 0, 253, 255] },
  { dbz: 70, color: [152, 84, 198, 255] },
  { dbz: 75, color: [255, 255, 255, 255] }
]

/** RadarScope / storm-relative greens with punchy cores. */
export const STORM_REFLECTIVITY_STOPS: PaletteStop[] = [
  { dbz: -10, color: [0, 0, 0, 0] },
  { dbz: 18, color: [0, 0, 0, 0] },
  { dbz: 20, color: [0, 180, 80, 190] },
  { dbz: 25, color: [0, 210, 40, 220] },
  { dbz: 30, color: [40, 200, 0, 235] },
  { dbz: 35, color: [180, 220, 0, 245] },
  { dbz: 40, color: [255, 210, 0, 255] },
  { dbz: 45, color: [255, 140, 0, 255] },
  { dbz: 50, color: [255, 40, 0, 255] },
  { dbz: 55, color: [200, 0, 40, 255] },
  { dbz: 60, color: [255, 0, 180, 255] },
  { dbz: 70, color: [255, 255, 255, 255] }
]

export const RADAR_PALETTES: {
  id: RadarPaletteId
  label: string
  stops: PaletteStop[]
}[] = [
  { id: 'nws', label: 'NWS 88D', stops: NWS_REFLECTIVITY_STOPS },
  { id: 'awips', label: 'AWIPS', stops: AWIPS_REFLECTIVITY_STOPS },
  { id: 'storm', label: 'Storm', stops: STORM_REFLECTIVITY_STOPS },
  { id: 'universal', label: 'Universal', stops: MOSAIC_REFLECTIVITY_STOPS }
]

export function paletteStops(id: RadarPaletteId): PaletteStop[] {
  return RADAR_PALETTES.find((entry) => entry.id === id)?.stops ?? MOSAIC_REFLECTIVITY_STOPS
}

export function thresholdBiasDbz(threshold: number): number {
  const t = clamp01(threshold)
  return -8 + t * 20
}

export function clampLoopFrames(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RADAR_DISPLAY.loopFrames
  return Math.min(NEXRAD_LOOP_FRAMES_MAX, Math.max(NEXRAD_LOOP_FRAMES_MIN, Math.round(value)))
}

export function clampSpeed(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(2.5, Math.max(0.4, value))
}

export function normalizeRadarDisplay(raw: Partial<RadarDisplayPrefs> | null): RadarDisplayPrefs {
  const palette = RADAR_PALETTES.some((entry) => entry.id === raw?.palette)
    ? (raw!.palette as RadarPaletteId)
    : DEFAULT_RADAR_DISPLAY.palette
  return {
    mosaicMode:
      raw?.mosaicMode === 'single' ? 'single' : raw?.mosaicMode === 'merged4' ? 'merged4' : 'merged',
    siteId: typeof raw?.siteId === 'string' && raw.siteId.length >= 3 ? raw.siteId.toUpperCase() : null,
    palette,
    product: raw?.product === 'reflectivity' ? 'reflectivity' : 'hca',
    threshold: clamp01(raw?.threshold ?? DEFAULT_RADAR_DISPLAY.threshold),
    cohesion: clamp01(raw?.cohesion ?? DEFAULT_RADAR_DISPLAY.cohesion),
    loopFrames: clampLoopFrames(raw?.loopFrames ?? DEFAULT_RADAR_DISPLAY.loopFrames),
    speed: clampSpeed(raw?.speed ?? DEFAULT_RADAR_DISPLAY.speed),
    opacity: clamp01(raw?.opacity ?? DEFAULT_RADAR_DISPLAY.opacity),
    drift: raw?.drift !== false
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}
