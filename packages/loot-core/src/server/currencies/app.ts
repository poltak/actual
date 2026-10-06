import { logger } from '#platform/server/log';
import { createApp } from '#server/app';
import * as db from '#server/db';
import { mutator } from '#server/mutators';
import * as prefs from '#server/prefs';
import { undoable } from '#server/undo';

import { getBaseCurrency, isForeignCurrency } from './base-currency';
import { getAccountMarketValue, revalueAccount } from './market-value';
import { ensureRates, getStoredRate, refreshRatesOfToday } from './rates';
import type { RateRequest, StoredRate } from './rates';

export type CurrenciesHandlers = {
  'rates-ensure': typeof ensureRatesForClient;
  'rates-ensure-for-account': typeof ensureRatesForAccount;
  'rate-get': typeof getRate;
  'account-market-value': typeof getAccountMarketValue;
  'account-revalue': typeof revalueAccount;
};

export const app = createApp<CurrenciesHandlers>();

// These two do not change a transaction, so they are not mutators. A
// screen calls `rates-ensure` before it saves, because a write cannot
// wait for the network.
app.method('rates-ensure', ensureRatesForClient);
app.method('rates-ensure-for-account', ensureRatesForAccount);
app.method('rate-get', getRate);
app.method('account-market-value', getAccountMarketValue);
app.method('account-revalue', mutator(undoable(revalueAccount)));

async function ensureRatesForClient({
  requests,
}: {
  requests: RateRequest[];
}): Promise<{ missing: RateRequest[] }> {
  return ensureRates({ requests });
}

// For a screen that has an account and some dates, and does not know
// the currencies. An account in the currency of the budget needs no rate.
async function ensureRatesForAccount({
  accountId,
  dates,
}: {
  accountId: string;
  dates: string[];
}): Promise<{ missing: RateRequest[] }> {
  const baseCurrency = await getBaseCurrency();
  const account = await db.first<Pick<db.DbAccount, 'currency'>>(
    'SELECT currency FROM accounts WHERE id = ?',
    [accountId],
  );
  const currency = account?.currency;
  if (
    !baseCurrency ||
    !currency ||
    !isForeignCurrency({ currency, baseCurrency })
  ) {
    return { missing: [] };
  }

  return ensureRates({
    requests: dates.map(date => ({ from: currency, to: baseCurrency, date })),
  });
}

async function getRate(request: RateRequest): Promise<StoredRate | null> {
  return getStoredRate(request);
}

app.events.on('sync', ({ type }) => {
  const isComplete =
    type === 'success' || type === 'error' || type === 'unauthorized';
  if (!isComplete || !prefs.getPrefs() || !db.getDatabase()) {
    return;
  }

  refreshRatesOfToday().catch(error => {
    logger.warn('Could not refresh the exchange rates of today', error);
  });
});
