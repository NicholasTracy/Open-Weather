export type BasemapId = 'dark' | 'light' | 'satellite'

export type MapLocation = {
  lat: number
  lon: number
  label: string
  zoom: number
}

export const DEFAULT_MAP_LOCATION: MapLocation = {
  lat: 39.8283,
  lon: -98.5795,
  label: 'Contiguous United States',
  zoom: 5
}

export const BASEMAP_TILES: Record<
  BasemapId,
  { url: string; attribution: string; maxZoom: number; subdomains?: string }
> = {
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 20,
    subdomains: 'abcd'
  },
  light: {
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 20,
    subdomains: 'abcd'
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution:
      'Tiles &copy; <a href="https://www.esri.com">Esri</a> — Maxar, Earthstar Geographics, and the GIS User Community',
    maxZoom: 19
  }
}

export function clampLatitude(value: number): number {
  return Math.min(85, Math.max(-85, value))
}

export function clampLongitude(value: number): number {
  if (!Number.isFinite(value)) return 0
  const wrapped = ((((value + 180) % 360) + 360) % 360) - 180
  return wrapped
}

export function isValidCoordinate(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
}
