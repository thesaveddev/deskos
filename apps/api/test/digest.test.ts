import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'
import { checkNeedsAttentionDigest, collectDigestContent } from '../src/modules/notifications/digest.js'

/**
 * Needs-attention digest: one combined email per owner/manager per day
 * summarising overdue KB reviews, upcoming asset expiries, and open device
 * alerts. The ledger dedupes per (tenant, recipient, day).
 */
describe('needs-attention digest', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let manager: Awaited<ReturnType<typeof seedActiveMember>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>

  const withTenant = async <T,>(fn: (client: import('../src/db/pool.js').DbClient) => Promise<T>): Promise<T> => {
    const { withTenant: wt } = await import('../src/db/pool.js')
    return wt(app.db, owner.tenantId!, fn)
  }

  beforeAll(async () => {
    app = await createTestApp({ REYDESK_SMTP_JSON: 'true', REYDESK_SMTP_FROM: 'ReyDesk <support@example.com>' })
    owner = await signupOwner(app, { tenantName: 'Digest Org' })
    manager = await seedActiveMember(app, owner.tenantId!, 'service_desk_manager')
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
  })

  afterAll(async () => {
    await app.close()
  })

  let articleId: string
  let deviceId: string

  it('empty tenant sends nothing', async () => {
    const before = app.mailer.sent.length
    const result = await checkNeedsAttentionDigest(app.db, app.emailQueue, app.mailer, 'https://reydesk.test')
    expect(app.mailer.sent.length).toBe(before)
    expect(result.recipients).toBe(0)
  })

  it('aggregates overdue review + upcoming expiry + open alert and emails owners/managers once per day', async () => {
    // Overdue KB review (published article, past review date).
    const createArticle = await app.inject({
      method: 'POST',
      url: '/api/v1/kb/articles',
      headers: authHeaders(manager),
      payload: { title: 'VPN setup guide', body: 'How to set up the VPN.' },
    })
    expect(createArticle.statusCode).toBe(201)
    articleId = createArticle.json().article.id as string
    const publish = await app.inject({
      method: 'POST',
      url: `/api/v1/kb/articles/${articleId}/status`,
      headers: authHeaders(manager),
      payload: { status: 'published' },
    })
    expect(publish.statusCode).toBe(200)
    await withTenant((client) => client.query(`UPDATE kb_articles SET review_due_at = now() - interval '2 days' WHERE id = $1`, [articleId]))

    // Asset with a warranty inside the 30-day window.
    const createAsset = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: authHeaders(manager),
      payload: {
        tag: 'LT-DIGEST',
        type: 'hardware',
        name: 'Digest laptop',
        warrantyUntil: new Date(Date.now() + 12 * 86_400_000).toISOString().slice(0, 10),
      },
    })
    expect(createAsset.statusCode).toBe(201)

    // Open device alert.
    const rotate = await app.inject({ method: 'POST', url: '/api/v1/devices/enrol-token/rotate', headers: authHeaders(owner) })
    expect(rotate.statusCode).toBe(201)
    const enrolToken = rotate.json().token as string
    const enrol = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/enrol',
      payload: { token: enrolToken, name: 'digest-box', hostname: 'digest-box', os: 'windows', osVersion: '11', arch: 'x64', ip: '10.0.0.9', agentVersion: '0.1.0' },
    })
    expect(enrol.statusCode).toBe(201)
    deviceId = enrol.json().device.id as string
    await withTenant((client) => client.query(
      `INSERT INTO device_alerts (tenant_id, device_id, kind, severity, message) VALUES ($1, $2, 'low_disk', 'warning', 'C: drive at 91% capacity')`,
      [owner.tenantId, deviceId],
    ))

    const content = await withTenant((client) => collectDigestContent(client))
    expect(content.reviews.map((r) => r.title)).toContain('VPN setup guide')
    expect(content.expiries.map((e) => e.tag)).toContain('LT-DIGEST')
    expect(content.alerts.map((a) => a.deviceName)).toContain('digest-box')

    const before = app.mailer.sent.length
    const result = await checkNeedsAttentionDigest(app.db, app.emailQueue, app.mailer, 'https://reydesk.test')

    // Exactly one digest email per eligible recipient (owner + manager, not analyst).
    const digestMails = app.mailer.sent.slice(before).filter((m) => m.subject.includes('attention'))
    expect(result.recipients).toBe(2)
    expect(digestMails).toHaveLength(2)
    const recipients = digestMails.map((m) => m.to).sort()
    expect(recipients).toEqual([owner.email, manager.email].sort())

    const mail = digestMails[0]
    expect(mail.subject).toContain('Digest Org')
    expect(mail.text).toContain('VPN setup guide')
    expect(mail.text).toContain('LT-DIGEST')
    expect(mail.text).toContain('digest-box')
    expect(mail.html).toContain('Overdue knowledge base reviews')
    expect(mail.html).toContain('Upcoming asset expiries')
    expect(mail.html).toContain('Open device alerts')
  })

  it('does not resend within the same day (ledger dedupe)', async () => {
    const before = app.mailer.sent.length
    const result = await checkNeedsAttentionDigest(app.db, app.emailQueue, app.mailer, 'https://reydesk.test')
    expect(result.recipients).toBe(0)
    expect(app.mailer.sent.slice(before).filter((m) => m.subject.includes('attention'))).toHaveLength(0)
  })

  it('an analyst is not a recipient even with items present', async () => {
    const rows = await withTenant((client) => client.query(
      `SELECT m.user_id FROM needs_attention_digests nd JOIN memberships m ON m.user_id = nd.recipient_id WHERE m.org_role = 'analyst'`,
    ))
    expect(rows.rows).toHaveLength(0)
  })

  it('resolving the alert and muting the asset empties those sections on the next day', async () => {
    await withTenant(async (client) => {
      await client.query(`UPDATE device_alerts SET resolved_at = now() WHERE device_id = $1`, [deviceId])
      await client.query(`UPDATE assets SET expiry_emails_muted = true WHERE tag = 'LT-DIGEST'`)
    })
    // Force a new digest day by backdating the ledger rows.
    await withTenant((client) => client.query(`UPDATE needs_attention_digests SET digest_date = CURRENT_DATE - 1`))

    const before = app.mailer.sent.length
    await checkNeedsAttentionDigest(app.db, app.emailQueue, app.mailer, 'https://reydesk.test')
    const mails = app.mailer.sent.slice(before).filter((m) => m.subject.includes('attention'))
    expect(mails.length).toBeGreaterThan(0)
    for (const mail of mails) {
      expect(mail.text).not.toContain('digest-box')
      expect(mail.text).not.toContain('LT-DIGEST')
      expect(mail.text).toContain('VPN setup guide') // review remains overdue
    }
  })
})
