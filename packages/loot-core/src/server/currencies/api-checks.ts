import { APIError } from '#server/errors';
import { getCurrency } from '#shared/currencies';
import * as monthUtils from '#shared/months';
import type { TransactionEntity } from '#types/models';

import { getForeignCurrencies } from './base-currency';
import type { RateRow } from './rates';

/**
 * Stops an API update that sends `amount` and no `native_amount` for a
 * transaction in a foreign currency account.
 *
 * A script that was written for a budget with one currency sends
 * `amount` and means the number on the account page. For such a
 * transaction that number is `native_amount`, and `amount` is the value
 * in the currency of the budget. The error makes the script say which
 * of the two it means, and nothing is written with the wrong meaning.
 */
export async function checkAmountUpdate({
  stored,
  fields,
}: {
  stored: Pick<TransactionEntity, 'account' | 'amount'> | undefined;
  fields: Partial<TransactionEntity>;
}): Promise<void> {
  if (fields.amount == null || fields.native_amount != null) {
    return;
  }
  if (stored && fields.amount === stored.amount) {
    return;
  }

  const account = fields.account ?? stored?.account;
  const { foreignCurrencies } = await getForeignCurrencies();
  const currency = account ? foreignCurrencies.get(account) : undefined;
  if (currency) {
    throw APIError(
      `This transaction is in an account with the currency ${currency}. ` +
        'Send `native_amount` for the amount in that currency. ' +
        'Send `amount` with it only to set the value in the currency of the budget.',
    );
  }
}

function isKnownCurrency(code: unknown): code is string {
  return (
    typeof code === 'string' && code !== '' && getCurrency(code).code === code
  );
}

/** Checks the rates that an API caller wants to store */
export function validateRateRows(rates: unknown): RateRow[] {
  if (!Array.isArray(rates)) {
    throw APIError('`rates` must be an array');
  }

  return rates.map((row: Partial<RateRow> | null) => {
    const { from, to, date, rate } = row ?? {};
    if (!isKnownCurrency(from) || !isKnownCurrency(to)) {
      throw APIError(`Unknown currency in the rate from ${from} to ${to}`);
    }
    if (from === to) {
      throw APIError(`A rate needs two different currencies: ${from}`);
    }
    if (typeof date !== 'string' || !monthUtils.isValidYearMonthDay(date)) {
      throw APIError('Invalid date format, use YYYY-MM-DD: ' + date);
    }
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      throw APIError('A rate must be a positive number: ' + rate);
    }
    return { from, to, date, rate };
  });
}
