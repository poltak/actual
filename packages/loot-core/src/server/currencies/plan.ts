import { v4 as uuidv4 } from 'uuid';

import * as db from '#server/db';
import { whereIn } from '#server/db/util';
import { convertAmount } from '#shared/currency-conversion';
import type { IntegerAmount } from '#shared/util';
import type { TransactionEntity } from '#types/models';

import { getForeignCurrencies } from './base-currency';
import { getStoredRate } from './rates';
import { ownsTransferAmount, resolveRowAmounts } from './resolve';
import type {
  AmountSemantics,
  ResolvedAmounts,
  StoredAmounts,
} from './resolve';

/**
 * A write needs a rate that the database does not have. The caller must
 * get the rate first with `ensureRates`, or send the base value.
 */
export class MissingRateError extends Error {
  type = 'MissingRateError' as const;
  meta: { from: string; to: string; date: string };

  constructor(meta: { from: string; to: string; date: string }) {
    super(
      `No exchange rate from ${meta.from} to ${meta.to} for ${meta.date} is stored`,
    );
    this.meta = meta;
  }
}

export type TransactionWrite = Partial<TransactionEntity>;

export type CurrencyWritePlan = {
  added: TransactionWrite[];
  updated: TransactionWrite[];
  // Updates for rows that the caller did not send. A split parent stores
  // the sum of its children, so a change to a child changes the parent.
  extraUpdated: Array<Pick<TransactionEntity, 'id' | 'amount'>>;
  // The native amount for the other side of a new transfer, by the id of
  // the row that starts the transfer
  transferNativeAmounts: Map<TransactionEntity['id'], IntegerAmount>;
};

type RawRow = {
  id: string;
  acct: string;
  date: number;
  amount: number | null;
  native_amount: number | null;
  amount_locked: number | null;
  transferred_id: string | null;
  isParent: number;
  isChild: number;
  parent_id: string | null;
  tombstone: number;
};

const RAW_COLUMNS =
  'id, acct, date, amount, native_amount, amount_locked, transferred_id, isParent, isChild, parent_id, tombstone';

async function loadRawRows(ids: string[]): Promise<Map<string, RawRow>> {
  const rows = new Map<string, RawRow>();
  const pageSize = 500;
  for (let start = 0; start < ids.length; start += pageSize) {
    const page = ids.slice(start, start + pageSize);
    const found = await db.all<RawRow>(
      `SELECT ${RAW_COLUMNS} FROM transactions WHERE ${whereIn(page, 'id')}`,
    );
    for (const row of found) {
      rows.set(row.id, row);
    }
  }
  return rows;
}

function toStored(row: RawRow): StoredAmounts {
  return {
    account: row.acct,
    date: db.fromDateRepr(row.date),
    amount: row.amount ?? 0,
    native_amount: row.native_amount,
    amount_locked: row.amount_locked === 1,
  };
}

function withoutCurrencyFields(row: TransactionWrite): TransactionWrite {
  const {
    native_amount: nativeAmount,
    amount_locked: _amountLocked,
    _transfer_native_amount: _transferNativeAmount,
    ...rest
  } = row;
  // A caller that sends only the native amount means the amount
  if (rest.amount == null && nativeAmount != null) {
    return { ...rest, amount: nativeAmount };
  }
  return rest;
}

type Work = {
  row: TransactionWrite & { id: string };
  existing: StoredAmounts | null;
  raw: RawRow | null;
  account: string | null;
  date: string | null;
  // Null for an account in the base currency
  currency: string | null;
  isParent: boolean;
  parentId: string | null;
  result: ResolvedAmounts | null;
};

/**
 * Decides `amount`, `native_amount` and `amount_locked` for each row of
 * a write, before anything is written. See `resolveRowAmounts` for the
 * rules.
 *
 * It reads the stored rows first, because an update holds only the
 * fields that changed. It only reads rates from the database, so it is
 * safe to call inside a mutator. A rate that is not there stops the
 * write with a `MissingRateError`.
 *
 * A budget with no foreign currency account gets its rows back with no
 * currency fields, so such a budget is written exactly as before.
 */
export async function planCurrencyWrites({
  added = [],
  updated = [],
  deleted = [],
  amountSemantics,
}: {
  added?: TransactionWrite[];
  updated?: TransactionWrite[];
  deleted?: Array<Pick<TransactionEntity, 'id'>>;
  amountSemantics: AmountSemantics;
}): Promise<CurrencyWritePlan> {
  const { baseCurrency, foreignCurrencies } = await getForeignCurrencies();

  if (baseCurrency == null || foreignCurrencies.size === 0) {
    return {
      added: added.map(withoutCurrencyFields),
      updated: updated.map(withoutCurrencyFields),
      extraUpdated: [],
      transferNativeAmounts: new Map(),
    };
  }

  const currencyOf = (account: string | null | undefined) =>
    (account != null ? foreignCurrencies.get(account) : undefined) ?? null;

  const rateCache = new Map<string, number | null>();
  async function rateFor(currency: string, date: string) {
    const key = `${currency}:${date}`;
    if (!rateCache.has(key)) {
      const stored = await getStoredRate({
        from: currency,
        to: baseCurrency!,
        date,
      });
      rateCache.set(key, stored?.rate ?? null);
    }
    return rateCache.get(key) ?? null;
  }

  // The stored rows of this write, their transfer partners, and the
  // families of the splits that it touches
  const addedWithIds = added.map(row => ({ ...row, id: row.id ?? uuidv4() }));
  const updatedIds = updated.flatMap(row => (row.id ? [row.id] : []));
  const deletedIds = new Set(deleted.map(row => row.id));
  const rawRows = await loadRawRows([...updatedIds, ...deletedIds]);

  const parentIds = new Set<string>();
  for (const row of [...addedWithIds, ...updated]) {
    const raw = row.id ? rawRows.get(row.id) : undefined;
    const parentId = row.parent_id ?? raw?.parent_id;
    if (parentId) {
      parentIds.add(parentId);
    }
    if (row.id && (row.is_parent || raw?.isParent === 1)) {
      parentIds.add(row.id);
    }
  }
  for (const id of deletedIds) {
    const parentId = rawRows.get(id)?.parent_id;
    if (parentId) {
      parentIds.add(parentId);
    }
  }

  const partnerIds = [...rawRows.values()].flatMap(raw =>
    raw.transferred_id ? [raw.transferred_id] : [],
  );
  const extraRows = await loadRawRows(
    [...partnerIds, ...parentIds].filter(id => !rawRows.has(id)),
  );
  const storedRow = (id: string | null | undefined) =>
    id ? (rawRows.get(id) ?? extraRows.get(id) ?? null) : null;

  const payeeRows = await db.all<Pick<db.DbPayee, 'id' | 'transfer_acct'>>(
    'SELECT id, transfer_acct FROM payees WHERE transfer_acct IS NOT NULL',
  );
  const transferAccountOf = new Map(
    payeeRows.map(payee => [payee.id, payee.transfer_acct ?? null]),
  );

  function toWork(row: TransactionWrite, raw: RawRow | null): Work {
    const existing = raw ? toStored(raw) : null;
    const account = row.account ?? existing?.account ?? null;
    return {
      row: { ...row, id: row.id ?? uuidv4() },
      existing,
      raw,
      account,
      date: row.date ?? existing?.date ?? null,
      currency: currencyOf(account),
      isParent: row.is_parent ?? raw?.isParent === 1,
      parentId: row.parent_id ?? raw?.parent_id ?? null,
      result: null,
    };
  }

  const addedWork = addedWithIds.map(row => toWork(row, null));
  const updatedWork = updated.map(row => toWork(row, storedRow(row.id)));
  const allWork = [...addedWork, ...updatedWork];
  const workById = new Map(allWork.map(work => [work.row.id, work]));

  async function resolve(
    work: Work,
    extra: {
      ownerAmount?: IntegerAmount | null;
      children?: Array<{ amount: number; native_amount: number }> | null;
    } = {},
  ): Promise<ResolvedAmounts> {
    const rate =
      work.currency && work.date
        ? await rateFor(work.currency, work.date)
        : null;
    const result = resolveRowAmounts({
      existing: work.existing,
      change: work.row,
      amountSemantics,
      baseCurrency,
      accountCurrency: work.currency,
      rate,
      ...extra,
    });

    // `=== false` narrows the union also where strict null checks are off
    if (result.ok === false) {
      if (result.reason === 'missing-rate' && work.currency && work.date) {
        throw new MissingRateError({
          from: work.currency,
          to: baseCurrency!,
          date: work.date,
        });
      }
      throw new Error(
        'A new transaction in a foreign currency account needs a native amount',
      );
    }
    return {
      amount: result.amount,
      native_amount: result.native_amount,
      amount_locked: result.amount_locked,
    };
  }

  // The side of a transfer whose base value comes from the other side
  function partnerOf(work: Work): RawRow | null {
    if (!work.raw?.transferred_id || work.isParent) {
      return null;
    }
    const partner = storedRow(work.raw.transferred_id);
    if (!partner || partner.tombstone === 1) {
      return null;
    }

    // A new payee moves the other side to the account of that payee. A
    // payee that is not an account ends the transfer.
    let partnerAccount = partner.acct;
    if (work.row.payee !== undefined) {
      const movedTo = work.row.payee
        ? transferAccountOf.get(work.row.payee)
        : null;
      if (!movedTo) {
        return null;
      }
      partnerAccount = movedTo;
    }
    const partnerCurrency = currencyOf(partnerAccount);
    const nativeAmount =
      work.row.native_amount ??
      work.row.amount ??
      work.existing?.native_amount ??
      work.existing?.amount ??
      0;
    const ownsAmount = ownsTransferAmount({
      baseCurrency,
      currency: work.currency,
      partnerCurrency,
      nativeAmount,
    });
    return ownsAmount ? null : partner;
  }

  // 1. Rows that decide their own base value
  const mirrored: Array<{ work: Work; partner: RawRow }> = [];
  for (const work of allWork) {
    if (work.isParent) {
      continue;
    }
    const partner = partnerOf(work);
    if (partner) {
      mirrored.push({ work, partner });
    } else {
      work.result = await resolve(work);
    }
  }

  // 2. Rows that mirror the other side of their transfer
  for (const { work, partner } of mirrored) {
    const ownerAmount =
      workById.get(partner.id)?.result?.amount ?? partner.amount ?? 0;
    work.result = await resolve(work, { ownerAmount });
  }

  // 3. Split parents. A parent stores the sum of its children.
  const extraUpdated: CurrencyWritePlan['extraUpdated'] = [];
  for (const parentId of parentIds) {
    const parentWork = workById.get(parentId) ?? null;
    const parentRaw = storedRow(parentId);
    const parentAccount = parentWork?.account ?? parentRaw?.acct ?? null;
    const parentCurrency = currencyOf(parentAccount);

    if (!parentCurrency) {
      if (parentWork) {
        parentWork.result = await resolve(parentWork);
      }
      continue;
    }

    const storedChildren = await db.all<RawRow>(
      `SELECT ${RAW_COLUMNS} FROM transactions WHERE parent_id = ? AND tombstone = 0`,
      [parentId],
    );
    const children: Array<{ amount: number; native_amount: number }> = [];
    const seen = new Set<string>();
    for (const child of storedChildren) {
      seen.add(child.id);
      if (deletedIds.has(child.id)) {
        continue;
      }
      const result = workById.get(child.id)?.result;
      const amount = result?.amount ?? child.amount ?? 0;
      children.push({
        amount,
        native_amount:
          result?.native_amount ?? child.native_amount ?? child.amount ?? 0,
      });
    }
    for (const work of allWork) {
      if (work.parentId === parentId && !seen.has(work.row.id) && work.result) {
        children.push({
          amount: work.result.amount,
          native_amount: work.result.native_amount ?? work.result.amount,
        });
      }
    }

    if (parentWork) {
      parentWork.result = await resolve(parentWork, { children });
    } else if (parentRaw && parentRaw.tombstone !== 1 && children.length > 0) {
      const nativeSum = children.reduce(
        (total, child) => total + child.native_amount,
        0,
      );
      const amountSum = children.reduce(
        (total, child) => total + child.amount,
        0,
      );
      const parentNative = parentRaw.native_amount ?? parentRaw.amount ?? 0;
      if (nativeSum === parentNative && amountSum !== parentRaw.amount) {
        extraUpdated.push({ id: parentId, amount: amountSum });
      }
    }
  }

  // A parent that the loop above did not reach, for example one with no id match
  for (const work of allWork) {
    if (!work.result) {
      work.result = await resolve(work);
    }
  }

  // The native amount for the other side of each new transfer. This also
  // finds a missing rate before the first side is written.
  const transferNativeAmounts: CurrencyWritePlan['transferNativeAmounts'] =
    new Map();
  for (const work of allWork) {
    const result = work.result;
    const targetAccount = work.row.payee
      ? transferAccountOf.get(work.row.payee)
      : null;
    const isNewTransfer =
      !!targetAccount && !work.isParent && !work.raw?.transferred_id;
    const targetCurrency = currencyOf(targetAccount);
    if (!isNewTransfer || !result || !targetCurrency) {
      continue;
    }

    if (work.row._transfer_native_amount != null) {
      transferNativeAmounts.set(work.row.id, work.row._transfer_native_amount);
    } else if (targetCurrency === work.currency) {
      transferNativeAmounts.set(
        work.row.id,
        -(result.native_amount ?? result.amount) || 0,
      );
    } else if (result.amount === 0) {
      transferNativeAmounts.set(work.row.id, 0);
    } else {
      const date = work.date!;
      const rate = await rateFor(targetCurrency, date);
      if (rate == null) {
        throw new MissingRateError({
          from: targetCurrency,
          to: baseCurrency,
          date,
        });
      }
      transferNativeAmounts.set(
        work.row.id,
        convertAmount({
          amount: -result.amount,
          rate: 1 / rate,
          fromCurrency: baseCurrency,
          toCurrency: targetCurrency,
        }),
      );
    }
  }

  function applyToAdded(work: Work): TransactionWrite {
    const { _transfer_native_amount: _unused, ...row } = work.row;
    const result = work.result!;
    const next: TransactionWrite = { ...row, amount: result.amount };
    delete next.native_amount;
    delete next.amount_locked;
    if (result.native_amount != null) {
      next.native_amount = result.native_amount;
    }
    if (result.amount_locked) {
      next.amount_locked = true;
    }
    return next;
  }

  function applyToUpdated(work: Work): TransactionWrite {
    if (!work.raw) {
      // The row is not in the database. Leave the write as the caller sent it.
      return withoutCurrencyFields(work.row);
    }

    const { _transfer_native_amount: _unused, ...row } = work.row;
    const result = work.result!;
    const next: TransactionWrite = { ...row };
    delete next.amount;
    delete next.native_amount;
    delete next.amount_locked;

    if (result.amount !== (work.raw.amount ?? 0)) {
      next.amount = result.amount;
    }
    if (result.native_amount !== work.raw.native_amount) {
      next.native_amount = result.native_amount;
    }
    if (result.amount_locked !== (work.raw.amount_locked === 1)) {
      next.amount_locked = result.amount_locked;
    }
    return next;
  }

  return {
    added: addedWork.map(applyToAdded),
    updated: updatedWork.map(applyToUpdated),
    extraUpdated,
    transferNativeAmounts,
  };
}
