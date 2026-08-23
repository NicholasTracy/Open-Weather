import { useEffect } from 'react'
import { useMap } from 'react-leaflet'

/**
 * Dedicated Leaflet panes so forecast vectors sit above radar tiles.
 * Default overlayPane hosts TileLayers with zIndex 410–420 that can hide SVG isobars.
 */
export function MapPanes(): null {
  const map = useMap()

  useEffect(() => {
    if (!map.getPane('owSatellite')) {
      const pane = map.createPane('owSatellite')
      pane.style.zIndex = '340'
      pane.style.pointerEvents = 'none'
    }
    if (!map.getPane('owRadar')) {
      const pane = map.createPane('owRadar')
      pane.style.zIndex = '350'
    }
    if (!map.getPane('owNexrad')) {
      const pane = map.createPane('owNexrad')
      pane.style.zIndex = '365'
      pane.style.pointerEvents = 'none'
    }
    if (!map.getPane('owOutlook')) {
      const pane = map.createPane('owOutlook')
      pane.style.zIndex = '410'
      pane.style.pointerEvents = 'none'
    }
    if (!map.getPane('owHazards')) {
      const pane = map.createPane('owHazards')
      pane.style.zIndex = '430'
    }
    if (!map.getPane('owStations')) {
      const pane = map.createPane('owStations')
      pane.style.zIndex = '440'
    }
    if (!map.getPane('owForecast')) {
      const pane = map.createPane('owForecast')
      pane.style.zIndex = '450'
      // Keep pointer events off except for map clicks on basemap
      pane.style.pointerEvents = 'none'
    }
  }, [map])

  return null
}
