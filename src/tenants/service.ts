import type { Pool } from 'pg';
import { ErrorCode, MeterError } from '../errors.js';
import { isValidTimeZone } from '../time/buckets.js';

export interface TenantInput {
  id: string;
  displayName: string;
  timezone: string;
  billingAnchorDay?: number;
}

interface TenantRow {
  id: string;
  display_name: string;
  timezone: string;
  billing_anchor_day: number;
}

// Minimal provisioning API so tenants can exist without an admin UI.
// (The metering surface itself has no management interface.)
export class TenantService {
  constructor(private pool: Pool) {}

  async upsert(input: Partial<TenantInput>): Promise<TenantRow> {
    if (typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.id)) {
      throw new MeterError(
        ErrorCode.VALIDATION_ERROR,
        'id is required (1..64 chars: letters, digits, _ -)',
        400,
        { field: 'id' },
      );
    }
    if (
      typeof input.displayName !== 'string' ||
      !input.displayName.trim() ||
      input.displayName.length > 200
    ) {
      throw new MeterError(
        ErrorCode.VALIDATION_ERROR,
        'displayName is required (max 200 chars)',
        400,
        { field: 'displayName' },
      );
    }
    if (typeof input.timezone !== 'string' || !isValidTimeZone(input.timezone)) {
      throw new MeterError(
        ErrorCode.VALIDATION_ERROR,
        `invalid IANA timezone: ${String(input.timezone)}`,
        400,
        { field: 'timezone' },
      );
    }
    const anchor = input.billingAnchorDay ?? 1;
    if (
      typeof anchor !== 'number' ||
      !Number.isInteger(anchor) ||
      anchor < 1 ||
      anchor > 28
    ) {
      throw new MeterError(
        ErrorCode.VALIDATION_ERROR,
        'billingAnchorDay must be an integer 1..28',
        400,
        { field: 'billingAnchorDay' },
      );
    }

    const res = await this.pool.query<TenantRow>(
      `INSERT INTO tenants (id, display_name, timezone, billing_anchor_day)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         timezone = EXCLUDED.timezone,
         billing_anchor_day = EXCLUDED.billing_anchor_day
       RETURNING id, display_name, timezone, billing_anchor_day`,
      [input.id, input.displayName, input.timezone, anchor],
    );
    return res.rows[0]!;
  }
}
