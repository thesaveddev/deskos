import { SignJWT, jwtVerify } from 'jose'
import type { AppConfig } from '../../config.js'

export interface AccessTokenPayload {
  sub: string
  typ: 'access'
  jti: string
}

export async function signAccessToken(
  config: AppConfig,
  userId: string,
  jti: string,
): Promise<string> {
  return new SignJWT({ typ: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setJti(jti)
    .setIssuer(config.jwtIssuer)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTokenTtlSec}s`)
    .sign(config.jwtSecret)
}

export async function verifyAccessToken(
  config: AppConfig,
  token: string,
): Promise<AccessTokenPayload> {
  const { payload } = await jwtVerify(token, config.jwtSecret, {
    issuer: config.jwtIssuer,
    algorithms: ['HS256'],
  })
  if (payload.typ !== 'access' || !payload.sub || !payload.jti) {
    throw new Error('invalid token payload')
  }
  return { sub: payload.sub, typ: 'access', jti: payload.jti }
}
