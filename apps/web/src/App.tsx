import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { LockScreen } from './components/LockScreen.js'
import { registerServiceWorker } from './lib/push.js'
import { useIdleTimeout } from './lib/idle.js'
import { clearLockedUser, onLockRequest, onLockStateChange, readPersistedLocked, setPersistedLocked, signalManualLock, signalManualUnlock } from './lib/lock.js'
// Route-level code splitting: every page is a lazy chunk so the initial bundle
// carries only the shell, auth, and the small route primitives. Pages load on
// demand as the user navigates.
const AiAgentPage = lazy(() => import('./pages/AiAgentPage.js'))
const ApprovalsPage = lazy(() => import('./pages/ApprovalsPage.js'))
const AssetsPage = lazy(() => import('./pages/AssetsPage.js'))
const AutomationPage = lazy(() => import('./pages/AutomationPage.js'))
const ConnectPage = lazy(() => import('./pages/ConnectPage.js'))
const DeviceDetailPage = lazy(() => import('./pages/DeviceDetailPage.js'))
const DeviceGroupsPage = lazy(() => import('./pages/DeviceGroupsPage.js'))
const DevicesPage = lazy(() => import('./pages/DevicesPage.js'))
const GrantsPage = lazy(() => import('./pages/GrantsPage.js'))
const HomePage = lazy(() => import('./pages/HomePage.js'))
const IncidentsPage = lazy(() => import('./pages/IncidentsPage.js'))
const KnowledgeBasePage = lazy(() => import('./pages/KnowledgeBasePage.js'))
const LearnPage = lazy(() => import('./pages/LearnPage.js'))
const LandingPage = lazy(() => import('./pages/LandingPage.js'))
const FeaturesPage = lazy(() => import('./pages/FeaturesPage.js'))
const UseCasesPage = lazy(() => import('./pages/UseCasesPage.js'))
const LoginPage = lazy(() => import('./pages/LoginPage.js'))
const LockPage = lazy(() => import('./pages/LockPage.js'))
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage.js'))
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage.js'))
const PricingPage = lazy(() => import('./pages/PricingPage.js'))
const PrivacyPage = lazy(() => import('./pages/PrivacyPage.js'))
const TermsPage = lazy(() => import('./pages/TermsPage.js'))
const AboutPage = lazy(() => import('./pages/AboutPage.js'))
const AcceptInvitationPage = lazy(() => import('./pages/AcceptInvitationPage.js'))
const ContactPage = lazy(() => import('./pages/ContactPage.js'))
const ApiDocsPage = lazy(() => import('./pages/ApiDocsPage.js'))
const SupportPage = lazy(() => import('./pages/SupportPage.js'))
const AdminDashboardPage = lazy(() => import('./pages/AdminDashboardPage.js'))
const AdminSupportPage = lazy(() => import('./pages/AdminSupportPage.js'))
const StaffPage = lazy(() => import('./pages/StaffPage.js'))
const NotesPage = lazy(() => import('./pages/NotesPage.js'))
const BillingPage = lazy(() => import('./pages/BillingPage.js'))
const ProfilePage = lazy(() => import('./pages/ProfilePage.js'))
const MonitoringPage = lazy(() => import('./pages/MonitoringPage.js'))
const MarketplacePage = lazy(() => import('./pages/MarketplacePage.js'))
const MspPage = lazy(() => import('./pages/MspPage.js'))
const NewTicketPage = lazy(() => import('./pages/NewTicketPage.js'))
const NotFoundPage = lazy(() => import('./pages/NotFoundPage.js'))
const TeamsPage = lazy(() => import('./pages/TeamsPage.js'))
const PatchPage = lazy(() => import('./pages/PatchPage.js'))
const ReportsPage = lazy(() => import('./pages/ReportsPage.js'))
const RmmPage = lazy(() => import('./pages/RmmPage.js'))
const ScriptsPage = lazy(() => import('./pages/ScriptsPage.js'))
const ServicesPage = lazy(() => import('./pages/ServicesPage.js'))
const SessionsPage = lazy(() => import('./pages/SessionsPage.js'))
const SessionConsolePage = lazy(() => import('./pages/SessionConsolePage.js'))
const SettingsPage = lazy(() => import('./pages/SettingsPage.js'))
const SignupPage = lazy(() => import('./pages/SignupPage.js'))
const TicketDetailPage = lazy(() => import('./pages/TicketDetailPage.js'))
const ChatPage = lazy(() => import('./pages/ChatPage.js'))
const CallsPage = lazy(() => import('./pages/CallsPage.js'))
const CompliancePage = lazy(() => import('./pages/CompliancePage.js'))
const DeveloperPage = lazy(() => import('./pages/DeveloperPage.js'))
const TicketsPage = lazy(() => import('./pages/TicketsPage.js'))
const WebhooksPage = lazy(() => import('./pages/WebhooksPage.js'))
const PortalHomePage = lazy(() => import('./pages/portal/PortalHomePage.js'))
const PortalPublicPage = lazy(() => import('./pages/portal/PortalPublicPage.js'))
const PortalNewTicketPage = lazy(() => import('./pages/portal/PortalNewTicketPage.js'))
const PortalTicketPage = lazy(() => import('./pages/portal/PortalTicketPage.js'))
import { useAuth } from './lib/auth.js'

function PageLoader() {
  return (
    <div className="route-loader" aria-busy="true" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>Loading…</span>
    </div>
  )
}

function Protected({ children }: { children: ReactNode }) {
  const status = useAuth((s) => s.status)
  if (status === 'anon') return <Navigate to="/login" replace />
  if (status === 'loading') return null
  return <>{children}</>
}

/** Public product landing for anonymous visitors; the console for signed-in users. */
function HomeRoute() {
  const status = useAuth((s) => s.status)
  if (status === 'anon') return <LandingPage />
  if (status === 'loading') return null
  return <HomePage />
}

function IdleLockWrapper({ children }: { children: ReactNode }) {
  const authStatus = useAuth((state) => state.status)
  const currentUser = useAuth((state) => state.user)
  const logout = useAuth((state) => state.logout)
  const navigate = useNavigate()
  // Start from the persisted lock state so a fresh tab honours a lock set by
  // another tab instead of falling straight through to the dashboard.
  const [locked, setLocked] = useState<boolean>(() => readPersistedLocked())
  const [lockedUser, setLockedUser] = useState<typeof currentUser>(null)

  const doLock = useCallback((user: typeof currentUser, manual: boolean) => {
    // Keep a stable snapshot for the lock screen; a later re-hydration must not
    // replace the signed-in identity with a generic fallback.
    if (user) setLockedUser(user)
    setLocked(true)
    setPersistedLocked(true)
    if (manual) signalManualLock()
  }, [])

  const { resetTimer } = useIdleTimeout(
    useCallback(() => {
      if (authStatus === 'authed' && currentUser) doLock(currentUser, false)
    }, [authStatus, currentUser, doLock]),
  )

  // Populate the lock-screen identity once auth resolves, including when the
  // lock originated in another tab and this tab is only now loading.
  useEffect(() => {
    if (locked && authStatus === 'authed' && currentUser) {
      setLockedUser((previous) => previous ?? currentUser)
    }
  }, [authStatus, currentUser, locked])

  // Manual lock requests (topbar button / Ctrl+L).
  useEffect(() => {
    return onLockRequest(() => {
      if (authStatus === 'authed' && currentUser) doLock(currentUser, true)
    })
  }, [authStatus, currentUser, doLock])

  // Cross-tab sync: mirror lock/unlock from other tabs so the lock screen
  // cannot be bypassed by opening the app in a new tab.
  useEffect(() => {
    return onLockStateChange((next) => {
      if (next) {
        setLocked(true)
      } else {
        setLocked(false)
        setLockedUser(null)
        resetTimer()
      }
    })
  }, [resetTimer])

  // If the session ends while locked, drop the persisted lock so the next tab
  // shows the sign-in page instead of a dead lock screen.
  useEffect(() => {
    if (locked && authStatus === 'anon') {
      setLocked(false)
      setLockedUser(null)
      setPersistedLocked(false)
    }
  }, [authStatus, locked])

  const unlock = useCallback(() => {
    setLocked(false)
    setLockedUser(null)
    setPersistedLocked(false)
    signalManualUnlock()
    resetTimer()
  }, [resetTimer])

  const goToLogin = useCallback(async () => {
    setLocked(false)
    setLockedUser(null)
    setPersistedLocked(false)
    signalManualUnlock()
    resetTimer()
    clearLockedUser()
    await logout()
    navigate('/login', { replace: true })
  }, [logout, navigate, resetTimer])

  if (locked) {
    const user = lockedUser ?? currentUser
    if (user) return <LockScreen user={user} onUnlock={unlock} onGoToLogin={goToLogin} />
    // Auth is still resolving while the workspace is locked; hold the loader
    // until the identity is known so the dashboard never flashes.
    return <PageLoader />
  }
  return <>{children}</>
}

export default function App() {
  const status = useAuth((s) => s.status)
  const hydrate = useAuth((s) => s.hydrate)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  // Register the service worker without prompting for notification permission.
  // Permission is requested from Settings → Notifications, where the user has
  // context and can test or revoke the device subscription.
  useEffect(() => {
    if (status === 'authed') void registerServiceWorker()
  }, [status])

  // Public routes must render even while the session is being hydrated. This
  // keeps the landing, Learn, support, and sign-in pages available when the API
  // is restarting or temporarily unreachable; protected routes still wait in
  // their own guard until authentication is known.
  return (
    <IdleLockWrapper>
      <Suspense fallback={<PageLoader />}>
    <Routes>
      {/* Public marketing pages */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/lock" element={<LockPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/accept-invitation" element={<AcceptInvitationPage />} />
      <Route path="/connect" element={<ConnectPage />} />
      <Route path="/connect/:code" element={<ConnectPage />} />
      <Route path="/features" element={<FeaturesPage />} />
      <Route path="/use-cases" element={<UseCasesPage />} />
      <Route path="/pricing" element={<PricingPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/about" element={<AboutPage />} />
      <Route path="/contact" element={<ContactPage />} />
      <Route path="/api-docs" element={<ApiDocsPage />} />
      <Route path="/support" element={<SupportPage />} />
      <Route path="/learn" element={<LearnPage publicView />} />
      <Route path="/admin" element={<Protected><AdminDashboardPage /></Protected>} />
      <Route path="/admin/support" element={<Protected><AdminSupportPage /></Protected>} />
      <Route path="/staff" element={<Protected><StaffPage /></Protected>} />
      <Route path="/teams" element={<Protected><TeamsPage /></Protected>} />
      <Route path="/team" element={<Navigate to="/teams" replace />} />
      <Route path="/profile" element={<Protected><ProfilePage /></Protected>} />
      <Route path="/notes" element={<Protected><NotesPage /></Protected>} />
      <Route path="/billing" element={<Protected><BillingPage /></Protected>} />
      <Route path="/" element={<HomeRoute />} />

      {/* Protected console pages */}
      <Route path="/tickets" element={<Protected><TicketsPage /></Protected>} />
      <Route path="/tickets/new" element={<Protected><NewTicketPage /></Protected>} />
      <Route path="/tickets/:id" element={<Protected><TicketDetailPage /></Protected>} />
      <Route path="/devices" element={<Protected><DevicesPage /></Protected>} />
      <Route path="/monitoring" element={<Protected><MonitoringPage /></Protected>} />
      <Route path="/devices/groups" element={<Protected><DeviceGroupsPage /></Protected>} />
      <Route path="/devices/:id" element={<Protected><DeviceDetailPage /></Protected>} />
      <Route path="/reports" element={<Protected><ReportsPage /></Protected>} />
      <Route path="/compliance" element={<Protected><CompliancePage /></Protected>} />
      <Route path="/kb" element={<Protected><KnowledgeBasePage /></Protected>} />
      <Route path="/automations" element={<Protected><AutomationPage /></Protected>} />
      <Route path="/assets" element={<Protected><AssetsPage /></Protected>} />
      <Route path="/services" element={<Protected><ServicesPage /></Protected>} />
      <Route path="/scripts" element={<Protected><ScriptsPage /></Protected>} />
      <Route path="/approvals" element={<Protected><ApprovalsPage /></Protected>} />
      <Route path="/chat" element={<Protected><ChatPage /></Protected>} />
      <Route path="/calls" element={<Protected><CallsPage /></Protected>} />
      <Route path="/incidents" element={<Protected><IncidentsPage /></Protected>} />
      <Route path="/msp" element={<Protected><MspPage /></Protected>} />
      <Route path="/grants" element={<Protected><GrantsPage /></Protected>} />
      <Route path="/patches" element={<Protected><PatchPage /></Protected>} />
      <Route path="/integrations" element={<Protected><WebhooksPage /></Protected>} />
      <Route path="/developer" element={<Protected><DeveloperPage /></Protected>} />
      <Route path="/rmm" element={<Protected><RmmPage /></Protected>} />
      <Route path="/marketplace" element={<Protected><MarketplacePage /></Protected>} />
      <Route path="/ai-agent" element={<Protected><AiAgentPage /></Protected>} />
      <Route path="/sessions" element={<Protected><SessionsPage /></Protected>} />
      <Route path="/sessions/:id" element={<Protected><SessionConsolePage /></Protected>} />
      <Route path="/settings" element={<Protected><SettingsPage /></Protected>} />
      <Route path="/settings/preferences" element={<Protected><SettingsPage /></Protected>} />
      <Route path="/settings/tickets" element={<Protected><SettingsPage /></Protected>} />
      <Route path="/settings/email" element={<Protected><SettingsPage /></Protected>} />
      <Route path="/settings/integrations" element={<Protected><SettingsPage /></Protected>} />
      <Route path="/settings/canned" element={<Protected><SettingsPage /></Protected>} />
      <Route path="/settings/notifications" element={<Protected><SettingsPage /></Protected>} />
      <Route path="/settings/ai" element={<Protected><SettingsPage /></Protected>} />
      <Route path="/settings/security" element={<Protected><SettingsPage /></Protected>} />
      <Route path="/settings/active-directory" element={<Protected><SettingsPage /></Protected>} />
      <Route path="/settings/ad" element={<Protected><SettingsPage /></Protected>} />
      <Route path="/settings/branding" element={<Protected><SettingsPage /></Protected>} />
      <Route path="/settings/portal" element={<Protected><SettingsPage /></Protected>} />
      <Route path="/settings/remote" element={<Protected><SettingsPage /></Protected>} />
      <Route path="/settings/devices" element={<Protected><SettingsPage /></Protected>} />
      <Route path="/settings/monitoring" element={<Protected><SettingsPage /></Protected>} />
      <Route path="/settings/data" element={<Protected><SettingsPage /></Protected>} />
      <Route path="/settings/api" element={<Protected><SettingsPage /></Protected>} />
      <Route path="/portal" element={<Protected><PortalHomePage /></Protected>} />
      <Route path="/portal/new" element={<Protected><PortalNewTicketPage /></Protected>} />
      <Route path="/portal/tickets/:number" element={<Protected><PortalTicketPage /></Protected>} />
      {/* Public tenant portal — reydesk.com/portal/<organisation-slug> */}
      <Route path="/portal/:slug/kb/:articleId" element={<PortalPublicPage />} />
      <Route path="/portal/:slug" element={<PortalPublicPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
      </Suspense>
    </IdleLockWrapper>
  )
}
