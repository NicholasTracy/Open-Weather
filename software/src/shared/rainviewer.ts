export type RadarFrameKind = 'observed' | 'nowcast'

export type RainViewerFrame = {
  time: number
  path: string
  kind?: RadarFrameKind
}

export type RainViewerMapsResponse = {
  version: string
  generated: number
  host: string
  radar: {
    past: RainViewerFrame[]
    nowcast?: RainViewerFrame[]
  }
}

export const RAINVIEWER_API_URL = 'https://api.rainviewer.com/public/weather-maps.json'

/** Color scheme 2 = Universal Blue; smooth + snow enabled. */
export function buildRadarTileUrl(host: string, framePath: string, tileSize: 256 | 512 = 256): string {
  const base = host.replace(/\/$/, '')
  return `${base}${framePath}/${tileSize}/{z}/{x}/{y}/2/1_1.png`
}

export function buildRadarTileUrlAt(
  host: string,
  framePath: string,
  z: number,
  x: number,
  y: number,
  tileSize: 256 | 512 = 256
): string {
  const base = host.replace(/\/$/, '')
  return `${base}${framePath}/${tileSize}/${z}/${x}/${y}/2/1_1.png`
}
