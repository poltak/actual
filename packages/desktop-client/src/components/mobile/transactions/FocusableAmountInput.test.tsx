import { setNumberFormat } from '@actual-app/core/shared/util';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FocusableAmountInput } from './FocusableAmountInput';

const prefs = vi.hoisted(() => ({
  values: {} as Record<string, string>,
}));

vi.mock('#hooks/useSyncedPref', () => ({
  useSyncedPref: (name: string) => [prefs.values[name], vi.fn()],
}));

describe('FocusableAmountInput', () => {
  it('takes typed digits as whole units in a currency without decimals', () => {
    prefs.values = { defaultCurrencyCode: 'JPY' };
    setNumberFormat({ format: 'comma-dot', hideFraction: false });
    render(<FocusableAmountInput value={0} focused />);

    const input = screen.getByTestId<HTMLInputElement>('amount-input');
    for (const digit of '1500') {
      fireEvent.change(input, { target: { value: input.value + digit } });
    }
    expect(input.value).toBe('1,500');
  });

  it('keeps the decimals of an account currency when the budget hides them', () => {
    prefs.values = {
      defaultCurrencyCode: 'VND',
      hideFraction: 'true',
      numberFormat: 'dot-comma',
    };
    setNumberFormat({ format: 'dot-comma', hideFraction: true });
    render(<FocusableAmountInput value={0} focused currency="USD" />);

    const input = screen.getByTestId<HTMLInputElement>('amount-input');
    for (const digit of '1250') {
      fireEvent.change(input, { target: { value: input.value + digit } });
    }
    expect(input.value).toBe('12,50');
  });

  it('takes typed digits as whole units in a foreign currency without decimals', () => {
    prefs.values = { defaultCurrencyCode: 'USD' };
    setNumberFormat({ format: 'comma-dot', hideFraction: false });
    render(<FocusableAmountInput value={0} focused currency="VND" />);

    const input = screen.getByTestId<HTMLInputElement>('amount-input');
    for (const digit of '50000') {
      fireEvent.change(input, { target: { value: input.value + digit } });
    }
    expect(input.value).toBe('50,000');
  });
});
