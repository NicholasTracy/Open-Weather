/** IPC channel names shared by main, preload, and renderer. */
export const ipcChannels = {
  open_page_window: 'open_page_window',
  request_window_close: 'request_window_close',
  get_window_context: 'get_window_context',
  set_window_page: 'set_window_page',
  navigate_page: 'navigate_page',
  list_displays: 'list_displays',
  focus_main_window: 'focus_main_window',
  fetch_wpc_script: 'fetch_wpc_script',
  fetch_wpc_analysis: 'fetch_wpc_analysis',
  fetch_nexrad_sweep: 'fetch_nexrad_sweep',
  fetch_nexrad_catalog: 'fetch_nexrad_catalog',
  fetch_nws_alerts: 'fetch_nws_alerts',
  fetch_nearby_stations: 'fetch_nearby_stations',
  fetch_spc_outlook: 'fetch_spc_outlook',
  place_main_on_display: 'place_main_on_display',
  save_ops_layout: 'save_ops_layout',
  apply_ops_layout: 'apply_ops_layout'
} as const

export type IpcChannel = (typeof ipcChannels)[keyof typeof ipcChannels]

export type OpenPageWindowOptions = {
  /** Electron Display.id; omit for default OS placement. */
  displayId?: number
}

export type ScreenDisplayChoice = {
  id: number
  label: string
  isPrimary: boolean
  workArea: { x: number; y: number; width: number; height: number }
}

export type WindowContext = {
  isMain: boolean
  page: import('./pages').Page
}
