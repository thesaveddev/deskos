export interface ErrorBody {
  error: {
    code: string
    message: string
    denied_reason?: string
  }
}

export class AppError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly deniedReason?: string

  constructor(statusCode: number, code: string, message: string, deniedReason?: string) {
    super(message)
    this.name = 'AppError'
    this.statusCode = statusCode
    this.code = code
    this.deniedReason = deniedReason
  }

  static badRequest(message: string, code = 'bad_request'): AppError {
    return new AppError(400, code, message)
  }
  static unauthorized(message = 'Authentication required', code = 'unauthorized'): AppError {
    return new AppError(401, code, message)
  }
  static forbidden(message: string, deniedReason?: string): AppError {
    return new AppError(403, 'permission_denied', message, deniedReason)
  }
  static notFound(message = 'Resource not found'): AppError {
    return new AppError(404, 'not_found', message)
  }
  static conflict(message: string, code = 'conflict'): AppError {
    return new AppError(409, code, message)
  }
  static tooMany(message = 'Too many requests'): AppError {
    return new AppError(429, 'rate_limited', message)
  }
}

export function toErrorBody(err: unknown): { statusCode: number; body: ErrorBody } {
  if (err instanceof AppError) {
    return {
      statusCode: err.statusCode,
      body: {
        error: {
          code: err.code,
          message: err.message,
          ...(err.deniedReason ? { denied_reason: err.deniedReason } : {}),
        },
      },
    }
  }
  return {
    statusCode: 500,
    body: { error: { code: 'internal_error', message: 'Internal server error' } },
  }
}
