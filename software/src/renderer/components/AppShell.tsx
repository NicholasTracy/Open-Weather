import { useState, type ReactElement, type ReactNode } from 'react'
import { ALL_PAGES, pageTitle, type Page } from '@shared/pages'
import { BrandMark } from './BrandMark'

type AppShellProps = {
  page: Page
  isMain: boolean
  onNavigate: (page: Page) => void
  children: ReactNode
}

export function AppShell({ page, isMain, onNavigate, children }: AppShellProps): ReactElement {
  const [navOpen, setNavOpen] = useState(false)

  const goTo = (next: Page): void => {
    setNavOpen(false)
    onNavigate(next)
  }

  return (
    <div
      className={`app-shell app-shell--${page.toLowerCase()}${isMain ? '' : ' app-shell--detached'}`}
    >
      <header className="app-header">
        <nav className="navbar navbar-expand-lg py-0" aria-label="Primary">
          <div className="container-fluid px-3 px-lg-4 py-1">
            <div className="d-flex align-items-center gap-2">
              <BrandMark />
              <div className="navbar-brand mb-0 py-0">
                <div className="brand-title">Open Weather</div>
                <div className="brand-subtitle d-none d-sm-block">Command Center</div>
              </div>
            </div>

            <button
              type="button"
              className="navbar-toggler app-nav-toggle"
              aria-controls="app-primary-nav"
              aria-expanded={navOpen}
              aria-label="Toggle navigation"
              onClick={() => setNavOpen((open) => !open)}
            >
              <span className="app-nav-toggle__bars" aria-hidden="true" />
            </button>

            <div
              id="app-primary-nav"
              className={`collapse navbar-collapse${navOpen ? ' show' : ''}`}
            >
              <div className="navbar-nav ms-lg-auto align-items-lg-center gap-1 py-2 py-lg-0">
                {ALL_PAGES.map((item) => (
                  <button
                    key={item}
                    type="button"
                    className={`nav-chip${page === item ? ' active' : ''}`}
                    onClick={() => goTo(item)}
                  >
                    {pageTitle(item)}
                  </button>
                ))}
              </div>
              <div className="d-flex flex-wrap align-items-center gap-2 ms-lg-3 pb-2 pb-lg-0">
                <button
                  type="button"
                  className="btn btn-sm btn-ow-ghost"
                  title="Open this page in a separate window"
                  onClick={() => void window.desktop?.openPageWindow(page)}
                >
                  <span className="d-none d-sm-inline">Open in new window</span>
                  <span className="d-sm-none">New window</span>
                </button>
                {isMain ? null : (
                  <button
                    type="button"
                    className="btn btn-sm btn-ow-ghost"
                    onClick={() => void window.desktop?.requestWindowClose()}
                  >
                    Close
                  </button>
                )}
              </div>
            </div>
          </div>
        </nav>
      </header>

      <main
        className={`app-main${page === 'Dashboard' ? ' app-main--dashboard' : ''}${
          page === 'Radar' ? ' app-main--radar' : ''
        }`}
      >
        <div className="container-fluid px-3 px-lg-4 app-main__inner">{children}</div>
      </main>
    </div>
  )
}
