import { SignJWT, jwtVerify } from 'jose'
import type { AppConfig } from '../../config.js'

export interface OAuthTokenPayload {
  typ: 'oauth'
  clientId: string
  tenantId: string
  scopes: string[]
  sub?: string
  jti: string
}

export async function signOAuthToken(
  config: AppConfig,
  payload: Omit<OAuthTokenPayload, 'typ' | 'jti'>,
  jti: string,
): Promise<string> {
  return new SignJWT({ typ: 'oauth', clientId: payload.clientId, tenantId: payload.tenantId, scopes: payload.scopes, ...(payload.sub ? { sub: payload.sub } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(jti)
    .setIssuer(config.jwtIssuer)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTokenTtlSec}s`)
    .sign(config.jwtSecret)
}

export async function verifyOAuthToken(config: AppConfig, token: string): Promise<OAuthTokenPayload> {
  const { payload } = await jwtVerify(token, config.jwtSecret, {
    issuer: config.jwtIssuer,
    algorithms: ['HS256'],
  })
  if (payload.typ !== 'oauth' || !payload.clientId || !payload.tenantId || !Array.isArray(payload.scopes) || !payload.jti) {
    throw new Error('invalid oauth token payload')
  }
  return {
    typ: 'oauth',
    clientId: payload.clientId as string,
    tenantId: payload.tenantId as string,
    scopes: payload.scopes as string[],
    sub: typeof payload.sub === 'string' ? payload.sub : undefined,
    jti: payload.jti as string,
  }
}
