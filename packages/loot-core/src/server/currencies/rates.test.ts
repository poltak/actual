import * as db from '#server/db';

import {
  ensureRates,
  fetchFrankfurterRates,
  FRANKFURTER_PROVIDER,
  getStoredRate,
  rateId,
  refreshRatesOfToday,
  resetRefreshTimer,
  saveRates,
} from './rates';
import type { FetchRates, RateRow } from './rates';

// No test here uses the network. Each one gives its own function for
// the HTTP call or for the download.
const fetchImpl = vi.fn<typeof fetch>();
const fetchRates = vi.fn<FetchRates>();

// The tests run with a fixed clock. `currentDay()` is 2017-01-01.
const TODAY = '2017-01-01';

function usdRates(rows: Array<{ date: string; rate: number }>): RateRow[] {
  return rows.map(row => ({ ...row, from: 'USD', to: 'VND' }));
}

async function turnDownloadOn() {
  await db.update('preferences', {
    id: 'exchangeRateProvider',
    value: FRANKFURTER_PROVIDER,
  });
}

async function storedRateCount() {
  const rows = await db.all<{ id: string }>(
    'SELECT id FROM exchange_rates WHERE tombstone = 0',
  );
  return rows.length;
}

beforeEach(global.emptyDatabase());
beforeEach(() => {
  fetchImpl.mockReset();
  fetchRates.mockReset();
  resetRefreshTimer();
});

describe('getStoredRate', () => {
  it('gives 1 for the same currency with no stored rate', async () => {
    expect(
      await getStoredRate({ from: 'VND', to: 'VND', date: '2016-12-10' }),
    ).toEqual({ rate: 1, date: '2016-12-10', isExactDate: true, source: null });
  });

  it('prefers the rate of the date', async () => {
    await saveRates({
      rates: [
        { from: 'USD', to: 'VND', date: '2016-12-09', rate: 22700 },
        { from: 'USD', to: 'VND', date: '2016-12-10', rate: 22750 },
        { from: 'USD', to: 'VND', date: '2016-12-11', rate: 22800 },
      ],
      source: 'frankfurter',
    });

    expect(
      await getStoredRate({ from: 'USD', to: 'VND', date: '2016-12-10' }),
    ).toEqual({
      rate: 22750,
      date: '2016-12-10',
      isExactDate: true,
      source: 'frankfurter',
    });
  });

  it('falls back to the nearest date, and to the earlier one on a tie', async () => {
    await saveRates({
      rates: [
        { from: 'USD', to: 'VND', date: '2016-12-08', rate: 22700 },
        { from: 'USD', to: 'VND', date: '2016-12-12', rate: 22800 },
        { from: 'USD', to: 'VND', date: '2016-12-20', rate: 22900 },
      ],
      source: 'manual',
    });

    // 2016-12-10 is 2 days from the 8th and 2 days from the 12th
    expect(
      await getStoredRate({ from: 'USD', to: 'VND', date: '2016-12-10' }),
    ).toMatchObject({ rate: 22700, date: '2016-12-08', isExactDate: false });

    expect(
      await getStoredRate({ from: 'USD', to: 'VND', date: '2016-12-17' }),
    ).toMatchObject({ rate: 22900, date: '2016-12-20', isExactDate: false });
  });

  it('gives nothing when the nearest rate is more than 7 days away', async () => {
    await saveRates({
      rates: [{ from: 'USD', to: 'VND', date: '2016-12-01', rate: 22700 }],
      source: 'manual',
    });

    expect(
      await getStoredRate({ from: 'USD', to: 'VND', date: '2016-12-09' }),
    ).toBeNull();
    expect(
      await getStoredRate({ from: 'USD', to: 'VND', date: '2016-12-08' }),
    ).not.toBeNull();
  });

  it('does not use the rate of a different pair', async () => {
    await saveRates({
      rates: [{ from: 'EUR', to: 'VND', date: '2016-12-10', rate: 24000 }],
      source: 'manual',
    });

    expect(
      await getStoredRate({ from: 'USD', to: 'VND', date: '2016-12-10' }),
    ).toBeNull();
  });

  it('uses today for a date after today', async () => {
    await saveRates({
      rates: [{ from: 'USD', to: 'VND', date: TODAY, rate: 22790 }],
      source: 'frankfurter',
    });

    expect(
      await getStoredRate({ from: 'USD', to: 'VND', date: '2017-03-01' }),
    ).toMatchObject({ rate: 22790, date: TODAY, isExactDate: true });
  });
});

describe('saveRates', () => {
  it('writes one row for a pair and a date, and a second save changes it', async () => {
    const request = { from: 'USD', to: 'VND', date: '2016-12-10' };
    await saveRates({
      rates: [{ ...request, rate: 22750 }],
      source: 'frankfurter',
    });
    await saveRates({ rates: [{ ...request, rate: 22760 }], source: 'manual' });

    expect(await storedRateCount()).toBe(1);
    expect(await getStoredRate(request)).toMatchObject({
      rate: 22760,
      source: 'manual',
    });
  });

  it('brings a deleted row back', async () => {
    const request = { from: 'USD', to: 'VND', date: '2016-12-10' };
    await saveRates({ rates: [{ ...request, rate: 22750 }], source: 'manual' });
    await db.update('exchange_rates', { id: rateId(request), tombstone: 1 });
    expect(await getStoredRate(request)).toBeNull();

    await saveRates({ rates: [{ ...request, rate: 22750 }], source: 'manual' });
    expect(await getStoredRate(request)).toMatchObject({ rate: 22750 });
  });
});

describe('fetchFrankfurterRates', () => {
  function answer(body: unknown, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }

  const range = {
    from: 'USD',
    to: 'VND',
    start: '2016-12-09',
    end: '2016-12-10',
  };

  it('asks for one pair and a range, and follows a redirect', async () => {
    fetchImpl.mockResolvedValue(
      answer([
        { date: '2016-12-09', base: 'USD', quote: 'VND', rate: 22700 },
        { date: '2016-12-10', base: 'USD', quote: 'VND', rate: 22750 },
      ]),
    );

    const rates = await fetchFrankfurterRates({ ...range, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(
      'https://api.frankfurter.dev/v2/rates?base=USD&quotes=VND&from=2016-12-09&to=2016-12-10',
    );
    expect(options).toEqual({ redirect: 'follow' });
    expect(rates).toEqual([
      { from: 'USD', to: 'VND', date: '2016-12-09', rate: 22700 },
      { from: 'USD', to: 'VND', date: '2016-12-10', rate: 22750 },
    ]);
  });

  it('drops rows that are not a rate of the pair', async () => {
    fetchImpl.mockResolvedValue(
      answer([
        { date: '2016-12-09', base: 'USD', quote: 'VND', rate: 22700 },
        { date: '2016-12-09', base: 'USD', quote: 'EUR', rate: 0.94 },
        { date: '2016-12-10', base: 'USD', quote: 'VND', rate: 0 },
        { date: '10 Dec 2016', base: 'USD', quote: 'VND', rate: 22750 },
        { date: '2016-12-11', base: 'USD', quote: 'VND', rate: '22800' },
        null,
      ]),
    );

    expect(await fetchFrankfurterRates({ ...range, fetchImpl })).toEqual([
      { from: 'USD', to: 'VND', date: '2016-12-09', rate: 22700 },
    ]);
  });

  it('fails on an error status and on an answer that is not a list', async () => {
    fetchImpl.mockResolvedValue(answer(null, 503));
    await expect(
      fetchFrankfurterRates({ ...range, fetchImpl }),
    ).rejects.toThrow('status 503');

    fetchImpl.mockResolvedValue(answer({ message: 'not found' }));
    await expect(
      fetchFrankfurterRates({ ...range, fetchImpl }),
    ).rejects.toThrow('not a list');
  });
});

describe('ensureRates', () => {
  it('does not download while the user did not turn the download on', async () => {
    const request = { from: 'USD', to: 'VND', date: '2016-12-10' };

    expect(await ensureRates({ requests: [request], fetchRates })).toEqual({
      missing: [request],
    });
    expect(fetchRates).not.toHaveBeenCalled();
  });

  it('downloads one range for a pair and stores only the dates that were asked for', async () => {
    await turnDownloadOn();
    fetchRates.mockResolvedValue(
      usdRates([
        { date: '2016-12-05', rate: 22600 },
        { date: '2016-12-06', rate: 22620 },
        { date: '2016-12-07', rate: 22640 },
        { date: '2016-12-08', rate: 22660 },
      ]),
    );

    const result = await ensureRates({
      requests: [
        { from: 'USD', to: 'VND', date: '2016-12-08' },
        { from: 'USD', to: 'VND', date: '2016-12-05' },
        { from: 'USD', to: 'VND', date: '2016-12-05' },
        { from: 'VND', to: 'VND', date: '2016-12-05' },
      ],
      fetchRates,
    });

    expect(result).toEqual({ missing: [] });
    expect(fetchRates).toHaveBeenCalledTimes(1);
    expect(fetchRates).toHaveBeenCalledWith({
      from: 'USD',
      to: 'VND',
      start: '2016-12-05',
      end: '2016-12-08',
    });
    expect(await storedRateCount()).toBe(2);
    expect(
      await getStoredRate({
        from: 'USD',
        to: 'VND',
        date: '2016-12-08',
        maxDays: 0,
      }),
    ).toMatchObject({ rate: 22660, source: 'frankfurter' });
  });

  it('does not download a rate that is already stored', async () => {
    await turnDownloadOn();
    const request = { from: 'USD', to: 'VND', date: '2016-12-10' };
    await saveRates({ rates: [{ ...request, rate: 22755 }], source: 'manual' });

    expect(await ensureRates({ requests: [request], fetchRates })).toEqual({
      missing: [],
    });
    expect(fetchRates).not.toHaveBeenCalled();
    expect(await getStoredRate(request)).toMatchObject({
      rate: 22755,
      source: 'manual',
    });
  });

  it('reports a request with no usable rate when the download fails', async () => {
    await turnDownloadOn();
    fetchRates.mockRejectedValue(new Error('offline'));
    const request = { from: 'USD', to: 'VND', date: '2016-12-10' };

    expect(await ensureRates({ requests: [request], fetchRates })).toEqual({
      missing: [request],
    });
  });

  it('accepts the nearest stored rate when the download fails', async () => {
    await turnDownloadOn();
    fetchRates.mockRejectedValue(new Error('offline'));
    await saveRates({
      rates: [{ from: 'USD', to: 'VND', date: '2016-12-08', rate: 22700 }],
      source: 'frankfurter',
    });

    expect(
      await ensureRates({
        requests: [{ from: 'USD', to: 'VND', date: '2016-12-10' }],
        fetchRates,
      }),
    ).toEqual({ missing: [] });
  });

  it('asks for today when the date is after today', async () => {
    await turnDownloadOn();
    fetchRates.mockResolvedValue(usdRates([{ date: TODAY, rate: 22790 }]));

    const request = { from: 'USD', to: 'VND', date: '2017-03-01' };
    expect(await ensureRates({ requests: [request], fetchRates })).toEqual({
      missing: [],
    });
    expect(fetchRates).toHaveBeenCalledWith({
      from: 'USD',
      to: 'VND',
      start: TODAY,
      end: TODAY,
    });
  });
});

describe('refreshRatesOfToday', () => {
  async function addAccount(id: string, currency: string | null) {
    await db.insertAccount({ id, name: id, currency });
  }

  it('gets the rate of today for each foreign currency of an open account', async () => {
    await turnDownloadOn();
    await db.update('preferences', { id: 'defaultCurrencyCode', value: 'VND' });
    await addAccount('cash', null);
    await addAccount('bank', 'VND');
    await addAccount('wise-usd', 'USD');
    fetchRates.mockResolvedValue(usdRates([{ date: TODAY, rate: 22790 }]));

    await refreshRatesOfToday({ fetchRates });

    expect(fetchRates).toHaveBeenCalledTimes(1);
    expect(fetchRates).toHaveBeenCalledWith({
      from: 'USD',
      to: 'VND',
      start: TODAY,
      end: TODAY,
    });
    expect(
      await getStoredRate({ from: 'USD', to: 'VND', date: TODAY, maxDays: 0 }),
    ).toMatchObject({ rate: 22790 });
  });

  it('does nothing while the budget has no base currency', async () => {
    await turnDownloadOn();
    await addAccount('wise-usd', 'USD');

    await refreshRatesOfToday({ fetchRates });

    expect(fetchRates).not.toHaveBeenCalled();
  });

  it('waits some minutes after a failed try', async () => {
    await turnDownloadOn();
    await db.update('preferences', { id: 'defaultCurrencyCode', value: 'VND' });
    await addAccount('wise-usd', 'USD');
    fetchRates.mockRejectedValue(new Error('offline'));

    const start = 1_000_000_000;
    await refreshRatesOfToday({ now: start, fetchRates });
    await refreshRatesOfToday({ now: start + 60 * 1000, fetchRates });
    expect(fetchRates).toHaveBeenCalledTimes(1);

    await refreshRatesOfToday({ now: start + 11 * 60 * 1000, fetchRates });
    expect(fetchRates).toHaveBeenCalledTimes(2);
  });
});
