-- Legacy meterd schema as it existed BEFORE btree_gist / the cycle overlap
-- exclusion constraint. Used by the dirty-upgrade regression test to reproduce
-- a database that already contains overlapping cycle rows.

CREATE TABLE tenants (
    id              TEXT PRIMARY KEY,
    display_name    TEXT NOT NULL,
    timezone        TEXT NOT NULL,
    billing_anchor_day INTEGER NOT NULL CHECK (billing_anchor_day BETWEEN 1 AND 28),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE usage_events (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id       TEXT NOT NULL REFERENCES tenants(id),
    metric          TEXT NOT NULL,
    value           BIGINT NOT NULL CHECK (value >= 0),
    occurred_at     TIMESTAMPTZ NOT NULL,
    idempotency_key TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_keys (
    tenant_id       TEXT NOT NULL REFERENCES tenants(id),
    idempotency_key TEXT NOT NULL,
    fingerprint     TEXT NOT NULL,
    event_id        BIGINT REFERENCES usage_events(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, idempotency_key)
);

CREATE TABLE usage_agg_hourly (
    tenant_id   TEXT NOT NULL REFERENCES tenants(id),
    metric      TEXT NOT NULL,
    bucket_hour TIMESTAMP NOT NULL,
    total       BIGINT NOT NULL DEFAULT 0 CHECK (total >= 0),
    event_count BIGINT NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, metric, bucket_hour)
);

CREATE TABLE usage_agg_daily (
    tenant_id   TEXT NOT NULL REFERENCES tenants(id),
    metric      TEXT NOT NULL,
    bucket_day  DATE NOT NULL,
    total       BIGINT NOT NULL DEFAULT 0 CHECK (total >= 0),
    event_count BIGINT NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, metric, bucket_day)
);

-- NOTE: no exclusion constraint here — this is the buggy legacy shape that
-- permits overlapping cycle rows.
CREATE TABLE usage_agg_cycle (
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
