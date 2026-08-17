import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'
import { withTenant } from '../src/db/pool.js'
import { isEncryptedSecret } from '../src/core/crypto.js'
import type { AdClient } from '../src/modules/ad/ldap.js'

function makeMockClient(): AdClient {
  return {
    async listUsers() {
      return [
        { objectId: 'ad-user-1', upn: 'alice@corp.local', displayName: 'Alice Example', mail: 'alice@corp.local', department: 'Finance', accountEnabled: true },
        { objectId: 'ad-user-2', upn: 'bob@corp.local', displayName: 'Bob Example', mail: 'bob@corp.local', accountEnabled: false },
      ]
    },
    async runAccountAction(_connection, action, upn) {
      return `${action} applied to ${upn}`
    },
  }
}

describe('Active Directory integration', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>
  let endUser: Awaited<ReturnType<typeof seedActiveMember>>
  let foreign: Awaited<ReturnType<typeof signupOwner>>
  let connectionId: string

  beforeAll(async () => {
    app = await createTestApp({}, (instance) => {
      instance.decorate('adClient', makeMockClient())
    })
    owner = await signupOwner(app, { tenantName: 'AD Org' })
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
    endUser = await seedActiveMember(app, owner.tenantId!, 'end_user')
    foreign = await signupOwner(app, { tenantName: 'AD Foreign' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('enforces RBAC: end users denied, analysts read-only', async () => {
    const denied = await app.inject({ method: 'GET', url: '/api/v1/ad/connections', headers: authHeaders(endUser) })
    expect(denied.statusCode).toBe(403)

    const read = await app.inject({ method: 'GET', url: '/api/v1/ad/connections', headers: authHeaders(analyst) })
    expect(read.statusCode).toBe(200)
    expect(read.json().connections).toHaveLength(0)

    const write = await app.inject({
      method: 'POST',
      url: '/api/v1/ad/connections',
      headers: authHeaders(analyst),
      payload: { name: 'Corp', host: 'dc.corp.local', baseDn: 'DC=corp,DC=local', bindDn: 'CN=svc', bindPassword: 'secret' },
    })
    expect(write.statusCode).toBe(403)
  })

  it('creates a connection and never exposes the bind password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ad/connections',
      headers: authHeaders(owner),
      payload: { name: 'Corp', host: 'dc.corp.local', port: 636, useSsl: true, baseDn: 'DC=corp,DC=local', bindDn: 'CN=DeskOS', bindPassword: 'super-secret-bind' },
    })
    expect(res.statusCode).toBe(201)
    connectionId = res.json().id

    const stored = await withTenant(app.db, owner.tenantId!, (client) =>
      client.query('SELECT bind_password_enc FROM ad_connections WHERE id = $1', [connectionId]).then((r) => r.rows[0]),
    )
    expect(stored.bind_password_enc).not.toContain('super-secret-bind')
    expect(isEncryptedSecret(stored.bind_password_enc)).toBe(true)

    const list = await app.inject({ method: 'GET', url: '/api/v1/ad/connections', headers: authHeaders(owner) })
    const row = list.json().connections.find((c: { id: string }) => c.id === connectionId)
    expect(row.hasSecret).toBe(true)
    expect(JSON.stringify(row)).not.toContain('super-secret-bind')
  })

  it('tests and syncs the directory into contacts', async () => {
    const test = await app.inject({ method: 'POST', url: `/api/v1/ad/connections/${connectionId}/test`, headers: authHeaders(owner), payload: {} })
    expect(test.statusCode).toBe(200)
    expect(test.json()).toEqual({ ok: true, users: 2 })

    const sync = await app.inject({ method: 'POST', url: `/api/v1/ad/connections/${connectionId}/sync`, headers: authHeaders(owner), payload: {} })
    expect(sync.statusCode).toBe(200)
    expect(sync.json()).toEqual({ fetched: 2, created: 2, updated: 0 })

    const contacts = await app.inject({ method: 'GET', url: '/api/v1/ad/contacts', headers: authHeaders(owner) })
    expect(contacts.json().contacts).toHaveLength(2)
    const alice = contacts.json().contacts.find((c: { email: string }) => c.email === 'alice@corp.local')
    expect(alice.department).toBe('Finance')

    const sync2 = await app.inject({ method: 'POST', url: `/api/v1/ad/connections/${connectionId}/sync`, headers: authHeaders(owner), payload: {} })
    expect(sync2.json()).toEqual({ fetched: 2, created: 0, updated: 2 })
  })

  it('runs gated account actions and records them', async () => {
    const reset = await app.inject({
      method: 'POST',
      url: `/api/v1/ad/connections/${connectionId}/actions`,
      headers: authHeaders(owner),
      payload: { action: 'resetPassword', upn: 'alice@corp.local', newPassword: 'TempPass123!' },
    })
    expect(reset.statusCode).toBe(201)
    expect(reset.json().status).toBe('ok')
    expect(reset.json().detail).toContain('resetPassword')

    const unlock = await app.inject({
      method: 'POST',
      url: `/api/v1/ad/connections/${connectionId}/actions`,
      headers: authHeaders(owner),
      payload: { action: 'unlockAccount', upn: 'bob@corp.local' },
    })
    expect(unlock.statusCode).toBe(201)

    const actions = await app.inject({ method: 'GET', url: '/api/v1/ad/actions', headers: authHeaders(owner) })
    expect(actions.json().actions).toHaveLength(2)
  })

  it('isolates connections between tenants', async () => {
    const foreignList = await app.inject({ method: 'GET', url: '/api/v1/ad/connections', headers: authHeaders(foreign) })
    expect(foreignList.json().connections).toHaveLength(0)

    const foreignSync = await app.inject({ method: 'POST', url: `/api/v1/ad/connections/${connectionId}/sync`, headers: authHeaders(foreign), payload: {} })
    expect(foreignSync.statusCode).toBe(404)
  })
})
