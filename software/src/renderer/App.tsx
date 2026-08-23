import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { isPage, type Page } from '@shared/pages'
import {
  AGENT_EVENTS,
  installAgentHost,
  registerAgentNavigate,
  setAgentWindowContext
} from './agent/agentHost'
import { AppShell } from './components/AppShell'
import { WeatherRadarMap } from './components/radar/WeatherRadarMap'
import { DashboardPage } from './pages/DashboardPage'
import { SensorsPage } from './pages/SensorsPage'
import { HistoryPage } from './pages/HistoryPage'
import { StationsPage } from './pages/StationsPage'
import { SettingsPage } from './pages/SettingsPage'
import { useAppSettings } from './hooks/useAppSettings'

function pageFromLocation(): Page {
  const params = new URLSearchParams(window.location.search)
  const raw = params.get('page')
  return isPage(raw) ? raw : 'Dashboard'
}

function renderOtherPage(page: Page): ReactNode {
  switch (page) {
    case 'Sensors':
      return <SensorsPage />
    case 'History':
      return <HistoryPage />
    case 'Stations':
      return <StationsPage />
    case 'Settings':
      return <SettingsPage />
    default:
      return null
  }
}

function syncPageUrl(page: Page): void {
  const url = new URL(window.location.href)
  if (url.searchParams.get('page') === page) return
  url.searchParams.set('page', page)
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
}

export function App(): ReactElement {
  useAppSettings()
  const initialPage = useMemo(() => pageFromLocation(), [])
  const [page, setPage] = useState<Page>(initialPage)
  const [isMain, setIsMain] = useState(true)
  const [seenPages, setSeenPages] = useState(() => new Set<Page>([initialPage]))

  useEffect(() => {
    installAgentHost()
  }, [])

  useEffect(() => {
    let cancelled = false
    const desktop = window.desktop
    if (!desktop?.getWindowContext) {
      return
    }
    void desktop.getWindowContext().then((ctx) => {
      if (cancelled) return
      setIsMain(ctx.isMain)
      if (isPage(ctx.page)) setPage(ctx.page)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const desktop = window.desktop
    if (!desktop?.onNavigatePage) return
    return desktop.onNavigatePage((next) => {
      if (isPage(next)) setPage(next)
    })
  }, [])

  useEffect(() => {
    syncPageUrl(page)
    setAgentWindowContext(page, isMain)
    void window.desktop?.setWindowPage?.(page)
    document.title = isMain ? 'Open Weather Command Center' : `Open Weather — ${page}`
    registerAgentNavigate(setPage)
    const onAgentNavigate = (event: Event): void => {
      const next = (event as CustomEvent<Page>).detail
      if (isPage(next)) setPage(next)
    }
    window.addEventListener(AGENT_EVENTS.navigate, onAgentNavigate)
    return () => {
      registerAgentNavigate(null)
      window.removeEventListener(AGENT_EVENTS.navigate, onAgentNavigate)
    }
  }, [page, isMain])

  useEffect(() => {
    setSeenPages((current) => {
      if (current.has(page)) return current
      const next = new Set(current)
      next.add(page)
      return next
    })
  }, [page])

  const radarWarm = seenPages.has('Dashboard') || seenPages.has('Radar')

  return (
    <AppShell page={page} isMain={isMain} onNavigate={setPage}>
      <div className={`wx-workspace wx-workspace--${page}`}>
        {radarWarm ? (
          <div
            className={`wx-workspace__map${
              page === 'Dashboard' ? ' panel radar-dashboard-panel' : ''
            }`}
          >
            <WeatherRadarMap compact={page === 'Dashboard'} />
          </div>
        ) : null}
        {seenPages.has('Dashboard') ? (
          <div className={`dashboard-keep${page === 'Dashboard' ? ' is-active' : ''}`}>
            <DashboardPage />
          </div>
        ) : null}
        {page !== 'Dashboard' && page !== 'Radar' ? renderOtherPage(page) : null}
      </div>
    </AppShell>
  )
}
