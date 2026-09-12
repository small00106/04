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

    const existingRes = await this.pool.query<TenantRow>(
      `SELECT id, display_name, timezone, billing_anchor_day
         FROM tenants WHERE id = $1`,
      [input.id],
    );
    const existing = existingRes.rows[0];

    if (existing) {
      const structuralChange =
        input.timezone !== existing.timezone ||
        anchor !== existing.billing_anchor_day;

      if (structuralChange) {
        // These two keys define how history is bucketed. Changing them after
        // usage exists leaves old rollups cut by the old rule while new rows
        // are cut by the new one (overlapping cycles / mislabeled days). Block
        // it; a backfill/re-cut is a separate, deliberate operation.
        const usageRes = await this.pool.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM usage_events WHERE tenant_id = $1
           ) AS exists`,
          [input.id],
        );
        if (usageRes.rows[0]!.exists) {
          throw new MeterError(
            ErrorCode.TENANT_CONFIG_IMMUTABLE,
            'timezone and billingAnchorDay cannot be changed once a tenant has metered usage',
            409,
            {
              fields: ['timezone', 'billingAnchorDay'],
              current: {
                timezone: existing.timezone,
                billingAnchorDay: existing.billing_anchor_day,
              },
            },
          );
        }
      }

      const res = await this.pool.query<TenantRow>(
        `UPDATE tenants
            SET display_name = $2,
                timezone = $3,
                billing_anchor_day = $4
          WHERE id = $1
          RETURNING id, display_name, timezone, billing_anchor_day`,
        [input.id, input.displayName, input.timezone, anchor],
      );
      return res.rows[0]!;
    }

    const res = await this.pool.query<TenantRow>(
      `INSERT INTO tenants (id, display_name, timezone, billing_anchor_day)
       VALUES ($1, $2, $3, $4)
       RETURNING id, display_name, timezone, billing_anchor_day`,
      [input.id, input.displayName, input.timezone, anchor],
    );
    return res.rows[0]!;
  }
}
