import nodemailer, { type Transporter } from 'nodemailer'
import type { SmtpConfig } from '../../config.js'

export interface TicketMailContext {
  to: string
  ticketNumber: number
  subject: string
  body: string
  tenantName: string
  replyBody?: string
  portalUrl?: string
}

export interface CapturedMail {
  to: string
  subject: string
  text: string
  html?: string
  messageId?: string
  raw: unknown
}

export interface MailerStatus {
  transportConfigured: boolean
  fromConfigured: boolean
  authConfigured: boolean
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastError: string | null
}

export interface EmailMessage {
  to: string
  subject: string
  text: string
  html: string
}

export interface InvitationMailContext {
  to: string
  tenantName: string
  role: string
  inviteUrl: string
  expiresInDays?: number
}

export interface BrandedEmailOptions {
  tenantName?: string
  brand?: { logoUrl?: string | null; primaryColor?: string | null }
  eyebrow?: string
  title: string
  preheader?: string
  greeting?: string
  paragraphs?: string[]
  htmlBody?: string
  action?: { label: string; url: string }
  metadata?: Array<{ label: string; value: string }>
  footer?: string
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character)
}

function safeText(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim().slice(0, 180)
}

function paragraphHtml(value: string): string {
  return `<p style="margin:0 0 18px;color:#c3cbd3;font-size:15px;line-height:1.65;">${escapeHtml(value).replace(/\n/g, '<br>')}</p>`
}

/**
 * Shared, table-based email shell. Styles are intentionally inline so the
 * message renders consistently in Outlook, Gmail, and mobile clients while
 * matching ReyDesk' dark workspace and amber accent.
 */
export function renderBrandedEmail(options: BrandedEmailOptions): string {
  const tenantName = safeText(options.tenantName ?? 'ReyDesk') || 'ReyDesk'
  const accent = /^#[0-9a-f]{6}$/i.test(options.brand?.primaryColor ?? '') ? options.brand!.primaryColor! : '#e8a33d'
  const logoUrl = options.brand?.logoUrl && /^https:\/\//i.test(options.brand.logoUrl) ? options.brand.logoUrl : null
  const preheader = escapeHtml(safeText(options.preheader ?? options.title))
  const eyebrow = escapeHtml(safeText(options.eyebrow ?? 'ReyDesk'))
  const title = escapeHtml(options.title)
  const greeting = options.greeting ? `<p style="margin:0 0 18px;color:#e6e9ec;font-size:15px;line-height:1.6;">${escapeHtml(options.greeting)}</p>` : ''
  const body = options.htmlBody ?? (options.paragraphs ?? []).map(paragraphHtml).join('')
  const metadata = options.metadata?.length
    ? `<table role="presentation" width="100%" style="margin:22px 0;border-collapse:collapse;background:#1a2027;border:1px solid #303a45;border-radius:6px;"><tbody>${options.metadata.map((item) => `<tr><td style="padding:10px 12px;border-bottom:1px solid #303a45;color:#8f9aa5;font-size:12px;">${escapeHtml(item.label)}</td><td style="padding:10px 12px;border-bottom:1px solid #303a45;color:#e6e9ec;font-size:13px;text-align:right;">${escapeHtml(item.value)}</td></tr>`).join('')}</tbody></table>`
    : ''
  const action = options.action
    ? `<p style="margin:26px 0 24px;"><a href="${escapeHtml(options.action.url)}" style="display:inline-block;padding:12px 18px;background:${accent};color:#17120a;text-decoration:none;font-weight:600;font-size:14px;border-radius:6px;">${escapeHtml(options.action.label)}</a></p>`
    : ''
  const footer = escapeHtml(options.footer ?? `This message was sent by ${tenantName} through ReyDesk.`)

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#0e1114;font-family:Arial,Helvetica,sans-serif;color:#e6e9ec;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0e1114;margin:0;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#14181d;border:1px solid #242b33;border-radius:8px;overflow:hidden;">
        <tr><td style="height:4px;background:#e8a33d;font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td style="padding:24px 30px 20px;border-bottom:1px solid #242b33;">
          <table role="presentation" width="100%"><tr><td>
            <span style="display:inline-block;width:26px;height:26px;line-height:26px;text-align:center;background:${accent};color:#17120a;border-radius:5px;font-weight:700;font-size:14px;vertical-align:middle;">${logoUrl ? `<img src="${escapeHtml(logoUrl)}" alt="" width="26" height="26" style="display:block;border-radius:5px;object-fit:cover;">` : 'R'}</span>
            <span style="margin-left:9px;color:#e6e9ec;font-size:17px;font-weight:700;vertical-align:middle;">${escapeHtml(tenantName)}</span>
          </td><td align="right" style="color:#6f7b87;font-family:monospace;font-size:11px;">${eyebrow}</td></tr></table>
        </td></tr>
        <tr><td style="padding:30px;">
          <h1 style="margin:0 0 22px;color:#f0f2f4;font-size:25px;line-height:1.25;font-weight:600;letter-spacing:-.3px;">${title}</h1>
          ${greeting}${body}${metadata}${action}
          <p style="margin:24px 0 0;color:#7f8a96;font-size:12px;line-height:1.6;">${footer}</p>
        </td></tr>
        <tr><td style="padding:16px 30px;border-top:1px solid #242b33;color:#5f6b77;font-size:11px;line-height:1.5;">ReyDesk · IT support operations</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}

/**
 * Outbound mailer for ticket notifications and authentication messages.
 * When SMTP is not configured, sending is a no-op; ticket operations never
 * fail because an email transport is unavailable.
 */
export class Mailer {
  private transport: Transporter | null = null
  private lastAttemptAt: Date | null = null
  private lastSuccessAt: Date | null = null
  private lastFailureAt: Date | null = null
  private lastError: string | null = null
  readonly sent: CapturedMail[] = []

  constructor(private config: SmtpConfig) {
    if (config.jsonTransport) {
      this.transport = nodemailer.createTransport({ jsonTransport: true })
    } else if (config.enabled && config.host) {
      this.transport = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.port === 465,
        requireTLS: config.tls && config.port !== 465,
        tls: { minVersion: 'TLSv1.2' },
        auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined,
      })
    }
  }

  get enabled(): boolean {
    return this.transport !== null && Boolean(this.config.from)
  }

  get status(): MailerStatus {
    return {
      transportConfigured: this.transport !== null,
      fromConfigured: Boolean(this.config.from),
      authConfigured: Boolean(this.config.user && this.config.pass),
      lastAttemptAt: this.lastAttemptAt?.toISOString() ?? null,
      lastSuccessAt: this.lastSuccessAt?.toISOString() ?? null,
      lastFailureAt: this.lastFailureAt?.toISOString() ?? null,
      lastError: this.lastError,
    }
  }

  async verifyConnection(): Promise<{ ok: boolean; error?: string }> {
    if (!this.transport) return { ok: false, error: 'SMTP transport is not configured' }
    if (!this.config.from) return { ok: false, error: 'REYDESK_SMTP_FROM (or legacy DESKOS_SMTP_FROM) is not configured' }
    try {
      await this.transport.verify()
      this.lastError = null
      return { ok: true }
    } catch (err) {
      const error = err instanceof Error ? err.message : 'SMTP verification failed'
      this.lastFailureAt = new Date()
      this.lastError = error
      return { ok: false, error }
    }
  }

  async sendMail(input: { to: string; subject: string; text: string; html?: string }): Promise<boolean> {
    this.lastAttemptAt = new Date()
    if (!this.transport) {
      this.lastFailureAt = new Date()
      this.lastError = 'SMTP transport is not configured'
      console.warn(`[mailer] SMTP is not configured; cannot send to ${input.to}: ${input.subject}`)
      return false
    }
    if (!this.config.from) {
      this.lastFailureAt = new Date()
      this.lastError = 'REYDESK_SMTP_FROM (or legacy DESKOS_SMTP_FROM) is not configured'
      console.warn('[mailer] REYDESK_SMTP_FROM (or legacy DESKOS_SMTP_FROM) is not configured; cannot send mail')
      return false
    }
    try {
      const info = await this.transport.sendMail({
        from: this.config.from,
        to: input.to,
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
      })
      this.lastSuccessAt = new Date()
      this.lastError = null
      if (this.config.jsonTransport) {
        try {
          const raw = JSON.parse(info.message as string)
          this.sent.push({
            to: input.to,
            subject: input.subject,
            text: input.text,
            html: input.html,
            messageId: raw.messageId,
            raw,
          })
        } catch {
          this.sent.push({ to: input.to, subject: input.subject, text: input.text, html: input.html, raw: info.message })
        }
      }
      return true
    } catch (err) {
      const error = err instanceof Error ? err.message : 'SMTP delivery failed'
      this.lastFailureAt = new Date()
      this.lastError = error
      console.error(`[mailer] send failed (${input.subject}):`, error)
      return false
    }
  }

  /** Human-readable email for a ticket thread message. */
  buildTicketMail(ctx: TicketMailContext, prefix?: string): { to: string; subject: string; text: string; html: string } {
    const reply = ctx.replyBody ?? ctx.body
    const subject = prefix
      ? `${prefix}: [${ctx.ticketNumber}] ${ctx.subject}`
      : ctx.subject.startsWith('Re:')
        ? ctx.subject
        : `Re: [${ctx.ticketNumber}] ${ctx.subject}`
    const resolved = prefix?.toLowerCase() === 'resolved'
    const text = [
      `Hi,`,
      ``,
      reply,
      ``,
      resolved ? 'Your request is now resolved. If the issue persists, reply to reopen it.' : `Ticket #${ctx.ticketNumber} has a new update.`,
      ``,
      `— ${ctx.tenantName} IT Support`,
      ``,
      `Ticket #${ctx.ticketNumber}: ${ctx.subject}`,
      ``,
      `Reply to this email or visit your portal to update the request.`,
    ].join('\n')
    const portalUrl = ctx.portalUrl?.replace(/\/$/, '')
    const html = renderBrandedEmail({
      tenantName: ctx.tenantName,
      eyebrow: `Ticket #${ctx.ticketNumber}`,
      preheader: `${resolved ? 'Resolved ticket' : 'New ticket update'} · ${ctx.subject}`,
      title: resolved ? 'Your ticket has been resolved' : 'There is an update on your ticket',
      greeting: 'Hi there,',
      paragraphs: [reply, resolved ? 'Your request is now resolved. If the issue persists, reply to reopen it.' : 'The support team has added an update to your request.'],
      action: portalUrl ? { label: 'Open ticket', url: `${portalUrl}/portal/tickets/${ctx.ticketNumber}` } : undefined,
      metadata: [
        { label: 'Ticket', value: `#${ctx.ticketNumber}` },
        { label: 'Subject', value: ctx.subject },
        { label: 'Status', value: resolved ? 'Resolved' : 'Open' },
      ],
    })
    return { to: ctx.to, subject, text, html }
  }

  /** Build a branded email for notification preferences that include email. */
  buildNotificationMail(ctx: { to: string; tenantName: string; kind: string; body: string; action?: { label: string; url: string }; settingsUrl?: string }): { to: string; subject: string; text: string; html: string } {
    const labels: Record<string, string> = {
      'ticket.replied': 'Ticket update',
      'ticket.requester_replied': 'Requester replied',
      'ticket.ai_triage': 'ReyDesk assistant update',
      'ticket.resolved': 'Ticket resolved',
      'sla.breached': 'SLA breach',
      'service.approval': 'Approval needed',
      'service.approval_decided': 'Approval decision',
      'change.approval': 'Change approval needed',
      'membership.invited': 'Workspace invitation',
      session_invite: 'Remote session invitation',
      'session.adhoc.claimed': 'Support code claimed',
      'device.alert': 'Device alert',
      offline: 'Device offline',
      low_disk: 'Low disk space',
      automation: 'Automation update',
      'ai_worker.approval': 'AI worker approval needed',
      'telephony.call_received': 'Inbound call',
    }
    const label = labels[ctx.kind] ?? 'Workspace notification'
    return {
      to: ctx.to,
      subject: `${label} · ${ctx.tenantName}`,
      text: [`${label} from ${ctx.tenantName}`, '', ctx.body, '', ctx.action ? `${ctx.action.label}: ${ctx.action.url}` : '', '', `Manage notification preferences: ${ctx.settingsUrl ?? 'https://www.reydesk.com/settings/notifications'}`].join('\n'),
      html: renderBrandedEmail({
        tenantName: ctx.tenantName,
        eyebrow: label,
        preheader: ctx.body,
        title: label,
        greeting: 'You have a new ReyDesk notification.',
        paragraphs: [ctx.body],
        action: ctx.action,
        footer: `You received this because email notifications are enabled for this event in ${ctx.tenantName}. Manage preferences in ReyDesk Settings.`,
      }),
    }
  }

  buildInvitationMail(ctx: InvitationMailContext): EmailMessage {
    const tenantName = safeText(ctx.tenantName) || 'your organisation'
    const role = safeText(ctx.role) || 'team member'
    const expiry = ctx.expiresInDays ?? 7
    return {
      to: ctx.to,
      subject: `You’re invited to join ${tenantName} on ReyDesk`,
      text: [
        `You’ve been invited to join ${tenantName} on ReyDesk as ${role}.`,
        '',
        `Accept your invitation: ${ctx.inviteUrl}`,
        '',
        `This invitation expires in ${expiry} days and can only be used once.`,
        'If you were not expecting this invitation, you can ignore this email.',
      ].join('\n'),
      html: renderBrandedEmail({
        tenantName,
        eyebrow: 'Workspace invitation',
        preheader: `Join ${tenantName} on ReyDesk`,
        title: 'You’re invited to join a workspace',
        greeting: `You’ve been invited to join ${tenantName} on ReyDesk as ${role}.`,
        paragraphs: [`Accept the invitation to set up your access. This link expires in ${expiry} days and can only be used once.`, 'If you were not expecting this invitation, you can ignore this email.'],
        action: { label: 'Accept invitation', url: ctx.inviteUrl },
        metadata: [{ label: 'Organisation', value: tenantName }, { label: 'Role', value: role }],
        footer: `This invitation was sent by ${tenantName} through ReyDesk.`,
      }),
    }
  }

  buildMagicLinkMail(to: string, signInUrl: string, tenantName: string): EmailMessage {
    const displayName = safeText(tenantName) || 'ReyDesk'
    return {
      to,
      subject: `Your ${displayName} ReyDesk sign-in link`,
      text: [
        `Use this one-time link to sign in to ${displayName} ReyDesk:`,
        '',
        signInUrl,
        '',
        'This link expires in 15 minutes and can only be used once.',
        'If you did not request it, you can safely ignore this email.',
      ].join('\n'),
      html: renderBrandedEmail({
        tenantName: displayName,
        eyebrow: 'Secure sign-in',
        preheader: 'Your one-time ReyDesk sign-in link',
        title: 'Sign in securely',
        greeting: `Use this one-time link to sign in to ${displayName} ReyDesk.`,
        paragraphs: ['The link expires in 15 minutes and can only be used once. If you did not request it, you can safely ignore this email.'],
        action: { label: 'Sign in to ReyDesk', url: signInUrl },
      }),
    }
  }

  buildPortalInviteMail(ctx: {
    to: string
    tenantName: string
    portalUrl: string
    senderName?: string
    message?: string
    brand?: { logoUrl?: string | null; primaryColor?: string | null }
  }): EmailMessage {
    const tenantName = safeText(ctx.tenantName) || 'ReyDesk'
    const senderName = safeText(ctx.senderName ?? '') || 'your IT team'
    const personalHtml = (ctx.message ?? '').trim()
      ? `<p style="margin:0 0 18px;color:#c3cbd3;font-size:15px;line-height:1.65;">${escapeHtml(ctx.message!.trim()).replace(/\n/g, '<br>')}</p>`
      : ''
    const standardHtml = `<p style="margin:0 0 18px;color:#c3cbd3;font-size:15px;line-height:1.65;">Everything lives in your portal: raise a new request in seconds, follow the status of open tickets, and read the knowledge base without waiting on a phone call.</p>`
    return {
      to: ctx.to,
      subject: `Your ${tenantName} support portal is ready`,
      text: [
        `${senderName} invited you to the ${tenantName} support portal.`,
        '',
        `Open the portal: ${ctx.portalUrl}`,
        '',
        'Sign in with your work email to raise requests, track tickets, and browse the knowledge base.',
        '',
        'If you were not expecting this invitation, you can safely ignore this email.',
      ].join('\n'),
      html: renderBrandedEmail({
        tenantName,
        brand: ctx.brand,
        eyebrow: 'Support portal',
        preheader: `Your ${tenantName} support portal is ready`,
        title: 'You’ve been invited to the support portal',
        greeting: `${escapeHtml(senderName)} invited you to the ${escapeHtml(tenantName)} support portal. Sign in with your work email to get help, track your requests, and browse self-service answers.`,
        htmlBody: personalHtml + standardHtml,
        action: { label: 'Open your portal', url: ctx.portalUrl },
        metadata: [
          { label: 'Portal address', value: ctx.portalUrl },
          { label: 'Sent by', value: senderName },
        ],
        footer: `This invitation was sent by ${senderName} through ReyDesk. If you were not expecting it, you can safely ignore this email.`,
      }),
    }
  }

  buildPasswordResetMail(to: string, resetUrl: string): EmailMessage {
    return {
      to,
      subject: 'Reset your ReyDesk password',
      text: [
        'We received a request to reset your ReyDesk password.',
        '',
        `Use this link within the next hour: ${resetUrl}`,
        '',
        'If you did not request this, you can safely ignore this email.',
      ].join('\n'),
      html: renderBrandedEmail({
        eyebrow: 'Account security',
        preheader: 'Reset your ReyDesk password',
        title: 'Reset your password',
        greeting: 'We received a request to reset your ReyDesk password.',
        paragraphs: ['This link expires in one hour. If you did not request this, you can safely ignore this email.'],
        action: { label: 'Reset password', url: resetUrl },
      }),
    }
  }

  buildVerificationMail(to: string, verifyUrl: string): EmailMessage {
    return {
      to,
      subject: 'Verify your ReyDesk email address',
      text: [`Verify your ReyDesk email address: ${verifyUrl}`, '', 'If you did not create this account, you can ignore this email.'].join('\n'),
      html: renderBrandedEmail({
        eyebrow: 'Account setup',
        preheader: 'Verify your ReyDesk email address',
        title: 'Verify your email address',
        greeting: 'Please verify your ReyDesk email address to finish setting up your account.',
        paragraphs: ['If you did not create this account, you can safely ignore this email.'],
        action: { label: 'Verify email address', url: verifyUrl },
      }),
    }
  }

  buildRemoteSupportMail(ctx: { to: string; connectUrl: string; code: string; mode: 'code' | 'email_link' }): EmailMessage {
    const isLink = ctx.mode === 'email_link'
    const subject = isLink ? 'Your secure ReyDesk support link' : 'ReyDesk remote support request'
    const text = isLink
      ? ['A ReyDesk technician has requested temporary access to your device.', '', 'Open this one-time secure link to continue:', ctx.connectUrl, '', 'The first helper that presents this link is bound to the claim. The link expires automatically and access starts only after you approve the request.'].join('\n')
      : ['A ReyDesk technician has requested temporary access to your device.', '', `Support code: ${ctx.code}`, `Open this link to continue: ${ctx.connectUrl}`, '', 'The code expires automatically and access starts only after you approve the request.'].join('\n')
    return {
      to: ctx.to,
      subject,
      text,
      html: renderBrandedEmail({
        eyebrow: 'Remote support',
        preheader: subject,
        title: 'A technician requested support access',
        greeting: 'Only continue if you expected help from your IT support team.',
        paragraphs: [isLink ? 'Use the secure link below to open the support page.' : `Enter this support code on the ReyDesk support page: ${ctx.code}`, 'Access begins only after you review and approve the request.'],
        metadata: isLink ? undefined : [{ label: 'Support code', value: ctx.code }],
        action: { label: 'Open secure support page', url: ctx.connectUrl },
        footer: 'Never share a support code with someone you do not trust.',
      }),
    }
  }

  /** Email sent when a technician replies publicly to a ticket. */
  async sendReplyEmail(ctx: TicketMailContext): Promise<boolean> {
    return this.sendMail(this.buildTicketMail(ctx))
  }

  /** Email sent when a ticket is resolved. */
  async sendResolvedEmail(ctx: Omit<TicketMailContext, 'replyBody'>): Promise<boolean> {
    const { to, subject, text, html } = this.buildTicketMail(
      { ...ctx, body: 'Your request is now resolved. If the issue persists, reply to reopen it.' },
      'Resolved',
    )
    return this.sendMail({ to, subject, text, html })
  }
}
