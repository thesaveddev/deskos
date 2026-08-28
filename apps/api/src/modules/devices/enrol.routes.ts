import { createReadStream, existsSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { hashToken } from './device-auth.js'
import { withTenant } from '../../db/pool.js'

const codeSchema = z.string().regex(/^\d{12}$/)

function platform(request: { headers: Record<string, string | string[] | undefined> }): 'windows' | 'android' | 'macos' | 'unknown' {
  const ua = String(request.headers['user-agent'] ?? '').toLowerCase()
  if (/android/.test(ua)) return 'android'
  if (/iphone|ipad|ipod/.test(ua)) return 'unknown'
  if (/macintosh|mac os x/.test(ua)) return 'macos'
  if (/windows/.test(ua)) return 'windows'
  return 'unknown'
}

export async function enrolRoutes(app: FastifyInstance): Promise<void> {
  app.get('/enrol/:code', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const parsed = codeSchema.safeParse((request.params as { code: string }).code)
    if (!parsed.success) return reply.code(404).send({ error: { code: 'not_found', message: 'This enrollment code is invalid or expired.' } })
    const result = await app.db.query(
      `SELECT t.enrol_code_expires_at
         FROM tenants t
        WHERE t.enrol_code_hash = $1
          AND t.enrol_code_used_at IS NULL
          AND t.enrol_code_expires_at > now()
        LIMIT 1`,
      [hashToken(parsed.data)],
    )
    const row = result.rows[0]
    if (!row) return reply.code(404).send({ error: { code: 'not_found', message: 'This enrollment code is invalid or expired.' } })
    const currentPlatform = platform(request)
    const helperAvailable = currentPlatform === 'windows'
      ? Boolean(app.config.helperBinaryPath && existsSync(app.config.helperBinaryPath))
      : currentPlatform === 'android'
        ? Boolean(app.config.androidApkPath && existsSync(app.config.androidApkPath))
        : currentPlatform === 'macos'
          ? Boolean(app.config.macHelperBinaryPath && existsSync(app.config.macHelperBinaryPath) && process.env.REYDESK_MAC_HELPER_VERIFIED === 'true')
          : false
    return reply.send({ valid: true, expiresAt: row.enrol_code_expires_at, platform: currentPlatform, helperAvailable })
  })

  app.get('/enrol/:code/download', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const parsed = codeSchema.safeParse((request.params as { code: string }).code)
    if (!parsed.success) return reply.code(404).send({ error: { code: 'not_found', message: 'This enrollment code is invalid or expired.' } })
    const result = await app.db.query(
      `SELECT t.tenant_id, t.enrol_code_expires_at
         FROM tenants t
        WHERE t.enrol_code_hash = $1
          AND t.enrol_code_used_at IS NULL
          AND t.enrol_code_expires_at > now()
        LIMIT 1`,
      [hashToken(parsed.data)],
    )
    if (!result.rowCount) return reply.code(404).send({ error: { code: 'not_found', message: 'This enrollment code is invalid or expired.' } })
    const currentPlatform = platform(request)
    let file = ''
    let filename = ''
    let contentType = 'application/octet-stream'
    if (currentPlatform === 'windows') { file = app.config.helperBinaryPath; filename = 'reydesk-helper.exe' }
    else if (currentPlatform === 'android') { file = app.config.androidApkPath; filename = 'reydesk-agent.apk'; contentType = 'application/vnd.android.package-archive' }
    else if (currentPlatform === 'macos' && process.env.REYDESK_MAC_HELPER_VERIFIED === 'true') { file = app.config.macHelperBinaryPath; filename = 'reydesk-helper.dmg' }
    if (!file || !existsSync(file)) return reply.code(404).send({ error: { code: 'helper_unavailable', message: 'The agent package is not available for this device yet.' } })
    reply.header('Content-Type', contentType)
    reply.header('Content-Disposition', `attachment; filename="${filename}"`)
    return reply.send(createReadStream(file))
  })
}
