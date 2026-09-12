// Stable error codes for clients. Never rename; only add.
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNKNOWN_TENANT: 'UNKNOWN_TENANT',
  EVENT_TOO_OLD: 'EVENT_TOO_OLD',
  EVENT_IN_FUTURE: 'EVENT_IN_FUTURE',
  // Same idempotency key replayed inside 24h with a different body.
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  // Attempt to change timezone / billing anchor on a tenant that already has
  // metered usage; doing so silently splits rollups across incompatible
  // bucketing rules. Update displayName freely; structural keys are immutable
  // once usage exists.
  TENANT_CONFIG_IMMUTABLE: 'TENANT_CONFIG_IMMUTABLE',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export class MeterError extends Error {
  constructor(
    public code: ErrorCodeValue,
    message: string,
    public statusCode: number,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'MeterError';
  }
}
