import type { DesktopApi } from './index'

declare global {
  interface Window {
    desktop?: DesktopApi
  }
}

export {}
