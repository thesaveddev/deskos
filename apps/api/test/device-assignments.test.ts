import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

describe('device assignment lifecycle and asset identity', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let staff: Awaited<ReturnType<typeof seedActiveMember>>
  let deviceId: string
  let assignmentId: string

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Assignment Org' })
    staff = await seedActiveMember(app, owner.tenantId!, 'analyst')
    const rotated = await app.inject({ method: 'POST', url: '/api/v1/devices/enrol-token/rotate', headers: authHeaders(owner) })
    const enrolled = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/enrol',
      payload: { token: rotated.json().token, name: 'assigned-laptop', hostname: 'assigned-host', os: 'windows' },
    })
    expect(enrolled.statusCode).toBe(201)
    deviceId = enrolled.json().device.id
  })

  afterAll(async () => {
    await app.close()
  })

  it('assigns a device to staff and exposes current plus history', async () => {
    const assigned = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${deviceId}/assignments`,
      headers: authHeaders(owner),
      payload: {
        userId: staff.userId,
        assignmentStatus: 'assigned',
        department: 'Finance',
        location: 'Lagos',
        reason: 'New starter',
      },
    })
    expect(assigned.statusCode).toBe(201)
    assignmentId = assigned.json().assignment.id
    expect(assigned.json().assignment.assigned_by).toBe(owner.userId)

    const detail = await app.inject({ method: 'GET', url: `/api/v1/devices/${deviceId}/assignments`, headers: authHeaders(owner) })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().current.user_id).toBe(staff.userId)
    expect(detail.json().current.department).toBe('Finance')
    expect(detail.json().assignments).toHaveLength(1)
  })

  it('closes the current assignment when a shared-device transfer is made', async () => {
    const shared = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${deviceId}/assignments`,
      headers: authHeaders(owner),
      payload: { assignmentStatus: 'shared', department: 'Reception', reason: 'Front desk pool' },
    })
    expect(shared.statusCode).toBe(201)
    const detail = await app.inject({ method: 'GET', url: `/api/v1/devices/${deviceId}/assignments`, headers: authHeaders(owner) })
    expect(detail.json().current.assignment_status).toBe('shared')
    expect(detail.json().assignments).toHaveLength(2)
    expect(detail.json().assignments.find((item: { id: string }) => item.id === assignmentId).assignment_status).toBe('returned')
  })

  it('returns the shared device and creates a QR identity for linked assets', async () => {
    const current = await app.inject({ method: 'GET', url: `/api/v1/devices/${deviceId}/assignments`, headers: authHeaders(owner) })
    const currentId = current.json().current.id
    const returned = await app.inject({ method: 'POST', url: `/api/v1/devices/${deviceId}/assignments/${currentId}/return`, headers: authHeaders(owner), payload: { notes: 'Returned with charger' } })
    expect(returned.statusCode).toBe(200)

    const asset = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: authHeaders(owner),
      payload: { tag: 'ITL-LAP-000421', type: 'hardware', name: 'Assigned laptop', deviceId },
    })
    expect(asset.statusCode).toBe(201)
    expect(asset.json().asset.qr_payload).toContain('ITL-LAP-000421')
    expect(asset.json().asset.barcode_value).toBe('ITL-LAP-000421')

    const immutable = await app.inject({ method: 'PATCH', url: `/api/v1/assets/${asset.json().asset.id}`, headers: authHeaders(owner), payload: { tag: 'ITL-LAP-000999' } })
    expect(immutable.statusCode).toBe(400)
    expect(immutable.json().error.code).toBe('asset_tag_immutable')

    const licence = await app.inject({ method: 'POST', url: '/api/v1/licences', headers: authHeaders(owner), payload: { name: 'DeskOS Pro', seatsTotal: 5 } })
    expect(licence.statusCode).toBe(201)
    const licenceAssignment = await app.inject({ method: 'POST', url: `/api/v1/licences/${licence.json().licence.id}/assignments`, headers: authHeaders(owner), payload: { userId: staff.userId, reason: 'Finance role' } })
    expect(licenceAssignment.statusCode).toBe(201)
    const offboarding = await app.inject({ method: 'GET', url: `/api/v1/members/${staff.userId}/device-assignments`, headers: authHeaders(owner) })
    expect(offboarding.statusCode).toBe(200)
    expect(offboarding.json().assignedLicences).toHaveLength(1)
  })
})
