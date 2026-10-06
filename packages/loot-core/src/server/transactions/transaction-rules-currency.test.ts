import { aqlQuery } from '#server/aql';
import { saveRates } from '#server/currencies/rates';
import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import { findSchedules } from '#server/schedules/find-schedules';
import { q } from '#shared/query';
import type { TransactionEntity } from '#types/models';

import {
  applyActions,
  conditionsToAQL,
  getRunningBalanceBeforeTransaction,
  insertRule,
  loadRules,
  resetState,
  runRules,
} from './transaction-rules';
import type { AmountField } from './transaction-rules';

import { batchUpdateTransactions } from './index';

// The budget is in VND, stored times 100, and one USD is 25,000 VND. So
// 10.00 USD is 1000 in the account and 25000000 in the budget.
//
// The tests run with a fixed clock on 2017-01-01, so all dates are
// before that day.
const DAY = '2016-12-10';
const NEXT_DAY = '2016-12-11';

type Row = {
  id: string;
  amount: number;
  native_amount: number | null;
  notes: string | null;
};

function storedRows(where: string, params: string[]) {
  return db.all<Row>(
    `SELECT id, amount, native_amount, notes FROM transactions
      WHERE ${where} AND tombstone = 0 ORDER BY native_amount DESC`,
    params,
  );
}

async function loadTransaction(id: string): Promise<TransactionEntity> {
  const { data } = await aqlQuery(
    q('transactions').filter({ id }).select('*').options({ splits: 'none' }),
  );
  return data[0];
}

async function addAccount(id: string, currency: string | null) {
  await db.insertAccount({ id, name: id, currency });
  await db.insertPayee({ id: 'to-' + id, name: '', transfer_acct: id });
}

async function findIds(conditions: unknown[], amountField?: AmountField) {
  const { filters } = conditionsToAQL(conditions, { amountField });
  const { data } = await aqlQuery(
    q('transactions').filter({ $and: filters }).select('id'),
  );
  return data.map((row: { id: string }) => row.id).sort();
}

beforeEach(async () => {
  await global.emptyDatabase()();
  resetState();
  await loadMappings();
  await loadRules();

  await db.update('preferences', { id: 'defaultCurrencyCode', value: 'VND' });
  await addAccount('cash', null);
  await addAccount('wise-usd', 'USD');
  await saveRates({
    rates: [
      { from: 'USD', to: 'VND', date: DAY, rate: 25000 },
      { from: 'USD', to: 'VND', date: NEXT_DAY, rate: 25000 },
    ],
    source: 'manual',
  });
});

describe('runRules for a foreign currency account', () => {
  beforeEach(async () => {
    await insertRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'amount', value: -1000 }],
      actions: [{ op: 'set', field: 'notes', value: 'ten of them' }],
    });
  });

  it('reads the one number of an imported row as it is', async () => {
    const result = await runRules({
      account: 'wise-usd',
      date: DAY,
      amount: -1000,
    });

    expect(result).toMatchObject({ amount: -1000, notes: 'ten of them' });
    expect(result).not.toHaveProperty('native_amount');
    expect(result).not.toHaveProperty('_base_amount');
  });

  it('compares the amount in the currency of the account, and keeps the base value', async () => {
    const result = await runRules({
      account: 'wise-usd',
      date: DAY,
      amount: -25000000,
      native_amount: -1000,
    });

    expect(result).toMatchObject({
      amount: -25000000,
      native_amount: -1000,
      notes: 'ten of them',
    });
    expect(result).not.toHaveProperty('_base_amount');
  });

  it('does not compare the base value of a foreign row', async () => {
    const result = await runRules({
      account: 'wise-usd',
      date: DAY,
      amount: -1000,
      native_amount: -4,
    });

    expect(result.notes).toBeUndefined();
  });

  it('compares the amount of a row in a base currency account, as before', async () => {
    const result = await runRules({
      account: 'cash',
      date: DAY,
      amount: -1000,
      native_amount: -1000,
    });

    expect(result).toMatchObject({ amount: -1000, notes: 'ten of them' });
  });

  it('puts an amount that a rule sets into the native amount', async () => {
    await insertRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'imported_payee', value: 'Netflix' }],
      actions: [{ op: 'set', field: 'amount', value: -1599 }],
    });

    const result = await runRules({
      account: 'wise-usd',
      date: DAY,
      imported_payee: 'Netflix',
      amount: -30000000,
      native_amount: -1200,
    });

    // The base value is the stored one. The write path calculates it
    // again, because the native amount is different.
    expect(result).toMatchObject({ amount: -30000000, native_amount: -1599 });
  });
});

describe('applyActions for a foreign currency account', () => {
  beforeEach(async () => {
    await batchUpdateTransactions({
      added: [{ id: 't1', account: 'wise-usd', date: DAY, amount: -1001 }],
    });
  });

  it('converts an amount that an action sets', async () => {
    expect(await storedRows('id = ?', ['t1'])).toEqual([
      expect.objectContaining({ amount: -25025000, native_amount: -1001 }),
    ]);

    await applyActions(
      [await loadTransaction('t1')],
      [{ op: 'set', field: 'amount', value: -1599 }],
    );

    expect(await storedRows('id = ?', ['t1'])).toEqual([
      expect.objectContaining({ amount: -39975000, native_amount: -1599 }),
    ]);
  });

  it('leaves the two amounts when an action changes a different field', async () => {
    await applyActions(
      [await loadTransaction('t1')],
      [{ op: 'set', field: 'notes', value: 'checked' }],
    );

    expect(await storedRows('id = ?', ['t1'])).toEqual([
      { id: 't1', amount: -25025000, native_amount: -1001, notes: 'checked' },
    ]);
  });

  it('splits the amount in the currency of the account', async () => {
    await applyActions(
      [await loadTransaction('t1')],
      [
        {
          op: 'set-split-amount',
          value: 50,
          options: { method: 'fixed-percent', splitIndex: 1 },
        },
        {
          op: 'set-split-amount',
          value: null,
          options: { method: 'remainder', splitIndex: 2 },
        },
      ],
    );

    // Half of 10.01 USD is 5.00 or 5.01, and each part has its value
    expect(await storedRows('parent_id = ?', ['t1'])).toEqual([
      expect.objectContaining({ amount: -12500000, native_amount: -500 }),
      expect.objectContaining({ amount: -12525000, native_amount: -501 }),
    ]);
    expect(await storedRows('id = ?', ['t1'])).toEqual([
      expect.objectContaining({ amount: -25025000, native_amount: -1001 }),
    ]);
  });
});

describe('a transfer into a foreign currency account', () => {
  it('runs the rules of the other side with the amount of that account', async () => {
    await insertRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [
        { op: 'is', field: 'account', value: 'wise-usd' },
        { op: 'is', field: 'amount', value: 1000 },
      ],
      actions: [{ op: 'set', field: 'notes', value: 'ten dollars in' }],
    });

    await batchUpdateTransactions({
      added: [
        {
          id: 'out',
          account: 'cash',
          date: DAY,
          amount: -25500000,
          payee: 'to-wise-usd',
          _transfer_native_amount: 1000,
        },
      ],
    });

    expect(await storedRows('acct = ?', ['wise-usd'])).toEqual([
      expect.objectContaining({
        amount: 25500000,
        native_amount: 1000,
        notes: 'ten dollars in',
      }),
    ]);
  });
});

describe('the running balance for rules', () => {
  it('is in the currency of the account', async () => {
    await batchUpdateTransactions({
      added: [
        { id: 'u1', account: 'wise-usd', date: DAY, amount: 5000 },
        { id: 'u2', account: 'wise-usd', date: DAY, amount: -1000 },
        { id: 'c1', account: 'cash', date: DAY, amount: 700000 },
      ],
    });
    const later = { id: 'new', date: NEXT_DAY, account: 'wise-usd', amount: 0 };

    expect(await getRunningBalanceBeforeTransaction(later, 'wise-usd')).toBe(
      4000,
    );
    expect(await getRunningBalanceBeforeTransaction(later, 'cash')).toBe(
      700000,
    );
  });
});

describe('conditionsToAQL with an amount field', () => {
  beforeEach(async () => {
    await batchUpdateTransactions({
      added: [
        { id: 'usd', account: 'wise-usd', date: DAY, amount: -1000 },
        { id: 'vnd', account: 'cash', date: DAY, amount: -25000000 },
      ],
    });
  });

  it('compares the base value by default, for the reports', async () => {
    expect(
      await findIds([{ op: 'is', field: 'amount', value: -25000000 }]),
    ).toEqual(['usd', 'vnd']);
    expect(
      await findIds([{ op: 'is', field: 'amount', value: -1000 }]),
    ).toEqual([]);
  });

  it('compares the amount of the account for a rule or a schedule', async () => {
    expect(
      await findIds(
        [{ op: 'is', field: 'amount', value: -25000000 }],
        'native_amount',
      ),
    ).toEqual(['vnd']);
    expect(
      await findIds(
        [{ op: 'is', field: 'amount', value: -1000 }],
        'native_amount',
      ),
    ).toEqual(['usd']);
  });

  it('uses the same field for the direction of the money', async () => {
    const outflow = {
      op: 'is',
      field: 'amount',
      value: 1000,
      options: { outflow: true },
    };
    const inflow = { ...outflow, options: { inflow: true } };

    expect(await findIds([outflow], 'native_amount')).toEqual(['usd']);
    expect(await findIds([inflow], 'native_amount')).toEqual([]);
    expect(await findIds([outflow])).toEqual([]);
  });
});

describe('findSchedules for a foreign currency account', () => {
  it('finds a bill by its amount in the account, while its base value changes', async () => {
    const days = ['2016-10-15', '2016-11-15', '2016-12-15'];
    await saveRates({
      rates: [
        { from: 'USD', to: 'VND', date: days[0], rate: 20000 },
        { from: 'USD', to: 'VND', date: days[1], rate: 25000 },
        { from: 'USD', to: 'VND', date: days[2], rate: 30000 },
      ],
      source: 'manual',
    });
    await db.insertPayee({ id: 'netflix', name: 'Netflix' });
    await batchUpdateTransactions({
      added: days.map((date, index) => ({
        id: 'bill-' + index,
        account: 'wise-usd',
        date,
        amount: -1599,
        payee: 'netflix',
      })),
    });
    expect(await storedRows('acct = ?', ['wise-usd'])).toEqual([
      expect.objectContaining({ amount: -31980000, native_amount: -1599 }),
      expect.objectContaining({ amount: -39975000, native_amount: -1599 }),
      expect.objectContaining({ amount: -47970000, native_amount: -1599 }),
    ]);

    const schedules = await findSchedules();

    expect(schedules).toEqual([
      expect.objectContaining({
        account: 'wise-usd',
        payee: 'netflix',
        amount: -1599,
        _conditions: expect.arrayContaining([
          { op: 'is', field: 'amount', value: -1599 },
        ]),
      }),
    ]);
  });
});
