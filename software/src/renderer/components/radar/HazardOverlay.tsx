import { useEffect, useMemo, useRef, type ReactElement } from 'react'
import L from 'leaflet'
import { Circle, GeoJSON, useMapEvents } from 'react-leaflet'
import type { HazardAlert } from '@shared/hazards'

const PANE = 'owHazards'

function styleFor(alert: HazardAlert, selected: boolean): L.PathOptions {
  const watch = alert.kind === 'watch'
  return {
    color: alert.color,
    weight: selected ? 3.6 : watch ? 2.2 : 2.8,
    opacity: 0.95,
    fillColor: alert.color,
    fillOpacity: selected ? (watch ? 0.22 : 0.34) : watch ? 0.1 : 0.2,
    dashArray: watch ? '7 5' : undefined,
    pane: PANE,
    bubblingMouseEvents: true
  }
}

export function HazardOverlay({
  alerts,
  selectedId,
  pin,
  radiusMi,
  onSelect
}: {
  alerts: HazardAlert[]
  selectedId: string | null
  pin: { lat: number; lon: number }
  radiusMi: number
  onSelect: (id: string | null) => void
}): ReactElement | null {
  const geoRef = useRef<L.GeoJSON | null>(null)
  const withGeom = useMemo(() => alerts.filter((alert) => alert.geometry), [alerts])
  const collection = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: withGeom.map((alert) => ({
        type: 'Feature' as const,
        id: alert.id,
        properties: alert,
        geometry: alert.geometry!
      }))
    }),
    [withGeom]
  )

  useMapEvents({
    click: () => onSelect(null)
  })

  useEffect(() => {
    if (!geoRef.current) return
    geoRef.current.eachLayer((layer) => {
      if (!('setStyle' in layer)) return
      const feature = (layer as L.GeoJSON & { feature?: { properties?: HazardAlert } }).feature
      const alert = feature?.properties
      if (!alert) return
      ;(layer as L.Path).setStyle(styleFor(alert, alert.id === selectedId))
    })
  }, [selectedId])

  const ringMeters = Math.max(1, radiusMi) * 1609.344

  return (
    <>
      <Circle
        center={[pin.lat, pin.lon]}
        radius={ringMeters}
        pane={PANE}
        interactive={false}
        pathOptions={{
          color: '#ff8a96',
          weight: 1.6,
          opacity: 0.7,
          dashArray: '7 6',
          fillColor: '#ff5d6c',
          fillOpacity: 0.045
        }}
      />
      {withGeom.length === 0 ? null : (
        <GeoJSON
          ref={(layer) => {
            geoRef.current = layer
          }}
          key={`hazards-${withGeom.map((alert) => alert.id).join('|')}`}
          data={collection as GeoJSON.GeoJsonObject}
          pane={PANE}
          style={(feature) => {
            const alert = feature?.properties as HazardAlert | undefined
            return alert ? styleFor(alert, alert.id === selectedId) : {}
          }}
          onEachFeature={(feature, layer) => {
            const alert = feature.properties as HazardAlert
            layer.on('click', (event) => {
              L.DomEvent.stopPropagation(event)
              onSelect(alert.id)
            })
            if (alert.kind === 'warning' && 'bringToFront' in layer) {
              ;(layer as L.Path).bringToFront()
            }
          }}
        />
      )}
    </>
  )
}
