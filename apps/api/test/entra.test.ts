import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'
import { withTenant } from '../src/db/pool.js'
import { isEncryptedSecret } from '../src/core/crypto.js'
import type { EntraGraphClient, EntraUser } from '../src/modules/entra/graph.js'

function makeMockGraph(users: EntraUser[]): EntraGraphClient {
  return {
    async listUsers() {
      return users
    },
    async listDevices() {
      return [
        {
          objectId: 'intune-device-1',
          name: 'LAPTOP-01',
          os: 'Windows',
          osVersion: '11 23H2',
          serialNumber: 'SN123',
          manufacturer: 'Dell',
          model: 'Latitude 5540',
          lastSyncDateTime: new Date().toISOString(),
        },
      ]
    },
    async runAccountAction(_connection, action, upn, _newPassword) {
      return `${action} applied to ${upn}`
    },
  }
}

describe('Entra / Microsoft 365 integration', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>
  let foreignOwner: Awaited<ReturnType<typeof signupOwner>>
  let connectionId: string

  beforeAll(async () => {
    app = await createTestApp({}, (instance) => {
      instance.decorate('entraGraph', makeMockGraph([
        {
          objectId: 'azure-user-1',
          upn: 'alice@contoso.com',
          displayName: 'Alice Example',
          mail: 'alice@contoso.com',
          department: 'Finance',
          jobTitle: 'Financial Controller',
          employeeId: 'EMP-001',
          accountEnabled: true,
        },
        {
          objectId: 'azure-user-2',
          upn: 'bob@contoso.com',
          displayName: 'Bob Example',
          mail: 'bob@contoso.com',
          accountEnabled: false,
        },
      ]))
    })
    owner = await signupOwner(app, { tenantName: 'Entra Org' })
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
    foreignOwner = await signupOwner(app, { tenantName: 'Entra Foreign' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('analysts can read connections but cannot manage them', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/entra/connections', headers: authHeaders(analyst) })
    expect(list.statusCode).toBe(200)
    expect(list.json().connections).toHaveLength(0)

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/entra/connections',
      headers: authHeaders(analyst),
      payload: { name: 'Contoso', azureTenantId: 't', clientId: 'c', clientSecret: 's' },
    })
    expect(create.statusCode).toBe(403)
  })

  it('creates a connection and never exposes the secret', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/entra/connections',
      headers: authHeaders(owner),
      payload: { name: 'Contoso', azureTenantId: 'tenant-guid', clientId: 'client-guid', clientSecret: 'super-secret-value' },
    })
    expect(res.statusCode).toBe(201)
    connectionId = res.json().id

    const stored = await withTenant(app.db, owner.tenantId!, (client) =>
      client.query('SELECT client_secret_enc FROM entra_connections WHERE id = $1', [connectionId]).then((r) => r.rows[0]),
    )
    expect(stored.client_secret_enc).not.toContain('super-secret-value')
    expect(isEncryptedSecret(stored.client_secret_enc)).toBe(true)

    const list = await app.inject({ method: 'GET', url: '/api/v1/entra/connections', headers: authHeaders(owner) })
    expect(list.statusCode).toBe(200)
    const row = list.json().connections.find((c: { id: string }) => c.id === connectionId)
    expect(row).toBeTruthy()
    expect(row.hasSecret).toBe(true)
    expect(row.clientSecretMasked).not.toContain('super-secret-value')
  })

  it('tests and syncs the directory into contacts', async () => {
    const test = await app.inject({ method: 'POST', url: `/api/v1/entra/connections/${connectionId}/test`, headers: authHeaders(owner), payload: {} })
    expect(test.statusCode).toBe(200)
    expect(test.json().ok).toBe(true)
    expect(test.json().users).toBe(2)

    const sync = await app.inject({ method: 'POST', url: `/api/v1/entra/connections/${connectionId}/sync`, headers: authHeaders(owner), payload: {} })
    expect(sync.statusCode).toBe(200)
    expect(sync.json()).toEqual({ fetched: 2, created: 2, updated: 0 })

    const contacts = await app.inject({ method: 'GET', url: '/api/v1/entra/contacts', headers: authHeaders(owner) })
    expect(contacts.statusCode).toBe(200)
    expect(contacts.json().contacts).toHaveLength(2)
    const alice = contacts.json().contacts.find((c: { email: string }) => c.email === 'alice@contoso.com')
    expect(alice.department).toBe('Finance')
    expect(alice.account_status).toBe('active')

    // A second sync updates rather than duplicates.
    const sync2 = await app.inject({ method: 'POST', url: `/api/v1/entra/connections/${connectionId}/sync`, headers: authHeaders(owner), payload: {} })
    expect(sync2.statusCode).toBe(200)
    expect(sync2.json()).toEqual({ fetched: 2, created: 0, updated: 2 })
  })

  it('syncs directory devices and finds contacts by staff id', async () => {
    const deviceSync = await app.inject({ method: 'POST', url: `/api/v1/entra/connections/${connectionId}/sync-devices`, headers: authHeaders(owner), payload: {} })
    expect(deviceSync.statusCode).toBe(200)
    expect(deviceSync.json()).toEqual({ fetched: 1, created: 1, updated: 0 })

    const devices = await app.inject({ method: 'GET', url: '/api/v1/devices', headers: authHeaders(owner) })
    expect(devices.statusCode).toBe(200)
    const synced = devices.json().devices.find((d: { name: string }) => d.name === 'LAPTOP-01')
    expect(synced).toBeTruthy()
    expect(synced.source).toBe('directory')
    expect(synced.managed_by).toBe('intune')
    expect(synced.serial_number).toBe('SN123')

    // A second device sync updates rather than duplicates.
    const deviceSync2 = await app.inject({ method: 'POST', url: `/api/v1/entra/connections/${connectionId}/sync-devices`, headers: authHeaders(owner), payload: {} })
    expect(deviceSync2.json()).toEqual({ fetched: 1, created: 0, updated: 1 })

    const search = await app.inject({ method: 'GET', url: '/api/v1/directory/search?q=EMP-001', headers: authHeaders(owner) })
    expect(search.statusCode).toBe(200)
    const hit = search.json().contacts.find((c: { email: string }) => c.email === 'alice@contoso.com')
    expect(hit).toBeTruthy()
    expect(hit.staffId).toBe('EMP-001')
    expect(hit.jobTitle).toBe('Financial Controller')
  })

  it('runs gated account actions and records them', async () => {
    const reset = await app.inject({
      method: 'POST',
      url: `/api/v1/entra/connections/${connectionId}/actions`,
      headers: authHeaders(owner),
      payload: { action: 'resetPassword', upn: 'alice@contoso.com', newPassword: 'TempPass123!' },
    })
    expect(reset.statusCode).toBe(201)
    expect(reset.json().status).toBe('ok')
    expect(reset.json().detail).toContain('resetPassword')

    const requireMfa = await app.inject({
      method: 'POST',
      url: `/api/v1/entra/connections/${connectionId}/actions`,
      headers: authHeaders(owner),
      payload: { action: 'requireMfa', upn: 'bob@contoso.com' },
    })
    expect(requireMfa.statusCode).toBe(201)

    const actions = await app.inject({ method: 'GET', url: '/api/v1/entra/actions', headers: authHeaders(owner) })
    expect(actions.statusCode).toBe(200)
    expect(actions.json().actions).toHaveLength(2)
  })

  it('isolates connections between tenants', async () => {
    const foreignList = await app.inject({ method: 'GET', url: '/api/v1/entra/connections', headers: authHeaders(foreignOwner) })
    expect(foreignList.statusCode).toBe(200)
    expect(foreignList.json().connections).toHaveLength(0)

    const foreignSync = await app.inject({ method: 'POST', url: `/api/v1/entra/connections/${connectionId}/sync`, headers: authHeaders(foreignOwner), payload: {} })
    expect(foreignSync.statusCode).toBe(404)
  })

  it('deletes a connection', async () => {
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/entra/connections/${connectionId}`, headers: authHeaders(owner) })
    expect(del.statusCode).toBe(200)
    const list = await app.inject({ method: 'GET', url: '/api/v1/entra/connections', headers: authHeaders(owner) })
    expect(list.json().connections).toHaveLength(0)
  })
})
