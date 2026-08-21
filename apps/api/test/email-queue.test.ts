import { describe, expect, it } from 'vitest'
import { EmailQueue } from '../src/modules/email/email.queue.js'
import { Mailer } from '../src/modules/email/mailer.js'

const jsonConfig = {
  enabled: true,
  host: '',
  port: 587,
  user: '',
  pass: '',
  from: 'ReyDesk <support@example.test>',
  tls: true,
  jsonTransport: true,
}

describe('email delivery queue', () => {
  it('attempts add() jobs without requiring a later manual drain', async () => {
    const mailer = new Mailer(jsonConfig)
    const queue = new EmailQueue(mailer, { retryDelayMs: 1 })

    const jobId = queue.add({
      to: 'user@example.test',
      subject: 'Queue test',
      text: 'A queued message',
      html: '<p>A queued message</p>',
    })
    await queue.drain()

    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0].subject).toBe('Queue test')
    expect(queue.getJob(jobId)?.status).toBe('sent')
    expect(queue.getStats()).toMatchObject({ sent: 1, failed: 0, dead: 0 })
  })

  it('records delivery failures and exposes a dead-letter job for retry', async () => {
    const mailer = new Mailer({ ...jsonConfig, jsonTransport: false, enabled: false })
    const queue = new EmailQueue(mailer, { maxRetries: 2, retryDelayMs: 1 })
    const jobId = queue.add({ to: 'user@example.test', subject: 'Failure test', text: 'test' })

    await queue.drain()
    expect(queue.getJob(jobId)?.status).toBe('dead')
    expect(queue.getDeadLetters()).toHaveLength(1)
    expect(queue.getStats()).toMatchObject({ failed: 1, dead: 1 })

    expect(queue.retryJob(jobId)).toBe(true)
    expect(queue.getJob(jobId)?.status).toBe('pending')
  })

  it('builds branded support mail with a text fallback and HTML action', () => {
    const mailer = new Mailer(jsonConfig)
    const message = mailer.buildRemoteSupportMail({
      to: 'customer@example.test',
      connectUrl: 'https://support.example.test/connect/1234567890',
      code: '1234567890',
      mode: 'email_link',
    })

    expect(message.text).toContain('https://support.example.test/connect/1234567890')
    expect(message.html).toContain('Open secure support page')
    expect(message.html).toContain('#e8a33d')
  })
})
