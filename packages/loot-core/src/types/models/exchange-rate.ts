export type ExchangeRateSource = 'manual' | 'frankfurter' | 'transfer';

export type ExchangeRateEntity = {
  // `FROM:TO:DATE`, for example `USD:VND:2025-02-26`
  id: string;
  from_currency: string;
  to_currency: string;
  date: string;
  // Units of `to_currency` for one unit of `from_currency`
  rate: number;
  source?: ExchangeRateSource | null;
  tombstone?: boolean;
};
