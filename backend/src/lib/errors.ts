export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'SLOT_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  SLOT_UNAVAILABLE: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

export const badRequest = (m: string, details?: unknown) => new AppError('VALIDATION_ERROR', m, details);
export const unauthenticated = (m = 'Please sign in to continue.') => new AppError('UNAUTHENTICATED', m);
export const forbidden = (m = 'You do not have permission to do that.') => new AppError('FORBIDDEN', m);
export const notFound = (m = 'Not found.') => new AppError('NOT_FOUND', m);
export const conflict = (m: string) => new AppError('CONFLICT', m);
export const slotUnavailable = (m = 'That time is no longer available. Please choose another slot.') =>
  new AppError('SLOT_UNAVAILABLE', m);
