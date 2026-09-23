import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AppError } from '../../core/errors.js'
import { authenticate } from '../../middleware/authenticate.js'

const contactSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(200),
  company: z.string().trim().max(200).optional(),
  subject: z.enum(['sales', 'support', 'billing', 'partnership', 'other']),
  message: z.string().trim().min(10).max(5000),
  // Honeypot: humans never see this field. Any non-empty value means a bot
  // filled the form — it must PASS validation (so the bot sees success) and
  // then be dropped in the handler without storing or mailing anything.
  website: z.string().max(500).optional(),
})

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

const SUBJECT_LABELS: Record<string, string> = {
  sales: 'Sales enquiry',
  support: 'Support enquiry',
  billing: 'Billing question',
  partnership: 'Partnership',
  other: 'General enquiry',
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export async function registerContactRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/contact',
    // No JSON-Schema on the route: this app validates bodies with Zod inside
    // the handler (a raw Zod object in `schema.body` breaks Fastify's compiler).
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const body = contactSchema.parse(req.body ?? {})

      // Honeypot tripped — accept silently without acting.
      if (body.website) {
        return reply.code(201).send({ ok: true })
      }

      const { firstName, lastName, email, subject, message } = body
      const company = body.company ?? null
      const ip = req.ip
      const userAgent = String(req.headers['user-agent'] ?? '').slice(0, 400)

      // Persist first so the enquiry survives an SMTP outage.
      await app.db.query(
        `INSERT INTO contact_messages (first_name, last_name, email, company, subject, message, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [firstName, lastName, email, company, subject, message, ip, userAgent]
      )

      const label = SUBJECT_LABELS[subject] ?? 'Enquiry'
      const plain = [
        `${firstName} ${lastName} <${email}>`,
        company ? `Company: ${company}` : null,
        `Subject: ${label}`,
        '',
        message,
        `IP: ${ip}`,
      ]
        .filter((line): line is string => line !== null)
        .join('\n')

      try {
        await app.emailQueue.addAndSend({
          to: app.config.contact.contactEmail,
          subject: `[ReyDesk contact] ${label} from ${firstName} ${lastName}`,
          text: plain,
          html: `<h2>${label}</h2><p><strong>From:</strong> ${escapeHtml(firstName)} ${escapeHtml(lastName)} &lt;${escapeHtml(email)}&gt;</p>${company ? `<p><strong>Company:</strong> ${escapeHtml(company)}</p>` : ''}<hr/><p style="white-space:pre-wrap">${escapeHtml(message)}</p><p style="color:#666;font-size:13px">IP: ${escapeHtml(ip)}</p>`,
        })
      } catch (err) {
        // The message is already persisted — a mail failure must not
        // surface to the visitor as an error.
        req.log.warn({ err }, 'contact message persisted but email delivery failed')
      }

      return reply.code(201).send({ ok: true })
    }
  )

  // Platform-admin listing so enquiries are visible even if email fails.
  app.get('/contact/messages', { preHandler: [authenticate] }, async (request) => {
    if (!request.user?.is_platform_admin) {
      throw AppError.forbidden('Platform admin access required')
    }
    const { limit } = listQuery.parse(request.query ?? {})
    const { rows } = await app.db.query(
      `SELECT id, first_name, last_name, email, company, subject, message, handled, created_at
       FROM contact_messages
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    )
    return { items: rows }
  })
}
