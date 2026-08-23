import { useEffect, useMemo, useState, type ReactElement } from 'react'
import L from 'leaflet'
import { Marker, Polyline, useMap } from 'react-leaflet'
import type {
  IsobarContour,
  PressureSystem,
  WeatherFront
} from '@shared/weatherOverlays'
import type { ForecastOverlayModel } from '../../hooks/useViewportWeatherGrid'
import { CityLabelsOverlay } from './CityLabelsOverlay'

const FORECAST_PANE = 'owForecast'

function pressureSystemIcon(system: PressureSystem): L.DivIcon {
  const glyph = system.kind === 'high' ? 'H' : 'L'
  return L.divIcon({
    className: `ow-forecast-hl ow-forecast-hl--${system.kind}`,
    html: `
      <span class="ow-forecast-hl__glyph">${glyph}</span>
      <span class="ow-forecast-hl__value">${Math.round(system.pressureHpa)}</span>
    `,
    iconSize: [48, 48],
    iconAnchor: [24, 24]
  })
}

function isobarLabelIcon(levelHpa: number): L.DivIcon {
  return L.divIcon({
    className: 'ow-isobar-label',
    html: `<span class="ow-isobar-label__text">${Math.round(levelHpa)}</span>`,
    iconSize: [40, 18],
    iconAnchor: [20, 9]
  })
}

function frontColor(kind: WeatherFront['kind']): string {
  if (kind === 'cold') return '#4a8bff'
  if (kind === 'warm') return '#ff5344'
  if (kind === 'occluded') return '#c85bff'
  if (kind === 'trough') return '#d6b07a'
  return '#d0a040'
}

function useMapZoom(): number {
  const map = useMap()
  const [zoom, setZoom] = useState(() => map.getZoom())
  useEffect(() => {
    const sync = (): void => setZoom(map.getZoom())
    map.on('zoomend', sync)
    map.on('zoomlevelschange', sync)
    return () => {
      map.off('zoomend', sync)
      map.off('zoomlevelschange', sync)
    }
  }, [map])
  return zoom
}

/** Pixel size of a front pip. Regional zoom (~8) needs ~2× the old 14px icons. */
function frontPipPx(zoom: number): number {
  const z = Math.max(3, Math.min(11, zoom))
  return Math.round(18 + (z - 3) * 2.25)
}

function frontStrokeWeights(
  zoom: number,
  trough: boolean
): { halo: number; line: number } {
  const boost = zoom >= 7 ? 1.28 : zoom >= 5.5 ? 1.1 : 1
  if (trough) return { halo: 4.6 * boost, line: 2.35 * boost }
  return { halo: 8.4 * boost, line: 4.35 * boost }
}

function frontPipIcon(kind: WeatherFront['kind'], bearingDeg: number, sizePx: number): L.DivIcon {
  const cold = '#3d82ff'
  const warm = '#ff4a3c'
  const occluded = '#c85bff'
  const halo = '#f4f7fb'
  const ink = '#070b12'
  const size = Math.max(16, Math.round(sizePx))

  let pip: string
  if (kind === 'trough') {
    pip = ''
  } else if (kind === 'cold') {
    pip = `
      <polygon points="2,1.2 22,1.2 12,22.4" fill="${ink}" />
      <polygon points="4.1,2.6 19.9,2.6 12,19.2" fill="${cold}" stroke="${halo}" stroke-width="1.35" />
    `
  } else if (kind === 'warm') {
    pip = `
      <path d="M2,2.2 H22 A10,10 0 0 1 2,2.2 Z" fill="${ink}" />
      <path d="M4.2,3.2 H19.8 A7.8,7.8 0 0 1 4.2,3.2 Z" fill="${warm}" stroke="${halo}" stroke-width="1.25" />
    `
  } else if (kind === 'occluded') {
    pip = `
      <polygon points="2,1.4 12,1.4 7,22" fill="${ink}" />
      <path d="M12,2.2 H22 A9,9 0 0 1 12,2.2 Z" fill="${ink}" />
      <polygon points="3.6,2.6 11.2,2.6 7.1,18.8" fill="${occluded}" stroke="${halo}" stroke-width="1.1" />
      <path d="M12.4,3.1 H20.6 A7.2,7.2 0 0 1 12.4,3.1 Z" fill="${occluded}" stroke="${halo}" stroke-width="1.1" />
    `
  } else {
    pip = `
      <polygon points="2,1.2 22,1.2 12,22.4" fill="${ink}" />
      <path d="M2,1.2 H22 A10,10 0 0 0 2,1.2 Z" fill="${ink}" transform="translate(0,0.4) scale(1,-1)" />
      <polygon points="4.1,2.6 19.9,2.6 12,19.2" fill="${cold}" stroke="${halo}" stroke-width="1.2" />
      <path d="M4.2,1.2 H19.8 A7.8,7.8 0 0 0 4.2,1.2 Z" fill="${warm}" stroke="${halo}" stroke-width="1.2" transform="translate(0,0.35) scale(1,-1)" />
    `
  }

  const pipBearing = kind === 'stationary' || kind === 'occluded' ? bearingDeg : bearingDeg + 90
  const anchorY =
    kind === 'warm' ? size * 0.16 : kind === 'stationary' || kind === 'occluded' ? size * 0.08 : size * 0.07

  return L.divIcon({
    className: `ow-front-pip ow-front-pip--${kind}`,
    html: `
      <span class="ow-front-pip__rot" style="transform: rotate(${pipBearing.toFixed(1)}deg)">
        <svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${pip}</svg>
      </span>
    `,
    iconSize: [size, size],
    iconAnchor: [size / 2, anchorY]
  })
}

function bearingDegrees(a: [number, number], b: [number, number]): number {
  const dLon = ((b[1] - a[1]) * Math.PI) / 180
  const lat1 = (a[0] * Math.PI) / 180
  const lat2 = (b[0] * Math.PI) / 180
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

function pathLength(path: Array<[number, number]>): number {
  let len = 0
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1]!
    const b = path[i]!
    const dLon = Math.abs(b[1] - a[1])
    const lon = Math.min(dLon, 360 - dLon)
    len += Math.hypot(b[0] - a[0], lon)
  }
  return len
}

function pointAlongPath(
  path: Array<[number, number]>,
  t: number
): [number, number] | null {
  if (path.length === 0) return null
  if (path.length === 1) return path[0]!
  const target = Math.max(0, Math.min(1, t)) * pathLength(path)
  let acc = 0
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1]!
    const b = path[i]!
    const dLon = Math.abs(b[1] - a[1])
    const lon = Math.min(dLon, 360 - dLon)
    const seg = Math.hypot(b[0] - a[0], lon)
    if (acc + seg >= target || i === path.length - 1) {
      const u = seg <= 1e-9 ? 0 : (target - acc) / seg
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]
    }
    acc += seg
  }
  return path[Math.floor(path.length / 2)]!
}

function sampleFrontPips(front: WeatherFront, zoom: number): Array<{
  key: string
  position: [number, number]
  bearing: number
}> {
  if (front.kind === 'trough') return []
  const path = front.path
  if (path.length < 2) return []
  const total = pathLength(path)
  if (total < 0.2) return []

  const spacing = zoom >= 8 ? 0.38 : zoom >= 6 ? 0.52 : 0.72
  const maxPips = zoom >= 8 ? 18 : 12
  const count = Math.max(3, Math.min(maxPips, Math.round(total / spacing)))
  const pips: Array<{ key: string; position: [number, number]; bearing: number }> = []

  for (let n = 1; n <= count; n += 1) {
    const t = n / (count + 1)
    const position = pointAlongPath(path, t)
    if (!position) continue

    let bestI = 1
    let best = Infinity
    for (let i = 1; i < path.length; i += 1) {
      const mid: [number, number] = [
        (path[i - 1]![0] + path[i]![0]) / 2,
        (path[i - 1]![1] + path[i]![1]) / 2
      ]
      const d = Math.hypot(mid[0] - position[0], mid[1] - position[1])
      if (d < best) {
        best = d
        bestI = i
      }
    }
    const a = path[Math.max(0, bestI - 1)]!
    const b = path[Math.min(path.length - 1, bestI)]!
    pips.push({
      key: `${front.id}-${n}`,
      position,
      bearing: bearingDegrees(a, b)
    })
  }
  return pips
}

function useForecastCanvas(): L.Renderer {
  return useMemo(
    () =>
      L.canvas({
        padding: 0.55,
        pane: FORECAST_PANE
      }),
    []
  )
}

function FrontLayer({
  front,
  renderer,
  zoom
}: {
  front: WeatherFront
  renderer: L.Renderer
  zoom: number
}): ReactElement {
  const pips = useMemo(() => sampleFrontPips(front, zoom), [front, zoom])
  const color = frontColor(front.kind)
  const trough = front.kind === 'trough'
  const strokeRenderer = trough ? undefined : renderer
  const weights = frontStrokeWeights(zoom, trough)
  const pipSize = frontPipPx(zoom)

  return (
    <>
      <Polyline
        positions={front.path}
        pathOptions={{
          renderer: strokeRenderer,
          pane: FORECAST_PANE,
          color: trough ? 'rgba(4, 8, 14, 0.5)' : 'rgba(4, 8, 14, 0.86)',
          weight: weights.halo,
          opacity: trough ? 0.72 : 0.92,
          lineCap: 'round',
          lineJoin: 'round',
          dashArray: trough ? '7 6' : undefined
        }}
      />
      <Polyline
        positions={front.path}
        pathOptions={{
          renderer: strokeRenderer,
          pane: FORECAST_PANE,
          color,
          weight: weights.line,
          opacity: trough ? 0.92 : 1,
          lineCap: 'round',
          lineJoin: 'round',
          dashArray: trough ? '7 6' : undefined
        }}
      />
      {pips.map((pip) => (
        <Marker
          key={`${pip.key}-${pipSize}`}
          position={pip.position}
          interactive={false}
          icon={frontPipIcon(front.kind, pip.bearing, pipSize)}
          zIndexOffset={520}
        />
      ))}
    </>
  )
}

function IsobarLayer({
  contour,
  showLabel,
  renderer
}: {
  contour: IsobarContour
  showLabel: boolean
  renderer: L.Renderer
}): ReactElement {
  const labelAt = useMemo(() => pointAlongPath(contour.path, 0.42), [contour.path])
  const major = contour.major !== false

  return (
    <>
      <Polyline
        positions={contour.path}
        pathOptions={{
          renderer,
          pane: FORECAST_PANE,
          color: major ? 'rgba(0, 0, 0, 0.7)' : 'rgba(0, 0, 0, 0.5)',
          weight: major ? 4.5 : 3.2,
          opacity: major ? 0.65 : 0.48,
          lineCap: 'round',
          lineJoin: 'round'
        }}
      />
      <Polyline
        positions={contour.path}
        pathOptions={{
          renderer,
          pane: FORECAST_PANE,
          color: major ? 'rgba(238, 244, 255, 0.96)' : 'rgba(238, 244, 255, 0.86)',
          weight: major ? 2.1 : 1.35,
          opacity: major ? 0.97 : 0.88,
          lineCap: 'round',
          lineJoin: 'round'
        }}
      />
      {showLabel && labelAt ? (
        <Marker
          position={labelAt}
          interactive={false}
          icon={isobarLabelIcon(contour.levelHpa)}
          zIndexOffset={500}
        />
      ) : null}
    </>
  )
}

function ForecastPanesHost(): null {
  const map = useMap()
  useEffect(() => {
    if (!map.getPane(FORECAST_PANE)) {
      const pane = map.createPane(FORECAST_PANE)
      pane.style.zIndex = '450'
      pane.style.pointerEvents = 'none'
    } else {
      const pane = map.getPane(FORECAST_PANE)
      if (pane) {
        pane.style.zIndex = '450'
        pane.style.pointerEvents = 'none'
      }
    }
  }, [map])
  return null
}

function pickIsobarLabels(isobars: IsobarContour[]): Set<string> {
  const even = isobars.filter((contour) => Math.abs(contour.levelHpa % 2) < 0.05)
  const pool = even.length >= 2 ? even : isobars
  const byLevel = new Map<number, IsobarContour>()
  for (const contour of pool) {
    const prev = byLevel.get(contour.levelHpa)
    if (!prev || pathLength(contour.path) > pathLength(prev.path)) {
      byLevel.set(contour.levelHpa, contour)
    }
  }
  const ids = new Set<string>()
  for (const contour of byLevel.values()) {
    if (pathLength(contour.path) < 0.85) continue
    ids.add(contour.id)
  }
  return ids
}

export function ForecastStyleOverlay({
  model,
  showPressure,
  showFronts,
  showTemps
}: {
  model: ForecastOverlayModel
  showPressure: boolean
  showFronts: boolean
  showTemps: boolean
}): ReactElement | null {
  const hasAnything =
    (showPressure && (Boolean(model.grid) || model.systems.length > 0 || model.isobars.length > 0)) ||
    (showFronts && model.fronts.length > 0) ||
    (showTemps && model.cities.length > 0) ||
    // Keep pane host while loading grid for pressure/fronts
    ((showPressure || showFronts) && Boolean(model.grid))

  const renderer = useForecastCanvas()
  const zoom = useMapZoom()
  const labelIds = useMemo(
    () => (showPressure ? pickIsobarLabels(model.isobars) : new Set<string>()),
    [showPressure, model.isobars]
  )

  if (!showPressure && !showFronts && !showTemps) return null
  if (!hasAnything && !model.grid) return null

  return (
    <>
      <ForecastPanesHost />
      {showPressure
        ? model.isobars.map((contour) => (
            <IsobarLayer
              key={contour.id}
              contour={contour}
              showLabel={labelIds.has(contour.id)}
              renderer={renderer}
            />
          ))
        : null}

      {showFronts
        ? model.fronts.map((front) => (
            <FrontLayer key={front.id} front={front} renderer={renderer} zoom={zoom} />
          ))
        : null}

      {showPressure
        ? model.systems.map((system) => (
            <Marker
              key={system.id}
              position={[system.lat, system.lon]}
              interactive={false}
              icon={pressureSystemIcon(system)}
              zIndexOffset={650}
            />
          ))
        : null}

      {showTemps && model.cities.length > 0 ? (
        <CityLabelsOverlay
          cities={model.cities}
          systems={showPressure ? model.systems : []}
        />
      ) : null}
    </>
  )
}
