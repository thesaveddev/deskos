import { createHmac } from 'node:crypto'
import {
  type CheckoutInput, type CheckoutResult, type GatewayMethod, type GatewayMethodInfo,
  type PaymentGateway, type VerifyResult, type WebhookEvent,
} from './gateway.js'

const API = 'https://api.paystack.co'

interface PaystackTransaction {
  status: string
  reference: string
  amount?: number
  currency?: string
  plan?: { plan_code: string }
  subscription?: { subscription_code: string }
  customer?: { customer_code: string }
  authorization?: {
    authorization_code: string
    channel: string
    card_type?: string
    bank?: string
    last4?: string
    exp_month?: number
    exp_year?: number
    reusable: boolean
  }
}

const LOCAL_METHODS = new Set(['card', 'bank_transfer', 'ussd', 'mobile_money', 'apple_pay', 'google_pay'])

function gatewayMethodOf(channel: string | undefined): Exclude<GatewayMethod, 'manual'> {
  return channel && LOCAL_METHODS.has(channel as Exclude<GatewayMethod, 'manual'>)
    ? channel as Exclude<GatewayMethod, 'manual'>
    : 'card'
}

function methodFromAuthorization(authorization: NonNullable<PaystackTransaction['authorization']>): NonNullable<VerifyResult['method']> {
  return {
    gatewayMethod: gatewayMethodOf(authorization.channel),
    brand: authorization.card_type || authorization.bank || 'Card',
    last4: authorization.last4 ?? '',
    expMonth: authorization.exp_month,
    expYear: authorization.exp_year,
    externalId: authorization.authorization_code,
  }
}

/**
 * Paystack provider. Hosted checkout via `transaction/initialize` with a plan
 * code, so a successful payment automatically creates a Paystack subscription
 * (auto-recurring). Webhooks are validated with HMAC-SHA512.
 */
export class PaystackGateway implements PaymentGateway {
  readonly slug = 'paystack' as const
  readonly label = 'Paystack'
  readonly enabled: boolean

  constructor(private readonly secretKey: string) {
    this.enabled = Boolean(secretKey)
  }

  methods(): GatewayMethodInfo[] {
    return [
      { id: 'card', label: 'Card', description: 'Debit or credit card (Visa, Mastercard, Verve).' },
      { id: 'bank_transfer', label: 'Bank transfer', description: 'Pay via instant bank transfer — no card needed.' },
      { id: 'ussd', label: 'USSD', description: 'Pay with any phone using a USSD code.', note: 'Nigeria' },
      { id: 'mobile_money', label: 'Mobile money', description: 'M-Pesa, MoMo and mobile wallets.', note: 'Kenya, Tanzania, Ghana, Rwanda, Uganda' },
      { id: 'apple_pay', label: 'Apple Pay', description: 'Fast checkout on iOS and Safari.' },
      { id: 'google_pay', label: 'Google Pay', description: 'Fast checkout on Android and Chrome.' },
    ]
  }

  private async request<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const json = (await res.json()) as { status?: boolean; message?: string; data?: T }
    if (!res.ok || json.status === false) {
      throw new Error(`Paystack error: ${json.message ?? res.statusText}`)
    }
    return json.data as T
  }

  private planCode(planSlug: string, cycle: 'monthly' | 'annual', currency: string): string {
    return `reydesk_${planSlug}_${cycle}_${currency.toUpperCase()}`
  }

  private async ensurePlan(input: CheckoutInput): Promise<string> {
    const code = this.planCode(input.planSlug, input.billingCycle, input.currency)
    try {
      const existing = await this.request<{ plan_code: string }>('GET', `/plan/${code}`)
      return existing.plan_code
    } catch {
      const created = await this.request<{ plan_code: string }>('POST', '/plan', {
        name: `ReyDesk ${input.planName} (${input.billingCycle})`,
        amount: input.amountCents,
        interval: input.billingCycle === 'annual' ? 'annually' : 'monthly',
        currency: input.currency,
        plan_code: code,
      })
      return created.plan_code
    }
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
    const plan = await this.ensurePlan(input)
    const data = await this.request<{ authorization_url: string; reference: string }>(
      'POST',
      '/transaction/initialize',
      {
        email: input.email,
        amount: input.amountCents,
        currency: input.currency,
        plan,
        reference: input.reference,
        callback_url: input.callbackUrl,
        metadata: {
          tenant_id: input.tenantId,
          plan_slug: input.planSlug,
          billing_cycle: input.billingCycle,
          reydesk: true,
        },
      },
    )
    if (data.reference !== input.reference) {
      throw new Error('Paystack returned an unexpected reference')
    }
    return { url: data.authorization_url, checkoutId: data.reference }
  }

  async verify(reference: string): Promise<VerifyResult> {
    const data = await this.request<PaystackTransaction>('GET', `/transaction/verify/${encodeURIComponent(reference)}`)
    if (data.status !== 'success') return { paid: false }

    return {
      paid: true,
      subscriptionId: data.plan?.plan_code,
      customerId: data.customer?.customer_code,
      method: data.authorization?.reusable ? methodFromAuthorization(data.authorization) : undefined,
    }
  }

  handleWebhook(rawBody: string, signature: string): WebhookEvent | null {
    const hmac = createHmac('sha512', this.secretKey).update(rawBody).digest('hex')
    if (signature !== hmac) return null
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>
    } catch {
      return null
    }
    const event = payload.event as string
    const data = (payload.data ?? {}) as Record<string, unknown>

    if (event === 'charge.success') {
      return {
        type: 'charge.success',
        reference: data.reference as string,
        verify: this.verifyResultFromWebhook(data),
      }
    }
    if (event === 'subscription.disable' || event === 'subscription.expiring') {
      return {
        type: 'subscription.disable',
        subscriptionId: String(data.subscription_code ?? data.plan_code ?? ''),
        reason: event === 'subscription.expiring' ? 'expiring' : 'disabled',
      }
    }
    if (event === 'invoice.payment_failed') {
      return {
        type: 'subscription.payment_failed',
        subscriptionId: String(data.subscription_code ?? ''),
        invoiceReference: data.invoice_reference ? String(data.invoice_reference) : undefined,
      }
    }
    return { type: 'unknown', raw: event }
  }

  private verifyResultFromWebhook(data: Record<string, unknown>): VerifyResult {
    const authorization = (data.authorization ?? {}) as Record<string, unknown>
    const plan = (data.plan ?? {}) as Record<string, unknown>
    const customer = (data.customer ?? {}) as Record<string, unknown>
    // Subscription events carry the real `subscription.subscription_code`;
    // transaction-responses only expose the plan code (PLN_…) which cannot be
    // disabled. Prefer the subscription code so auto-renewal cancels work.
    const subscription = (data.subscription ?? {}) as Record<string, unknown>
    const subscriptionCode = typeof subscription.subscription_code === 'string' ? subscription.subscription_code : undefined
    const channel = typeof authorization.channel === 'string' ? authorization.channel : 'card'
    const reusable = authorization.reusable === true
    return {
      paid: true,
      subscriptionId: subscriptionCode ?? (plan.plan_code ? String(plan.plan_code) : undefined),
      customerId: customer.customer_code ? String(customer.customer_code) : undefined,
      method: reusable ? {
        gatewayMethod: gatewayMethodOf(channel),
        brand: String(authorization.card_type ?? authorization.bank ?? 'Card'),
        last4: authorization.last4 ? String(authorization.last4) : '',
        expMonth: typeof authorization.exp_month === 'number' ? authorization.exp_month : undefined,
        expYear: typeof authorization.exp_year === 'number' ? authorization.exp_year : undefined,
        externalId: String(authorization.authorization_code ?? ''),
      } : undefined,
    }
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    if (subscriptionId.startsWith('PLN_')) {
      // Plan-code-only sub (pre-subscription); nothing active to cancel.
      return
    }
    await this.request('POST', `/subscription/${encodeURIComponent(subscriptionId)}/disable`, { code: subscriptionId })
  }
}