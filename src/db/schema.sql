-- meterd schema: usage events + incremental rollups
-- All usage values are stored as BIGINT (integer minor units, e.g. cents / bytes / millis).
-- No floating point anywhere.

CREATE TABLE IF NOT EXISTS tenants (
    id              TEXT PRIMARY KEY,
    display_name    TEXT NOT NULL,
    -- IANA timezone name, e.g. 'Asia/Shanghai'. Day boundaries are computed per tenant.
    timezone        TEXT NOT NULL,
    -- Day-of-month (1..28) on which the tenant's billing cycle starts.
    -- 1 = calendar month. 28 is the max safe anchor (every month has the 28th).
    billing_anchor_day INTEGER NOT NULL CHECK (billing_anchor_day BETWEEN 1 AND 28),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Raw events: append-only audit trail. Reads NEVER aggregate from this table;
-- rollups are maintained incrementally at ingest time. The same idempotency
-- key can legitimately recur here 24h+ apart (key reuse after the dedup
-- window), so no unique constraint on the key in this table.
CREATE TABLE IF NOT EXISTS usage_events (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id       TEXT NOT NULL REFERENCES tenants(id),
    metric          TEXT NOT NULL,
    -- Integer minor units. Never negative.
    value           BIGINT NOT NULL CHECK (value >= 0),
    -- When the usage actually happened (client-supplied, bounded by the 72h lateness rule).
    occurred_at     TIMESTAMPTZ NOT NULL,
    idempotency_key TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_events_tenant_occurred_idx
    ON usage_events (tenant_id, occurred_at);

-- Active idempotency claims, one row per (tenant, key). Rows are reclaimed once
-- their claim ages past the 24h dedup window (see ingest service), after which
-- the key may be reused. The PK makes concurrent claims race-safe: losers get
-- ON CONFLICT and are deduplicated.
CREATE TABLE IF NOT EXISTS idempotency_keys (
    tenant_id       TEXT NOT NULL REFERENCES tenants(id),
    idempotency_key TEXT NOT NULL,
    -- Canonical digest of (metric, value, occurredAt); a replay with a
    -- different body is rejected rather than silently deduplicated.
    fingerprint     TEXT NOT NULL,
    event_id        BIGINT REFERENCES usage_events(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, idempotency_key)
);

-- Hourly rollup: bucket_hour is the hour start in the TENANT's local timezone
-- (wall clock), stored tz-free so aggregates are independent of session TimeZone.
CREATE TABLE IF NOT EXISTS usage_agg_hourly (
    tenant_id   TEXT NOT NULL REFERENCES tenants(id),
    metric      TEXT NOT NULL,
    bucket_hour TIMESTAMP NOT NULL,            -- local wall-clock hour, minute=0
    total       BIGINT NOT NULL DEFAULT 0 CHECK (total >= 0),
    event_count BIGINT NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, metric, bucket_hour)
);

-- Daily rollup: bucket_day is a calendar date in the TENANT's local timezone.
CREATE TABLE IF NOT EXISTS usage_agg_daily (
    tenant_id   TEXT NOT NULL REFERENCES tenants(id),
    metric      TEXT NOT NULL,
    bucket_day  DATE NOT NULL,
    total       BIGINT NOT NULL DEFAULT 0 CHECK (total >= 0),
    event_count BIGINT NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, metric, bucket_day)
);

-- Billing-cycle rollup. cycle_start is the tenant-local date the cycle began;
-- cycle_end is exclusive. Events landing in [cycle_start, cycle_end) accumulate
-- into the same row.
CREATE TABLE IF NOT EXISTS usage_agg_cycle (
    tenant_id   TEXT NOT NULL REFERENCES tenants(id),
    metric      TEXT NOT NULL,
    cycle_start DATE NOT NULL,
    cycle_end   DATE NOT NULL,
    total       BIGINT NOT NULL DEFAULT 0 CHECK (total >= 0),
    event_count BIGINT NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, metric, cycle_start),
    CHECK (cycle_end > cycle_start)
);
