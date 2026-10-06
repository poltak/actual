import React from 'react';
import type { ReactNode } from 'react';

import type { SyncedPrefs } from '@actual-app/core/types/prefs';
import { renderHook } from '@testing-library/react';

import {
  configureTestAppStore,
  createTestQueryClient,
  TestProviders,
} from '#mocks';
import { mergeSyncedPrefs } from '#prefs/prefsSlice';

import { useFormat } from './useFormat';

// The marks that the hook puts around a currency symbol and between a
// symbol and its amount
const NARROW_SPACE = '\u202F';
const EMBED_START = '\u202A';
const EMBED_END = '\u202C';

// A budget in VND, as it is after the user selects that currency
const vndBudget: Partial<SyncedPrefs> = {
  defaultCurrencyCode: 'VND',
  numberFormat: 'dot-comma',
  hideFraction: 'true',
  currencySymbolPosition: 'after',
  currencySpaceBetweenAmountAndSymbol: 'true',
};

function renderFormat(
  prefs: Partial<SyncedPrefs>,
  currencyCode?: string | null,
) {
  const queryClient = createTestQueryClient();
  const store = configureTestAppStore({ queryClient });
  store.dispatch(mergeSyncedPrefs(prefs));

  const wrapper = ({ children }: { children: ReactNode }) => (
    <TestProviders queryClient={queryClient} store={store}>
      {children}
    </TestProviders>
  );
  return renderHook(() => useFormat(currencyCode), { wrapper }).result.current;
}

describe('useFormat', () => {
  it('formats in the currency of the budget, with its settings', () => {
    const format = renderFormat(vndBudget);

    // 250,000.00 VND, stored times 100, with the decimals hidden
    expect(format(25000000, 'financial')).toBe(`250.000${NARROW_SPACE}₫`);
    expect(format.currency.code).toBe('VND');
    expect(format.forEdit(25000000)).toBe('250.000');
  });

  it('formats in the currency of an account, with the decimals of that currency', () => {
    const format = renderFormat(vndBudget, 'USD');

    // The number marks are those of the user. The symbol goes where it
    // goes for USD, and "Hide decimal places" does not apply.
    expect(format(123456, 'financial')).toBe(
      `${EMBED_START}$${EMBED_END}1.234,56`,
    );
    expect(format(-1000, 'financial')).toBe(
      `-${EMBED_START}$${EMBED_END}10,00`,
    );
    expect(format.currency.code).toBe('USD');
    expect(format.forEdit(123456)).toBe('1.234,56');
    expect(format.fromEdit('12,50')).toBe(1250);
  });

  it('puts the symbol after the amount for a currency that has it there', () => {
    const format = renderFormat(
      { defaultCurrencyCode: 'USD', numberFormat: 'comma-dot' },
      'VND',
    );

    expect(format(25000000, 'financial')).toBe(`250,000.00${NARROW_SPACE}₫`);
  });

  it('uses the settings of the budget when the code is the currency of the budget', () => {
    const withCode = renderFormat(vndBudget, 'VND');
    const withNoCode = renderFormat(vndBudget, null);

    expect(withCode(25000000, 'financial')).toBe(`250.000${NARROW_SPACE}₫`);
    expect(withNoCode(25000000, 'financial')).toBe(`250.000${NARROW_SPACE}₫`);
  });

  it('formats as before when the budget has no currency', () => {
    const format = renderFormat({ numberFormat: 'comma-dot' });

    expect(format(123456, 'financial')).toBe('1,234.56');
    expect(format.currency.code).toBe('');
  });
});
