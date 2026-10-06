import MockDate from 'mockdate';

import { saveRates } from '#server/currencies/rates';
import type { FetchRates } from '#server/currencies/rates';
import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import { loadRules } from '#server/transactions/transaction-rules';

import {
  advanceSchedulesService,
  createSchedule,
  runSchedulesService,
  app as schedulesApp,
} from './app';

// The budget is in VND, stored times 100. The schedule pays 15.99 USD
// each two weeks from 2016-12-05, and today is 2017-01-01. So two
// payments are late: 2016-12-05 and 2016-12-19.
const FIRST = '2016-12-05';
const SECOND = '2016-12-19';

type Row = {
  date: number;
  amount: number;
  native_amount: number | null;
};

function postedFor(scheduleId: string) {
  return db.all<Row>(
    `SELECT date, amount, native_amount FROM transactions
      WHERE schedule = ? AND tombstone = 0 ORDER BY date`,
    [scheduleId],
  );
}

async function addLateSchedule({
  account,
  amount,
}: {
  account: string;
  amount: number;
}) {
  const id = await createSchedule({
    schedule: { posts_transaction: true },
    conditions: [
      { op: 'is', field: 'account', value: account },
      { op: 'is', field: 'amount', value: amount },
      {
        op: 'is',
        field: 'date',
        value: {
          start: FIRST,
          frequency: 'weekly',
          interval: 2,
          patterns: [],
        },
      },
    ],
  });

  const nextDate = await db.first<{ id: string }>(
    'SELECT id FROM schedules_next_date WHERE schedule_id = ?',
    [id],
  );
  if (!nextDate) {
    throw new Error('The schedule has no next date');
  }
  await db.update('schedules_next_date', {
    id: nextDate.id,
    local_next_date: db.toDateRepr(FIRST),
    local_next_date_ts: Date.now(),
    base_next_date: db.toDateRepr(FIRST),
    base_next_date_ts: Date.now(),
  });
  return id;
}

beforeEach(async () => {
  await global.emptyDatabase()();
  await loadMappings();
  await loadRules();

  MockDate.set(new Date(2016, 11, 31, 12));
  schedulesApp.startServices();

  await db.update('preferences', { id: 'defaultCurrencyCode', value: 'VND' });
  await db.insertAccount({ id: 'cash', name: 'cash' });
  await db.insertAccount({ id: 'wise-usd', name: 'wise-usd', currency: 'USD' });
});

afterEach(async () => {
  MockDate.reset();
  await schedulesApp.stopServices();
});

describe('a schedule in a foreign currency account', () => {
  it('posts its amount in the currency of the account, at the rate of each date', async () => {
    await saveRates({
      rates: [
        { from: 'USD', to: 'VND', date: FIRST, rate: 25000 },
        { from: 'USD', to: 'VND', date: SECOND, rate: 26000 },
      ],
      source: 'manual',
    });
    const id = await addLateSchedule({ account: 'wise-usd', amount: -1599 });

    await runSchedulesService({ syncSuccess: true });

    expect(await postedFor(id)).toEqual([
      { date: db.toDateRepr(FIRST), amount: -39975000, native_amount: -1599 },
      { date: db.toDateRepr(SECOND), amount: -41574000, native_amount: -1599 },
    ]);
  });

  it('stays due when a rate is not there, and the other schedules continue', async () => {
    await saveRates({
      rates: [{ from: 'USD', to: 'VND', date: FIRST, rate: 25000 }],
      source: 'manual',
    });
    const usd = await addLateSchedule({ account: 'wise-usd', amount: -1599 });
    const vnd = await addLateSchedule({ account: 'cash', amount: -5000000 });

    const result = await advanceSchedulesService(true);

    expect(result).toEqual({
      missingRates: [{ from: 'USD', to: 'VND', date: SECOND }],
    });
    expect(await postedFor(usd)).toEqual([
      { date: db.toDateRepr(FIRST), amount: -39975000, native_amount: -1599 },
    ]);
    expect(await postedFor(vnd)).toHaveLength(2);
  });

  it('gets the rate between two runs and then posts', async () => {
    await db.update('preferences', {
      id: 'exchangeRateProvider',
      value: 'frankfurter',
    });
    await saveRates({
      rates: [{ from: 'USD', to: 'VND', date: FIRST, rate: 25000 }],
      source: 'manual',
    });
    const id = await addLateSchedule({ account: 'wise-usd', amount: -1599 });
    const fetchRates = vi.fn<FetchRates>(async ({ from, to, start }) => [
      { from, to, date: start, rate: 26000 },
    ]);

    await runSchedulesService({ syncSuccess: true, fetchRates });

    expect(fetchRates).toHaveBeenCalledTimes(1);
    expect(fetchRates).toHaveBeenCalledWith({
      from: 'USD',
      to: 'VND',
      start: SECOND,
      end: SECOND,
    });
    expect(await postedFor(id)).toEqual([
      { date: db.toDateRepr(FIRST), amount: -39975000, native_amount: -1599 },
      { date: db.toDateRepr(SECOND), amount: -41574000, native_amount: -1599 },
    ]);
  });

  it('stops when the download gives no rate', async () => {
    await db.update('preferences', {
      id: 'exchangeRateProvider',
      value: 'frankfurter',
    });
    const id = await addLateSchedule({ account: 'wise-usd', amount: -1599 });
    const fetchRates = vi.fn<FetchRates>(async () => []);

    await runSchedulesService({ syncSuccess: true, fetchRates });

    expect(fetchRates).toHaveBeenCalledTimes(1);
    expect(await postedFor(id)).toEqual([]);
  });
});
