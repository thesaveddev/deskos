import { Link } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import './NotFoundPage.css'
import LandingLayout from '../components/LandingLayout.js'
import { useAuth } from '../lib/auth.js'

function NotFoundContent({ authenticated }: { authenticated: boolean }) {
  return (
    <main className="not-found-page">
      <div className="not-found-card">
        <span className="not-found-code">404</span>
        <span className="eyebrow">Page not found</span>
        <h1>That page is not here.</h1>
        <p>
          The link may be outdated, or the page may have moved. Choose a destination below and we&apos;ll get you back on track.
        </p>
        <div className="not-found-actions">
          <Link className="btn btn-primary" to={authenticated ? '/' : '/'}>Go to dashboard</Link>
          <Link className="btn btn-ghost" to={authenticated ? '/tickets' : '/support'}>{authenticated ? 'Open tickets' : 'Visit support'}</Link>
        </div>
        <span className="not-found-path">Requested path: {window.location.pathname}</span>
      </div>
    </main>
  )
}

export default function NotFoundPage() {
  const status = useAuth((state) => state.status)
  const authenticated = status === 'authed'

  if (authenticated) {
    return <Shell><NotFoundContent authenticated /></Shell>
  }

  return (
    <LandingLayout title="Page Not Found — DeskOS" description="The DeskOS page you requested could not be found.">
      <NotFoundContent authenticated={false} />
    </LandingLayout>
  )
}
