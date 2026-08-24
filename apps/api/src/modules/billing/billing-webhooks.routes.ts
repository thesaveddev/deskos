import type { FastifyInstance, FastifyRequest } from 'fastify'
import { PaystackGateway } from './paystack.js'
import { StripeGateway } from './stripe.js'
import type { WebhookEvent } from './gateway.js'
import { confirmGatewayCheckout, markCanceledByGatewaySubscription, markPaymentFailed } from './billing.service.js'

interface WebhookRequest extends FastifyRequest {
  rawBody?: string
}

/**
 * Gateway webhooks — intentionally unauthenticated, reachable only with a
 * provider-validated signature. Raw bodies are captured for HMAC checks.
 */
export async function billingWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      const request = _req as WebhookRequest
      request.rawBody = body as string
      done(null, JSON.parse(body as string))
    } catch (error) {
      done(error as Error)
    }
  })

  app.post('/billing/webhooks/paystack', async (request, reply) => {
    const raw = (request as WebhookRequest).rawBody ?? ''
    const signature = request.headers['x-paystack-signature']
    if (!raw || typeof signature !== 'string') return reply.code(400).send({ error: 'missing_signature' })

    const gateway = new PaystackGateway(app.config.billing.paystackSecretKey)
    const event = gateway.handleWebhook(raw, signature)
    if (!event) return reply.code(401).send({ error: 'invalid_signature' })

    await applyEvent(app, event, 'paystack')
    return reply.send({ received: true })
  })

  app.post('/billing/webhooks/stripe', async (request, reply) => {
    const raw = (request as WebhookRequest).rawBody ?? ''
    const signature = request.headers['stripe-signature']
    if (!raw || typeof signature !== 'string') return reply.code(400).send({ error: 'missing_signature' })

    const gateway = new StripeGateway(app.config.billing.stripeSecretKey, app.config.billing.stripeWebhookSecret)
    const event = gateway.handleWebhook(raw, signature)
    if (!event) return reply.code(401).send({ error: 'invalid_signature' })

    await applyEvent(app, event, 'stripe')
    return reply.send({ received: true })
  })
}

async function applyEvent(app: FastifyInstance, event: WebhookEvent, gateway: string): Promise<void> {
  switch (event.type) {
    case 'charge.success': {
      if (!event.reference || !event.verify.paid) return
      await confirmGatewayWebhook(app, event.reference, event.verify, gateway)
      return
    }
    case 'subscription.disable':
      await markCanceledByGatewaySubscription(app.db, event.subscriptionId, event.reason)
      return
    case 'subscription.payment_failed':
      if (event.subscriptionId) await markPaymentFailed(app.db, event.subscriptionId)
      return
  }
}

/** Activate the local subscription from a gateway confirmation. */
async function confirmGatewayWebhook(
  app: FastifyInstance,
  reference: string,
  verify: { paid: boolean; subscriptionId?: string; customerId?: string },
  gateway: string,
): Promise<void> {
  try {
    // `gateway` must be one of the values allowed by the invoices CHECK
    // constraint ('manual' | 'paystack' | 'stripe') or the UPDATE fails.
    await confirmGatewayCheckout(app.db, reference, verify, gateway)
  } catch (error) {
    app.log.error({ error, reference }, 'gateway webhook activation failed')
  }
}