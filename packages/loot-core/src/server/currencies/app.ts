import { logger } from '#platform/server/log';
import { createApp } from '#server/app';
import * as db from '#server/db';
import * as prefs from '#server/prefs';

import { ensureRates, getStoredRate, refreshRatesOfToday } from './rates';
import type { RateRequest, StoredRate } from './rates';

export type CurrenciesHandlers = {
  'rates-ensure': typeof ensureRates;
  'rate-get': typeof getRate;
};

export const app = createApp<CurrenciesHandlers>();

// These two do not change a transaction, so they are not mutators. A
// screen calls `rates-ensure` before it saves, because a write cannot
// wait for the network.
app.method('rates-ensure', ensureRates);
app.method('rate-get', getRate);

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
