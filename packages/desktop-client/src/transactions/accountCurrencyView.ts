import type {
  PayeeEntity,
  TransactionEntity,
} from '@actual-app/core/types/models';

/**
 * A transaction of a foreign currency account in the form that a screen
 * shows and edits.
 *
 * The database keeps the value in the currency of the budget in
 * `amount`, and the amount in the currency of the account in
 * `native_amount`. A screen for one account works with the amount of
 * that account. So in the view form, `amount` holds the amount in the
 * currency of the account, and `base_amount` holds the value in the
 * currency of the budget. The table, the split logic and the rules then
 * work on `amount` with no change.
 */
export type AccountCurrencyView<T> = T & { base_amount?: number | null };

type TransactionChange = Partial<TransactionEntity> & {
  base_amount?: number | null;
};

/** From the database form to the view form */
export function toView<T extends TransactionEntity>(
  transaction: T,
): AccountCurrencyView<T> {
  return {
    ...transaction,
    amount: transaction.native_amount ?? transaction.amount,
    base_amount: transaction.amount,
    ...(transaction.subtransactions && {
      subtransactions: transaction.subtransactions.map(toView),
    }),
  };
}

/**
 * From the view form back to the form of the screen state, which is the
 * database form. The value in the currency of the budget is the one from
 * before the edit. The server calculates it again when it saves, and a
 * new load brings the result.
 */
export function fromView<T extends TransactionEntity>(
  transaction: AccountCurrencyView<T>,
): T {
  const { base_amount: baseAmount, ...rest } = transaction;
  return {
    ...rest,
    native_amount: transaction.amount,
    amount: baseAmount ?? transaction.amount,
    ...(transaction.subtransactions && {
      subtransactions: transaction.subtransactions.map(fromView),
    }),
  } as unknown as T;
}

/**
 * A write for the server from a view row, or from the changed fields of
 * one. The amount goes out as `native_amount` and no `amount` goes out,
 * so the server gives the transaction its value in the currency of the
 * budget.
 */
export function toDb<T extends TransactionChange>(
  change: T,
): Omit<T, 'amount' | 'base_amount'> {
  const {
    amount,
    base_amount: _baseAmount,
    native_amount: _oldNativeAmount,
    ...rest
  } = change;

  return {
    ...rest,
    ...(amount !== undefined && { native_amount: amount ?? 0 }),
    ...(change.subtransactions && {
      subtransactions: change.subtransactions.map(toDb),
    }),
  } as Omit<T, 'amount' | 'base_amount'>;
}

type TransactionDiff = {
  added?: TransactionChange[];
  updated?: TransactionChange[];
  deleted?: Array<Pick<TransactionEntity, 'id'>>;
};

/**
 * Maps the rows of a diff that are in the view form.
 *
 * `isInViewForm` gets the account of a row. An update has only the
 * changed fields, so `accountOf` finds the account of a row that does
 * not carry it.
 */
export function toDbDiff<T extends TransactionDiff>({
  diff,
  isInViewForm,
  accountOf,
}: {
  diff: T;
  isInViewForm: (account: string | null | undefined) => boolean;
  accountOf: (id: string | undefined) => string | null | undefined;
}): T {
  const map = (row: TransactionChange) =>
    isInViewForm(row.account ?? accountOf(row.id)) ? toDb(row) : row;

  return {
    ...diff,
    ...(diff.added && { added: diff.added.map(map) }),
    ...(diff.updated && { updated: diff.updated.map(map) }),
  };
}

export type RateRequest = { from: string; to: string; date: string };

// A change to one of these fields can give a row a new value in the
// currency of the budget
const FIELDS_THAT_NEED_A_RATE = [
  'amount',
  'native_amount',
  'date',
  'account',
  'payee',
] as const;

/**
 * The exchange rates that the server needs to save a diff.
 *
 * A row in a foreign currency account needs the rate of its date. A
 * transfer needs the rate for the currency of the account on its other
 * side too. The server cannot wait for a download while it saves, so
 * the screen asks for the rates first.
 */
export function getRateRequests({
  added = [],
  updated = [],
  dateOf,
  accountOf,
  payees,
  foreignCurrencyOf,
  baseCurrency,
}: {
  added?: TransactionChange[];
  updated?: TransactionChange[];
  // The date and the account of a row that an update does not carry
  dateOf: (id: string | undefined) => string | null | undefined;
  accountOf: (id: string | undefined) => string | null | undefined;
  payees: Array<Pick<PayeeEntity, 'id' | 'transfer_acct'>>;
  foreignCurrencyOf: (account: string | null | undefined) => string | null;
  baseCurrency: string;
}): RateRequest[] {
  const transferAccountOf = new Map(
    payees.flatMap(payee =>
      payee.transfer_acct ? [[payee.id, payee.transfer_acct] as const] : [],
    ),
  );

  const rows = [
    ...added,
    ...updated.filter(row =>
      FIELDS_THAT_NEED_A_RATE.some(field => row[field] !== undefined),
    ),
  ];

  const requests = new Map<string, RateRequest>();
  for (const row of rows) {
    const date = row.date ?? dateOf(row.id);
    if (!date) {
      continue;
    }

    const currencies = [
      foreignCurrencyOf(row.account ?? accountOf(row.id)),
      foreignCurrencyOf(row.payee ? transferAccountOf.get(row.payee) : null),
    ];
    for (const currency of currencies) {
      if (currency) {
        requests.set(`${currency}:${date}`, {
          from: currency,
          to: baseCurrency,
          date,
        });
      }
    }
  }
  return [...requests.values()];
}
