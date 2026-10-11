import { setNumberFormat } from '@actual-app/core/shared/util';
import type { TransactionEntity } from '@actual-app/core/types/models';

import type { SerializedTransaction } from './utils';
import {
  deserializeTransaction,
  formatAmount,
  formatTypedAmount,
  getInitialCleared,
  makeTemporaryTransactions,
  serializeTransaction,
  shouldApplyRuleChange,
} from './utils';

describe('shouldApplyRuleChange', () => {
  test('applies rule changes to empty fields', () => {
    expect(shouldApplyRuleChange('category', null, 'food')).toBe(true);
    expect(shouldApplyRuleChange('notes', '', 'memo')).toBe(true);
    expect(shouldApplyRuleChange('cleared', false, true)).toBe(true);
    expect(shouldApplyRuleChange('amount', 0, 1200)).toBe(true);
  });

  test('keeps user-entered values for non-empty fields by default', () => {
    expect(shouldApplyRuleChange('category', 'food', 'home')).toBe(false);
    expect(shouldApplyRuleChange('notes', 'manual note', 'rule note')).toBe(
      false,
    );
  });

  test('applies append and prepend notes rules', () => {
    expect(
      shouldApplyRuleChange('notes', 'Coffee and cake', 'Coffee and cake Tip'),
    ).toBe(true);
    expect(
      shouldApplyRuleChange('notes', 'Coffee and cake', 'Tip Coffee and cake'),
    ).toBe(true);
  });

  test('applies appends with no separator between the note and added text', () => {
    expect(shouldApplyRuleChange('notes', 'Coffee', 'CoffeePAID')).toBe(true);
  });

  test('applies a combined prepend and append in a single rule run', () => {
    expect(shouldApplyRuleChange('notes', 'Coffee', 'A Coffee B')).toBe(true);
  });

  test('is idempotent: does not re-append text already present', () => {
    // Rules re-run on every keystroke during entry; the second run sees the
    // already-appended note and must not append again.
    expect(
      shouldApplyRuleChange(
        'notes',
        'Coffee and cake Tip',
        'Coffee and cake Tip Tip',
      ),
    ).toBe(false);
    expect(
      shouldApplyRuleChange(
        'notes',
        'Tip Coffee and cake',
        'Tip Tip Coffee and cake',
      ),
    ).toBe(false);
  });

  test('does not apply when the rule replaces the note entirely', () => {
    expect(
      shouldApplyRuleChange('notes', 'manual note', 'completely different'),
    ).toBe(false);
  });

  test('only the notes field is allowed to merge', () => {
    expect(shouldApplyRuleChange('imported_payee', 'Store', 'Store Inc')).toBe(
      false,
    );
  });
});

describe('deserializeTransaction', () => {
  const originalTransaction: TransactionEntity = {
    id: 'temp',
    account: 'account-id',
    date: '2017-01-01',
    amount: 0,
    cleared: false,
  };

  function serialized(
    overrides: Partial<SerializedTransaction>,
  ): SerializedTransaction {
    return {
      ...originalTransaction,
      debit: '',
      credit: '',
      ...overrides,
    };
  }

  test('reads the amount from the debit field', () => {
    expect(
      deserializeTransaction(serialized({ debit: '100.00' }), {
        ...originalTransaction,
        amount: -2500,
      }).amount,
    ).toBe(-10000);
  });

  test('reads the amount from the credit field', () => {
    expect(
      deserializeTransaction(serialized({ credit: '100.00' }), {
        ...originalTransaction,
        amount: -2500,
      }).amount,
    ).toBe(10000);
  });

  test('keeps the in-progress amount when both amount fields are blank', () => {
    // Editing a non-amount field (e.g. toggling cleared) blanks both debit and
    // credit, so the amount has to come from elsewhere. `originalTransaction`
    // can still be showing the pre-save amount while a save is in flight, so
    // the amount already on the row wins over the parent's copy.
    const result = deserializeTransaction(
      serialized({ amount: -10000, cleared: true }),
      { ...originalTransaction, amount: 0 },
    );

    expect(result.amount).toBe(-10000);
    expect(result.cleared).toBe(true);
  });

  test('falls back to the original amount when the row has none', () => {
    expect(
      deserializeTransaction(
        serialized({ amount: null as unknown as TransactionEntity['amount'] }),
        { ...originalTransaction, amount: -2500 },
      ).amount,
    ).toBe(-2500);
  });
});

describe('amounts in the currency of an account', () => {
  // A budget in VND hides the decimals. An amount in USD keeps them.
  beforeEach(() => {
    setNumberFormat({ format: 'dot-comma', hideFraction: true });
  });
  afterEach(() => {
    setNumberFormat({ format: 'comma-dot', hideFraction: false });
  });

  const usdRow = {
    id: 't1',
    account: 'wise-usd',
    date: '2026-10-01',
    amount: -1000,
  } satisfies TransactionEntity;

  test('formatAmount shows the decimals of the currency', () => {
    expect(formatAmount(123456, 'USD')).toBe('1.234,56');
    expect(formatAmount(1000, 'USD')).toBe('10,00');
    expect(formatAmount(1000, 'JPY')).toBe('1.000');
  });

  test('formatAmount follows the settings of the budget with no currency', () => {
    expect(formatAmount(25000000)).toBe('250.000');
    expect(formatAmount(25000000, null)).toBe('250.000');
  });

  test('formatTypedAmount keeps the decimals that the user typed', () => {
    expect(formatTypedAmount('12,5', 'USD')).toBe('12,50');
    expect(formatTypedAmount('', 'USD')).toBe('');
    // With no currency, the budget hides the decimals
    expect(formatTypedAmount('12,5')).toBe('13');
  });

  test('serializeTransaction writes the amount with its decimals', () => {
    expect(serializeTransaction(usdRow, false, 'USD')).toMatchObject({
      debit: '10,00',
      credit: '',
    });
  });

  test('deserializeTransaction reads an amount in the units of the currency', () => {
    const serialized = serializeTransaction(usdRow, false, 'USD');

    expect(
      deserializeTransaction({ ...serialized, debit: '12,5' }, usdRow, 'USD')
        .amount,
    ).toBe(-1250);
    // A currency with no decimals has no smaller unit
    expect(
      deserializeTransaction({ ...serialized, debit: '1.500' }, usdRow, 'JPY')
        .amount,
    ).toBe(-1500);
  });
});

describe('the draft of a new manual transaction', () => {
  test('starts as cleared', () => {
    const [draft] = makeTemporaryTransactions('account-1', null);

    expect(draft.cleared).toBe(true);
  });

  test('keeps its other start values', () => {
    const [draft, ...others] = makeTemporaryTransactions(
      'account-1',
      'category-1',
      '2026-10-01',
    );

    expect(others).toEqual([]);
    expect(draft).toMatchObject({
      id: 'temp',
      account: 'account-1',
      category: 'category-1',
      date: '2026-10-01',
      amount: null,
    });
  });

  test('has no account and no category when the page gives none', () => {
    const [draft] = makeTemporaryTransactions(null, undefined);

    expect(draft.account).toBeNull();
    expect(draft.category).toBeUndefined();
  });
});

describe('getInitialCleared', () => {
  test('is true when a link to the mobile form says nothing', () => {
    expect(getInitialCleared(null)).toBe(true);
  });

  test('follows the cleared parameter of a link, as before', () => {
    expect(getInitialCleared('true')).toBe(true);
    expect(getInitialCleared('false')).toBe(false);
    // Before the change, each value that is not "true" gave false
    expect(getInitialCleared('')).toBe(false);
    expect(getInitialCleared('yes')).toBe(false);
  });
});
