import { useEffect, useRef, useState, type ReactElement } from 'react'
import {
  NEXRAD_LOOP_FRAMES_MAX,
  NEXRAD_LOOP_FRAMES_MIN,
  RADAR_PALETTES,
  type RadarDisplayPrefs,
  type RadarMosaicMode,
  type RadarPaletteId,
  type RadarProductId
} from '@shared/radarDisplay'
import type { NexradSite } from '@shared/nexrad'
import { SATELLITE_PRODUCTS, type SatelliteProduct } from '@shared/satellite'
import { displayDistance, formatRadiusLabel } from '@shared/appSettings'
import { HAZARD_RADIUS_MAX_MI, HAZARD_RADIUS_MIN_MI } from '@shared/hazards'
import { useAppSettings } from '../../hooks/useAppSettings'

export function RadarDisplayMenu({
  prefs,
  sites,
  satelliteProduct,
  hazardRadiusMi,
  onChange,
  onSatelliteProduct,
  onHazardRadius
}: {
  prefs: RadarDisplayPrefs
  sites: { site: NexradSite; distanceKm: number }[]
  satelliteProduct: SatelliteProduct
  hazardRadiusMi: number
  onChange: (partial: Partial<RadarDisplayPrefs>) => void
  onSatelliteProduct: (product: SatelliteProduct) => void
  onHazardRadius: (miles: number) => void
}): ReactElement {
  const { settings } = useAppSettings()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className={`radar-display-menu${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="radar-display-menu__toggle"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((value) => !value)}
      >
        Radar
        <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className="radar-display-menu__panel" role="dialog" aria-label="Radar display settings">
          <label className="radar-display-menu__field">
            <span>Satellite imagery</span>
            <select
              value={satelliteProduct}
              onChange={(event) => onSatelliteProduct(event.target.value as SatelliteProduct)}
            >
              {SATELLITE_PRODUCTS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>

          <label className="radar-display-menu__field">
            <span>Hazard radius {formatRadiusLabel(hazardRadiusMi, settings.distanceUnit)}</span>
            <input
              type="range"
              min={HAZARD_RADIUS_MIN_MI}
              max={HAZARD_RADIUS_MAX_MI}
              step={5}
              value={hazardRadiusMi}
              onChange={(event) => onHazardRadius(Number(event.target.value))}
            />
          </label>

          <label className="radar-display-menu__field">
            <span>Merged REF mosaic</span>
            <select
              value={prefs.mosaicMode}
              onChange={(event) => onChange({ mosaicMode: event.target.value as RadarMosaicMode })}
            >
              <option value="merged">On · two nearest sites</option>
              <option value="merged4">On · four nearest sites</option>
              <option value="single">Off · single station</option>
            </select>
          </label>

          <label className="radar-display-menu__field">
            <span>Station</span>
            <select
              value={prefs.siteId ?? sites[0]?.site.id ?? ''}
              disabled={prefs.mosaicMode !== 'single' || sites.length === 0}
              onChange={(event) => onChange({ siteId: event.target.value })}
            >
              {sites.map(({ site, distanceKm }) => (
                <option key={site.id} value={site.id}>
                  {site.id} · {site.name} (
                  {Math.round(displayDistance(distanceKm / 1.60934, settings.distanceUnit))}{' '}
                  {settings.distanceUnit})
                </option>
              ))}
            </select>
          </label>

          <label className="radar-display-menu__field">
            <span>Radar product</span>
            <select
              value={prefs.product}
              onChange={(event) => onChange({ product: event.target.value as RadarProductId })}
            >
              <option value="hca">Hydrometeors · dual-pol HCA</option>
              <option value="reflectivity">Reflectivity · dBZ</option>
            </select>
          </label>

          {prefs.product === 'reflectivity' ? (
          <label className="radar-display-menu__field">
            <span>Color palette</span>
            <select
              value={prefs.palette}
              onChange={(event) => onChange({ palette: event.target.value as RadarPaletteId })}
            >
              {RADAR_PALETTES.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          ) : null}

          <label className="radar-display-menu__field">
            <span>Threshold {Math.round(prefs.threshold * 100)}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={prefs.threshold}
              onChange={(event) => onChange({ threshold: Number(event.target.value) })}
            />
          </label>

          <label className="radar-display-menu__field">
            <span>Blend / anti-alias {Math.round(prefs.cohesion * 100)}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={prefs.cohesion}
              onChange={(event) => onChange({ cohesion: Number(event.target.value) })}
            />
          </label>

          <label className="radar-display-menu__field">
            <span>Key frames {prefs.loopFrames}</span>
            <input
              type="range"
              min={NEXRAD_LOOP_FRAMES_MIN}
              max={NEXRAD_LOOP_FRAMES_MAX}
              step={1}
              value={prefs.loopFrames}
              onChange={(event) => onChange({ loopFrames: Number(event.target.value) })}
            />
          </label>

          <label className="radar-display-menu__field">
            <span>Frame drift</span>
            <select
              value={prefs.drift ? 'on' : 'off'}
              onChange={(event) => onChange({ drift: event.target.value === 'on' })}
            >
              <option value="on">On · slide with storm motion</option>
              <option value="off">Off · hold keyframes</option>
            </select>
          </label>

          <label className="radar-display-menu__field">
            <span>Playback {prefs.speed.toFixed(1)}×</span>
            <input
              type="range"
              min={0.4}
              max={2.5}
              step={0.1}
              value={prefs.speed}
              onChange={(event) => onChange({ speed: Number(event.target.value) })}
            />
          </label>

          <label className="radar-display-menu__field">
            <span>Opacity {Math.round(prefs.opacity * 100)}%</span>
            <input
              type="range"
              min={0.15}
              max={1}
              step={0.01}
              value={prefs.opacity}
              onChange={(event) => onChange({ opacity: Number(event.target.value) })}
            />
          </label>
        </div>
      ) : null}
    </div>
  )
}
