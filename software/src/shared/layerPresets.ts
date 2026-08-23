import type { BasemapId } from './mapLocation'

export type LayerPresetId = 'analysis' | 'radar' | 'satellite'

export type LayerPresetOverlays = {
  pressure: boolean
  fronts: boolean
  temps: boolean
  nexrad: boolean
  satellite: boolean
  hazards: boolean
  spc: boolean
  stations: boolean
}

export type LayerPreset = {
  id: LayerPresetId
  label: string
  title: string
  overlays: LayerPresetOverlays
  /** Optional basemap switch so the product matches the overlay mix. */
  basemap?: BasemapId
}

export const LAYER_PRESETS: LayerPreset[] = [
  {
    id: 'analysis',
    label: 'Analysis',
    title: 'Surface analysis: isobars, fronts, and city temps. NEXRAD and GOES off.',
    overlays: {
      pressure: true,
      fronts: true,
      temps: true,
      nexrad: false,
      satellite: false,
      hazards: true,
      spc: false,
      stations: true
    }
  },
  {
    id: 'radar',
    label: 'Radar',
    title: 'NEXRAD reflectivity. Analysis and GOES off so the mosaic can read.',
    overlays: {
      pressure: false,
      fronts: false,
      temps: false,
      nexrad: true,
      satellite: false,
      hazards: true,
      spc: false,
      stations: true
    },
    basemap: 'dark'
  },
  {
    id: 'satellite',
    label: 'Sat',
    title: 'GOES overlay on a satellite basemap. Analysis and NEXRAD off.',
    overlays: {
      pressure: false,
      fronts: false,
      temps: false,
      nexrad: false,
      satellite: true,
      hazards: true,
      spc: false,
      stations: true
    },
    basemap: 'satellite'
  }
]

export function matchingLayerPreset(overlays: {
  pressure: boolean
  fronts: boolean
  temps: boolean
  nexrad: boolean
  satellite: boolean
}): LayerPresetId | null {
  for (const preset of LAYER_PRESETS) {
    const want = preset.overlays
    if (
      overlays.pressure === want.pressure &&
      overlays.fronts === want.fronts &&
      overlays.temps === want.temps &&
      overlays.nexrad === want.nexrad &&
      overlays.satellite === want.satellite
    ) {
      return preset.id
    }
  }
  return null
}

export function isLayerPresetId(value: unknown): value is LayerPresetId {
  return value === 'analysis' || value === 'radar' || value === 'satellite'
}
