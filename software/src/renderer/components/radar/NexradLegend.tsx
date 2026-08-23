import type { ReactElement } from 'react'
import {
  MOSAIC_REFLECTIVITY_STOPS,
  colorAtDbz,
  type NexradSweepMeta,
  type PaletteStop
} from '@shared/nexrad'
import { HCA_LEGEND } from '../../lib/nexradHca'
import type { RadarPaletteId } from '@shared/radarDisplay'

type PrecipBand = { label: string; dbz: number }

function rgba(color: [number, number, number, number]): string {
  return `rgba(${color[0]},${color[1]},${color[2]},${(color[3] / 255).toFixed(2)})`
}

function isVisible(color: [number, number, number, number]): boolean {
  return color[3] > 40
}

function isCoolEcho(color: [number, number, number, number]): boolean {
  const [r, g, b, a] = color
  return a > 40 && b >= g && r < 90 && b > 140
}

function isMagenta(color: [number, number, number, number]): boolean {
  const [r, g, b, a] = color
  return a > 40 && r > 160 && b > 120 && g < 100
}

function isGreenRain(color: [number, number, number, number]): boolean {
  const [r, g, b, a] = color
  return a > 40 && g > b + 20 && g > 100 && r < 120
}

function dbzGradient(stops: PaletteStop[], min: number, max: number): string {
  const span = Math.max(1, max - min)
  return stops
    .map((stop) => {
      const pct = ((stop.dbz - min) / span) * 100
      return `${rgba(stop.color)} ${pct.toFixed(1)}%`
    })
    .join(', ')
}

function precipBands(
  id: RadarPaletteId,
  palette: PaletteStop[],
  visible: PaletteStop[]
): PrecipBand[] {
  const max = visible[visible.length - 1]!.dbz
  const cool = visible.filter((stop) => isCoolEcho(stop.color))
  const magenta = [...visible].reverse().find((stop) => isMagenta(stop.color))
  const firstGreen = visible.find((stop) => isGreenRain(stop.color))

  const bands: Array<PrecipBand | null> = [
    { label: 'Hail', dbz: max },
    magenta && magenta.dbz < max - 4 ? { label: 'Large hail', dbz: magenta.dbz } : null,
    { label: 'Extreme rain', dbz: 55 },
    { label: 'Heavy rain', dbz: 45 },
    { label: 'Rain', dbz: 32 }
  ]

  if (id === 'nws' || id === 'awips') {
    if (firstGreen) bands.push({ label: 'Light rain', dbz: firstGreen.dbz })
    if (cool[0]) bands.push({ label: 'Light snow possible', dbz: cool[0].dbz })
  } else if (id === 'universal') {
    const light = cool[0] ?? visible[0]
    if (light) bands.push({ label: 'Light rain', dbz: light.dbz })
  } else if (id === 'storm' && firstGreen && firstGreen.dbz < 30) {
    bands.push({ label: 'Light rain', dbz: firstGreen.dbz })
  }

  const unique: PrecipBand[] = []
  for (const band of bands) {
    if (!band) continue
    if (!isVisible(colorAtDbz(palette, band.dbz))) continue
    if (unique.some((entry) => entry.label === band.label)) continue
    unique.push(band)
  }
  return unique.sort((a, b) => b.dbz - a.dbz)
}

export function NexradLegend({
  meta,
  stops,
  paletteId = 'universal',
  product = 'reflectivity',
  hasHca = false
}: {
  meta: NexradSweepMeta | null
  stops?: PaletteStop[]
  paletteId?: RadarPaletteId
  product?: 'reflectivity' | 'hca'
  hasHca?: boolean
}): ReactElement | null {
  if (!meta) return null
  if (product === 'hca') {
    return (
      <div className="nexrad-legend nexrad-legend--hca" aria-label="Dual-pol hydrometeor classification">
        <span className="nexrad-legend__unit">Dual-pol HCA</span>
        {hasHca ? (
          <ol className="nexrad-legend__hca">
            {HCA_LEGEND.map((entry) => (
              <li key={entry.id} className="nexrad-legend__type">
                <span className="nexrad-legend__swatch" style={{ background: rgba(entry.color) }} />
                <span>{entry.label}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="nexrad-legend__fallback">Waiting for dual-pol volumes</p>
        )}
      </div>
    )
  }
  const palette = stops ?? MOSAIC_REFLECTIVITY_STOPS
  const visible = palette.filter((stop) => isVisible(stop.color))
  if (visible.length === 0) return null

  const min = visible[0]!.dbz
  const max = visible[visible.length - 1]!.dbz
  const span = Math.max(1, max - min)
  const bands = precipBands(paletteId, palette, visible)

  return (
    <div className="nexrad-legend" aria-label="Typical radar echo types for this color table">
      <span className="nexrad-legend__unit">Typical echo</span>
      <div className="nexrad-legend__scale">
        <div
          className="nexrad-legend__bar"
          style={{ background: `linear-gradient(to top, ${dbzGradient(visible, min, max)})` }}
        />
        <ol className="nexrad-legend__types">
          {bands.map((band) => {
            const color = colorAtDbz(palette, band.dbz)
            const at = ((max - band.dbz) / span) * 100
            return (
              <li
                key={band.label}
                className="nexrad-legend__type"
                style={{ top: `${at.toFixed(2)}%` }}
              >
                <span className="nexrad-legend__swatch" style={{ background: rgba(color) }} />
                <span>{band.label}</span>
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}
