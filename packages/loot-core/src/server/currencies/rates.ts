import { fetch } from '#platform/server/fetch';
import { logger } from '#platform/server/log';
import * as db from '#server/db';
import { runMutator } from '#server/mutators';
import { batchMessages } from '#server/sync';
import * as monthUtils from '#shared/months';
import type { ExchangeRateSource } from '#types/models';

import { getBaseCurrency, isForeignCurrency } from './base-currency';

const FRANKFURTER_URL = 'https://api.frankfurter.dev/v2/rates';

// The value of the synced preference `exchangeRateProvider` that turns
// the download on
export const FRANKFURTER_PROVIDER = 'frankfurter';

// A write uses a stored rate that is at most this number of days from
// its date
export const NEAREST_RATE_MAX_DAYS = 7;

const REFRESH_RETRY_MS = 10 * 60 * 1000;

export type RateRequest = {
  from: string;
  to: string;
  date: string;
};

export type RateRow = RateRequest & {
  // Units of `to` for one unit of `from`
  rate: number;
};

export type StoredRate = {
  rate: number;
  date: string;
  isExactDate: boolean;
  source: string | null;
};

export function rateId({ from, to, date }: RateRequest): string {
  return `${from}:${to}:${date}`;
}

// No rate exists for a date after today, so such a date uses today
function lookupDate(date: string): string {
  const today = monthUtils.currentDay();
  return monthUtils.isAfter(date, today) ? today : date;
}

/**
 * Reads a rate from the database. It never downloads, so a write can
 * call it. The rate of the date wins, then the nearest date within
 * `maxDays`. On a tie the earlier date wins.
 */
export async function getStoredRate({
  from,
  to,
  date,
  maxDays = NEAREST_RATE_MAX_DAYS,
}: RateRequest & { maxDays?: number }): Promise<StoredRate | null> {
  if (from === to) {
    return { rate: 1, date, isExactDate: true, source: null };
  }

  const day = lookupDate(date);
  const rows = await db.all<
    Pick<db.DbExchangeRate, 'date' | 'rate' | 'source'>
  >(
    `SELECT date, rate, source FROM exchange_rates
      WHERE from_currency = ? AND to_currency = ?
        AND date >= ? AND date <= ? AND tombstone = 0`,
    [
      from,
      to,
      db.toDateRepr(monthUtils.subDays(day, maxDays)),
      db.toDateRepr(monthUtils.addDays(day, maxDays)),
    ],
  );

  let best: StoredRate | null = null;
  let bestDistance = Infinity;
  for (const row of rows) {
    if (!(row.rate > 0)) {
      continue;
    }
    const rowDate = db.fromDateRepr(row.date);
    const distance = Math.abs(
      monthUtils.differenceInCalendarDays(rowDate, day),
    );
    const isNearer =
      distance < bestDistance ||
      (distance === bestDistance && best != null && rowDate < best.date);
    if (isNearer) {
      best = {
        rate: row.rate,
        date: rowDate,
        isExactDate: distance === 0,
        source: row.source ?? null,
      };
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Stores rates. The id of a row comes from the pair and the date, so a
 * second save of the same rate changes the same row, also when it comes
 * from a different device.
 *
 * Do not call this inside a mutator. It starts its own, and mutators run
 * one after the other.
 */
export async function saveRates({
  rates,
  source,
}: {
  rates: RateRow[];
  source: ExchangeRateSource;
}): Promise<void> {
  if (rates.length === 0) {
    return;
  }

  await runMutator(() =>
    batchMessages(async () => {
      for (const { from, to, date, rate } of rates) {
        await db.updateWithSchema('exchange_rates', {
          id: rateId({ from, to, date }),
          from_currency: from,
          to_currency: to,
          date,
          rate,
          source,
          // Brings back a row that an undo or a delete removed
          tombstone: false,
        });
      }
    }),
  );
}

function isFrankfurterRow(
  row: unknown,
): row is { date: string; base: string; quote: string; rate: number } {
  if (typeof row !== 'object' || row === null) {
    return false;
  }
  const { date, base, quote, rate } = row as Record<string, unknown>;
  return (
    typeof date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    typeof base === 'string' &&
    typeof quote === 'string' &&
    typeof rate === 'number' &&
    Number.isFinite(rate) &&
    rate > 0
  );
}

/**
 * Downloads the daily rates of one pair for a range of dates.
 *
 * Always ask with the foreign currency as `from`. Frankfurter gives
 * about five significant digits, so a rate such as VND to USD loses
 * most of its precision.
 */
export async function fetchFrankfurterRates({
  from,
  to,
  start,
  end,
}: {
  from: string;
  to: string;
  start: string;
  end: string;
}): Promise<RateRow[]> {
  const params = new URLSearchParams({
    base: from,
    quotes: to,
    from: start,
    to: end,
  });
  // The fetch wrapper reads a redirect as an expired login unless the
  // request says that a redirect is fine
  const response = await fetch(`${FRANKFURTER_URL}?${params.toString()}`, {
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(`Frankfurter answered with status ${response.status}`);
  }

  const body: unknown = await response.json();
  if (!Array.isArray(body)) {
    throw new Error('Frankfurter gave an answer that is not a list');
  }

  return body.flatMap(row =>
    isFrankfurterRow(row) && row.base === from && row.quote === to
      ? [{ from, to, date: row.date, rate: row.rate }]
      : [],
  );
}

async function isDownloadEnabled(): Promise<boolean> {
  const row = await db.first<Pick<db.DbPreference, 'value'>>(
    "SELECT value FROM preferences WHERE id = 'exchangeRateProvider'",
  );
  return row?.value === FRANKFURTER_PROVIDER;
}

/**
 * Makes sure that the database has a rate for each request, and
 * downloads the ones that are not there when the user turned the
 * download on. A failed download is not an error: the caller gets the
 * requests that still have no usable rate, and decides what to do.
 *
 * Call this before a write, never inside one. A write is one undo step,
 * and a network wait inside it would let other changes join that step.
 */
export async function ensureRates({
  requests,
}: {
  requests: RateRequest[];
}): Promise<{ missing: RateRequest[] }> {
  const wanted = new Map<string, RateRequest>();
  for (const request of requests) {
    if (request.from !== request.to) {
      const normalized = { ...request, date: lookupDate(request.date) };
      wanted.set(rateId(normalized), normalized);
    }
  }

  const byPair = new Map<string, RateRequest[]>();
  for (const request of wanted.values()) {
    const exact = await getStoredRate({ ...request, maxDays: 0 });
    if (!exact) {
      const pair = `${request.from}:${request.to}`;
      byPair.set(pair, [...(byPair.get(pair) ?? []), request]);
    }
  }

  if (byPair.size > 0 && (await isDownloadEnabled())) {
    for (const group of byPair.values()) {
      const { from, to } = group[0];
      const dates = group.map(request => request.date).sort();
      try {
        const rates = await fetchFrankfurterRates({
          from,
          to,
          start: dates[0],
          end: dates[dates.length - 1],
        });
        // A range gives each day between its ends. Only the days that a
        // request named are stored, because each row syncs to all devices.
        const asked = new Set(dates);
        await saveRates({
          rates: rates.filter(rate => asked.has(rate.date)),
          source: 'frankfurter',
        });
      } catch (error) {
        logger.warn(`Could not download the rates for ${from} to ${to}`, error);
      }
    }
  }

  const missing: RateRequest[] = [];
  for (const request of requests) {
    if (request.from !== request.to && !(await getStoredRate(request))) {
      missing.push(request);
    }
  }
  return { missing };
}

let lastRefreshAttempt = 0;

/**
 * Gets the rate of today for each foreign currency that an open account
 * uses. The market value of a foreign balance needs it. A failed try
 * waits some minutes before the next one.
 */
export async function refreshRatesOfToday({
  now = Date.now(),
}: { now?: number } = {}): Promise<void> {
  if (now - lastRefreshAttempt < REFRESH_RETRY_MS) {
    return;
  }

  const baseCurrency = await getBaseCurrency();
  if (!baseCurrency) {
    return;
  }

  const rows = await db.all<Pick<db.DbAccount, 'currency'>>(
    `SELECT DISTINCT currency FROM accounts
      WHERE currency IS NOT NULL AND tombstone = 0 AND closed = 0`,
  );
  const today = monthUtils.currentDay();
  const requests = rows.flatMap(({ currency }) =>
    currency && isForeignCurrency({ currency, baseCurrency })
      ? [{ from: currency, to: baseCurrency, date: today }]
      : [],
  );
  if (requests.length === 0) {
    return;
  }

  lastRefreshAttempt = now;
  await ensureRates({ requests });
}

// For tests
export function resetRefreshTimer(): void {
  lastRefreshAttempt = 0;
}
