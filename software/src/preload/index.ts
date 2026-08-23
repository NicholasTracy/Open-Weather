import { contextBridge, ipcRenderer } from 'electron'
import {
  ipcChannels,
  type OpenPageWindowOptions,
  type ScreenDisplayChoice,
  type WindowContext
} from '../shared/ipc'
import type { HazardAlert } from '../shared/hazards'
import type { NearbyStationsFetch } from '../shared/nearbyStations'
import type { WpcSurfaceAnalysis } from '../shared/codsus'
import type { SpcOutlookCollection } from '../shared/spcOutlook'
import type { NexradSweepPayload, NexradVolumeRef } from '../shared/nexrad'
import type { Page } from '../shared/pages'

export type DesktopApi = {
  openPageWindow: (page: Page, options?: OpenPageWindowOptions) => Promise<boolean>
  requestWindowClose: () => Promise<boolean>
  getWindowContext: () => Promise<WindowContext>
  setWindowPage: (page: Page) => Promise<boolean>
  onNavigatePage: (handler: (page: Page) => void) => () => void
  listDisplays: () => Promise<ScreenDisplayChoice[]>
  focusMainWindow: () => Promise<boolean>
  fetchWpcScript: (url: string) => Promise<string>
  fetchWpcAnalysis: () => Promise<WpcSurfaceAnalysis>
  fetchNexradSweep: (siteId: string, volumeKey?: string) => Promise<NexradSweepPayload>
  fetchNexradCatalog: (siteId: string) => Promise<NexradVolumeRef[]>
  fetchNwsAlerts: (lat?: number, lon?: number) => Promise<HazardAlert[]>
  fetchNearbyStations: (lat: number, lon: number, synopticToken?: string) => Promise<NearbyStationsFetch>
  fetchSpcOutlook: () => Promise<SpcOutlookCollection>
  placeMainOnDisplay: (displayId: number) => Promise<boolean>
  saveOpsLayout: () => Promise<{ dashboardDisplayId: number | null; radarDisplayId: number | null }>
  applyOpsLayout: () => Promise<boolean>
}

const api: DesktopApi = {
  openPageWindow: (page, options) =>
    ipcRenderer.invoke(ipcChannels.open_page_window, page, options),
  requestWindowClose: () => ipcRenderer.invoke(ipcChannels.request_window_close),
  getWindowContext: () => ipcRenderer.invoke(ipcChannels.get_window_context),
  setWindowPage: (page) => ipcRenderer.invoke(ipcChannels.set_window_page, page),
  onNavigatePage: (handler) => {
    const listener = (_event: unknown, page: Page): void => {
      handler(page)
    }
    ipcRenderer.on(ipcChannels.navigate_page, listener)
    return () => {
      ipcRenderer.removeListener(ipcChannels.navigate_page, listener)
    }
  },
  listDisplays: () => ipcRenderer.invoke(ipcChannels.list_displays),
  focusMainWindow: () => ipcRenderer.invoke(ipcChannels.focus_main_window),
  fetchWpcScript: (url) => ipcRenderer.invoke(ipcChannels.fetch_wpc_script, url),
  fetchWpcAnalysis: () => ipcRenderer.invoke(ipcChannels.fetch_wpc_analysis),
  fetchNexradSweep: (siteId, volumeKey) =>
    ipcRenderer.invoke(ipcChannels.fetch_nexrad_sweep, siteId, volumeKey),
  fetchNexradCatalog: (siteId) => ipcRenderer.invoke(ipcChannels.fetch_nexrad_catalog, siteId),
  fetchNwsAlerts: (lat, lon) => ipcRenderer.invoke(ipcChannels.fetch_nws_alerts, lat, lon),
  fetchNearbyStations: (lat, lon, synopticToken) =>
    ipcRenderer.invoke(ipcChannels.fetch_nearby_stations, lat, lon, synopticToken),
  fetchSpcOutlook: () => ipcRenderer.invoke(ipcChannels.fetch_spc_outlook),
  placeMainOnDisplay: (displayId) => ipcRenderer.invoke(ipcChannels.place_main_on_display, displayId),
  saveOpsLayout: () => ipcRenderer.invoke(ipcChannels.save_ops_layout),
  applyOpsLayout: () => ipcRenderer.invoke(ipcChannels.apply_ops_layout)
}

contextBridge.exposeInMainWorld('desktop', api)
