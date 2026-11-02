import { safeNumber } from './util';
import type { IntegerAmount } from './util';

/**
 * Converts an integer amount between two currencies.
 *
 * `rate` is the number of units of the target currency for one unit of
 * the source currency. Every currency is stored times 100, so the rate
 * is all that the conversion needs.
 *
 * The absolute value is rounded and the sign is put back after that, so
 * `x` and `-x` always convert to opposite numbers. The two sides of a
 * transfer depend on this.
 */
export function convertAmount({
  amount,
  rate,
}: {
  amount: IntegerAmount;
  rate: number;
}): IntegerAmount {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('convertAmount: rate must be a positive number: ' + rate);
  }

  const converted = Math.round(Math.abs(safeNumber(amount)) * rate);

  // `|| 0` turns -0 into 0
  return safeNumber(Math.sign(amount) * converted || 0);
}

/**
 * The rate that turns `fromAmount` into `toAmount`, as `convertAmount`
 * reads it. Returns null when one of the amounts is zero, because no
 * rate follows from that.
 */
export function impliedRate({
  fromAmount,
  toAmount,
}: {
  fromAmount: IntegerAmount;
  toAmount: IntegerAmount;
}): number | null {
  if (fromAmount === 0 || toAmount === 0) {
    return null;
  }

  return Math.abs(toAmount / fromAmount);
}
