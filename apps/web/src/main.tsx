import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary.js'
import { ConfirmProvider } from './components/ui.js'
import { ThemeProvider } from './lib/theme.js'
import './index.css'
import { registerServiceWorker } from './lib/push.js'
import { startVersionCheck } from './lib/versionCheck'

// Web Push service worker — silent, best-effort registration on boot.
void registerServiceWorker()

// Proactive stale-bundle detection — reloads when a deploy lands while
// the user has the app open in another tab or idle in the same tab.
startVersionCheck()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary autoReloadOnChunkError>
      <ThemeProvider>
        <ConfirmProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ConfirmProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)
