import nodemailer, { type Transporter } from 'nodemailer'
import type { SmtpConfig } from '../../config.js'

export interface TicketMailContext {
  to: string
  ticketNumber: number
  subject: string
  body: string
  tenantName: string
  replyBody?: string
}

export interface CapturedMail {
  to: string
  subject: string
  text: string
  messageId?: string
  raw: unknown
}

/**
 * Outbound mailer for ticket notifications (reply-by-email). Wraps nodemailer.
 *
 * - When SMTP is not configured (`enabled === false`) sending is a no-op that
 *   logs at debug level — the API never fails a ticket operation because of
 *   mail.
 * - When `jsonTransport` is true (tests) messages are captured in `sent`
 *   instead of being delivered over the network.
 */
export class Mailer {
  private transport: Transporter | null = null
  readonly sent: CapturedMail[] = []

  constructor(private config: SmtpConfig) {
    if (config.jsonTransport) {
      this.transport = nodemailer.createTransport({ jsonTransport: true })
    } else if (config.enabled && config.host) {
      this.transport = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.tls && config.port === 465,
        auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined,
      })
    }
  }

  get enabled(): boolean {
    return this.transport !== null
  }

  async sendMail(input: { to: string; subject: string; text: string }): Promise<boolean> {
    if (!this.transport) {
      console.log(`[mailer] disabled, skipping mail to ${input.to}: ${input.subject}`)
      return false
    }
    if (!this.config.from) {
      console.warn('[mailer] DESKOS_SMTP_FROM not set; skipping mail')
      return false
    }
    try {
      const info = await this.transport.sendMail({
        from: this.config.from,
        to: input.to,
        subject: input.subject,
        text: input.text,
      })
      if (this.config.jsonTransport) {
        try {
          const raw = JSON.parse(info.message as string)
          this.sent.push({
            to: input.to,
            subject: input.subject,
            text: input.text,
            messageId: raw.messageId,
            raw,
          })
        } catch {
          this.sent.push({ to: input.to, subject: input.subject, text: input.text, raw: info.message })
        }
      }
      return true
    } catch (err) {
      console.error(`[mailer] send failed (${input.subject}):`, (err as Error).message)
      return false
    }
  }

  /** Human-readable email for a ticket thread message. */
  buildTicketMail(ctx: TicketMailContext, prefix?: string): { to: string; subject: string; text: string } {
    const subject = prefix
      ? `${prefix}: [${ctx.ticketNumber}] ${ctx.subject}`
      : ctx.subject.startsWith('Re:')
        ? ctx.subject
        : `Re: [${ctx.ticketNumber}] ${ctx.subject}`
    const text = [
      `Hi,`,
      ``,
      ctx.replyBody ?? ctx.body,
      ``,
      `— ${ctx.tenantName} IT Support`,
      ``,
      `Ticket #${ctx.ticketNumber}: ${ctx.subject}`,
      ``,
      `Reply to this email or visit your portal to update the request.`,
    ].join('\n')
    return { to: ctx.to, subject, text }
  }

  /** Email sent when a technician replies publicly to a ticket. */
  async sendReplyEmail(ctx: TicketMailContext): Promise<boolean> {
    return this.sendMail(this.buildTicketMail(ctx))
  }

  /** Email sent when a ticket is resolved. */
  async sendResolvedEmail(ctx: Omit<TicketMailContext, 'replyBody'>): Promise<boolean> {
    const { to, subject, text } = this.buildTicketMail(
      { ...ctx, body: `Your request is now resolved. If the issue persists, reply to reopen it.` },
      'Resolved',
    )
    return this.sendMail({ to, subject, text })
  }
}
