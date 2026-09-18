import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'
import { checkAssetExpiryNotices } from '../src/modules/assets/expiry.js'

describe('assets & licences', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let manager: Awaited<ReturnType<typeof seedActiveMember>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>
  let endUser: Awaited<ReturnType<typeof seedActiveMember>>
  let foreignOwner: Awaited<ReturnType<typeof signupOwner>>

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Assets Org' })
    manager = await seedActiveMember(app, owner.tenantId!, 'service_desk_manager')
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
    endUser = await seedActiveMember(app, owner.tenantId!, 'end_user')
    foreignOwner = await signupOwner(app, { tenantName: 'Assets Foreign' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('end_user cannot read assets', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/assets', headers: authHeaders(endUser) })
    expect(res.statusCode).toBe(403)
  })

  it('analyst can read but cannot create assets', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/assets', headers: authHeaders(analyst) })
    expect(list.statusCode).toBe(200)

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: authHeaders(analyst),
      payload: { tag: 'LT-001', type: 'hardware', name: 'Laptop' },
    })
    expect(create.statusCode).toBe(403)
  })

  let assetId: string

  it('manager creates an asset with an owner link', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: authHeaders(manager),
      payload: {
        tag: 'LT-001',
        type: 'hardware',
        name: 'Engineering laptop',
        status: 'in_use',
        ownerId: analyst.userId,
        location: 'HQ-2F',
        supplier: 'Dell',
        warrantyUntil: '2027-01-01',
      },
    })
    expect(res.statusCode).toBe(201)
    assetId = res.json().asset.id
    expect(res.json().asset.tag).toBe('LT-001')
    expect(res.json().asset.owner_id).toBe(analyst.userId)
  })

  it('duplicate asset tag is rejected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: authHeaders(manager),
      payload: { tag: 'LT-001', type: 'hardware', name: 'Duplicate' },
    })
    expect(res.statusCode).toBe(409)
  })

  it('owner must be a tenant member', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: authHeaders(manager),
      payload: { tag: 'LT-002', type: 'hardware', name: 'Bad owner', ownerId: foreignOwner.userId },
    })
    expect(res.statusCode).toBe(400)
  })

  it('linking a non-existent device is rejected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: authHeaders(manager),
      payload: {
        tag: 'LT-003',
        type: 'hardware',
        name: 'Bad device',
        deviceId: '00000000-0000-4000-8000-000000000000',
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('assets are searchable and filterable', async () => {
    const search = await app.inject({ method: 'GET', url: '/api/v1/assets?q=Engineering', headers: authHeaders(manager) })
    expect(search.json().assets.length).toBe(1)

    const filtered = await app.inject({ method: 'GET', url: '/api/v1/assets?type=hardware', headers: authHeaders(manager) })
    expect(filtered.json().assets.length).toBe(1)

    const none = await app.inject({ method: 'GET', url: '/api/v1/assets?type=mobile', headers: authHeaders(manager) })
    expect(none.json().assets).toHaveLength(0)
  })

  let licenceId: string

  it('manager creates a licence linked to the asset', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/licences',
      headers: authHeaders(manager),
      payload: { assetId, name: 'Windows 11 Pro', keyRef: 'ref-123', seatsTotal: 25, seatsUsed: 10, expiresAt: '2027-06-30' },
    })
    expect(res.statusCode).toBe(201)
    licenceId = res.json().licence.id
    expect(res.json().licence.asset_id).toBe(assetId)
  })

  it('asset detail returns its licences', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${assetId}`, headers: authHeaders(manager) })
    expect(res.statusCode).toBe(200)
    expect(res.json().licences).toHaveLength(1)
    expect(res.json().licences[0].name).toBe('Windows 11 Pro')
  })

  it('manager updates a licence', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/licences/${licenceId}`,
      headers: authHeaders(manager),
      payload: { seatsUsed: 11 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().licence.seats_used).toBe(11)
  })

  it('assets and licences are tenant-isolated', async () => {
    const steal = await app.inject({ method: 'GET', url: `/api/v1/assets/${assetId}`, headers: authHeaders(foreignOwner) })
    expect(steal.statusCode).toBe(404)

    const list = await app.inject({ method: 'GET', url: '/api/v1/assets', headers: authHeaders(foreignOwner) })
    expect(list.json().assets).toHaveLength(0)

    const licences = await app.inject({ method: 'GET', url: '/api/v1/licences', headers: authHeaders(foreignOwner) })
    expect(licences.json().licences).toHaveLength(0)
  })

  it('asset with a linked licence cannot be deleted until the licence is removed', async () => {
    // The main flow deleted its asset; build a fresh one for this guard.
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: authHeaders(manager),
      payload: { tag: 'LT-GUARD', type: 'hardware', name: 'Guard laptop' },
    })
    expect(create.statusCode).toBe(201)
    const guardedAssetId = create.json().asset.id as string

    const licence = await app.inject({
      method: 'POST',
      url: '/api/v1/licences',
      headers: authHeaders(manager),
      payload: { assetId: guardedAssetId, name: 'Guard licence', seatsTotal: 5 },
    })
    expect(licence.statusCode).toBe(201)

    const blocked = await app.inject({ method: 'DELETE', url: `/api/v1/assets/${guardedAssetId}`, headers: authHeaders(manager) })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().error?.code ?? blocked.json().code).toBe('asset_has_licences')

    // Once the licence is gone, deletion succeeds.
    await app.inject({ method: 'DELETE', url: `/api/v1/licences/${licence.json().licence.id}`, headers: authHeaders(manager) })
    const allowed = await app.inject({ method: 'DELETE', url: `/api/v1/assets/${guardedAssetId}`, headers: authHeaders(manager) })
    expect(allowed.statusCode).toBe(200)
  })

  it('seatsUsed cannot be set below currently assigned seats', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/licences',
      headers: authHeaders(manager),
      payload: { name: 'Seats guard licence', seatsTotal: 10 },
    })
    const seatsLicenceId = create.json().licence.id as string

    const assign = await app.inject({
      method: 'POST',
      url: `/api/v1/licences/${seatsLicenceId}/assignments`,
      headers: authHeaders(manager),
      payload: { userId: analyst.userId, seats: 2 },
    })
    expect(assign.statusCode).toBe(201)

    const undercut = await app.inject({
      method: 'PATCH',
      url: `/api/v1/licences/${seatsLicenceId}`,
      headers: authHeaders(manager),
      payload: { seatsUsed: 1 },
    })
    expect(undercut.statusCode).toBe(409)

    // Raising above the assigned floor is fine.
    const raise = await app.inject({
      method: 'PATCH',
      url: `/api/v1/licences/${seatsLicenceId}`,
      headers: authHeaders(manager),
      payload: { seatsUsed: 3 },
    })
    expect(raise.statusCode).toBe(200)
    expect(raise.json().licence.seats_used).toBe(3)
  })

  it('warranty watch lists soon-expiring warranties and licence expiries', async () => {
    const soon = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10)
    const far = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10)

    await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: authHeaders(manager),
      payload: { tag: 'LT-WARR', type: 'hardware', name: 'Warranty laptop', warrantyUntil: soon },
    })
    await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: authHeaders(manager),
      payload: { tag: 'LT-WARR-FAR', type: 'hardware', name: 'Far warranty laptop', warrantyUntil: far },
    })
    await app.inject({
      method: 'POST',
      url: '/api/v1/licences',
      headers: authHeaders(manager),
      payload: { name: 'Soon licence', seatsTotal: 5, expiresAt: soon },
    })

    const res = await app.inject({ method: 'GET', url: '/api/v1/assets/warranties?days=90', headers: authHeaders(manager) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.warranties.some((w: { tag: string }) => w.tag === 'LT-WARR')).toBe(true)
    expect(body.warranties.some((w: { tag: string }) => w.tag === 'LT-WARR-FAR')).toBe(false)
    expect(body.licences.some((l: { name: string }) => l.name === 'Soon licence')).toBe(true)
  })

  it('manager deletes the licence and asset', async () => {
    const delLicence = await app.inject({ method: 'DELETE', url: `/api/v1/licences/${licenceId}`, headers: authHeaders(manager) })
    expect(delLicence.statusCode).toBe(200)

    const delAsset = await app.inject({ method: 'DELETE', url: `/api/v1/assets/${assetId}`, headers: authHeaders(manager) })
    expect(delAsset.statusCode).toBe(200)
  })

  describe('expiry notices', () => {
    let emailApp: FastifyInstance
    let expOwner: Awaited<ReturnType<typeof signupOwner>>
    let expManager: Awaited<ReturnType<typeof seedActiveMember>>
    let expAnalyst: Awaited<ReturnType<typeof seedActiveMember>>

    beforeAll(async () => {
      emailApp = await createTestApp({ REYDESK_SMTP_JSON: 'true', REYDESK_SMTP_FROM: 'ReyDesk <support@example.com>' })
      expOwner = await signupOwner(emailApp, { tenantName: 'Expiry Org' })
      expManager = await seedActiveMember(emailApp, expOwner.tenantId!, 'service_desk_manager')
      expAnalyst = await seedActiveMember(emailApp, expOwner.tenantId!, 'analyst')
    })

    afterAll(async () => {
      await emailApp.close()
    })

    const soonDate = () => new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10)
    const noticesFor = async (assetId: string) => {
      const { withTenant: wt } = await import('../src/db/pool.js')
      return wt(emailApp.db, expOwner.tenantId!, (client) => client.query(
        `SELECT count(*)::int AS n FROM notifications WHERE kind = 'asset.warranty_expiry' AND subject_id = $1`,
        [assetId],
      )).then((r) => r.rows[0].n as number)
    }

    it('notifies the owner once per due date, in-app and by email', async () => {
      const due = soonDate()
      const create = await emailApp.inject({
        method: 'POST',
        url: '/api/v1/assets',
        headers: authHeaders(expManager),
        payload: { tag: 'LT-EXPIRY', type: 'hardware', name: 'Expiry laptop', ownerId: expAnalyst.userId, warrantyUntil: due },
      })
      expect(create.statusCode).toBe(201)
      const expiringAssetId = create.json().asset.id as string

      await checkAssetExpiryNotices(emailApp.db, emailApp.emailQueue, emailApp.mailer, 'https://reydesk.test')

      // One in-app notification for the owner.
      expect(await noticesFor(expiringAssetId)).toBe(1)
      // One queued email carrying the asset tag and due date.
      const mails = emailApp.mailer.sent.filter((m) => m.subject.includes('LT-EXPIRY'))
      expect(mails).toHaveLength(1)
      expect(mails[0].text).toContain(due)

      // A second sweep is a no-op — the due date already notified.
      await checkAssetExpiryNotices(emailApp.db, emailApp.emailQueue, emailApp.mailer, 'https://reydesk.test')
      expect(await noticesFor(expiringAssetId)).toBe(1)
      expect(emailApp.mailer.sent.filter((m) => m.subject.includes('LT-EXPIRY'))).toHaveLength(1)
    })

    it('honours the tenant opt-out for expiry emails', async () => {
      const due = soonDate()
      const create = await emailApp.inject({
        method: 'POST',
        url: '/api/v1/assets',
        headers: authHeaders(expManager),
        payload: { tag: 'LT-QUIET', type: 'hardware', name: 'Quiet laptop', ownerId: expAnalyst.userId, warrantyUntil: due },
      })
      expect(create.statusCode).toBe(201)
      const quietAssetId = create.json().asset.id as string

      const patch = await emailApp.inject({
        method: 'PATCH',
        url: '/api/v1/tenant/settings',
        headers: authHeaders(expOwner),
        payload: { assets: { warranty_expiry_emails: false } },
      })
      expect(patch.statusCode).toBe(200)

      await checkAssetExpiryNotices(emailApp.db, emailApp.emailQueue, emailApp.mailer, 'https://reydesk.test')
      expect(await noticesFor(quietAssetId)).toBe(0)
      expect(emailApp.mailer.sent.filter((m) => m.subject.includes('LT-QUIET'))).toHaveLength(0)

      // Ledger stays empty for the opted-out asset — re-enabling re-arms it.
      const { withTenant: wt } = await import('../src/db/pool.js')
      const ledger = await wt(emailApp.db, expOwner.tenantId!, (client) => client.query(
        `SELECT count(*)::int AS n FROM asset_expiry_notices WHERE asset_id = $1`,
        [quietAssetId],
      ))
      expect(ledger.rows[0].n).toBe(0)
    })
  })
})
