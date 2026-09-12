-- meterd schema: usage events + incremental rollups
-- All usage values are stored as BIGINT (integer minor units, e.g. cents / bytes / millis).
-- No floating point anywhere.

-- btree_gist lets us put TEXT columns in a GiST exclusion constraint, used to
-- guarantee billing-cycle rows never overlap for the same (tenant, metric).
CREATE EXTENSION IF NOT EXISTS btree_gist;

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
    CHECK (cycle_end > cycle_start),
    -- Defense in depth: two cycle rows for the same (tenant, metric) must never
    -- cover overlapping dates, or a client summing cycle rows double counts.
    -- Anchor changes are blocked at the API while usage exists, but this index
    -- makes an overlap physically impossible even against a direct SQL write.
    CONSTRAINT usage_agg_cycle_no_overlap EXCLUDE USING gist (
        tenant_id WITH =,
        metric WITH =,
        daterange(cycle_start, cycle_end, '[)') WITH &&
    )
);

-- Upgrade path for databases created before the exclusion constraint existed.
-- Such a database may already contain OVERLAPPING cycle rows produced by the
-- old anchor-change bug (e.g. [2026-08-20,2026-09-20) AND
-- [2026-09-01,2026-10-01) for one tenant+metric). Adding the constraint would
-- fail on exactly that data and leave the service unable to boot, so we
-- self-heal first and NEVER let migration abort on dirty legacy rows.
--
-- Repair policy (see README "Upgrading with overlapping cycles"):
--   * Find connected components of strictly-overlapping rows per
--     (tenant_id, metric) via gaps-and-islands. Adjacent (non-overlapping)
--     cycles are left untouched.
--   * Collapse each component into one row; total/event_count are SUMMED
--     (every event originally hit exactly one row, so the sum preserves the
--     grand total). The resulting range is:
--       - the member covering the tenant's LOCAL today with the latest start,
--         i.e. the current anchor's active cycle (so future ingests upsert the
--         surviving row instead of colliding with an artificial union range);
--       - otherwise the union [min(start), max(end)).
--   * Every superseded original row is copied to ..._repair_log for billing
--     reconciliation; the merge is a one-time approximation and must be
--     reconciled against usage_events rather than silently trusted.
CREATE TABLE IF NOT EXISTS usage_agg_cycle_repair_log (
    id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id                 TEXT NOT NULL,
    metric                    TEXT NOT NULL,
    old_cycle_start           DATE NOT NULL,
    old_cycle_end             DATE NOT NULL,
    old_total                 BIGINT NOT NULL,
    old_event_count           BIGINT NOT NULL,
    merged_into_cycle_start   DATE NOT NULL,
    repaired_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'usage_agg_cycle_no_overlap'
    ) THEN
        RETURN;  -- already repaired & constrained; migration is idempotent
    END IF;

    -- Repeatedly collapse overlapping components until none remain. Each pass
    -- strictly reduces the number of rows, so this always terminates; the loop
    -- also covers pathological shapes where normalizing the active cycle makes
    -- it touch a neighbouring historical row.
    LOOP
        -- anything still overlapping?
        EXIT WHEN NOT EXISTS (
            SELECT 1
            FROM usage_agg_cycle a
            JOIN usage_agg_cycle b
              ON a.tenant_id = b.tenant_id
             AND a.metric    = b.metric
             AND a.ctid     <> b.ctid
             AND daterange(a.cycle_start, a.cycle_end, '[)')
                 && daterange(b.cycle_start, b.cycle_end, '[)')
        );

        DROP TABLE IF EXISTS pg_temp._cycle_repair;

        CREATE TEMP TABLE _cycle_repair AS
        WITH base AS (
            SELECT
                c.tenant_id, c.metric, c.cycle_start, c.cycle_end,
                c.total, c.event_count,
                lt.local_today,
                CASE WHEN lt.local_today >= lt.month_anchor
                     THEN lt.month_anchor
                     ELSE (lt.month_anchor - INTERVAL '1 month')::date
                END AS cur_start,
                CASE WHEN lt.local_today >= lt.month_anchor
                     THEN (lt.month_anchor + INTERVAL '1 month')::date
                     ELSE lt.month_anchor
                END AS cur_end
            FROM usage_agg_cycle c
            JOIN tenants t ON t.id = c.tenant_id
            CROSS JOIN LATERAL (
                SELECT
                    (now() AT TIME ZONE COALESCE(t.timezone, 'UTC'))::date AS local_today,
                    (date_trunc('month', now() AT TIME ZONE COALESCE(t.timezone, 'UTC'))::date
                        + (t.billing_anchor_day - 1)) AS month_anchor
            ) lt
        ),
        ordered AS (
            SELECT *,
                MAX(cycle_end) OVER (
                    PARTITION BY tenant_id, metric
                    ORDER BY cycle_start, cycle_end
                    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                ) AS prev_max_end
            FROM base
        ),
        flagged AS (
            SELECT *,
                COUNT(*) FILTER (
                    WHERE prev_max_end IS NULL OR cycle_start >= prev_max_end
                ) OVER (
                    PARTITION BY tenant_id, metric
                    ORDER BY cycle_start, cycle_end
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) AS grp
            FROM ordered
        ),
        comp AS (
            SELECT tenant_id, metric, grp,
                COUNT(*)         AS member_count,
                SUM(total)       AS new_total,
                SUM(event_count) AS new_event_count,
                MIN(cycle_start) AS union_start,
                MAX(cycle_end)   AS union_end,
                BOOL_OR(cycle_start <= local_today AND cycle_end > local_today)
                                 AS covers_today,
                MAX(cur_start)   AS cur_start,
                MAX(cur_end)     AS cur_end
            FROM flagged
            GROUP BY tenant_id, metric, grp
        )
        SELECT
            f.tenant_id, f.metric,
            f.cycle_start AS old_start, f.cycle_end AS old_end,
            f.total AS old_total, f.event_count AS old_event_count,
            c.member_count,
            CASE WHEN c.covers_today THEN c.cur_start  ELSE c.union_start END AS new_start,
            CASE WHEN c.covers_today THEN c.cur_end    ELSE c.union_end   END AS new_end,
            c.new_total, c.new_event_count
        FROM flagged f
        JOIN comp c USING (tenant_id, metric, grp);

        -- audit every original row about to be superseded in this pass
        INSERT INTO usage_agg_cycle_repair_log
            (tenant_id, metric, old_cycle_start, old_cycle_end,
             old_total, old_event_count, merged_into_cycle_start)
        SELECT tenant_id, metric, old_start, old_end,
               old_total, old_event_count, new_start
        FROM _cycle_repair
        WHERE member_count > 1;

        DELETE FROM usage_agg_cycle c
        USING _cycle_repair r
        WHERE c.tenant_id   = r.tenant_id
          AND c.metric      = r.metric
          AND c.cycle_start = r.old_start
          AND r.member_count > 1;

        INSERT INTO usage_agg_cycle
            (tenant_id, metric, cycle_start, cycle_end, total, event_count, updated_at)
        SELECT DISTINCT
            tenant_id, metric, new_start, new_end, new_total, new_event_count, now()
        FROM _cycle_repair
        WHERE member_count > 1;

        DROP TABLE pg_temp._cycle_repair;
    END LOOP;

    -- data is now guaranteed overlap-free; the constraint can always build
    ALTER TABLE usage_agg_cycle
        ADD CONSTRAINT usage_agg_cycle_no_overlap EXCLUDE USING gist (
            tenant_id WITH =,
            metric WITH =,
            daterange(cycle_start, cycle_end, '[)') WITH &&
        );
END $$;
