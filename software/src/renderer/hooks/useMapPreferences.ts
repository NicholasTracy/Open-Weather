import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_MAP_LOCATION,
  isValidCoordinate,
  type BasemapId,
  type MapLocation
} from '@shared/mapLocation'
import { AGENT_EVENTS } from '../agent/agentHost'

const LOCATION_KEY = 'open-weather.map.location'
const BASEMAP_KEY = 'open-weather.map.basemap'

function readLocation(): MapLocation {
  try {
    const raw = localStorage.getItem(LOCATION_KEY)
    if (!raw) return DEFAULT_MAP_LOCATION
    const parsed = JSON.parse(raw) as Partial<MapLocation>
    const lat = Number(parsed.lat)
    const lon = Number(parsed.lon)
    const zoom = Number(parsed.zoom)
    if (!isValidCoordinate(lat, lon)) return DEFAULT_MAP_LOCATION
    return {
      lat: Number(lat.toFixed(5)),
      lon: Number(lon.toFixed(5)),
      label: typeof parsed.label === 'string' && parsed.label.length > 0 ? parsed.label : 'Custom pin',
      zoom: Number.isFinite(zoom) ? Math.min(12, Math.max(3, Math.round(zoom))) : DEFAULT_MAP_LOCATION.zoom
    }
  } catch {
    return DEFAULT_MAP_LOCATION
  }
}

function readBasemap(): BasemapId {
  const raw = localStorage.getItem(BASEMAP_KEY)
  if (raw === 'dark' || raw === 'light' || raw === 'satellite') return raw
  return 'dark'
}

export function useMapPreferences(): {
  location: MapLocation
  basemap: BasemapId
  setLocation: (next: MapLocation) => void
  setBasemap: (next: BasemapId) => void
} {
  const [location, setLocationState] = useState<MapLocation>(() => readLocation())
  const [basemap, setBasemapState] = useState<BasemapId>(() => readBasemap())

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === LOCATION_KEY) setLocationState(readLocation())
      if (event.key === BASEMAP_KEY) setBasemapState(readBasemap())
    }
    const onAgentLocation = (event: Event): void => {
      const detail = (event as CustomEvent<MapLocation>).detail
      if (detail && isValidCoordinate(detail.lat, detail.lon)) {
        setLocationState(detail)
      } else {
        setLocationState(readLocation())
      }
    }
    const onAgentBasemap = (event: Event): void => {
      const detail = (event as CustomEvent<BasemapId>).detail
      if (detail === 'dark' || detail === 'light' || detail === 'satellite') {
        setBasemapState(detail)
      } else {
        setBasemapState(readBasemap())
      }
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener(AGENT_EVENTS.location, onAgentLocation)
    window.addEventListener(AGENT_EVENTS.basemap, onAgentBasemap)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(AGENT_EVENTS.location, onAgentLocation)
      window.removeEventListener(AGENT_EVENTS.basemap, onAgentBasemap)
    }
  }, [])

  const setLocation = useCallback((next: MapLocation) => {
    const normalized: MapLocation = {
      lat: Number(next.lat.toFixed(5)),
      lon: Number(next.lon.toFixed(5)),
      label: next.label.trim() || 'Custom pin',
      zoom: Math.min(12, Math.max(3, Math.round(next.zoom)))
    }
    localStorage.setItem(LOCATION_KEY, JSON.stringify(normalized))
    setLocationState(normalized)
    window.dispatchEvent(new CustomEvent(AGENT_EVENTS.location, { detail: normalized }))
  }, [])

  const setBasemap = useCallback((next: BasemapId) => {
    localStorage.setItem(BASEMAP_KEY, next)
    setBasemapState(next)
  }, [])

  return { location, basemap, setLocation, setBasemap }
}
