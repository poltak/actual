import { getDecimalPlaces } from './currencies';
import { safeNumber } from './util';
import type { IntegerAmount } from './util';

/**
 * Converts an integer amount between two currencies.
 *
 * `rate` is the number of units of `toCurrency` for one unit of
 * `fromCurrency`. Each integer is in minor units of its own currency, so
 * the decimal places of the two currencies scale the result.
 *
 * The absolute value is rounded and the sign is put back after that, so
 * `x` and `-x` always convert to opposite numbers. The two sides of a
 * transfer depend on this.
 */
export function convertAmount({
  amount,
  rate,
  fromCurrency,
  toCurrency,
}: {
  amount: IntegerAmount;
  rate: number;
  fromCurrency: string;
  toCurrency: string;
}): IntegerAmount {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('convertAmount: rate must be a positive number: ' + rate);
  }

  const scale =
    Math.pow(10, getDecimalPlaces(toCurrency)) /
    Math.pow(10, getDecimalPlaces(fromCurrency));
  const converted = Math.round(Math.abs(safeNumber(amount)) * rate * scale);

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
  fromCurrency,
  toCurrency,
}: {
  fromAmount: IntegerAmount;
  toAmount: IntegerAmount;
  fromCurrency: string;
  toCurrency: string;
}): number | null {
  if (fromAmount === 0 || toAmount === 0) {
    return null;
  }

  const scale =
    Math.pow(10, getDecimalPlaces(fromCurrency)) /
    Math.pow(10, getDecimalPlaces(toCurrency));
  return Math.abs(toAmount / fromAmount) * scale;
}
