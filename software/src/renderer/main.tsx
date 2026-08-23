import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'bootstrap/dist/css/bootstrap.min.css'
import './styles/theme.css'
import './styles/app.css'
import { App } from './App'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { installAgentHost } from './agent/agentHost'

installAgentHost()

const rootEl = document.getElementById('root')
if (!rootEl) {
  throw new Error('Open Weather root element missing')
}

createRoot(rootEl).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>
)

