import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Marker, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import { displayTemp } from '@shared/appSettings'
import { packCityLabels, type CityTemperature, type PressureSystem } from '@shared/weatherOverlays'
import { useAppSettings } from '../../hooks/useAppSettings'

function tempAccent(tempF: number): string {
  if (tempF >= 100) return '#ff6b4a'
  if (tempF >= 85) return '#ffb347'
  if (tempF >= 70) return '#3ecf8e'
  if (tempF >= 50) return '#6aa8b8'
  if (tempF >= 32) return '#7aa7ff'
  return '#a8c4ff'
}

function cityTempIcon(city: CityTemperature, toC: boolean): L.DivIcon {
  const unit = toC ? 'C' : 'F'
  const current = Math.round(displayTemp(city.currentF, unit) ?? city.currentF)
  const high = Math.round(displayTemp(city.highF, unit) ?? city.highF)
  const low = Math.round(displayTemp(city.lowF, unit) ?? city.lowF)
  const accent = tempAccent(city.currentF)
  return L.divIcon({
    className: 'ow-city-temp',
    html: `
      <div class="ow-city-temp__card" style="--ow-city-accent:${accent}">
        <span class="ow-city-temp__name">${city.name}</span>
        <span class="ow-city-temp__now">${current}°</span>
        <span class="ow-city-temp__range">
          <span class="ow-city-temp__high">${high}°</span>
          <span class="ow-city-temp__sep">/</span>
          <span class="ow-city-temp__low">${low}°</span>
        </span>
      </div>
    `,
    iconSize: [88, 52],
    iconAnchor: [44, 26]
  })
}

/**
 * Renders city temperature chips with screen-space collision avoidance.
 * Zoomed out: only non-overlapping majors. Zoomed in: fills gaps with more cities.
 */
export function CityLabelsOverlay({
  cities,
  systems = []
}: {
  cities: CityTemperature[]
  systems?: PressureSystem[]
}): ReactElement | null {
  const map = useMap()
  const { settings } = useAppSettings()
  const toC = settings.temperatureUnit === 'C'
  const [viewEpoch, setViewEpoch] = useState(0)

  useMapEvents({
    zoomend: () => setViewEpoch((value) => value + 1),
    moveend: () => setViewEpoch((value) => value + 1),
    resize: () => setViewEpoch((value) => value + 1)
  })

  useEffect(() => {
    setViewEpoch((value) => value + 1)
  }, [cities, map])

  const visible = useMemo(() => {
    void viewEpoch
    const zoom = map.getZoom()
    const maxLabels =
      zoom >= 10 ? 32 : zoom >= 8 ? 18 : zoom >= 6 ? 12 : zoom >= 5 ? 8 : 6
    const padding = zoom >= 8 ? 16 : zoom >= 6 ? 14 : 18
    const blocked = systems.map((system) => {
      const point = map.latLngToLayerPoint([system.lat, system.lon])
      return { x: point.x, y: point.y, w: 56, h: 56 }
    })

    const candidates = cities.map((city) => ({
      ...city,
      population: city.population
    }))

    return packCityLabels(
      candidates,
      (lat, lon) => {
        const point = map.latLngToLayerPoint([lat, lon])
        return { x: point.x, y: point.y }
      },
      { padding, maxLabels, blocked }
    )
  }, [cities, systems, map, viewEpoch])

  if (visible.length === 0) return null

  return (
    <>
      {visible.map((city) => (
        <Marker
          key={`${city.name}-${city.country}-${city.lat}-${city.lon}`}
          position={[city.lat, city.lon]}
          interactive={false}
          icon={cityTempIcon(city, toC)}
          zIndexOffset={720}
        />
      ))}
    </>
  )
}
