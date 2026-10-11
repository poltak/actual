import { addTransactions, reconcileTransactions } from '#server/accounts/sync';
import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';

import { loadRules, resetState } from './transaction-rules';

import { batchUpdateTransactions } from './index';

// The screens start a new manual transaction as cleared. That is only
// the start value of a draft. These tests fix what the server does with
// the cleared state: it stores what it gets, and an import keeps its own
// default.

type Row = { id: string; cleared: number; notes: string | null };

function rows() {
  return db.all<Row>(
    `SELECT id, cleared, notes FROM transactions
      WHERE tombstone = 0 ORDER BY amount`,
  );
}

beforeEach(async () => {
  await global.emptyDatabase()();
  resetState();
  await loadMappings();
  await loadRules();
  await db.insertAccount({ id: 'cash', name: 'cash' });
});

describe('the save of a manual transaction', () => {
  it('stores the cleared state that the new transaction brings', async () => {
    await batchUpdateTransactions({
      added: [
        {
          id: 'unticked',
          account: 'cash',
          date: '2016-12-10',
          amount: -100,
          cleared: false,
        },
        {
          id: 'ticked',
          account: 'cash',
          date: '2016-12-10',
          amount: -200,
          cleared: true,
        },
      ],
    });

    expect(await rows()).toEqual([
      expect.objectContaining({ id: 'ticked', cleared: 1 }),
      expect.objectContaining({ id: 'unticked', cleared: 0 }),
    ]);
  });

  it('does not clear a stored transaction when a different field changes', async () => {
    await batchUpdateTransactions({
      added: [
        {
          id: 'unticked',
          account: 'cash',
          date: '2016-12-10',
          amount: -100,
          cleared: false,
        },
      ],
    });

    await batchUpdateTransactions({
      updated: [{ id: 'unticked', notes: 'coffee' }],
    });

    expect(await rows()).toEqual([
      { id: 'unticked', cleared: 0, notes: 'coffee' },
    ]);
  });
});

describe('the cleared state of an import', () => {
  it('follows the row and the default of the import, as before', async () => {
    await reconcileTransactions('cash', [
      // A pending row of a bank file
      { date: '2016-12-10', amount: -100, cleared: false },
      // A row that says nothing gets the default of the import
      { date: '2016-12-11', amount: -200 },
    ]);

    expect(await rows()).toEqual([
      expect.objectContaining({ cleared: 1 }),
      expect.objectContaining({ cleared: 0 }),
    ]);
  });

  it('can import rows as not cleared', async () => {
    await reconcileTransactions(
      'cash',
      [{ date: '2016-12-10', amount: -100 }],
      { defaultCleared: false },
    );

    expect(await rows()).toEqual([expect.objectContaining({ cleared: 0 })]);
  });

  it('keeps the default and the choice of a row that the API adds', async () => {
    await addTransactions('cash', [
      { date: '2016-12-10', amount: -100, cleared: false },
      { date: '2016-12-11', amount: -200 },
    ]);

    expect(await rows()).toEqual([
      expect.objectContaining({ cleared: 1 }),
      expect.objectContaining({ cleared: 0 }),
    ]);
  });
});
