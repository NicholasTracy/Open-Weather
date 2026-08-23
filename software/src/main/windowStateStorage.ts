import { app, BrowserWindow, screen, type BrowserWindowConstructorOptions } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { isPage, type Page } from '../shared/pages'

const WINDOW_STATE_DIRNAME = 'window-state'
const WINDOW_STATE_FILENAME = 'open-weather-window-layout.json'
const WINDOW_STATE_VERSION = 1 as const

export interface WindowPlacement {
  x?: number
  y?: number
  width: number
  height: number
  isMaximized?: boolean
  isFullScreen?: boolean
}

export interface DetachedWindowPlacement extends WindowPlacement {
  page: Page
}

export interface OpsLayout {
  dashboardDisplayId: number | null
  radarDisplayId: number | null
}

export interface PersistedWindowLayout {
  version: typeof WINDOW_STATE_VERSION
  main: WindowPlacement | null
  detached: DetachedWindowPlacement[]
  ops: OpsLayout
}

export function initWindowLayout(): PersistedWindowLayout {
  return {
    version: WINDOW_STATE_VERSION,
    main: null,
    detached: [],
    ops: { dashboardDisplayId: null, radarDisplayId: null }
  }
}

export function getWindowLayoutPath(): string {
  return path.join(app.getPath('userData'), WINDOW_STATE_DIRNAME, WINDOW_STATE_FILENAME)
}

export function readWindowLayout(): PersistedWindowLayout {
  const defaults = initWindowLayout()
  const filePath = getWindowLayoutPath()
  if (!existsSync(filePath)) {
    return defaults
  }

  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<PersistedWindowLayout>
    return sanitizeWindowLayout(parsed, defaults)
  } catch {
    return defaults
  }
}

export function writeWindowLayout(layout: PersistedWindowLayout): PersistedWindowLayout {
  const filePath = getWindowLayoutPath()
  mkdirSync(path.dirname(filePath), { recursive: true })
  const sanitized = sanitizeWindowLayout(layout, initWindowLayout())
  writeFileSync(filePath, JSON.stringify(sanitized, null, 2), 'utf8')
  return sanitized
}

export function captureWindowPlacement(window: BrowserWindow): WindowPlacement {
  const isMaximized = window.isMaximized()
  const isFullScreen = window.isFullScreen()
  const bounds =
    isMaximized || isFullScreen ? window.getNormalBounds() : window.getBounds()

  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized,
    isFullScreen
  }
}

export function buildWindowConstructorOptions(
  placement: WindowPlacement | null | undefined,
  fallbackWidth: number,
  fallbackHeight: number
): Pick<BrowserWindowConstructorOptions, 'x' | 'y' | 'width' | 'height'> {
  const fallback = {
    width: Math.max(320, Math.round(fallbackWidth)),
    height: Math.max(240, Math.round(fallbackHeight))
  }
  const sanitized = sanitizePlacement(placement)
  if (sanitized === null) {
    return fallback
  }

  const width = Math.max(320, Math.round(sanitized.width))
  const height = Math.max(240, Math.round(sanitized.height))
  const boundsWithPosition =
    Number.isFinite(sanitized.x) && Number.isFinite(sanitized.y)
      ? {
          x: Math.round(sanitized.x as number),
          y: Math.round(sanitized.y as number),
          width,
          height
        }
      : null

  if (boundsWithPosition === null) {
    return { width, height }
  }

  const display = screen.getDisplayMatching(boundsWithPosition)
  const workArea = display.workArea
  const intersects =
    boundsWithPosition.x + boundsWithPosition.width > workArea.x &&
    boundsWithPosition.x < workArea.x + workArea.width &&
    boundsWithPosition.y + boundsWithPosition.height > workArea.y &&
    boundsWithPosition.y < workArea.y + workArea.height

  if (!intersects) {
    return { width, height }
  }

  return boundsWithPosition
}

function sanitizeWindowLayout(
  input: Partial<PersistedWindowLayout>,
  defaults: PersistedWindowLayout
): PersistedWindowLayout {
  const detached = Array.isArray(input.detached)
    ? input.detached
        .map((entry) => sanitizeDetachedPlacement(entry))
        .filter((entry): entry is DetachedWindowPlacement => entry !== null)
    : defaults.detached

  return {
    version: WINDOW_STATE_VERSION,
    main: sanitizePlacement(input.main),
    detached,
    ops: sanitizeOpsLayout(input.ops, defaults.ops)
  }
}

function sanitizeOpsLayout(value: unknown, fallback: OpsLayout): OpsLayout {
  if (!isObject(value)) return fallback
  const dashboard = Number(value.dashboardDisplayId)
  const radar = Number(value.radarDisplayId)
  return {
    dashboardDisplayId: Number.isFinite(dashboard) ? Math.trunc(dashboard) : null,
    radarDisplayId: Number.isFinite(radar) ? Math.trunc(radar) : null
  }
}

function sanitizeDetachedPlacement(value: unknown): DetachedWindowPlacement | null {
  if (!isObject(value)) return null
  const page = typeof value.page === 'string' && isPage(value.page) ? value.page : null
  if (page === null) return null
  const placement = sanitizePlacement(value)
  if (placement === null) return null
  return { ...placement, page }
}

function sanitizePlacement(value: unknown): WindowPlacement | null {
  if (!isObject(value)) return null
  const width = Number(value.width)
  const height = Number(value.height)
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  const x = Number(value.x)
  const y = Number(value.y)
  return {
    width: Math.max(320, Math.round(width)),
    height: Math.max(240, Math.round(height)),
    x: Number.isFinite(x) ? Math.round(x) : undefined,
    y: Number.isFinite(y) ? Math.round(y) : undefined,
    isMaximized: Boolean(value.isMaximized),
    isFullScreen: Boolean(value.isFullScreen)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
