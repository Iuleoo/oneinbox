import type { ErrorCode } from '@inbox/shared';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  VALIDATION: 400,
  AUTH_FAILED: 400,
  NETWORK: 502,
  THROTTLED: 503,
  RATE_LIMITED: 429,
  CONFLICT: 409,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = options?.status ?? STATUS_BY_CODE[code];
  }

  toJSON() {
    return { error: { code: this.code, message: this.message } };
  }
}

export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`);
export const unauthorized = (message = 'Authentication required') =>
  new AppError('UNAUTHORIZED', message);
