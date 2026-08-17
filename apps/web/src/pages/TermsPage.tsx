import LandingLayout from '../components/LandingLayout'

export default function TermsPage() {
  return (
    <LandingLayout
      title="Terms of Service — DeskOS"
      description="DeskOS Terms of Service — the rules governing your use of the DeskOS IT support platform."
    >
      <section className="landing-section legal-page">
        <div className="legal-content">
          <h1>Terms of Service</h1>
          <p className="legal-updated">Last updated: August 2026</p>

          <h2>1. Acceptance of terms</h2>
          <p>
            By accessing or using DeskOS ("Service"), you agree to these Terms of Service ("Terms"). If you are using the Service on behalf of an organisation, you represent that you have authority to bind that organisation to these Terms.
          </p>

          <h2>2. Description of service</h2>
          <p>
            DeskOS is an IT support platform that provides remote desktop control, endpoint monitoring and management, IT service management (ticketing), and related tools. The Service is provided "as is" and may be modified, updated, or discontinued at our discretion.
          </p>

          <h2>3. Account registration</h2>
          <ul>
            <li>You must provide accurate and complete registration information.</li>
            <li>You are responsible for the security of your account credentials.</li>
            <li>You must not share your account with others or allow unauthorised access.</li>
            <li>You must notify us immediately of any security breach.</li>
          </ul>

          <h2>4. Acceptable use</h2>
          <p>You agree not to:</p>
          <ul>
            <li>Use the Service for any unlawful purpose or in violation of applicable laws.</li>
            <li>Attempt to gain unauthorised access to any part of the Service.</li>
            <li>Interfere with or disrupt the Service or its infrastructure.</li>
            <li>Use the Service to harm, exploit, or surveil individuals without their knowledge or consent.</li>
            <li>Reverse-engineer, decompile, or disassemble any part of the Service.</li>
          </ul>

          <h2>5. Remote support</h2>
          <p>
            Remote support sessions are end-to-end encrypted. Every session requires explicit consent from the managed device user. You must not use remote support features to bypass consent mechanisms or access devices without proper authorisation.
          </p>

          <h2>6. Data ownership</h2>
          <p>
            You retain all rights to your data. We do not access, sell, or use your data for purposes other than providing the Service. See our Privacy Policy for full details on data handling.
          </p>

          <h2>7. Intellectual property</h2>
          <p>
            The Service, including its software, design, documentation, and branding, is owned by Clean IT Ltd and protected by copyright and trademark laws. You are granted a limited, non-exclusive, non-transferable licence to use the Service.
          </p>

          <h2>8. Fees and billing</h2>
          <ul>
            <li>Free tier: no fees for up to 3 technicians and 100 devices.</li>
            <li>Starter tier: $29 per technician per month (billed annually).</li>
            <li>Pro tier: $79 per technician per month (billed annually).</li>
            <li>Enterprise tier: custom pricing negotiated individually.</li>
            <li>All fees are non-refundable except as required by applicable law.</li>
          </ul>

          <h2>9. Service level</h2>
          <p>
            We target 99.9% uptime for the control plane. Scheduled maintenance windows will be communicated at least 48 hours in advance. Enterprise customers may negotiate dedicated SLA terms.
          </p>

          <h2>10. Limitation of liability</h2>
          <p>
            To the maximum extent permitted by law, DeskOS and Clean IT Ltd shall not be liable for any indirect, incidental, special, consequential, or punitive damages, or any loss of profits or revenues, whether incurred directly or indirectly. Our total liability shall not exceed the fees you paid in the twelve months preceding the claim.
          </p>

          <h2>11. Indemnification</h2>
          <p>
            You agree to indemnify and hold harmless DeskOS and Clean IT Ltd from any claims, losses, or damages arising from your use of the Service or violation of these Terms.
          </p>

          <h2>12. Termination</h2>
          <p>
            Either party may terminate this agreement at any time. Upon termination, your access to the Service will cease. We will retain your data for 30 days to allow for export, then delete it permanently.
          </p>

          <h2>13. Governing law</h2>
          <p>
            These Terms are governed by the laws of England and Wales. Any disputes shall be subject to the exclusive jurisdiction of the courts of England and Wales.
          </p>

          <h2>14. Changes to these terms</h2>
          <p>
            We may update these Terms from time to time. Material changes will be notified via email or in-app notification at least 30 days before they take effect. Continued use of the Service after changes constitutes acceptance.
          </p>

          <h2>15. Contact</h2>
          <p>
            Clean IT Ltd<br />
            <a href="mailto:legal@deskos.com">legal@deskos.com</a>
          </p>
        </div>
      </section>
    </LandingLayout>
  )
}
