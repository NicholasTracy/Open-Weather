import { useCallback, useEffect, useState } from 'react'
import {
  APP_SETTINGS_KEY,
  DEFAULT_APP_SETTINGS,
  applyTheme,
  normalizeAppSettings,
  type AppSettings
} from '@shared/appSettings'
import { AGENT_EVENTS } from '../agent/agentHost'

export function readAppSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(APP_SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_APP_SETTINGS, overlays: { ...DEFAULT_APP_SETTINGS.overlays } }
    return normalizeAppSettings(JSON.parse(raw) as Partial<AppSettings>)
  } catch {
    return { ...DEFAULT_APP_SETTINGS, overlays: { ...DEFAULT_APP_SETTINGS.overlays } }
  }
}

export function writeAppSettings(next: AppSettings): AppSettings {
  const normalized = normalizeAppSettings(next)
  localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(normalized))
  applyTheme(normalized.theme)
  window.dispatchEvent(new CustomEvent(AGENT_EVENTS.settings, { detail: normalized }))
  return normalized
}

export function useAppSettings(): {
  settings: AppSettings
  updateSettings: (partial: Partial<AppSettings>) => void
  resetSettings: () => void
} {
  const [settings, setSettings] = useState<AppSettings>(() => {
    const initial = readAppSettings()
    applyTheme(initial.theme)
    return initial
  })

  useEffect(() => {
    const sync = (): void => setSettings(readAppSettings())
    const onStorage = (event: StorageEvent): void => {
      if (event.key === APP_SETTINGS_KEY) sync()
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener(AGENT_EVENTS.settings, sync)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(AGENT_EVENTS.settings, sync)
    }
  }, [])

  const updateSettings = useCallback((partial: Partial<AppSettings>) => {
    setSettings((current) => {
      const next = normalizeAppSettings({
        ...current,
        ...partial,
        overlays: partial.overlays ? { ...current.overlays, ...partial.overlays } : current.overlays
      })
      return writeAppSettings(next)
    })
  }, [])

  const resetSettings = useCallback(() => {
    const next = writeAppSettings({
      ...DEFAULT_APP_SETTINGS,
      overlays: { ...DEFAULT_APP_SETTINGS.overlays }
    })
    setSettings(next)
  }, [])

  return { settings, updateSettings, resetSettings }
}
