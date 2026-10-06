import type { TransactionEntity } from '@actual-app/core/types/models';

import {
  fromView,
  getRateRequests,
  toDb,
  toDbDiff,
  toView,
} from './accountCurrencyView';

// The budget is in VND, stored times 100. 10.00 USD is 1000 in the
// account and 25000000 in the budget.
function stored(fields: Partial<TransactionEntity> = {}): TransactionEntity {
  return {
    id: 't1',
    account: 'wise-usd',
    date: '2026-10-01',
    amount: -25000000,
    native_amount: -1000,
    ...fields,
  };
}

const foreignCurrencyOf = (account: string | null | undefined) =>
  account === 'wise-usd' ? 'USD' : account === 'wise-eur' ? 'EUR' : null;

describe('toView and fromView', () => {
  it('shows the amount of the account and keeps the value of the budget', () => {
    expect(toView(stored())).toMatchObject({
      amount: -1000,
      base_amount: -25000000,
    });
  });

  it('maps the parts of a split', () => {
    const view = toView(
      stored({
        is_parent: true,
        subtransactions: [
          stored({ id: 'c1', amount: -10000000, native_amount: -400 }),
          stored({ id: 'c2', amount: -15000000, native_amount: -600 }),
        ],
      }),
    );

    expect(view.subtransactions).toEqual([
      expect.objectContaining({ amount: -400, base_amount: -10000000 }),
      expect.objectContaining({ amount: -600, base_amount: -15000000 }),
    ]);
  });

  it('gives the stored form back after a round trip', () => {
    expect(fromView(toView(stored()))).toEqual(stored());
  });

  it('puts a new amount into the native amount, and keeps the old value', () => {
    const edited = { ...toView(stored()), amount: -2000 };

    expect(fromView(edited)).toMatchObject({
      amount: -25000000,
      native_amount: -2000,
    });
    expect(fromView(edited)).not.toHaveProperty('base_amount');
  });
});

describe('toDb', () => {
  it('sends the amount of a full row as the native amount, with no base value', () => {
    const write = toDb({ ...toView(stored()), amount: -2000 });

    expect(write).toMatchObject({ id: 't1', native_amount: -2000 });
    expect(write).not.toHaveProperty('amount');
    expect(write).not.toHaveProperty('base_amount');
  });

  it('adds no amount to a change of a different field', () => {
    expect(toDb({ id: 't1', notes: 'coffee' })).toEqual({
      id: 't1',
      notes: 'coffee',
    });
  });

  it('reads the empty amount of a new row as zero', () => {
    expect(
      toDb({
        id: 'new',
        account: 'wise-usd',
        amount: null as unknown as number,
      }),
    ).toEqual({ id: 'new', account: 'wise-usd', native_amount: 0 });
  });
});

describe('toDbDiff', () => {
  it('maps only the rows of a foreign currency account', () => {
    const diff = toDbDiff({
      diff: {
        added: [
          { id: 'a1', account: 'wise-usd', amount: -1000 },
          { id: 'a2', account: 'cash', amount: -500000 },
        ],
        // An update has no account. Its row is in a USD account.
        updated: [{ id: 't1', amount: -2000 }],
        deleted: [{ id: 'gone' }],
      },
      isInViewForm: account => foreignCurrencyOf(account) != null,
      accountOf: id => (id === 't1' ? 'wise-usd' : undefined),
    });

    expect(diff).toEqual({
      added: [
        { id: 'a1', account: 'wise-usd', native_amount: -1000 },
        { id: 'a2', account: 'cash', amount: -500000 },
      ],
      updated: [{ id: 't1', native_amount: -2000 }],
      deleted: [{ id: 'gone' }],
    });
  });
});

describe('getRateRequests', () => {
  const lookups = {
    dateOf: (id: string | undefined) =>
      id === 't1' ? '2026-10-01' : undefined,
    accountOf: (id: string | undefined) =>
      id === 't1' ? 'wise-usd' : undefined,
    payees: [
      { id: 'to-wise-eur', transfer_acct: 'wise-eur' },
      { id: 'shop', transfer_acct: undefined },
    ],
    foreignCurrencyOf,
    baseCurrency: 'VND',
  };

  it('asks for the rate of a new row in a foreign currency account', () => {
    expect(
      getRateRequests({
        ...lookups,
        added: [
          { id: 'a1', account: 'wise-usd', date: '2026-10-05', amount: -1 },
          { id: 'a2', account: 'cash', date: '2026-10-05', amount: -1 },
        ],
      }),
    ).toEqual([{ from: 'USD', to: 'VND', date: '2026-10-05' }]);
  });

  it('asks for nothing when an update cannot change the value', () => {
    expect(
      getRateRequests({ ...lookups, updated: [{ id: 't1', notes: 'coffee' }] }),
    ).toEqual([]);
  });

  it('uses the stored date and account of an update', () => {
    expect(
      getRateRequests({ ...lookups, updated: [{ id: 't1', amount: -2000 }] }),
    ).toEqual([{ from: 'USD', to: 'VND', date: '2026-10-01' }]);
  });

  it('asks for the currency on the other side of a transfer too', () => {
    expect(
      getRateRequests({
        ...lookups,
        added: [
          {
            id: 'a1',
            account: 'wise-usd',
            date: '2026-10-05',
            amount: -1000,
            payee: 'to-wise-eur',
          },
          {
            id: 'a2',
            account: 'cash',
            date: '2026-10-05',
            amount: -1,
            payee: 'to-wise-eur',
          },
        ],
      }),
    ).toEqual([
      { from: 'USD', to: 'VND', date: '2026-10-05' },
      { from: 'EUR', to: 'VND', date: '2026-10-05' },
    ]);
  });
});
