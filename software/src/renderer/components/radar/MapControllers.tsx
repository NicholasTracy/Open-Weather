import { useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import L from 'leaflet'
import { useMap, useMapEvents } from 'react-leaflet'
import type { MapLocation } from '@shared/mapLocation'

/** Keep Leaflet view synced when the saved pin / zoom changes. */
export function MapViewController({ location }: { location: MapLocation }): null {
  const map = useMap()

  useEffect(() => {
    const zoom = map.getZoom()
    const zoomChanged = zoom !== location.zoom
    const onScreen = map.getBounds().pad(-0.02).contains([location.lat, location.lon])
    if (onScreen && !zoomChanged) return
    if (onScreen && zoomChanged) {
      map.setZoom(location.zoom)
      return
    }
    map.setView([location.lat, location.lon], location.zoom, { animate: true })
  }, [map, location.lat, location.lon, location.zoom])

  useEffect(() => {
    const invalidate = (): void => {
      map.invalidateSize()
    }
    invalidate()
    const timer = window.setTimeout(invalidate, 120)
    const delayed = window.setTimeout(invalidate, 400)
    window.addEventListener('resize', invalidate)

    const container = map.getContainer()
    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            invalidate()
          })
        : null
    observer?.observe(container)

    return () => {
      window.clearTimeout(timer)
      window.clearTimeout(delayed)
      window.removeEventListener('resize', invalidate)
      observer?.disconnect()
    }
  }, [map])

  return null
}

type PinMenu = { x: number; y: number; lat: number; lon: number }

export function MapPinContextMenu({
  onPin
}: {
  onPin: (lat: number, lon: number) => void
}): ReactElement | null {
  const map = useMap()
  const [menu, setMenu] = useState<PinMenu | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = map.getContainer()
    const preventBrowserMenu = (event: Event): void => {
      event.preventDefault()
    }
    container.addEventListener('contextmenu', preventBrowserMenu)
    return () => {
      container.removeEventListener('contextmenu', preventBrowserMenu)
    }
  }, [map])

  useEffect(() => {
    const el = menuRef.current
    if (!el) return
    L.DomEvent.disableClickPropagation(el)
    L.DomEvent.disableScrollPropagation(el)
  }, [menu])

  useMapEvents({
    contextmenu(event) {
      L.DomEvent.preventDefault(event.originalEvent)
      L.DomEvent.stopPropagation(event.originalEvent)
      const latlng = map.mouseEventToLatLng(event.originalEvent)
      const rect = map.getContainer().getBoundingClientRect()
      const x = event.originalEvent.clientX - rect.left
      const y = event.originalEvent.clientY - rect.top
      const size = map.getSize()
      const pad = 8
      const width = 168
      const height = 40
      setMenu({
        x: Math.min(Math.max(pad, x), Math.max(pad, size.x - width - pad)),
        y: Math.min(Math.max(pad, y), Math.max(pad, size.y - height - pad)),
        lat: latlng.lat,
        lon: latlng.lng
      })
    },
    click(event) {
      const target = event.originalEvent.target
      if (target instanceof Node && menuRef.current?.contains(target)) return
      setMenu(null)
    },
    movestart() {
      setMenu(null)
    },
    zoomstart() {
      setMenu(null)
    }
  })

  useEffect(() => {
    if (!menu) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  if (!menu) return null

  return createPortal(
    <div ref={menuRef} className="map-pin-menu" style={{ left: menu.x, top: menu.y }} role="menu">
      <button
        type="button"
        role="menuitem"
        className="map-pin-menu__item"
        onPointerDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onPin(menu.lat, menu.lon)
          setMenu(null)
        }}
      >
        Drop Pin Here
      </button>
    </div>,
    map.getContainer()
  )
}

export function MapZoomTracker({
  onZoom
}: {
  onZoom: (zoom: number) => void
}): null {
  useMapEvents({
    zoomend(event) {
      onZoom(event.target.getZoom())
    }
  })
  return null
}
