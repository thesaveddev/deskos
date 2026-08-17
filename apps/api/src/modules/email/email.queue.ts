import type { Mailer } from './mailer.js'

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

/**
 * Simple in-process email queue with retry logic.
 * For production, swap this with BullMQ + Redis for persistence and horizontal scaling.
 */
export class EmailQueue {
  private queue: EmailJob[] = []
  private processing = false
  private drainTimer: NodeJS.Timeout | null = null
  private stats = { sent: 0, failed: 0, dead: 0 }

  constructor(
    private mailer: Mailer,
    private options: { maxRetries?: number; retryDelayMs?: number; batchSize?: number } = {},
  ) {
    this.options.maxRetries ??= 3
    this.options.retryDelayMs ??= 5_000
    this.options.batchSize ??= 5
  }

  /** Add an email to the queue. Returns the job ID. */
  add(input: EmailJobInput): string {
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
    this.scheduleDrain()
    return id
  }

  /** Process pending jobs. Called automatically on a timer. */
  async drain(): Promise<{ sent: number; failed: number }> {
    if (this.processing) return { sent: 0, failed: 0 }
    this.processing = true

    const pending = this.queue.filter((j) => j.status === 'pending')
    let sent = 0
    let failed = 0

    for (const job of pending.slice(0, this.options.batchSize!)) {
      job.status = 'processing'
      job.lastAttemptAt = new Date()
      try {
        const ok = await this.mailer.sendMail({ to: job.to, subject: job.subject, text: job.text })
        if (ok) {
          job.status = 'sent'
          this.stats.sent++
          sent++
        } else {
          this.retryOrDead(job, 'Mailer returned false')
          failed++
        }
      } catch (err) {
        this.retryOrDead(job, err instanceof Error ? err.message : 'Unknown error')
        failed++
      }
    }

    this.processing = false
    if (sent + failed > 0) {
      console.log(`[email-queue] drained: ${sent} sent, ${failed} failed, ${this.queue.length} remaining`)
    }
    return { sent, failed }
  }

  /** Get queue stats. */
  getStats() {
    return {
      ...this.stats,
      pending: this.queue.filter((j) => j.status === 'pending').length,
      processing: this.queue.filter((j) => j.status === 'processing').length,
      dead: this.queue.filter((j) => j.status === 'dead').length,
      total: this.queue.length,
    }
  }

  /** Get dead letter jobs for inspection. */
  getDeadLetters(): EmailJob[] {
    return this.queue.filter((j) => j.status === 'dead')
  }

  /** Retry a dead letter job. */
  retryJob(jobId: string): boolean {
    const job = this.queue.find((j) => j.id === jobId && j.status === 'dead')
    if (!job) return false
    job.status = 'pending'
    job.retries = 0
    job.lastError = undefined
    this.scheduleDrain()
    return true
  }

  /** Clear completed/failed jobs from memory. */
  purge(): number {
    const before = this.queue.length
    this.queue = this.queue.filter((j) => j.status === 'pending' || j.status === 'processing')
    return before - this.queue.length
  }

  private retryOrDead(job: EmailJob, error: string): void {
    job.retries++
    job.lastError = error
    if (job.retries >= job.maxRetries) {
      job.status = 'dead'
      this.stats.dead++
      console.error(`[email-queue] dead letter: ${job.id} → ${job.to} (${error})`)
    } else {
      job.status = 'pending'
      console.log(`[email-queue] retry ${job.retries}/${job.maxRetries}: ${job.id} (${error})`)
    }
  }

  private scheduleDrain(): void {
    if (this.drainTimer) return
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null
      void this.drain()
    }, this.options.retryDelayMs!)
  }
}
