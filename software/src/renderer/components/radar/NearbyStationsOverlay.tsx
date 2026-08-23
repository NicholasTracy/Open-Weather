import type { ReactElement } from 'react'
import L from 'leaflet'
import { CircleMarker, Tooltip } from 'react-leaflet'
import type { NearbyStation } from '@shared/nearbyStations'
import type { MapLocation } from '@shared/mapLocation'

const PANE = 'owStations'

export function NearbyStationsOverlay({
  stations,
  onSelect
}: {
  stations: NearbyStation[]
  onSelect: (station: NearbyStation) => void
}): ReactElement | null {
  if (stations.length === 0) return null

  return (
    <>
      {stations.map((station) => {
        const color = station.usedInAverage ? '#7ad0c8' : station.stale ? '#8a93a3' : '#f0c36a'
        return (
          <CircleMarker
            key={`${station.network}-${station.id}`}
            center={[station.lat, station.lon]}
            pane={PANE}
            radius={station.usedInAverage ? 6.5 : 5}
            pathOptions={{
              color: '#070b12',
              weight: 1.4,
              fillColor: color,
              fillOpacity: 0.95
            }}
            eventHandlers={{
              click: (event) => {
                L.DomEvent.stopPropagation(event)
                onSelect(station)
              }
            }}
          >
            <Tooltip direction="top" offset={[0, -8]} opacity={0.95}>
              <span className="ow-station-tip">
                <strong>{station.id}</strong>
                {station.name ? ` · ${station.name}` : ''}
              </span>
            </Tooltip>
          </CircleMarker>
        )
      })}
    </>
  )
}

export function stationToLocation(station: NearbyStation, zoom = 10): MapLocation {
  return {
    lat: station.lat,
    lon: station.lon,
    label: station.name ? `${station.id} · ${station.name}` : station.id,
    zoom
  }
}
