/**
 * Application pages. Detached windows load the same renderer with ?page=<Page>.
 * Pattern adapted from Captivate 2's multi-window page model.
 */
export type Page =
  | 'Dashboard'
  | 'Radar'
  | 'Sensors'
  | 'History'
  | 'Stations'
  | 'Settings'

export const ALL_PAGES: Page[] = [
  'Dashboard',
  'Radar',
  'Sensors',
  'History',
  'Stations',
  'Settings'
]

export const DETACHABLE_PAGES: Page[] = [
  'Radar',
  'Sensors',
  'History',
  'Stations',
  'Settings'
]

export function isPage(value: unknown): value is Page {
  return typeof value === 'string' && (ALL_PAGES as string[]).includes(value)
}

export function pageTitle(page: Page): string {
  switch (page) {
    case 'Dashboard':
      return 'Dashboard'
    case 'Radar':
      return 'Radar'
    case 'Sensors':
      return 'Sensors'
    case 'History':
      return 'History'
    case 'Stations':
      return 'Stations'
    case 'Settings':
      return 'Settings'
  }
}
