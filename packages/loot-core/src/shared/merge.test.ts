import type { TransactionEntity } from '#types/models/transaction';

import { validForMerge } from './merge';

describe('validForMerge', () => {
  const t1: TransactionEntity = {
    id: 'id1',
    account: 'one',
    amount: 12,
    date: '2025-01-01',
  };
  const t2: TransactionEntity = {
    id: 'id2',
    account: 'one',
    amount: 12,
    date: '2025-01-01',
  };

  it('cannot merge if different accounts', () => {
    expect(validForMerge({ ...t1, account: 'other' }, t2)).toBe(false);
  });

  it('cannot merge if different amounts', () => {
    expect(validForMerge({ ...t1, amount: 13 }, t2)).toBe(false);
  });

  it('can merge if everything matches', () => {
    expect(validForMerge(t1, t2)).toBe(true);
  });

  it('compares the amounts of the account for a foreign currency account', () => {
    // The same 10.00 USD on two days has two base values
    const first = { ...t1, amount: 25000000, native_amount: 1000 };
    const second = { ...t2, amount: 25100000, native_amount: 1000 };
    expect(validForMerge(first, second)).toBe(true);
    expect(validForMerge(first, { ...second, native_amount: 1001 })).toBe(
      false,
    );
  });

  it('cannot merge if both transfers but transfer to different accounts', () => {
    const transfer1 = { ...t1, transfer_id: 'transfer1', payee: 'account3' };
    const transfer2 = { ...t2, transfer_id: 'transfer2', payee: 'account4' };
    expect(validForMerge(transfer1, transfer2)).toBe(false);
  });

  it('can merge if both transfers and transfer to the same account', () => {
    const transfer1 = { ...t1, transfer_id: 'transfer1', payee: 'account3' };
    const transfer2 = { ...t2, transfer_id: 'transfer2', payee: 'account3' };
    expect(validForMerge(transfer1, transfer2)).toBe(true);
  });
});
