import type { FastifyInstance } from 'fastify'
import { authenticate } from '../../middleware/authenticate.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import {
  listPlans, getSubscription, createSubscription, changePlan, cancelSubscription,
  listInvoices, listPaymentMethods, addPaymentMethod, removePaymentMethod, setDefaultPaymentMethod,
} from './billing.service.js'

export async function billingRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', requireTenant)

  // ── Plans (read-only, any authenticated user) ──

  app.get('/billing/plans', async (_req, reply) => {
    const plans = await listPlans(app.db)
    return reply.send({ plans })
  })

  // ── Subscription ──

  app.get('/billing/subscription', async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const subscription = await getSubscription(app.db, ctx.tenantId)
    return reply.send({ subscription })
  })

  app.post('/billing/subscription', { preHandler: requirePermission('billing.manage') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const body = (req.body || {}) as { plan?: string; billing_cycle?: string }
    const plan = body.plan || 'free'
    const cycle = body.billing_cycle === 'annual' ? 'annual' : 'monthly'
    const subscription = await createSubscription(app.db, ctx.tenantId, plan, cycle)
    return reply.code(201).send({ subscription })
  })

  app.patch('/billing/subscription', { preHandler: requirePermission('billing.manage') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const body = (req.body || {}) as { plan?: string }
    if (!body.plan) return reply.code(400).send({ error: 'plan is required' })
    const subscription = await changePlan(app.db, ctx.tenantId, body.plan)
    if (!subscription) return reply.code(404).send({ error: 'No active subscription found' })
    return reply.send({ subscription })
  })

  app.delete('/billing/subscription', { preHandler: requirePermission('billing.manage') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const canceled = await cancelSubscription(app.db, ctx.tenantId)
    if (!canceled) return reply.code(404).send({ error: 'No active subscription found' })
    return reply.send({ ok: true })
  })

  // ── Invoices ──

  app.get('/billing/invoices', async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const invoices = await listInvoices(app.db, ctx.tenantId)
    return reply.send({ invoices })
  })

  // ── Payment methods ──

  app.get('/billing/payment-methods', async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const methods = await listPaymentMethods(app.db, ctx.tenantId)
    return reply.send({ methods })
  })

  app.post('/billing/payment-methods', { preHandler: requirePermission('billing.manage') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const body = (req.body || {}) as { brand?: string; last4: string; exp_month?: number; exp_year?: number }
    if (!body.last4) return reply.code(400).send({ error: 'last4 is required' })
    const method = await addPaymentMethod(app.db, ctx.tenantId, body)
    return reply.code(201).send({ method })
  })

  app.delete('/billing/payment-methods/:id', { preHandler: requirePermission('billing.manage') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const { id } = req.params as { id: string }
    const removed = await removePaymentMethod(app.db, ctx.tenantId, Number(id))
    if (!removed) return reply.code(404).send({ error: 'Payment method not found' })
    return reply.send({ ok: true })
  })

  app.patch('/billing/payment-methods/:id/default', { preHandler: requirePermission('billing.manage') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const { id } = req.params as { id: string }
    const set = await setDefaultPaymentMethod(app.db, ctx.tenantId, Number(id))
    if (!set) return reply.code(404).send({ error: 'Payment method not found' })
    return reply.send({ ok: true })
  })
}
