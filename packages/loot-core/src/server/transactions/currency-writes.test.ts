import { MissingRateError } from '#server/currencies/plan';
import { saveRates } from '#server/currencies/rates';
import * as db from '#server/db';

import { batchUpdateTransactions } from './index';

// The budget is in VND. Integers are minor units, and VND is stored
// times 100, so 250,000.00 VND is 25000000 and 10.00 USD is 1000.
//
// The tests run with a fixed clock on 2017-01-01, and a date after that
// uses the rate of that day. So all dates here are in December 2016.
const DAY = '2016-12-10';
const NEXT_DAY = '2016-12-11';

type Row = {
  id: string;
  acct: string;
  amount: number;
  native_amount: number | null;
  amount_locked: number | null;
  transferred_id: string | null;
};

async function row(id: string): Promise<Row> {
  const found = await db.first<Row>(
    `SELECT id, acct, amount, native_amount, amount_locked, transferred_id
       FROM transactions WHERE id = ?`,
    [id],
  );
  if (!found) {
    throw new Error('No transaction ' + id);
  }
  return found;
}

async function otherSide(id: string): Promise<Row> {
  const { transferred_id: otherId } = await row(id);
  if (!otherId) {
    throw new Error('Transaction ' + id + ' is not a transfer');
  }
  return row(otherId);
}

async function addAccount(id: string, currency: string | null) {
  await db.insertAccount({ id, name: id, currency });
  await db.insertPayee({ id: 'to-' + id, name: '', transfer_acct: id });
}

async function prepareBudget() {
  await db.update('preferences', { id: 'defaultCurrencyCode', value: 'VND' });
  await addAccount('cash', null);
  await addAccount('bank', 'VND');
  await addAccount('wise-usd', 'USD');
  await addAccount('wise-usd-2', 'USD');
  await addAccount('wise-eur', 'EUR');
  await saveRates({
    rates: [
      { from: 'USD', to: 'VND', date: DAY, rate: 25000 },
      { from: 'USD', to: 'VND', date: NEXT_DAY, rate: 25100 },
      { from: 'EUR', to: 'VND', date: DAY, rate: 29000 },
    ],
    source: 'manual',
  });
}

beforeEach(global.emptyDatabase());

describe('a budget with no foreign currency account', () => {
  it('writes no currency fields, also when a caller sends them', async () => {
    await addAccount('cash', null);

    await batchUpdateTransactions({
      added: [
        {
          id: 't1',
          account: 'cash',
          amount: -5000,
          native_amount: -5000,
          amount_locked: false,
          date: DAY,
        },
      ],
    });
    await batchUpdateTransactions({
      updated: [{ id: 't1', amount: -6000, native_amount: -5000 }],
    });

    expect(await row('t1')).toMatchObject({
      amount: -6000,
      native_amount: null,
      amount_locked: null,
    });
  });

  it('treats an account with a currency as a base account while the budget has no currency', async () => {
    await addAccount('wise-usd', 'USD');

    await batchUpdateTransactions({
      added: [{ id: 't1', account: 'wise-usd', amount: -1000, date: DAY }],
    });

    expect(await row('t1')).toMatchObject({
      amount: -1000,
      native_amount: null,
    });
  });
});

describe('a transaction in a foreign currency account', () => {
  beforeEach(prepareBudget);

  it('gets its base value from the stored rate', async () => {
    // A caller that knows no currencies sends the amount of the account
    await batchUpdateTransactions({
      added: [{ id: 't1', account: 'wise-usd', amount: -1000, date: DAY }],
    });

    expect(await row('t1')).toMatchObject({
      amount: -25000000,
      native_amount: -1000,
      amount_locked: null,
    });
  });

  it('leaves a row in a base currency account as it is', async () => {
    await batchUpdateTransactions({
      added: [
        { id: 't1', account: 'cash', amount: -5000000, date: DAY },
        { id: 't2', account: 'bank', amount: -7000000, date: DAY },
      ],
    });

    expect(await row('t1')).toMatchObject({
      amount: -5000000,
      native_amount: null,
    });
    expect(await row('t2')).toMatchObject({
      amount: -7000000,
      native_amount: null,
    });
  });

  it('stops the write when no rate is stored, and writes nothing', async () => {
    const write = batchUpdateTransactions({
      added: [
        { id: 't1', account: 'cash', amount: -5000000, date: '2016-11-01' },
        { id: 't2', account: 'wise-usd', amount: -1000, date: '2016-11-01' },
      ],
    });

    await expect(write).rejects.toBeInstanceOf(MissingRateError);
    await expect(write).rejects.toMatchObject({
      meta: { from: 'USD', to: 'VND', date: '2016-11-01' },
    });
    expect(await db.all('SELECT id FROM transactions')).toEqual([]);
  });

  it('calculates the base value again when the native amount or the date changes', async () => {
    await batchUpdateTransactions({
      added: [{ id: 't1', account: 'wise-usd', amount: -1000, date: DAY }],
    });

    await batchUpdateTransactions({
      updated: [{ id: 't1', native_amount: -1200 }],
      amountSemantics: 'explicit',
    });
    expect(await row('t1')).toMatchObject({
      amount: -30000000,
      native_amount: -1200,
    });

    await batchUpdateTransactions({ updated: [{ id: 't1', date: NEXT_DAY }] });
    expect(await row('t1')).toMatchObject({
      amount: -30120000,
      native_amount: -1200,
    });
  });

  it('keeps the base value when a different field changes', async () => {
    await batchUpdateTransactions({
      added: [{ id: 't1', account: 'wise-usd', amount: -1000, date: DAY }],
    });
    // The rate of that day changes after the entry
    await saveRates({
      rates: [{ from: 'USD', to: 'VND', date: DAY, rate: 26000 }],
      source: 'manual',
    });

    await batchUpdateTransactions({ updated: [{ id: 't1', notes: 'coffee' }] });

    expect(await row('t1')).toMatchObject({
      amount: -25000000,
      native_amount: -1000,
    });
  });

  it('locks a base value that the write brings, and keeps it through a date change', async () => {
    await batchUpdateTransactions({
      added: [{ id: 't1', account: 'wise-usd', amount: -1000, date: DAY }],
    });

    await batchUpdateTransactions({
      updated: [{ id: 't1', amount: -25480000 }],
      amountSemantics: 'explicit',
    });
    expect(await row('t1')).toMatchObject({
      amount: -25480000,
      native_amount: -1000,
      amount_locked: 1,
    });

    await batchUpdateTransactions({ updated: [{ id: 't1', date: NEXT_DAY }] });
    expect(await row('t1')).toMatchObject({
      amount: -25480000,
      amount_locked: 1,
    });

    await batchUpdateTransactions({
      updated: [{ id: 't1', amount_locked: false }],
      amountSemantics: 'explicit',
    });
    expect(await row('t1')).toMatchObject({
      amount: -25100000,
      amount_locked: 0,
    });
  });

  it('keeps the typed number when the row moves to a base currency account', async () => {
    await batchUpdateTransactions({
      added: [{ id: 't1', account: 'wise-usd', amount: -1000, date: DAY }],
    });

    await batchUpdateTransactions({ updated: [{ id: 't1', account: 'cash' }] });

    expect(await row('t1')).toMatchObject({
      acct: 'cash',
      amount: -1000,
      native_amount: null,
    });
  });

  it('makes a split parent the sum of its children', async () => {
    await saveRates({
      rates: [{ from: 'USD', to: 'VND', date: DAY, rate: 25000.5 }],
      source: 'manual',
    });

    // 3.33 + 3.33 + 3.34 USD. Each part rounds on its own, so the parts
    // add up to 25000501 and 10.00 USD alone gives 25000500.
    await batchUpdateTransactions({
      added: [
        {
          id: 'parent',
          account: 'wise-usd',
          amount: -1000,
          date: DAY,
          is_parent: true,
        },
        ...[-333, -333, -334].map((amount, index) => ({
          id: 'child-' + index,
          account: 'wise-usd',
          amount,
          date: DAY,
          is_child: true,
          parent_id: 'parent',
        })),
      ],
    });

    expect(await row('child-0')).toMatchObject({
      amount: -8325167,
      native_amount: -333,
    });
    expect(await row('child-2')).toMatchObject({
      amount: -8350167,
      native_amount: -334,
    });
    expect(await row('parent')).toMatchObject({
      amount: -25000501,
      native_amount: -1000,
    });

    // A change to one child changes the parent, also when the write
    // does not name the parent
    await batchUpdateTransactions({
      updated: [
        { id: 'child-0', native_amount: -433 },
        { id: 'parent', native_amount: -1100 },
      ],
      amountSemantics: 'explicit',
    });
    expect(await row('parent')).toMatchObject({
      amount: -10825217 - 8325167 - 8350167,
      native_amount: -1100,
    });
  });
});

describe('a transfer between two currencies', () => {
  beforeEach(prepareBudget);

  it('keeps the two real amounts when the money goes to a base currency account', async () => {
    // 1,988.99 USD out, 50,729,873 VND in
    await batchUpdateTransactions({
      added: [
        {
          id: 'out',
          account: 'wise-usd',
          payee: 'to-bank',
          native_amount: -198899,
          amount: -5072987300,
          date: DAY,
        },
      ],
      amountSemantics: 'explicit',
    });

    expect(await row('out')).toMatchObject({
      amount: -5072987300,
      native_amount: -198899,
    });
    expect(await otherSide('out')).toMatchObject({
      acct: 'bank',
      amount: 5072987300,
      native_amount: null,
    });
  });

  it('lets the side in the base currency decide the base value', async () => {
    await batchUpdateTransactions({
      added: [
        {
          id: 'out',
          account: 'wise-usd',
          payee: 'to-bank',
          amount: -198899,
          date: DAY,
        },
      ],
    });
    // With no real amount, the rate gives the first value
    expect(await otherSide('out')).toMatchObject({ amount: 4972475000 });
    const { id: inId } = await otherSide('out');

    // The user types the real amount in the VND account
    await batchUpdateTransactions({
      updated: [{ id: inId, amount: 5072987300 }],
    });
    expect(await row('out')).toMatchObject({
      amount: -5072987300,
      native_amount: -198899,
    });

    // A new USD amount does not change the VND value
    await batchUpdateTransactions({
      updated: [{ id: 'out', native_amount: -199000 }],
      amountSemantics: 'explicit',
    });
    expect(await row('out')).toMatchObject({
      amount: -5072987300,
      native_amount: -199000,
    });
    expect(await row(inId)).toMatchObject({
      amount: 5072987300,
      native_amount: null,
    });

    // A new date does not change it either, also with a new rate that day
    await batchUpdateTransactions({ updated: [{ id: 'out', date: NEXT_DAY }] });
    expect(await row('out')).toMatchObject({ amount: -5072987300 });
  });

  it('gives the foreign side its amount when the money comes from a base currency account', async () => {
    // 25,000,000 VND out. The user knows that 995.00 USD arrived.
    await batchUpdateTransactions({
      added: [
        {
          id: 'known',
          account: 'bank',
          payee: 'to-wise-usd',
          amount: -2500000000,
          date: DAY,
          _transfer_native_amount: 99500,
        },
        // Here the user does not know it yet, so the rate gives 1,000.00 USD
        {
          id: 'estimated',
          account: 'bank',
          payee: 'to-wise-usd',
          amount: -2500000000,
          date: DAY,
        },
      ],
    });

    expect(await row('known')).toMatchObject({
      amount: -2500000000,
      native_amount: null,
    });
    expect(await otherSide('known')).toMatchObject({
      acct: 'wise-usd',
      amount: 2500000000,
      native_amount: 99500,
    });
    expect(await otherSide('estimated')).toMatchObject({
      amount: 2500000000,
      native_amount: 100000,
    });

    // The user corrects the USD amount later. The VND value stays.
    const { id: usdSide } = await otherSide('estimated');
    await batchUpdateTransactions({
      updated: [{ id: usdSide, native_amount: 99800 }],
      amountSemantics: 'explicit',
    });
    expect(await row(usdSide)).toMatchObject({
      amount: 2500000000,
      native_amount: 99800,
    });
    expect(await row('estimated')).toMatchObject({ amount: -2500000000 });
  });

  it('stops before the first side is written when the other side needs a rate that is not stored', async () => {
    const write = batchUpdateTransactions({
      added: [
        {
          id: 'out',
          account: 'bank',
          payee: 'to-wise-usd',
          amount: -2500000000,
          date: '2016-11-01',
        },
      ],
    });

    await expect(write).rejects.toBeInstanceOf(MissingRateError);
    expect(await db.all('SELECT id FROM transactions')).toEqual([]);
  });

  it('lets the side that the money leaves decide when no side is in the base currency', async () => {
    // 227.30 EUR out, 239.02 USD in
    await batchUpdateTransactions({
      added: [
        {
          id: 'out',
          account: 'wise-eur',
          payee: 'to-wise-usd',
          amount: -22730,
          date: DAY,
          _transfer_native_amount: 23902,
        },
      ],
    });

    // 227.30 EUR at 29,000 VND
    expect(await row('out')).toMatchObject({
      amount: -659170000,
      native_amount: -22730,
    });
    expect(await otherSide('out')).toMatchObject({
      acct: 'wise-usd',
      amount: 659170000,
      native_amount: 23902,
    });

    // A change on the USD side does not move the base value
    const { id: inId } = await otherSide('out');
    await batchUpdateTransactions({
      updated: [{ id: inId, native_amount: 24000 }],
      amountSemantics: 'explicit',
    });
    expect(await row(inId)).toMatchObject({
      amount: 659170000,
      native_amount: 24000,
    });
    expect(await row('out')).toMatchObject({ amount: -659170000 });

    // A change on the EUR side does, and the USD amount stays
    await batchUpdateTransactions({
      updated: [{ id: 'out', native_amount: -20000 }],
      amountSemantics: 'explicit',
    });
    expect(await row('out')).toMatchObject({
      amount: -580000000,
      native_amount: -20000,
    });
    expect(await row(inId)).toMatchObject({
      amount: 580000000,
      native_amount: 24000,
    });
  });

  it('copies the native amount between two accounts in the same foreign currency', async () => {
    await batchUpdateTransactions({
      added: [
        {
          id: 'out',
          account: 'wise-usd',
          payee: 'to-wise-usd-2',
          amount: -1000,
          date: DAY,
        },
      ],
    });
    expect(await otherSide('out')).toMatchObject({
      acct: 'wise-usd-2',
      amount: 25000000,
      native_amount: 1000,
    });

    await batchUpdateTransactions({
      updated: [{ id: 'out', native_amount: -1500 }],
      amountSemantics: 'explicit',
    });
    expect(await row('out')).toMatchObject({
      amount: -37500000,
      native_amount: -1500,
    });
    expect(await otherSide('out')).toMatchObject({
      amount: 37500000,
      native_amount: 1500,
    });
  });

  it('drops the native amount when the other side moves to a base currency account', async () => {
    await batchUpdateTransactions({
      added: [
        {
          id: 'out',
          account: 'bank',
          payee: 'to-wise-usd',
          amount: -2500000000,
          date: DAY,
        },
      ],
    });
    expect(await otherSide('out')).toMatchObject({ native_amount: 100000 });

    // The user changes the payee: the money went to cash, not to Wise
    await batchUpdateTransactions({
      updated: [{ id: 'out', payee: 'to-cash' }],
    });

    expect(await otherSide('out')).toMatchObject({
      acct: 'cash',
      amount: 2500000000,
      native_amount: null,
    });
  });

  it('gives two rows one base value when a write links them as a transfer', async () => {
    // The user typed the two sides as two rows, and then picks "Make transfer"
    await batchUpdateTransactions({
      added: [
        { id: 'out', account: 'wise-usd', amount: -1000, date: DAY },
        { id: 'in', account: 'bank', amount: 2600000000, date: DAY },
      ],
    });
    expect(await row('out')).toMatchObject({ amount: -25000000 });

    await batchUpdateTransactions({
      updated: [
        { id: 'out', payee: 'to-bank', transfer_id: 'in' },
        { id: 'in', payee: 'to-wise-usd', transfer_id: 'out' },
      ],
      runTransfers: false,
    });

    // The side in the base currency decides
    expect(await row('in')).toMatchObject({
      amount: 2600000000,
      native_amount: null,
    });
    expect(await row('out')).toMatchObject({
      amount: -2600000000,
      native_amount: -1000,
    });
  });

  it('gives two rows in the same foreign currency one base value when a write links them', async () => {
    // The two rows have two dates, so the rate gave them two base values
    await batchUpdateTransactions({
      added: [
        { id: 'out', account: 'wise-usd', amount: -1000, date: DAY },
        { id: 'in', account: 'wise-usd-2', amount: 1000, date: NEXT_DAY },
      ],
    });
    expect(await row('in')).toMatchObject({ amount: 25100000 });

    await batchUpdateTransactions({
      updated: [
        { id: 'out', payee: 'to-wise-usd-2', transfer_id: 'in' },
        { id: 'in', payee: 'to-wise-usd', transfer_id: 'out' },
      ],
      runTransfers: false,
    });

    // The side that the money leaves decides
    expect(await row('out')).toMatchObject({
      amount: -25000000,
      native_amount: -1000,
    });
    expect(await row('in')).toMatchObject({
      amount: 25000000,
      native_amount: 1000,
    });
  });
});
