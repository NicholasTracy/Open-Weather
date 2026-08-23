import type { ReactElement } from 'react'
import clearDay from '../assets/weather/wx-clear-day.jpg'
import clearNight from '../assets/weather/wx-clear-night.jpg'
import drizzleDay from '../assets/weather/wx-drizzle-day.jpg'
import drizzleNight from '../assets/weather/wx-drizzle-night.jpg'
import fogDay from '../assets/weather/wx-fog-day.jpg'
import fogNight from '../assets/weather/wx-fog-night.jpg'
import overcastDay from '../assets/weather/wx-overcast-day.jpg'
import overcastNight from '../assets/weather/wx-overcast-night.jpg'
import partlyCloudyDay from '../assets/weather/wx-partly-cloudy-day.jpg'
import partlyCloudyNight from '../assets/weather/wx-partly-cloudy-night.jpg'
import rainDay from '../assets/weather/wx-rain-day.jpg'
import rainNight from '../assets/weather/wx-rain-night.jpg'
import snowDay from '../assets/weather/wx-snow-day.jpg'
import snowNight from '../assets/weather/wx-snow-night.jpg'
import thunderDay from '../assets/weather/wx-thunder-day.jpg'
import thunderNight from '../assets/weather/wx-thunder-night.jpg'

type SkyKind =
  | 'clear'
  | 'mostlyClear'
  | 'partlyCloudy'
  | 'overcast'
  | 'fog'
  | 'drizzle'
  | 'rain'
  | 'snow'
  | 'showers'
  | 'thunder'

function skyKind(code: number | null | undefined): SkyKind {
  if (code == null || !Number.isFinite(code)) return 'partlyCloudy'
  const n = Math.round(code)
  if (n === 0) return 'clear'
  if (n === 1) return 'mostlyClear'
  if (n === 2) return 'partlyCloudy'
  if (n === 3) return 'overcast'
  if (n === 45 || n === 48) return 'fog'
  if (n >= 51 && n <= 57) return 'drizzle'
  if (n >= 61 && n <= 67) return 'rain'
  if (n >= 71 && n <= 77) return 'snow'
  if (n >= 80 && n <= 82) return 'showers'
  if (n >= 85 && n <= 86) return 'snow'
  if (n === 95 || n === 96 || n === 99) return 'thunder'
  return 'partlyCloudy'
}

function weatherArt(kind: SkyKind, night: boolean): string {
  switch (kind) {
    case 'clear':
      return night ? clearNight : clearDay
    case 'mostlyClear':
    case 'partlyCloudy':
      return night ? partlyCloudyNight : partlyCloudyDay
    case 'overcast':
      return night ? overcastNight : overcastDay
    case 'fog':
      return night ? fogNight : fogDay
    case 'drizzle':
      return night ? drizzleNight : drizzleDay
    case 'rain':
    case 'showers':
      return night ? rainNight : rainDay
    case 'snow':
      return night ? snowNight : snowDay
    case 'thunder':
      return night ? thunderNight : thunderDay
    default:
      return night ? partlyCloudyNight : partlyCloudyDay
  }
}

/** Photorealistic day/night weather art mapped from WMO weather codes. */
export function WeatherGlyph({
  code,
  period,
  label,
  size: _size = 56
}: {
  code: number | null | undefined
  period: 'day' | 'night'
  label: string
  size?: number
}): ReactElement {
  const kind = skyKind(code)
  const night = period === 'night'
  const src = weatherArt(kind, night)

  return (
    <span className={`wx-frame wx-frame--${period}`} title={label}>
      <img
        className={`wx-scene wx-scene--photo wx-scene--${period} wx-scene--${kind}`}
        src={src}
        alt={label}
        draggable={false}
      />
    </span>
  )
}
