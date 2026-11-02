import { setNumberFormat } from '@actual-app/core/shared/util';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Value } from '#components/rules/Value';
import { TestProviders } from '#mocks';

import { FilterEditor } from './FiltersMenu';

const prefs: Record<string, string> = {
  defaultCurrencyCode: 'VND',
  hideFraction: 'true',
  numberFormat: 'dot-comma',
};

vi.mock('#hooks/useSyncedPref', () => ({
  useSyncedPref: (name: string) => [prefs[name], vi.fn()],
}));

describe('an amount filter on a foreign currency account', () => {
  beforeEach(() => {
    setNumberFormat({ format: 'dot-comma', hideFraction: true });
  });

  it('shows the symbol of the account currency in the label', () => {
    render(<Value field="amount" value={-2000} currency="USD" />, {
      wrapper: TestProviders,
    });

    expect(screen.getByText(/20,00/).textContent).toContain('$');
  });

  it('shows the symbol of the budget currency with no account currency', () => {
    render(<Value field="amount" value={-2000} />, { wrapper: TestProviders });

    expect(screen.getByText(/20/).textContent).toContain('₫');
  });

  it('keeps the decimals of the account currency in the editor', () => {
    render(
      <FilterEditor
        field="amount"
        op="is"
        value={-1250}
        options={undefined}
        currency="USD"
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
      { wrapper: TestProviders },
    );

    expect(screen.getByRole<HTMLInputElement>('textbox').value).toContain(
      '12,50',
    );
  });
});
