import { setNumberFormat } from '@actual-app/core/shared/util';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CalculatorAmountInput } from './CalculatorAmountInput';

describe('CalculatorAmountInput', () => {
  it('keeps the decimals of an account currency when the budget hides them', () => {
    setNumberFormat({ format: 'dot-comma', hideFraction: true });
    render(<CalculatorAmountInput value={12.5} currency="USD" />);

    expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('12,50');
  });

  it('hides the decimals of the budget currency when the budget hides them', () => {
    setNumberFormat({ format: 'dot-comma', hideFraction: true });
    render(<CalculatorAmountInput value={12.5} />);

    expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('13');
  });
});
