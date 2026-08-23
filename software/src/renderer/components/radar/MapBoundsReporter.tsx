import { useEffect, useRef, useState } from 'react'
import { useMap, useMapEvents } from 'react-leaflet'
import type { MapBounds } from '@shared/weatherOverlays'

function nearlyEqualBounds(a: MapBounds, b: MapBounds): boolean {
  const latSpan = Math.max(0.1, a.north - a.south)
  let lonSpan = a.east - a.west
  if (lonSpan < 0) lonSpan += 360
  lonSpan = Math.max(0.1, lonSpan)
  const epsLat = latSpan * 0.02
  const epsLon = lonSpan * 0.02
  return (
    Math.abs(a.zoom - b.zoom) < 0.05 &&
    Math.abs(a.north - b.north) < epsLat &&
    Math.abs(a.south - b.south) < epsLat &&
    Math.abs(a.east - b.east) < epsLon &&
    Math.abs(a.west - b.west) < epsLon
  )
}

export function MapBoundsReporter({
  onBounds
}: {
  onBounds: (bounds: MapBounds) => void
}): null {
  const map = useMap()
  const lastSentRef = useRef<MapBounds | null>(null)

  const publish = (): void => {
    const b = map.getBounds()
    const next: MapBounds = {
      north: b.getNorth(),
      south: b.getSouth(),
      east: b.getEast(),
      west: b.getWest(),
      zoom: map.getZoom()
    }
    if (lastSentRef.current && nearlyEqualBounds(lastSentRef.current, next)) {
      return
    }
    lastSentRef.current = next
    onBounds(next)
  }

  useEffect(() => {
    publish()
  }, [map])

  useMapEvents({
    moveend: publish,
    zoomend: publish
  })

  return null
}

export function useMapBoundsState(): {
  bounds: MapBounds | null
  setBounds: (bounds: MapBounds) => void
} {
  const [bounds, setBounds] = useState<MapBounds | null>(null)
  return { bounds, setBounds }
}
