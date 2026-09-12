// Tenant-local time bucketing.
//
// Day boundaries MUST follow each tenant's configured IANA timezone, not UTC.
// We compute local wall-clock parts with Intl (full IANA tz database) and pass
// the buckets to Postgres as *text* ('YYYY-MM-DD' / 'YYYY-MM-DD HH:00:00'),
// cast to date/timestamp, so the result never depends on the database session's
// timezone setting.

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

const tzFmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = tzFmtCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    tzFmtCache.set(timeZone, fmt);
  }
  return fmt;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(instant);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 'NaN');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
  };
}

/** Tenant-local hour bucket as a Postgres timestamp literal, minute=0. */
export function hourBucketKey(p: LocalParts): string {
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:00:00`;
}

/** Tenant-local calendar day as a Postgres date literal. */
export function dayKey(p: LocalParts): string {
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

function prevMonth(year: number, month: number): { year: number; month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

function nextMonth(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Billing-cycle range [start, end) (end exclusive) containing the given
 * tenant-local date. The cycle starts on `anchorDay` each month; anchor is
 * limited to 1..28 so every month contains the anchor (no short-month clamps).
 */
export function cycleRange(
  p: Pick<LocalParts, 'year' | 'month' | 'day'>,
  anchorDay: number,
): { start: string; end: string } {
  const startYM =
    p.day >= anchorDay
      ? { year: p.year, month: p.month }
      : prevMonth(p.year, p.month);
  const endYM = nextMonth(startYM.year, startYM.month);
  return {
    start: dateKey(startYM.year, startYM.month, anchorDay),
    end: dateKey(endYM.year, endYM.month, anchorDay),
  };
}
