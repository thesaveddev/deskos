import type { Mailer, EmailMessage } from './mailer.js'

export interface EmailJob {
  id: string
  to: string
  subject: string
  text: string
  html?: string
  retries: number
  maxRetries: number
  createdAt: Date
  lastAttemptAt?: Date
  lastError?: string
  status: 'pending' | 'processing' | 'sent' | 'failed' | 'dead'
}

export type EmailJobInput = Omit<EmailJob, 'id' | 'retries' | 'maxRetries' | 'createdAt' | 'status'>

export interface EmailQueueStats {
  sent: number
  failed: number
  dead: number
  pending: number
  processing: number
  total: number
  lastFailure: string | null
}

/**
 * Small process-local delivery queue. It owns the first delivery attempt
 * instead of relying on callers to remember to drain it.
 */
export class EmailQueue {
  private queue: EmailJob[] = []
  private processing = false
  private drainTimer: NodeJS.Timeout | null = null
  private drainPromise: Promise<{ sent: number; failed: number }> | null = null
  private stats = { sent: 0, failed: 0, dead: 0 }
  private lastFailure: string | null = null

  constructor(
    private mailer: Mailer,
    private options: { maxRetries?: number; retryDelayMs?: number; batchSize?: number } = {},
  ) {
    this.options.maxRetries ??= 3
    this.options.retryDelayMs ??= 5_000
    this.options.batchSize ??= 5
  }

  add(input: EmailJobInput | EmailMessage): string {
    const id = `email_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const job: EmailJob = {
      id,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      retries: 0,
      maxRetries: this.options.maxRetries!,
      createdAt: new Date(),
      status: 'pending',
    }
    this.queue.push(job)
    console.log(`[email-queue] queued: ${job.id} → ${job.to} (${job.subject})`)
    this.scheduleDrain(0)
    return id
  }

  async addAndSend(input: EmailJobInput | EmailMessage): Promise<string> {
    const id = this.add(input)
    await this.drain()
    return id
  }

  async drain(): Promise<{ sent: number; failed: number }> {
    if (this.drainPromise) return this.drainPromise
    this.drainPromise = this.runDrain()
    try {
      return await this.drainPromise
    } finally {
      this.drainPromise = null
    }
  }

  private async runDrain(): Promise<{ sent: number; failed: number }> {
    if (this.processing) return { sent: 0, failed: 0 }
    this.processing = true
    const pending = this.queue.filter((job) => job.status === 'pending').slice(0, this.options.batchSize!)
    let sent = 0
    let failed = 0

    for (const job of pending) {
      job.status = 'processing'
      job.lastAttemptAt = new Date()
      try {
        const ok = await this.mailer.sendMail({ to: job.to, subject: job.subject, text: job.text, html: job.html })
        if (ok) {
          job.status = 'sent'
          this.stats.sent += 1
          sent += 1
        } else {
          this.retryOrDead(job, this.mailer.status.lastError ?? 'Mailer returned false')
          failed += 1
        }
      } catch (err) {
        this.retryOrDead(job, err instanceof Error ? err.message : 'Unknown email delivery error')
        failed += 1
      }
    }

    this.processing = false
    if (sent + failed > 0) console.log(`[email-queue] drained: ${sent} sent, ${failed} failed, ${this.queue.length} total`)
    return { sent, failed }
  }

  getStats(): EmailQueueStats {
    return {
      ...this.stats,
      pending: this.queue.filter((job) => job.status === 'pending').length,
      processing: this.queue.filter((job) => job.status === 'processing').length,
      total: this.queue.length,
      lastFailure: this.lastFailure,
    }
  }

  getJob(jobId: string): EmailJob | undefined {
    return this.queue.find((job) => job.id === jobId)
  }

  getDeadLetters(): EmailJob[] {
    return this.queue.filter((job) => job.status === 'dead')
  }

  retryJob(jobId: string): boolean {
    const job = this.queue.find((item) => item.id === jobId && item.status === 'dead')
    if (!job) return false
    job.status = 'pending'
    job.retries = 0
    job.lastError = undefined
    this.scheduleDrain(0)
    return true
  }

  purge(): number {
    const before = this.queue.length
    this.queue = this.queue.filter((job) => job.status === 'pending' || job.status === 'processing')
    return before - this.queue.length
  }

  private retryOrDead(job: EmailJob, error: string): void {
    job.retries += 1
    job.lastError = error
    this.stats.failed += 1
    this.lastFailure = `${job.id}: ${error}`
    const configurationError = error === 'SMTP transport is not configured' || error === 'REYDESK_SMTP_FROM (or legacy DESKOS_SMTP_FROM) is not configured' || error === 'DESKOS_SMTP_FROM is not configured'
    if (configurationError || job.retries >= job.maxRetries) {
      job.status = 'dead'
      this.stats.dead += 1
      console.error(`[email-queue] dead letter: ${job.id} → ${job.to} (${error})`)
      return
    }
    job.status = 'pending'
    const delay = this.options.retryDelayMs! * 2 ** Math.max(0, job.retries - 1)
    console.warn(`[email-queue] retry ${job.retries}/${job.maxRetries} in ${delay}ms: ${job.id} (${error})`)
    this.scheduleDrain(delay)
  }

  private scheduleDrain(delayMs: number): void {
    if (this.drainTimer) return
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null
      void this.drain()
    }, delayMs)
    this.drainTimer.unref?.()
  }
}
