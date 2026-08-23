import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  net,
  screen,
  shell,
  type MenuItemConstructorOptions
} from 'electron'
import path from 'path'
import {
  DEFAULT_CDP_PORT,
  type AgentAppState,
  type AgentCommand,
  type AgentCommandResult,
  type AgentWindowInfo
} from '../shared/agentApi'
import { ipcChannels, type OpenPageWindowOptions, type ScreenDisplayChoice } from '../shared/ipc'
import { ALL_PAGES, DETACHABLE_PAGES, isPage, pageTitle, type Page } from '../shared/pages'
import { startAgentBridge, stopAgentBridge } from './agentBridge'
import { fetchNexradReflectivitySweep, listNexradVolumeKeys } from './nexradLevel2'
import { fetchNearbyPublicStations } from './nearbyStations'
import { fetchNwsHazards } from './nwsAlerts'
import { fetchWpcSurfaceAnalysis } from './wpcAnalysis'
import { fetchSpcDay1Outlook } from './spcOutlook'
import {
  buildWindowConstructorOptions,
  captureWindowPlacement,
  initWindowLayout,
  readWindowLayout,
  writeWindowLayout,
  type DetachedWindowPlacement,
  type PersistedWindowLayout,
  type WindowPlacement
} from './windowStateStorage'

// CDP must be set before ready so Cursor / chrome tooling can attach.
function agentToolsWanted(): boolean {
  if (process.env.OW_AGENT_BRIDGE === '0') return false
  if (process.env.OW_AGENT_BRIDGE === '1') return true
  return !app.isPackaged
}

const cdpPort = agentToolsWanted()
  ? process.env.OW_CDP_PORT ?? String(DEFAULT_CDP_PORT)
  : process.env.OW_CDP_PORT ?? ''
if (cdpPort) {
  app.commandLine.appendSwitch('remote-debugging-port', cdpPort)
}

let mainWindow: BrowserWindow | null = null
const detachedWindows = new Set<BrowserWindow>()
const detachedWindowPagesById = new Map<number, Page>()
/** Survives past `closed` — never read `window.webContents` after destroy. */
const detachedWindowContentIds = new WeakMap<BrowserWindow, number>()
/** Last known bounds per page so reopen can restore after a window is destroyed. */
const lastDetachedPlacements = new Map<Page, WindowPlacement>()
let persistedWindowLayout: PersistedWindowLayout = initWindowLayout()
let persistedWindowLayoutDirty = false
let persistWindowLayoutTimer: NodeJS.Timeout | null = null
let isClosing = false

function schedulePersistWindowLayout(): void {
  persistedWindowLayoutDirty = true
  if (persistWindowLayoutTimer !== null) {
    clearTimeout(persistWindowLayoutTimer)
  }
  persistWindowLayoutTimer = setTimeout(() => {
    persistWindowLayoutTimer = null
    flushPersistedWindowLayout()
  }, 220)
}

function flushPersistedWindowLayout(): void {
  if (!persistedWindowLayoutDirty) return
  persistedWindowLayout = writeWindowLayout(persistedWindowLayout)
  persistedWindowLayoutDirty = false
}

function captureWindowPlacementSafe(window: BrowserWindow): WindowPlacement | null {
  if (window.isDestroyed()) return null
  try {
    return captureWindowPlacement(window)
  } catch {
    try {
      const bounds = window.getBounds()
      return {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        isMaximized: window.isMaximized(),
        isFullScreen: window.isFullScreen()
      }
    } catch {
      return null
    }
  }
}

function pageForWindow(window: BrowserWindow): Page | undefined {
  return detachedWindowPagesById.get(window.webContents.id)
}

function applyWindowPage(window: BrowserWindow, page: Page): void {
  if (window.isDestroyed()) return
  detachedWindowPagesById.set(window.webContents.id, page)
  window.setTitle(
    window === mainWindow ? 'Open Weather Command Center' : `Open Weather — ${pageTitle(page)}`
  )
}

function navigateWindowToPage(window: BrowserWindow | null, page: Page): void {
  if (!window || window.isDestroyed() || !isPage(page)) return
  applyWindowPage(window, page)
  window.webContents.send(ipcChannels.navigate_page, page)
  focusWindow(window)
}

function syncDetachedWindowLayoutSnapshot(): void {
  if (isClosing) return
  const detached: DetachedWindowPlacement[] = []
  for (const window of detachedWindows) {
    if (window.isDestroyed()) continue
    const page = pageForWindow(window)
    if (page === undefined) continue
    const placement = captureWindowPlacementSafe(window)
    if (placement === null) continue
    lastDetachedPlacements.set(page, placement)
    detached.push({ page, ...placement })
  }
  persistedWindowLayout.detached = detached
  schedulePersistWindowLayout()
}

function placeWindowOnDisplay(window: BrowserWindow, displayId: number): boolean {
  const display = screen.getAllDisplays().find((item) => item.id === Math.trunc(displayId))
  if (!display || window.isDestroyed()) return false
  const wa = display.workArea
  const current = window.getBounds()
  const width = Math.min(Math.max(current.width, 800), Math.max(720, wa.width - 24))
  const height = Math.min(Math.max(current.height, 560), Math.max(480, wa.height - 24))
  window.setBounds({
    x: wa.x + Math.max(0, Math.floor((wa.width - width) / 2)),
    y: wa.y + Math.max(0, Math.floor((wa.height - height) / 2)),
    width,
    height
  })
  return true
}

function displayIdForWindow(window: BrowserWindow): number | null {
  if (window.isDestroyed()) return null
  return screen.getDisplayMatching(window.getBounds()).id
}

function saveOpsLayoutFromWindows(): { dashboardDisplayId: number | null; radarDisplayId: number | null } {
  const dashboardDisplayId = mainWindow ? displayIdForWindow(mainWindow) : null
  const radar = findDetachedWindowByPage('Radar')
  const radarDisplayId = radar ? displayIdForWindow(radar) : persistedWindowLayout.ops.radarDisplayId
  persistedWindowLayout.ops = { dashboardDisplayId, radarDisplayId }
  schedulePersistWindowLayout()
  return persistedWindowLayout.ops
}

function applyOpsLayout(): boolean {
  const { dashboardDisplayId, radarDisplayId } = persistedWindowLayout.ops
  let moved = false
  if (dashboardDisplayId != null && mainWindow && !mainWindow.isDestroyed()) {
    moved = placeWindowOnDisplay(mainWindow, dashboardDisplayId) || moved
    navigateWindowToPage(mainWindow, 'Dashboard')
  }
  if (radarDisplayId != null) {
    openOrFocusDetachedPage('Radar', { displayId: radarDisplayId })
    moved = true
  }
  return moved
}

function findDetachedWindowByPage(page: Page): BrowserWindow | null {
  for (const window of detachedWindows) {
    if (window.isDestroyed()) continue
    if (pageForWindow(window) === page) {
      return window
    }
  }
  return null
}

function focusWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function resolveRendererUrl(page: Page): string {
  const query = `?page=${encodeURIComponent(page)}`
  if (process.env['ELECTRON_RENDERER_URL']) {
    return `${process.env['ELECTRON_RENDERER_URL']}${query}`
  }
  return `file://${path.join(__dirname, '../renderer/index.html')}${query}`
}

function getAssetPath(...paths: string[]): string {
  return path.join(app.getAppPath(), 'resources', ...paths)
}

function createAppWindow({
  isMain,
  defaultPage,
  initialPlacement
}: {
  isMain: boolean
  defaultPage: Page
  initialPlacement?: WindowPlacement | null
}): BrowserWindow {
  const initialBounds = buildWindowConstructorOptions(
    initialPlacement ?? null,
    isMain ? 1280 : 960,
    isMain ? 800 : 640
  )

  const window = new BrowserWindow({
    show: false,
    ...initialBounds,
    minWidth: 480,
    minHeight: 420,
    backgroundColor: '#0b0f14',
    title: isMain
      ? 'Open Weather Command Center'
      : `Open Weather — ${pageTitle(defaultPage)}`,
    icon: getAssetPath('icon.png'),
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  void window.loadURL(resolveRendererUrl(defaultPage))

  window.on('ready-to-show', () => {
    if (initialPlacement?.isFullScreen) {
      window.setFullScreen(true)
    } else if (initialPlacement?.isMaximized) {
      window.maximize()
    }
    window.show()
  })

  window.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const webContentsId = window.webContents.id

  const persistBounds = (): void => {
    if (isClosing || window.isDestroyed()) return
    if (isMain) {
      const placement = captureWindowPlacementSafe(window)
      if (placement === null) return
      persistedWindowLayout.main = placement
      schedulePersistWindowLayout()
    } else {
      syncDetachedWindowLayoutSnapshot()
    }
  }

  window.on('move', persistBounds)
  window.on('resize', persistBounds)
  window.on('maximize', persistBounds)
  window.on('unmaximize', persistBounds)
  window.on('enter-full-screen', persistBounds)
  window.on('leave-full-screen', persistBounds)

  detachedWindowContentIds.set(window, webContentsId)
  detachedWindowPagesById.set(webContentsId, defaultPage)

  if (isMain) {
    mainWindow = window
    window.on('closed', () => {
      mainWindow = null
    })
  } else {
    detachedWindows.add(window)

    // Capture bounds while the native window still exists (`closed` is too late).
    window.on('close', () => {
      if (window.isDestroyed()) return
      const placement = captureWindowPlacementSafe(window)
      if (placement !== null) {
        lastDetachedPlacements.set(pageForWindow(window) ?? defaultPage, placement)
      }
    })

    window.on('closed', () => {
      detachedWindows.delete(window)
      detachedWindowPagesById.delete(webContentsId)
      syncDetachedWindowLayoutSnapshot()
    })
  }

  let recovering = false
  const recoverBlank = (): void => {
    if (recovering || window.isDestroyed() || isClosing) return
    recovering = true
    setTimeout(() => {
      recovering = false
      if (window.isDestroyed() || isClosing) return
      window.webContents.reloadIgnoringCache()
    }, 600)
  }
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('[window] render-process-gone', details.reason, details.exitCode)
    recoverBlank()
  })

  return window
}

/** Focus an existing detached page window, or spawn a new one. */
export function openOrFocusDetachedPage(
  page: Page,
  options?: OpenPageWindowOptions
): void {
  const existing = findDetachedWindowByPage(page)
  if (existing !== null) {
    if (options?.displayId !== undefined && Number.isFinite(options.displayId)) {
      placeWindowOnDisplay(existing, Math.trunc(options.displayId))
    }
    focusWindow(existing)
    return
  }

  let initialPlacement: WindowPlacement | null | undefined =
    lastDetachedPlacements.get(page) ??
    persistedWindowLayout.detached.find((entry) => entry.page === page) ??
    null

  if (options?.displayId !== undefined && Number.isFinite(options.displayId)) {
    const display = screen.getAllDisplays().find((d) => d.id === Math.trunc(options.displayId!))
    if (display) {
      const wa = display.workArea
      const width = Math.min(1100, Math.max(720, wa.width - 80))
      const height = Math.min(760, Math.max(480, wa.height - 80))
      initialPlacement = {
        x: wa.x + Math.max(0, Math.floor((wa.width - width) / 2)),
        y: wa.y + Math.max(0, Math.floor((wa.height - height) / 2)),
        width,
        height
      }
    }
  }

  createAppWindow({
    isMain: false,
    defaultPage: page,
    initialPlacement
  })
  syncDetachedWindowLayoutSnapshot()
}

function restoreDetachedWindows(): void {
  for (const entry of persistedWindowLayout.detached) {
    if (!DETACHABLE_PAGES.includes(entry.page)) continue
    if (findDetachedWindowByPage(entry.page) !== null) continue
    createAppWindow({
      isMain: false,
      defaultPage: entry.page,
      initialPlacement: entry
    })
  }
}

function focusedAppWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) return focused
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  return null
}

function buildApplicationMenu(): void {
  const goToItems: MenuItemConstructorOptions[] = ALL_PAGES.map((page, index) => ({
    label: pageTitle(page),
    accelerator: `CmdOrCtrl+${index + 1}`,
    click: () => navigateWindowToPage(focusedAppWindow(), page)
  }))

  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        ...goToItems,
        { type: 'separator' },
        {
          label: 'Focus Main Window',
          click: () => {
            if (mainWindow) focusWindow(mainWindow)
          }
        },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        {
          label: 'Open Current Page in New Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            const target = focusedAppWindow()
            const page = target ? pageForWindow(target) : undefined
            openOrFocusDetachedPage(page ?? 'Dashboard')
          }
        },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin' ? ([{ type: 'separator' }, { role: 'front' }] as const) : [])
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ]

  if (process.platform === 'darwin') {
    template.unshift({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function isAllowedWpcFrontUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'www.wpc.ncep.noaa.gov' &&
      parsed.pathname.startsWith('/NationalForecastChart/mapdata/fronts') &&
      parsed.pathname.endsWith('.js') &&
      !parsed.search &&
      !parsed.hash
    )
  } catch {
    return false
  }
}

function registerIpc(): void {
  ipcMain.handle(
    ipcChannels.open_page_window,
    (_event, page: unknown, options?: OpenPageWindowOptions) => {
      if (!isPage(page)) return false
      openOrFocusDetachedPage(page, options)
      return true
    }
  )

  ipcMain.handle(ipcChannels.request_window_close, (event) => {
    const target = BrowserWindow.fromWebContents(event.sender)
    if (!target || target.isDestroyed() || target === mainWindow) return false
    target.close()
    return true
  })

  ipcMain.handle(ipcChannels.get_window_context, (event) => {
    const target = BrowserWindow.fromWebContents(event.sender)
    if (!target || target.isDestroyed()) {
      return { isMain: true, page: 'Dashboard' as Page }
    }
    const page = detachedWindowPagesById.get(event.sender.id) ?? 'Dashboard'
    return { isMain: target === mainWindow, page }
  })

  ipcMain.handle(ipcChannels.set_window_page, (event, page: unknown) => {
    if (!isPage(page)) return false
    const target = BrowserWindow.fromWebContents(event.sender)
    if (!target || target.isDestroyed()) return false
    applyWindowPage(target, page)
    if (target !== mainWindow) syncDetachedWindowLayoutSnapshot()
    return true
  })

  ipcMain.handle(ipcChannels.list_displays, (): ScreenDisplayChoice[] => {
    const primaryId = screen.getPrimaryDisplay().id
    return screen.getAllDisplays().map((display, index) => ({
      id: display.id,
      label: display.label || `Display ${index + 1}`,
      isPrimary: display.id === primaryId,
      workArea: {
        x: display.workArea.x,
        y: display.workArea.y,
        width: display.workArea.width,
        height: display.workArea.height
      }
    }))
  })

  ipcMain.handle(ipcChannels.focus_main_window, () => {
    if (mainWindow) focusWindow(mainWindow)
    return true
  })

  ipcMain.handle(ipcChannels.fetch_wpc_script, async (_event, url: unknown) => {
    if (typeof url !== 'string' || !isAllowedWpcFrontUrl(url)) {
      throw new Error('Blocked WPC front URL')
    }
    const response = await net.fetch(url, { cache: 'no-store' })
    if (!response.ok) {
      throw new Error(`WPC fronts HTTP ${response.status}`)
    }
    return await response.text()
  })

  ipcMain.handle(ipcChannels.fetch_wpc_analysis, async () => {
    return await fetchWpcSurfaceAnalysis()
  })

  ipcMain.handle(ipcChannels.fetch_nexrad_sweep, async (_event, siteId: unknown, volumeKey: unknown) => {
    if (typeof siteId !== 'string') throw new Error('Radar site required')
    const key = typeof volumeKey === 'string' && volumeKey.length > 0 ? volumeKey : undefined
    return await fetchNexradReflectivitySweep(siteId, key)
  })

  ipcMain.handle(ipcChannels.fetch_nexrad_catalog, async (_event, siteId: unknown) => {
    if (typeof siteId !== 'string') throw new Error('Radar site required')
    return await listNexradVolumeKeys(siteId)
  })

  ipcMain.handle(ipcChannels.fetch_nws_alerts, async (_event, lat: unknown, lon: unknown) => {
    const pinLat = typeof lat === 'number' && Number.isFinite(lat) ? lat : undefined
    const pinLon = typeof lon === 'number' && Number.isFinite(lon) ? lon : undefined
    return await fetchNwsHazards(pinLat, pinLon)
  })

  ipcMain.handle(
    ipcChannels.fetch_nearby_stations,
    async (_event, lat: unknown, lon: unknown, token: unknown) => {
      if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw new Error('Pin required')
      }
      const synopticToken = typeof token === 'string' ? token : ''
      return await fetchNearbyPublicStations(lat, lon, synopticToken)
    }
  )

  ipcMain.handle(ipcChannels.fetch_spc_outlook, async () => {
    return await fetchSpcDay1Outlook()
  })

  ipcMain.handle(ipcChannels.place_main_on_display, (_event, displayId: unknown) => {
    if (typeof displayId !== 'number' || !Number.isFinite(displayId) || !mainWindow) return false
    const ok = placeWindowOnDisplay(mainWindow, Math.trunc(displayId))
    if (ok) navigateWindowToPage(mainWindow, 'Dashboard')
    return ok
  })

  ipcMain.handle(ipcChannels.save_ops_layout, () => saveOpsLayoutFromWindows())

  ipcMain.handle(ipcChannels.apply_ops_layout, () => applyOpsLayout())
}

function listAgentWindows(): AgentWindowInfo[] {
  const windows: AgentWindowInfo[] = []
  if (mainWindow && !mainWindow.isDestroyed()) {
    const bounds = mainWindow.getBounds()
    windows.push({
      id: mainWindow.id,
      title: mainWindow.getTitle(),
      isMain: true,
      page: 'Dashboard',
      bounds,
      url: mainWindow.webContents.getURL()
    })
  }
  for (const window of detachedWindows) {
    if (window.isDestroyed()) continue
    const page = pageForWindow(window) ?? 'unknown'
    const bounds = window.getBounds()
    windows.push({
      id: window.id,
      title: window.getTitle(),
      isMain: false,
      page,
      bounds,
      url: window.webContents.getURL()
    })
  }
  return windows
}

function findAgentWindow(windowId?: number, page?: string): BrowserWindow | null {
  if (windowId !== undefined && Number.isFinite(windowId)) {
    const match = BrowserWindow.getAllWindows().find((window) => window.id === windowId)
    return match && !match.isDestroyed() ? match : null
  }
  if (page && isPage(page)) {
    if (mainWindow && !mainWindow.isDestroyed() && pageForWindow(mainWindow) === page) {
      return mainWindow
    }
    return findDetachedWindowByPage(page) ?? (page === 'Dashboard' && mainWindow && !mainWindow.isDestroyed()
      ? mainWindow
      : null)
  }
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  const first = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())
  return first ?? null
}

async function getRendererAgentState(window: BrowserWindow): Promise<AgentAppState | null> {
  if (window.isDestroyed()) return null
  try {
    return (await window.webContents.executeJavaScript(
      `window.__openWeatherAgent ? window.__openWeatherAgent.getState() : null`,
      true
    )) as AgentAppState | null
  } catch {
    return null
  }
}

async function executeRendererAgentCommand(
  window: BrowserWindow,
  command: AgentCommand
): Promise<AgentCommandResult> {
  if (window.isDestroyed()) {
    return { ok: false, message: 'Window destroyed' }
  }
  // Eval works even when the renderer agent host failed to mount (blank-screen recovery).
  if (command.type === 'eval') {
    try {
      const value = await window.webContents.executeJavaScript(command.expression, true)
      return { ok: true, message: 'Evaluated', data: value }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to evaluate in renderer'
      }
    }
  }
  try {
    const encoded = JSON.stringify(command)
    return (await window.webContents.executeJavaScript(
      `window.__openWeatherAgent
        ? window.__openWeatherAgent.execute(${encoded})
        : { ok: false, message: 'Agent host not ready' }`,
      true
    )) as AgentCommandResult
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Failed to execute renderer command'
    }
  }
}

function agentBridgeEnabled(): boolean {
  return agentToolsWanted()
}

function closeDetachedAgentWindow(page?: Page): boolean {
  if (page) {
    const target = findDetachedWindowByPage(page)
    if (!target) return false
    target.close()
    return true
  }
  let closed = false
  for (const window of [...detachedWindows]) {
    if (window.isDestroyed()) continue
    window.close()
    closed = true
  }
  return closed
}

app.on('child-process-gone', (_event, details) => {
  if (details.type !== 'GPU' && details.type !== 'Utility') return
  console.error('[app] child-process-gone', details.type, details.reason)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.reloadIgnoringCache()
  }
})

app.whenReady().then(async () => {
  persistedWindowLayout = readWindowLayout()
  for (const entry of persistedWindowLayout.detached) {
    const { page, ...placement } = entry
    lastDetachedPlacements.set(page, placement)
  }
  registerIpc()
  buildApplicationMenu()

  createAppWindow({
    isMain: true,
    defaultPage: 'Dashboard',
    initialPlacement: persistedWindowLayout.main
  })

  restoreDetachedWindows()

  if (agentBridgeEnabled()) {
    try {
      await startAgentBridge({
        listWindows: listAgentWindows,
        findWindow: findAgentWindow,
        openPage: (page, displayId) => {
          if (displayId !== undefined) {
            openOrFocusDetachedPage(page, { displayId })
            return
          }
          navigateWindowToPage(mainWindow, page)
        },
        focusMain: () => {
          if (mainWindow) focusWindow(mainWindow)
        },
        closeDetached: closeDetachedAgentWindow,
        executeRendererCommand: executeRendererAgentCommand,
        getRendererState: getRendererAgentState
      })
      if (cdpPort) {
        console.log(`[agent-bridge] Chrome DevTools Protocol on port ${cdpPort}`)
      }
    } catch (error) {
      console.error('[agent-bridge] failed to start', error)
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createAppWindow({
        isMain: true,
        defaultPage: 'Dashboard',
        initialPlacement: persistedWindowLayout.main
      })
    } else if (mainWindow) {
      focusWindow(mainWindow)
    }
  })
})

app.on('before-quit', () => {
  isClosing = true
  void stopAgentBridge()
  if (mainWindow && !mainWindow.isDestroyed()) {
    const placement = captureWindowPlacementSafe(mainWindow)
    if (placement !== null) {
      persistedWindowLayout.main = placement
    }
  }
  const detached: DetachedWindowPlacement[] = []
  for (const window of detachedWindows) {
    if (window.isDestroyed()) continue
    const page = pageForWindow(window)
    if (page === undefined) continue
    const placement = captureWindowPlacementSafe(window) ?? lastDetachedPlacements.get(page)
    if (placement === undefined || placement === null) continue
    detached.push({ page, ...placement })
  }
  persistedWindowLayout.detached = detached
  persistedWindowLayoutDirty = true
  flushPersistedWindowLayout()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
