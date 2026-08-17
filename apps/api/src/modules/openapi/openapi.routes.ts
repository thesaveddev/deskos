import type { FastifyInstance } from 'fastify'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { API_SCOPES } from '../oauth/scopes.js'
import { buildOpenApiSpec } from './openapi.js'
import '../../types.js'

export async function openApiRoutes(app: FastifyInstance): Promise<void> {
  // Public: the spec describes endpoints + scopes only, never tenant data.
  app.get('/openapi.json', async () => buildOpenApiSpec(app.config.publicUrl))

  // Developer portal overview (integration.read): scope catalog + endpoint map.
  app.get('/developer/overview', { preHandler: [authenticate, requireTenant, requirePermission('integration.read')] }, async () => {
    const base = app.config.publicUrl.replace(/\/+$/, '')
    return {
      baseUrl: base,
      specUrl: `${base}/api/v1/openapi.json`,
      auth: {
        tokenUrl: `${base}/api/v1/oauth/token`,
        authorizeUrl: `${base}/api/v1/oauth/authorize`,
        grantTypes: ['client_credentials', 'authorization_code'],
      },
      endpoints: [{ method: 'GET', path: '/api/v1/public/tickets', scope: 'tickets:read', description: 'List tickets in your tenant' }],
      scopes: API_SCOPES,
    }
  })
}
