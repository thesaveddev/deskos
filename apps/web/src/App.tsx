import { useEffect, type ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import AiAgentPage from './pages/AiAgentPage.js'
import ApprovalsPage from './pages/ApprovalsPage.js'
import AssetsPage from './pages/AssetsPage.js'
import AutomationPage from './pages/AutomationPage.js'
import EmailSettingsPage from './pages/EmailSettingsPage.js'
import EntraSettingsPage from './pages/EntraSettingsPage.js'
import CannedResponsesPage from './pages/CannedResponsesPage.js'
import ConnectPage from './pages/ConnectPage.js'
import DeviceDetailPage from './pages/DeviceDetailPage.js'
import DeviceGroupsPage from './pages/DeviceGroupsPage.js'
import DevicesPage from './pages/DevicesPage.js'
import GrantsPage from './pages/GrantsPage.js'
import HomePage from './pages/HomePage.js'
import IncidentsPage from './pages/IncidentsPage.js'
import KnowledgeBasePage from './pages/KnowledgeBasePage.js'
import LandingPage from './pages/LandingPage.js'
import FeaturesPage from './pages/FeaturesPage.js'
import UseCasesPage from './pages/UseCasesPage.js'
import LoginPage from './pages/LoginPage.js'
import PricingPage from './pages/PricingPage.js'
import PrivacyPage from './pages/PrivacyPage.js'
import TermsPage from './pages/TermsPage.js'
import AboutPage from './pages/AboutPage.js'
import MonitoringPage from './pages/MonitoringPage.js'
import MarketplacePage from './pages/MarketplacePage.js'
import MspPage from './pages/MspPage.js'
import NewTicketPage from './pages/NewTicketPage.js'
import PatchPage from './pages/PatchPage.js'
import NotificationSettingsPage from './pages/NotificationSettingsPage.js'
import OauthSettingsPage from './pages/OauthSettingsPage.js'
import ReportsPage from './pages/ReportsPage.js'
import RmmPage from './pages/RmmPage.js'
import ScriptsPage from './pages/ScriptsPage.js'
import ServicesPage from './pages/ServicesPage.js'
import SessionsPage from './pages/SessionsPage.js'
import SessionConsolePage from './pages/SessionConsolePage.js'
import SettingsPage from './pages/SettingsPage.js'
import SignupPage from './pages/SignupPage.js'
import TicketDetailPage from './pages/TicketDetailPage.js'
import ChatPage from './pages/ChatPage.js'
import CallsPage from './pages/CallsPage.js'
import CompliancePage from './pages/CompliancePage.js'
import DeveloperPage from './pages/DeveloperPage.js'
import SecuritySettingsPage from './pages/SecuritySettingsPage.js'
import AdSettingsPage from './pages/AdSettingsPage.js'
import TicketsPage from './pages/TicketsPage.js'
import WebhooksPage from './pages/WebhooksPage.js'
import PortalHomePage from './pages/portal/PortalHomePage.js'
import PortalNewTicketPage from './pages/portal/PortalNewTicketPage.js'
import PortalTicketPage from './pages/portal/PortalTicketPage.js'
import { useAuth } from './lib/auth.js'

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

export default function App() {
  const status = useAuth((s) => s.status)
  const hydrate = useAuth((s) => s.hydrate)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  if (status === 'loading') {
    return (
      <div className="auth-screen">
        <span className="etch">Loading workspace…</span>
      </div>
    )
  }

  return (
    <Routes>
      {/* Public marketing pages */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/connect/:code" element={<ConnectPage />} />
      <Route path="/features" element={<FeaturesPage />} />
      <Route path="/use-cases" element={<UseCasesPage />} />
      <Route path="/pricing" element={<PricingPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/about" element={<AboutPage />} />
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
      <Route path="/settings/api" element={<Protected><OauthSettingsPage /></Protected>} />
      <Route path="/rmm" element={<Protected><RmmPage /></Protected>} />
      <Route path="/marketplace" element={<Protected><MarketplacePage /></Protected>} />
      <Route path="/ai-agent" element={<Protected><AiAgentPage /></Protected>} />
      <Route path="/sessions" element={<Protected><SessionsPage /></Protected>} />
      <Route path="/sessions/:id" element={<Protected><SessionConsolePage /></Protected>} />
      <Route path="/settings" element={<Protected><SettingsPage /></Protected>}>
        <Route path="email" element={<EmailSettingsPage />} />
        <Route path="integrations" element={<EntraSettingsPage />} />
        <Route path="canned" element={<CannedResponsesPage />} />
        <Route path="notifications" element={<NotificationSettingsPage />} />
        <Route path="security" element={<SecuritySettingsPage />} />
        <Route path="active-directory" element={<AdSettingsPage />} />
      </Route>
      <Route path="/portal" element={<Protected><PortalHomePage /></Protected>} />
      <Route path="/portal/new" element={<Protected><PortalNewTicketPage /></Protected>} />
      <Route path="/portal/tickets/:number" element={<Protected><PortalTicketPage /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
