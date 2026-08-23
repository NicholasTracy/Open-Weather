import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_RADAR_DISPLAY,
  RADAR_DISPLAY_KEY,
  normalizeRadarDisplay,
  type RadarDisplayPrefs
} from '@shared/radarDisplay'

function readPrefs(): RadarDisplayPrefs {
  try {
    const raw = localStorage.getItem(RADAR_DISPLAY_KEY)
    if (!raw) return DEFAULT_RADAR_DISPLAY
    return normalizeRadarDisplay(JSON.parse(raw) as Partial<RadarDisplayPrefs>)
  } catch {
    return DEFAULT_RADAR_DISPLAY
  }
}

export function useRadarDisplayPrefs(): {
  prefs: RadarDisplayPrefs
  updatePrefs: (partial: Partial<RadarDisplayPrefs>) => void
} {
  const [prefs, setPrefs] = useState<RadarDisplayPrefs>(() => readPrefs())

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === RADAR_DISPLAY_KEY) setPrefs(readPrefs())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const updatePrefs = useCallback((partial: Partial<RadarDisplayPrefs>) => {
    setPrefs((current) => {
      const next = normalizeRadarDisplay({ ...current, ...partial })
      localStorage.setItem(RADAR_DISPLAY_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  return { prefs, updatePrefs }
}
