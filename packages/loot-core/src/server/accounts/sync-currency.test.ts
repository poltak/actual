import { saveRates } from '#server/currencies/rates';
import * as db from '#server/db';

import { addTransactions, reconcileTransactions } from './sync';

// The budget is in VND, stored times 100, and one USD is 25,000 VND.
// The tests run with a fixed clock on 2017-01-01.
const DAY = '2016-12-10';

type Row = { amount: number; native_amount: number | null };

function rows(account: string) {
  return db.all<Row>(
    `SELECT amount, native_amount FROM transactions
      WHERE acct = ? AND tombstone = 0 ORDER BY amount`,
    [account],
  );
}

beforeEach(global.emptyDatabase());
beforeEach(async () => {
  await db.update('preferences', { id: 'defaultCurrencyCode', value: 'VND' });
  await db.insertAccount({ id: 'cash', name: 'cash' });
  await db.insertAccount({ id: 'wise-usd', name: 'wise-usd', currency: 'USD' });
  await saveRates({
    rates: [{ from: 'USD', to: 'VND', date: DAY, rate: 25000 }],
    source: 'manual',
  });
});

describe('addTransactions for a foreign currency account', () => {
  it('reads the amounts as amounts of the account, with and without transfers', async () => {
    // With transfers off, the rows skip the normal write path
    await addTransactions(
      'wise-usd',
      [{ date: DAY, amount: -1000, payee_name: 'Coffee' }],
      { runTransfers: false },
    );
    await addTransactions('wise-usd', [
      { date: DAY, amount: -2000, payee_name: 'Books' },
    ]);

    expect(await rows('wise-usd')).toEqual([
      { amount: -50000000, native_amount: -2000 },
      { amount: -25000000, native_amount: -1000 },
    ]);
  });

  it('leaves the rows of a base currency account as they are', async () => {
    await addTransactions(
      'cash',
      [{ date: DAY, amount: -500000, payee_name: 'Market' }],
      { runTransfers: false },
    );

    expect(await rows('cash')).toEqual([
      { amount: -500000, native_amount: null },
    ]);
  });
});

describe('reconcileTransactions for a foreign currency account', () => {
  it('finds a row of an earlier import by its amount in the account currency', async () => {
    const fileRows = [
      {
        date: DAY,
        amount: -1000,
        imported_payee: 'Coffee',
        payee_name: 'Coffee',
      },
    ];

    const first = await reconcileTransactions('wise-usd', fileRows);
    expect(first.added.length).toBe(1);
    expect(await rows('wise-usd')).toEqual([
      { amount: -25000000, native_amount: -1000 },
    ]);

    // The same file a second time must not add the row again. The
    // stored base value is 25000000, and the file says 1000.
    const second = await reconcileTransactions('wise-usd', fileRows);
    expect(second.added.length).toBe(0);
    expect(await rows('wise-usd')).toEqual([
      { amount: -25000000, native_amount: -1000 },
    ]);
  });
});
