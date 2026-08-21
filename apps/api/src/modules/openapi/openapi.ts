import { API_SCOPES } from '../oauth/scopes.js'

/**
 * Build the OpenAPI 3.1 document describing ReyDesk's public, integrator-facing
 * API surface: OAuth2 token/authorize endpoints and the protected resources
 * third-party clients can call. The spec is intentionally curated (not a full
 * reflection of every internal route) so it only promises a stable contract.
 */
export function buildOpenApiSpec(baseUrl: string): Record<string, unknown> {
  const tokenUrl = `${baseUrl.replace(/\/+$/, '')}/api/v1/oauth/token`
  const authorizeUrl = `${baseUrl.replace(/\/+$/, '')}/api/v1/oauth/authorize`
  const scopes: Record<string, string> = {}
  for (const s of API_SCOPES) scopes[s.scope] = s.description

  return {
    openapi: '3.1.0',
    info: {
      title: 'ReyDesk Public API',
      version: '0.0.1',
      description:
        'The integrator-facing API for ReyDesk. Authenticate with OAuth2 (client credentials for machine-to-machine, or authorization code + PKCE for user-delegated access) and call tenant-scoped resources with the issued bearer token.',
    },
    servers: [{ url: baseUrl.replace(/\/+$/, ''), description: 'ReyDesk API' }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'A ReyDesk OAuth2 access token (or user access token).',
        },
        oauthClientCredentials: {
          type: 'oauth2',
          flows: {
            clientCredentials: { tokenUrl, scopes },
          },
        },
        oauthAuthorizationCode: {
          type: 'oauth2',
          flows: {
            authorizationCode: { authorizationUrl: authorizeUrl, tokenUrl, scopes },
          },
        },
      },
    },
    paths: {
      '/api/v1/oauth/token': {
        post: {
          operationId: 'issueToken',
          summary: 'Exchange credentials or an authorization code for an access token',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['grant_type', 'client_id'],
                  properties: {
                    grant_type: { type: 'string', enum: ['client_credentials', 'authorization_code'] },
                    client_id: { type: 'string', format: 'uuid' },
                    client_secret: { type: 'string' },
                    code: { type: 'string' },
                    code_verifier: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'An access token', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Invalid request' },
            '401': { description: 'Invalid client credentials' },
          },
        },
      },
      '/api/v1/oauth/authorize': {
        post: {
          operationId: 'authorize',
          summary: 'Approve scopes for a client (authorization-code flow step 1)',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['clientId', 'redirectUri', 'codeChallenge', 'scopes'],
                  properties: {
                    clientId: { type: 'string', format: 'uuid' },
                    redirectUri: { type: 'string' },
                    codeChallenge: { type: 'string' },
                    scopes: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'A one-time authorization code' },
            '400': { description: 'Invalid request' },
          },
        },
      },
      '/api/v1/public/tickets': {
        get: {
          operationId: 'listPublicTickets',
          summary: 'List tickets in the authenticated tenant',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': { description: 'A list of tickets', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Missing or invalid token' },
            '403': { description: 'Token lacks the tickets:read scope' },
          },
        },
      },
    },
    // ReyDesk extension: the canonical scope catalog, rendered by the developer portal.
    'x-deskos-scopes': API_SCOPES,
  }
}
