import { useEffect, useState, type ReactElement } from 'react'
import { TileLayer, useMap, useMapEvents } from 'react-leaflet'
import {
  IEM_TILE_SUBDOMAINS,
  SATELLITE_ATTRIBUTION,
  buildGibsGeoColorUrl,
  buildGoesTileUrl,
  pickGoesView,
  type SatelliteProduct
} from '@shared/satellite'

export function SatelliteOverlay({
  product,
  opacity,
  cacheMs = 300_000
}: {
  product: SatelliteProduct
  opacity: number
  cacheMs?: number
}): ReactElement {
  const intervalMs = Math.max(60_000, cacheMs)
  const cacheTick = (): number => Math.floor(Date.now() / intervalMs)
  const map = useMap()
  const [view, setView] = useState(() => {
    const center = map.getCenter()
    return pickGoesView(center.lat, center.lng, map.getZoom(), product)
  })
  const [tick, setTick] = useState(cacheTick)

  useEffect(() => {
    const center = map.getCenter()
    const next = pickGoesView(center.lat, center.lng, map.getZoom(), product)
    setView((current) => (current.layer === next.layer ? current : next))
  }, [map, product])

  useMapEvents({
    moveend: () => {
      const center = map.getCenter()
      const next = pickGoesView(center.lat, center.lng, map.getZoom(), product)
      setView((current) => (current.layer === next.layer ? current : next))
    },
    zoomend: () => {
      const center = map.getCenter()
      const next = pickGoesView(center.lat, center.lng, map.getZoom(), product)
      setView((current) => (current.layer === next.layer ? current : next))
    }
  })

  useEffect(() => {
    const id = window.setInterval(() => setTick(cacheTick()), Math.min(60_000, intervalMs))
    return () => window.clearInterval(id)
  }, [intervalMs])

  if (product === 'geocolor') {
    return (
      <TileLayer
        key={`gibs-${view.bird}-${tick}`}
        url={buildGibsGeoColorUrl(view.bird, tick)}
        pane="owSatellite"
        opacity={opacity}
        maxNativeZoom={7}
        maxZoom={12}
        attribution={SATELLITE_ATTRIBUTION}
      />
    )
  }

  return (
    <TileLayer
      key={`iem-${view.layer}-${tick}`}
      url={buildGoesTileUrl(view.layer, tick)}
      subdomains={IEM_TILE_SUBDOMAINS}
      pane="owSatellite"
      opacity={opacity}
      maxZoom={12}
      attribution={SATELLITE_ATTRIBUTION}
    />
  )
}
