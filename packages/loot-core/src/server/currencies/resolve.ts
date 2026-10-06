import { convertAmount } from '#shared/currency-conversion';
import type { IntegerAmount } from '#shared/util';

/**
 * How to read an `amount` that comes with no `native_amount` for a row
 * in a foreign currency account.
 *
 * - `explicit`: the caller knows the two numbers. A lone `amount` is a
 *   base value that a person set, and a new row must bring its
 *   `native_amount`. The screens of the app write this way.
 * - `native`: the caller knows nothing about currencies, so a lone
 *   `amount` is in the currency of the account. File import, bank sync,
 *   schedule posting and API inserts write this way.
 */
export type AmountSemantics = 'explicit' | 'native';

/** What the database has for a row before the write */
export type StoredAmounts = {
  account: string;
  date: string;
  amount: IntegerAmount;
  // The raw column, not the view. Null when the row never got one.
  native_amount: IntegerAmount | null;
  amount_locked: boolean;
};

/** The fields of a write that matter for the amounts */
export type AmountChange = {
  account?: string | null;
  date?: string | null;
  amount?: IntegerAmount | null;
  native_amount?: IntegerAmount | null;
  amount_locked?: boolean | null;
};

export type ResolveRowInput = {
  // Null for a new row
  existing: StoredAmounts | null;
  change: AmountChange;
  amountSemantics: AmountSemantics;
  baseCurrency: string | null;
  // The currency of the account that holds the row after the write.
  // Null means the base currency.
  accountCurrency: string | null;
  // The base value of the other side of a transfer, when that side owns
  // the value. See `ownsTransferAmount`.
  ownerAmount?: IntegerAmount | null;
  // The children of a split parent, after they are resolved
  children?: Array<{
    amount: IntegerAmount;
    native_amount: IntegerAmount;
  }> | null;
  // The stored rate from the account currency to the base currency for
  // the date of the row. Null when the database has none.
  rate: number | null;
};

export type ResolvedAmounts = {
  // Always in the base currency
  amount: IntegerAmount;
  // Null for a row in a base currency account
  native_amount: IntegerAmount | null;
  amount_locked: boolean;
};

export type ResolveRowResult =
  | ({ ok: true } & ResolvedAmounts)
  | { ok: false; reason: 'missing-rate' | 'missing-native-amount' };

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Decides the two amounts of one transaction row for a write.
 *
 * `amount` is always in the base currency of the budget, so the budget
 * and the reports can add it. `native_amount` is the number that the
 * user typed, in the currency of the account.
 *
 * For a row in a foreign currency account, the first rule that applies
 * gives the base value:
 *
 * 1. A balanced split parent stores the sum of its children.
 * 2. The write brings a base value. It is kept, and locked.
 * 3. The other side of a transfer owns the value. This side mirrors it.
 * 4. The value is locked. It stays as it is.
 * 5. Otherwise the value is the native amount times the stored rate. It
 *    is calculated again only when the native amount, the date or the
 *    account changes.
 *
 * A field of `change` that is equal to the stored row counts as not
 * sent. Some callers send full rows.
 */
export function resolveRowAmounts({
  existing,
  change,
  amountSemantics,
  baseCurrency,
  accountCurrency,
  ownerAmount = null,
  children = null,
  rate,
}: ResolveRowInput): ResolveRowResult {
  // The number that the user saw in the account before this write
  const typedBefore = existing
    ? (existing.native_amount ?? existing.amount)
    : null;

  const sentAmount =
    change.amount != null && change.amount !== existing?.amount
      ? change.amount
      : undefined;
  const sentNative =
    change.native_amount != null && change.native_amount !== typedBefore
      ? change.native_amount
      : undefined;
  const sentLock =
    change.amount_locked != null &&
    change.amount_locked !== (existing?.amount_locked ?? false)
      ? change.amount_locked
      : undefined;
  const dateChanged = change.date != null && change.date !== existing?.date;
  const accountChanged =
    change.account != null && change.account !== existing?.account;

  const isForeign =
    baseCurrency != null &&
    accountCurrency != null &&
    accountCurrency !== '' &&
    accountCurrency !== baseCurrency;

  if (!isForeign) {
    // A row that moves here from a foreign account keeps its typed number
    const kept = accountChanged ? typedBefore : (existing?.amount ?? null);
    return {
      ok: true,
      amount: sentAmount ?? sentNative ?? kept ?? 0,
      native_amount: null,
      amount_locked: false,
    };
  }

  let native: IntegerAmount | null;
  let sentBase: IntegerAmount | undefined;
  if (sentNative !== undefined) {
    native = sentNative;
    sentBase = sentAmount;
  } else if (sentAmount !== undefined && amountSemantics === 'native') {
    native = sentAmount;
    sentBase = undefined;
  } else {
    native = typedBefore;
    sentBase = sentAmount;
  }

  if (native == null) {
    if (sentBase !== undefined) {
      // A value in the base currency with no amount in the account
      return { ok: false, reason: 'missing-native-amount' };
    }
    // A new row with no amount at all, as a screen saves it before the
    // user types one
    native = 0;
  }

  const resolved = (amount: IntegerAmount, isLocked: boolean) =>
    ({
      ok: true,
      amount,
      native_amount: native,
      amount_locked: isLocked,
    }) as const;

  if (children && children.length > 0) {
    const isBalanced =
      sum(children.map(child => child.native_amount)) === native;
    if (isBalanced) {
      return resolved(sum(children.map(child => child.amount)), false);
    }
  }

  const isUnlock = sentLock === false;
  const partnerOwns = ownerAmount != null;

  if (sentBase !== undefined && !isUnlock) {
    // The mirror code copies this value to the side that owns it, so a
    // lock on this side would have no effect
    return resolved(sentBase, !partnerOwns);
  }

  if (partnerOwns) {
    // `|| 0` turns -0 into 0
    return resolved(-ownerAmount || 0, false);
  }

  const isLocked = existing?.amount_locked === true || sentLock === true;
  if (existing && isLocked && !isUnlock) {
    return resolved(existing.amount, true);
  }

  const wasConverted = existing != null && existing.native_amount != null;
  const nativeChanged = native !== typedBefore;
  if (
    existing &&
    wasConverted &&
    !nativeChanged &&
    !dateChanged &&
    !accountChanged &&
    !isUnlock
  ) {
    return resolved(existing.amount, false);
  }

  if (native === 0) {
    return resolved(0, sentLock === true);
  }
  if (rate == null) {
    return { ok: false, reason: 'missing-rate' };
  }
  return resolved(
    convertAmount({
      amount: native,
      rate,
      fromCurrency: accountCurrency,
      toCurrency: baseCurrency,
    }),
    sentLock === true,
  );
}

/**
 * Says if this side of a transfer owns the base value of the transfer.
 * The two sides must have equal and opposite base values, so only one
 * side can decide it.
 *
 * The owner is the side in the base currency: that amount is real money
 * in the currency of the budget, and no rate can be better. When no side
 * is in the base currency, the owner is the side that the money leaves.
 * When the two sides have the same currency, each side owns the value,
 * as for a transfer with one currency.
 */
export function ownsTransferAmount({
  baseCurrency,
  currency,
  partnerCurrency,
  nativeAmount,
}: {
  baseCurrency: string | null;
  // Null means the base currency
  currency: string | null;
  partnerCurrency: string | null;
  nativeAmount: IntegerAmount;
}): boolean {
  const own = currency || baseCurrency;
  const other = partnerCurrency || baseCurrency;

  if (own === other) {
    return true;
  }
  if (own === baseCurrency) {
    return true;
  }
  if (other === baseCurrency) {
    return false;
  }
  return nativeAmount < 0;
}
