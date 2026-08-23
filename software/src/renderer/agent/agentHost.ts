import {
  BASEMAP_TILES,
  DEFAULT_MAP_LOCATION,
  isValidCoordinate,
  type BasemapId,
  type MapLocation
} from '@shared/mapLocation'
import type {
  AgentAppState,
  AgentCommand,
  AgentCommandResult
} from '@shared/agentApi'
import { isPage, type Page } from '@shared/pages'
import { isSatelliteProduct, type SatelliteProduct } from '@shared/satellite'
import { clampHazardRadiusMi, HAZARD_RADIUS_DEFAULT_MI } from '@shared/hazards'
import { isLayerPresetId, LAYER_PRESETS } from '@shared/layerPresets'

const LOCATION_KEY = 'open-weather.map.location'
const BASEMAP_KEY = 'open-weather.map.basemap'
const OVERLAY_KEY = 'open-weather.map.overlays'

export const AGENT_EVENTS = {
  location: 'ow-agent:location',
  basemap: 'ow-agent:basemap',
  overlays: 'ow-agent:overlays',
  settings: 'ow-agent:settings',
  radar: 'ow-agent:radar',
  navigate: 'ow-agent:navigate'
} as const

type RadarLiveState = {
  playing: boolean
  frameIndex: number
  frameCount: number
  frameDateLabel: string | null
}

type RadarController = {
  getState: () => RadarLiveState
  setPlaying: (playing: boolean) => void
  setFrameIndex: (index: number) => void
  setProgress: (progress: number) => void
}

let radarController: RadarController | null = null
let navigateHandler: ((page: Page) => void) | null = null
let contextPage: Page = 'Dashboard'
let contextIsMain = true

function readLocation(): MapLocation | null {
  try {
    const raw = localStorage.getItem(LOCATION_KEY)
    if (!raw) return DEFAULT_MAP_LOCATION
    const parsed = JSON.parse(raw) as Partial<MapLocation>
    const lat = Number(parsed.lat)
    const lon = Number(parsed.lon)
    const zoom = Number(parsed.zoom)
    if (!isValidCoordinate(lat, lon)) return DEFAULT_MAP_LOCATION
    return {
      lat,
      lon,
      label: typeof parsed.label === 'string' && parsed.label.length > 0 ? parsed.label : 'Custom pin',
      zoom: Number.isFinite(zoom) ? Math.min(12, Math.max(3, Math.round(zoom))) : DEFAULT_MAP_LOCATION.zoom
    }
  } catch {
    return DEFAULT_MAP_LOCATION
  }
}

function readBasemap(): BasemapId | null {
  const raw = localStorage.getItem(BASEMAP_KEY)
  if (raw === 'dark' || raw === 'light' || raw === 'satellite') return raw
  return 'dark'
}

type OverlayState = {
  pressure: boolean
  fronts: boolean
  temps: boolean
  nexrad: boolean
  satellite: boolean
  satelliteProduct: SatelliteProduct
  hazards: boolean
  spc: boolean
  stations: boolean
  hazardRadiusMi: number
  frontSource: 'wpc' | 'local'
}

function readOverlays(): OverlayState & { wind: boolean } {
  try {
    const raw = localStorage.getItem(OVERLAY_KEY)
    if (!raw) {
      return {
        pressure: true,
        fronts: true,
        temps: true,
        nexrad: true,
        satellite: true,
        satelliteProduct: 'ir',
        hazards: true,
        spc: false,
        stations: true,
        hazardRadiusMi: HAZARD_RADIUS_DEFAULT_MI,
        wind: true,
        frontSource: 'wpc'
      }
    }
    const parsed = JSON.parse(raw) as {
      pressure?: boolean
      fronts?: boolean
      temps?: boolean
      wind?: boolean
      nexrad?: boolean
      satellite?: boolean
      satelliteProduct?: SatelliteProduct
      hazards?: boolean
      spc?: boolean
      stations?: boolean
      hazardRadiusMi?: number
      frontSource?: 'wpc' | 'local'
    }
    const fronts =
      parsed.fronts !== undefined ? parsed.fronts !== false : parsed.wind !== false
    const pressure = parsed.pressure !== false
    const temps = parsed.temps !== false
    const nexrad = parsed.nexrad !== false
    const satellite = parsed.satellite !== false
    const satelliteProduct = isSatelliteProduct(parsed.satelliteProduct)
      ? parsed.satelliteProduct
      : 'ir'
    const hazards = parsed.hazards !== false
    const spc = parsed.spc === true
    const stations = parsed.stations !== false
    const hazardRadiusMi = clampHazardRadiusMi(parsed.hazardRadiusMi ?? HAZARD_RADIUS_DEFAULT_MI)
    const frontSource = parsed.frontSource === 'local' ? 'local' : 'wpc'
    return {
      pressure,
      fronts,
      temps,
      nexrad,
      satellite,
      satelliteProduct,
      hazards,
      spc,
      stations,
      hazardRadiusMi,
      wind: fronts,
      frontSource
    }
  } catch {
    return {
      pressure: true,
      fronts: true,
      temps: true,
      nexrad: true,
      satellite: true,
      satelliteProduct: 'ir',
      hazards: true,
      spc: false,
      stations: true,
      hazardRadiusMi: HAZARD_RADIUS_DEFAULT_MI,
      wind: true,
      frontSource: 'wpc'
    }
  }
}

function writeOverlays(partial: {
  pressure?: boolean
  fronts?: boolean
  temps?: boolean
  wind?: boolean
  nexrad?: boolean
  satellite?: boolean
  satelliteProduct?: SatelliteProduct
  hazards?: boolean
  spc?: boolean
  stations?: boolean
  hazardRadiusMi?: number
  frontSource?: 'wpc' | 'local'
}): OverlayState & { wind: boolean } {
  const current = readOverlays()
  const fronts =
    partial.fronts !== undefined
      ? partial.fronts
      : partial.wind !== undefined
        ? partial.wind
        : current.fronts
  const next: OverlayState = {
    pressure: partial.pressure ?? current.pressure,
    fronts,
    temps: partial.temps ?? current.temps,
    nexrad: partial.nexrad ?? current.nexrad,
    satellite: partial.satellite ?? current.satellite,
    satelliteProduct: isSatelliteProduct(partial.satelliteProduct)
      ? partial.satelliteProduct
      : current.satelliteProduct,
    hazards: partial.hazards ?? current.hazards,
    spc: partial.spc ?? current.spc,
    stations: partial.stations ?? current.stations,
    hazardRadiusMi: clampHazardRadiusMi(partial.hazardRadiusMi ?? current.hazardRadiusMi),
    frontSource: partial.frontSource ?? current.frontSource
  }
  localStorage.setItem(OVERLAY_KEY, JSON.stringify(next))
  const detail = { ...next, wind: next.fronts }
  window.dispatchEvent(new CustomEvent(AGENT_EVENTS.overlays, { detail }))
  return detail
}

function writeLocation(next: MapLocation): MapLocation {
  const normalized: MapLocation = {
    lat: Number(next.lat.toFixed(5)),
    lon: Number(next.lon.toFixed(5)),
    label: next.label.trim() || 'Custom pin',
    zoom: Math.min(12, Math.max(3, Math.round(next.zoom)))
  }
  localStorage.setItem(LOCATION_KEY, JSON.stringify(normalized))
  window.dispatchEvent(new CustomEvent(AGENT_EVENTS.location, { detail: normalized }))
  return normalized
}

function writeBasemap(next: BasemapId): BasemapId {
  if (!(next in BASEMAP_TILES)) {
    throw new Error(`Invalid basemap: ${String(next)}`)
  }
  localStorage.setItem(BASEMAP_KEY, next)
  window.dispatchEvent(new CustomEvent(AGENT_EVENTS.basemap, { detail: next }))
  return next
}

export function registerRadarAgentController(controller: RadarController | null): void {
  radarController = controller
}

export function registerAgentNavigate(handler: ((page: Page) => void) | null): void {
  navigateHandler = handler
}

export function setAgentWindowContext(page: Page, isMain: boolean): void {
  contextPage = page
  contextIsMain = isMain
}

function getState(): AgentAppState {
  const radar = radarController?.getState()
  return {
    timestamp: new Date().toISOString(),
    window: {
      isMain: contextIsMain,
      page: contextPage
    },
    location: readLocation(),
    basemap: readBasemap(),
    overlays: readOverlays(),
    radar: {
      playing: radar?.playing ?? null,
      frameIndex: radar?.frameIndex ?? null,
      frameCount: radar?.frameCount ?? null,
      frameDateLabel: radar?.frameDateLabel ?? null
    },
    path: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    userAgent: navigator.userAgent
  }
}

function execute(command: AgentCommand): AgentCommandResult {
  try {
    switch (command.type) {
      case 'set_location': {
        if (!isValidCoordinate(command.location.lat, command.location.lon)) {
          return { ok: false, message: 'Invalid coordinates' }
        }
        const location = writeLocation(command.location)
        return { ok: true, message: 'Location updated', data: location }
      }
      case 'set_basemap': {
        const basemap = writeBasemap(command.basemap)
        return { ok: true, message: `Basemap set to ${basemap}`, data: basemap }
      }
      case 'set_overlays': {
        const overlays = writeOverlays({
          pressure: command.pressure,
          fronts: command.fronts,
          temps: command.temps,
          wind: command.wind,
          nexrad: command.nexrad,
          satellite: command.satellite,
          satelliteProduct: command.satelliteProduct,
          hazards: command.hazards,
          spc: command.spc,
          stations: command.stations,
          hazardRadiusMi: command.hazardRadiusMi,
          frontSource: command.frontSource
        })
        return { ok: true, message: 'Overlays updated', data: overlays }
      }
      case 'set_layer_preset': {
        if (!isLayerPresetId(command.preset)) {
          return { ok: false, message: 'Unknown layer preset' }
        }
        const preset = LAYER_PRESETS.find((item) => item.id === command.preset)
        if (!preset) return { ok: false, message: 'Unknown layer preset' }
        const overlays = writeOverlays({ ...preset.overlays })
        const basemap = preset.basemap ? writeBasemap(preset.basemap) : readBasemap()
        return {
          ok: true,
          message: `${preset.label} preset applied`,
          data: { overlays, basemap }
        }
      }
      case 'set_radar_playing': {
        if (!radarController) {
          return { ok: false, message: 'Radar controller not mounted in this window' }
        }
        radarController.setPlaying(command.playing)
        window.dispatchEvent(
          new CustomEvent(AGENT_EVENTS.radar, { detail: { playing: command.playing } })
        )
        return { ok: true, message: command.playing ? 'Radar playing' : 'Radar paused' }
      }
      case 'set_radar_frame': {
        if (!radarController) {
          return { ok: false, message: 'Radar controller not mounted in this window' }
        }
        radarController.setFrameIndex(command.frameIndex)
        return { ok: true, message: `Frame set to ${command.frameIndex}` }
      }
      case 'set_radar_progress': {
        if (!radarController) {
          return { ok: false, message: 'Radar controller not mounted in this window' }
        }
        const progress = Math.min(1, Math.max(0, command.progress))
        radarController.setProgress(progress)
        return { ok: true, message: `Progress set to ${progress}` }
      }
      case 'navigate_hash': {
        if (!isPage(command.page)) {
          return { ok: false, message: 'Invalid page' }
        }
        if (navigateHandler) {
          navigateHandler(command.page)
        } else {
          window.dispatchEvent(
            new CustomEvent(AGENT_EVENTS.navigate, { detail: command.page })
          )
        }
        contextPage = command.page
        return { ok: true, message: `Navigated to ${command.page}` }
      }
      case 'eval': {
        // Advanced local tooling only; prefer named commands when possible.
        const value = new Function(`"use strict"; return (${command.expression})`)()
        return { ok: true, message: 'Evaluated', data: value }
      }
      case 'open_page':
      case 'focus_main':
      case 'close_detached':
      case 'reload':
        return {
          ok: false,
          message: `Command ${command.type} is handled by the main process, not the renderer`
        }
      default: {
        const _exhaustive: never = command
        return { ok: false, message: `Unknown command ${JSON.stringify(_exhaustive)}` }
      }
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Command failed'
    }
  }
}

declare global {
  interface Window {
    __openWeatherAgent?: {
      getState: () => AgentAppState
      execute: (command: AgentCommand) => AgentCommandResult
    }
  }
}

export function installAgentHost(): void {
  window.__openWeatherAgent = {
    getState,
    execute
  }
}
