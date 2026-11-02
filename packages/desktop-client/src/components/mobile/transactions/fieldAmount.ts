import { getDecimalPlaces } from '@actual-app/core/shared/currencies';
import {
  amountToCurrency,
  appendDecimals,
  currencyToAmount,
  getNumberFormat,
} from '@actual-app/core/shared/util';

/**
 * The text of an amount in a field of a mobile form. The amount is a
 * number with decimals, not an integer.
 *
 * With a currency code, the amount is in that currency: the transaction
 * is in a foreign currency account. The field then shows the decimals
 * of that currency, and "Hide decimal places" does not apply.
 */
export function formatFieldAmount(
  amount: number,
  currencyCode?: string | null,
): string {
  if (!currencyCode) {
    return amountToCurrency(amount);
  }
  return getNumberFormat({
    decimalPlaces: getDecimalPlaces(currencyCode),
  }).formatter.format(amount);
}

/**
 * The text of an amount field while the user types. The digits fill the
 * decimals from the right, so "1250" becomes 12.50 for a currency with
 * two decimals.
 */
export function appendFieldDecimals({
  text,
  hideDecimals,
  currencyCode,
}: {
  text: string;
  // The setting of the budget. It does not apply with a currency code.
  hideDecimals: boolean;
  currencyCode?: string | null;
}): string {
  if (!currencyCode) {
    return appendDecimals(text, hideDecimals);
  }

  const decimalPlaces = getDecimalPlaces(currencyCode);
  const { decimalSeparator } = getNumberFormat();
  let result = text;
  if (result.slice(-1) === decimalSeparator) {
    result = result.slice(0, -1);
  }
  if (decimalPlaces > 0) {
    result = result.replaceAll(/[,.]/g, '');
    result = result.replace(/^0+(?!$)/, '');
    result = result.padStart(decimalPlaces + 1, '0');
    result =
      result.slice(0, -decimalPlaces) +
      decimalSeparator +
      result.slice(-decimalPlaces);
  }
  return formatFieldAmount(currencyToAmount(result) ?? 0, currencyCode);
}
