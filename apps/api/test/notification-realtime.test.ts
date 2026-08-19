import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { notifyInTxn, subscribeNotifications } from '../src/core/notify.js'
import { authHeaders, createTestApp, signupOwner } from './helpers.js'

describe('real-time notifications', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Realtime Notifications Org' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('publishes a committed notification to the matching subscriber', async () => {
    const received = new Promise<{ body: string; subjectId: string | null }>((resolve) => {
      const unsubscribe = subscribeNotifications(owner.tenantId!, owner.userId, (notification) => {
        if (notification.body === 'Realtime notification test') {
          unsubscribe()
          resolve({ body: notification.body, subjectId: notification.subjectId })
        }
      })
    })

    await notifyInTxn(app.db, owner.tenantId!, {
      userId: owner.userId,
      kind: 'ticket.replied',
      body: 'Realtime notification test',
      subjectType: 'ticket',
      subjectId: '00000000-0000-0000-0000-000000000001',
    })

    await expect(received).resolves.toEqual({
      body: 'Realtime notification test',
      subjectId: '00000000-0000-0000-0000-000000000001',
    })
  })
})
