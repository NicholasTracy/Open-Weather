import type { BasemapId, MapLocation } from './mapLocation'
import type { Page } from './pages'

/** Default localhost agent HTTP bridge. */
export const DEFAULT_AGENT_BRIDGE_PORT = 17832
export const DEFAULT_CDP_PORT = 9222

export type AgentWindowInfo = {
  id: number
  title: string
  isMain: boolean
  page: Page | 'unknown'
  bounds: { x: number; y: number; width: number; height: number }
  url: string
}

export type AgentAppState = {
  timestamp: string
  window: {
    isMain: boolean
    page: Page | string
  }
  location: MapLocation | null
  basemap: BasemapId | null
  overlays: {
    pressure: boolean
    fronts: boolean
    temps: boolean
    wind: boolean
    nexrad: boolean
    satellite: boolean
    satelliteProduct: 'geocolor' | 'ir' | 'vis' | 'wv'
    hazards: boolean
    spc: boolean
    stations: boolean
    hazardRadiusMi: number
    frontSource: 'wpc' | 'local'
  } | null
  radar: {
    playing: boolean | null
    frameIndex: number | null
    frameCount: number | null
    frameDateLabel: string | null
  }
  path: string
  userAgent: string
}

export type AgentCommand =
  | { type: 'open_page'; page: Page; displayId?: number }
  | { type: 'focus_main' }
  | { type: 'close_detached'; page?: Page }
  | { type: 'set_location'; location: MapLocation }
  | { type: 'set_basemap'; basemap: BasemapId }
  | {
      type: 'set_overlays'
      pressure?: boolean
      fronts?: boolean
      temps?: boolean
      wind?: boolean
      nexrad?: boolean
      satellite?: boolean
      satelliteProduct?: 'geocolor' | 'ir' | 'vis' | 'wv'
      hazards?: boolean
      spc?: boolean
      stations?: boolean
      hazardRadiusMi?: number
      frontSource?: 'wpc' | 'local'
    }
  | { type: 'set_layer_preset'; preset: 'analysis' | 'radar' | 'satellite' }
  | { type: 'set_radar_playing'; playing: boolean }
  | { type: 'set_radar_frame'; frameIndex: number }
  | { type: 'set_radar_progress'; progress: number }
  | { type: 'navigate_hash'; page: Page }
  | { type: 'reload' }
  | { type: 'eval'; expression: string }

export type AgentCommandResult = {
  ok: boolean
  message?: string
  data?: unknown
}

export type AgentScreenshotResult = {
  ok: boolean
  windowId: number
  page: string
  path: string
  mimeType: 'image/png'
  width: number
  height: number
}
