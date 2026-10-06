// @ts-strict-ignore
// TODO: remove strict
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

import { theme } from '@actual-app/components/theme';
import { send } from '@actual-app/core/platform/client/connection';
import {
  addSplitTransaction,
  applyTransactionDiff,
  isPreviewId,
  makeEmptySplitSubtransactions,
  realizeTempTransactions,
  splitTransaction,
  updateTransaction,
} from '@actual-app/core/shared/transactions';
import { applyChanges, getChangedValues } from '@actual-app/core/shared/util';
import type {
  AccountEntity,
  CategoryEntity,
  PayeeEntity,
  RuleConditionEntity,
  ScheduleEntity,
  TransactionEntity,
  TransactionFilterEntity,
} from '@actual-app/core/types/models';

import { FeatureErrorFallback } from '#components/FeatureErrorFallback';
import type { TableHandleRef } from '#components/table';
import { useAccountCurrencies } from '#hooks/useAccountCurrencies';
import { isValidBoundaryDrop } from '#hooks/useDragDrop';
import type { DropPosition } from '#hooks/useDragDrop';
import { useNavigate } from '#hooks/useNavigate';
import { useSyncedPref } from '#hooks/useSyncedPref';
import { pushModal } from '#modals/modalsSlice';
import { addNotification } from '#notifications/notificationsSlice';
import { useDispatch } from '#redux';
import {
  fromView,
  getRateRequests,
  toDbDiff,
  toView,
} from '#transactions/accountCurrencyView';
import { ensureRatesOrNotify } from '#transactions/exchangeRates';

import { TableCurrencyProvider } from './table/TableCurrencyContext';
import { shouldApplyRuleChange } from './table/utils';
import { TransactionTable } from './TransactionsTable';
import type { TransactionTableProps } from './TransactionsTable';
// When data changes, there are two ways to update the UI:
//
// * Optimistic updates: we apply the needed updates to local data
//   and rerender immediately, and send off the changes to the
//   server. Currently, it assumes the server request is successful.
//   If it fails the user will see a generic error which isn't
//   great, but since the server is local a failure is very
//   unlikely. Still, we should notify errors better.
//
// * A full refetch and rerender: this is needed when applying
//   updates locally is too complex. Usually this happens when
//   changing a field that data is sorted on: we're not going
//   to resort the data in memory, we want to rely on the database
//   for that. So we need to do a full refresh.
//
// When writing updates, it's up to you to decide which one to do.
// Optimistic updates feel snappy, but they might show data
// differently than a full refresh. It's up to you to decide which
// one to use when doing updates.

async function saveDiff(diff, learnCategories) {
  const remoteUpdates = await send('transactions-batch-update', {
    ...diff,
    learnCategories,
  });

  if (remoteUpdates && remoteUpdates.updated.length > 0) {
    return { updates: remoteUpdates };
  }
  return {};
}

async function saveDiffAndApply(diff, changes, onChange, learnCategories) {
  const remoteDiff = await saveDiff(diff, learnCategories);
  onChange(
    // TODO:
    // @ts-expect-error - fix me
    applyTransactionDiff(changes.newTransaction, remoteDiff),
    // @ts-expect-error - fix me
    applyChanges(remoteDiff, changes.data),
  );
}

type TransactionListProps = Pick<
  TransactionTableProps,
  | 'accounts'
  | 'allowSplitTransaction'
  | 'ascDesc'
  | 'balances'
  | 'categoryGroups'
  | 'dateFormat'
  | 'hideFraction'
  | 'isAdding'
  | 'isMatched'
  | 'isNew'
  | 'loadMoreTransactions'
  | 'onBatchDelete'
  | 'onBatchDuplicate'
  | 'onBatchLinkSchedule'
  | 'onBatchUnlinkSchedule'
  | 'onCloseAddTransaction'
  | 'onCreatePayee'
  | 'onCreateRule'
  | 'onMakeAsNonSplitTransactions'
  | 'onSort'
  | 'onScheduleAction'
  | 'payees'
  | 'renderEmpty'
  | 'showAccount'
  | 'showBalances'
  | 'showCleared'
  | 'showGroup'
  | 'showReconciled'
  | 'showSelection'
  | 'columnOrder'
  | 'sortField'
  | 'transactions'
> & {
  tableRef: RefObject<TableHandleRef<TransactionEntity> | null>;
  allTransactions: TransactionEntity[];
  account: AccountEntity | undefined;
  category: CategoryEntity | undefined;
  isFiltered?: boolean;
  allowReorder?: boolean;
  onChange: (
    transaction: TransactionEntity,
    transactions: TransactionEntity[],
  ) => void;
  onApplyFilter: (
    f: Partial<RuleConditionEntity> | TransactionFilterEntity,
  ) => void;
  onRefetch: () => void;
};

export function TransactionList({
  tableRef,
  transactions,
  allTransactions,
  loadMoreTransactions,
  account,
  accounts,
  category,
  categoryGroups,
  payees,
  balances,
  showBalances,
  showReconciled,
  showCleared,
  showGroup,
  showAccount,
  columnOrder,
  isAdding,
  isNew,
  isMatched,
  isFiltered,
  allowReorder = true,
  dateFormat,
  hideFraction,
  renderEmpty,
  onSort,
  sortField,
  ascDesc,
  onChange,
  onRefetch,
  onCloseAddTransaction,
  onCreatePayee,
  onApplyFilter,
  showSelection = true,
  allowSplitTransaction = true,
  onBatchDelete,
  onBatchDuplicate,
  onBatchLinkSchedule,
  onBatchUnlinkSchedule,
  onCreateRule,
  onScheduleAction,
  onMakeAsNonSplitTransactions,
}: TransactionListProps) {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const [learnCategories = 'true'] = useSyncedPref('learn-categories');
  const isLearnCategoriesEnabled = String(learnCategories) === 'true';

  // On the page of a foreign currency account, the rows are in the view
  // form: `amount` holds the amount in the currency of the account. See
  // `accountCurrencyView`. All other pages work as before.
  const { baseCurrency, foreignCurrencyOf } = useAccountCurrencies();
  const pageCurrency = foreignCurrencyOf(account?.id);
  const hasViewRows = pageCurrency != null;
  transactions = useMemo(
    () => (hasViewRows ? transactions.map(toView) : transactions),
    [hasViewRows, transactions],
  );
  allTransactions = useMemo(
    () => (hasViewRows ? allTransactions.map(toView) : allTransactions),
    [hasViewRows, allTransactions],
  );

  const transactionsLatest = useRef<readonly TransactionEntity[]>([]);
  useLayoutEffect(() => {
    transactionsLatest.current = transactions;
  }, [transactions]);

  const transferAccountOf = useMemo(() => {
    const accountByPayee = new Map(
      payees.flatMap(payee =>
        payee.transfer_acct ? [[payee.id, payee.transfer_acct] as const] : [],
      ),
    );
    return (payeeId: string | null | undefined) =>
      (payeeId ? accountByPayee.get(payeeId) : undefined) ?? null;
  }, [payees]);

  // Gets the exchange rates that a save needs, and maps the rows that
  // are in the view form. Gives null when a rate is not available: the
  // save must stop then, because the server cannot convert the amount.
  const prepareDiff = useCallback(
    async <T extends Parameters<typeof toDbDiff>[0]['diff']>(
      diff: T,
    ): Promise<T | null> => {
      const stored = (id: string | undefined) =>
        transactionsLatest.current.find(row => row.id === id);
      const accountOf = (id: string | undefined) => stored(id)?.account;

      const requests = getRateRequests({
        added: diff.added,
        updated: diff.updated,
        dateOf: id => stored(id)?.date,
        accountOf,
        payees,
        foreignCurrencyOf,
        baseCurrency,
      });
      if (!(await ensureRatesOrNotify({ requests, dispatch }))) {
        return null;
      }

      return toDbDiff({
        diff,
        // A new row is in the view form on each page. A stored row is in
        // the view form only on the page of its account.
        isInViewForm: account => foreignCurrencyOf(account) != null,
        accountOf,
      });
    },
    [baseCurrency, dispatch, foreignCurrencyOf, payees],
  );

  const onAdd = useCallback(
    async (newTransactions: TransactionEntity[]) => {
      newTransactions = realizeTempTransactions(newTransactions);
      const diff = await prepareDiff({ added: newTransactions });
      if (diff) {
        await saveDiff(diff, isLearnCategoriesEnabled);
      }
      onRefetch();

      // The server gave the other side of a new transfer between two
      // currencies an amount from the exchange rate. The real amount is
      // almost never that number, so the dialog asks for it.
      const transfer = newTransactions.find(row => {
        const otherAccount = transferAccountOf(row.payee);
        return (
          otherAccount != null &&
          !row.is_parent &&
          foreignCurrencyOf(row.account) !== foreignCurrencyOf(otherAccount)
        );
      });
      if (diff && transfer) {
        dispatch(
          pushModal({
            modal: {
              name: 'transaction-amounts',
              options: { transactionId: transfer.id, onSaved: onRefetch },
            },
          }),
        );
      }
    },
    [
      dispatch,
      foreignCurrencyOf,
      isLearnCategoriesEnabled,
      onRefetch,
      prepareDiff,
      transferAccountOf,
    ],
  );

  const onSave = useCallback(
    async (transaction: TransactionEntity) => {
      const saveTransaction = async () => {
        const changes = updateTransaction(
          transactionsLatest.current,
          transaction,
        );
        transactionsLatest.current = changes.data;

        if (changes.diff.updated.length > 0) {
          const dateChanged = !!changes.diff.updated[0].date;
          if (dateChanged) {
            changes.diff.updated[0].sort_order = Date.now();
          }
          if (dateChanged || hasViewRows) {
            // The server gives a row of a foreign currency account its
            // value in the currency of the budget, so the page loads the
            // rows again after the save
            if (!dateChanged) {
              onChange(
                fromView(changes.newTransaction),
                changes.data.map(fromView),
              );
            }
            const diff = await prepareDiff(changes.diff);
            if (diff) {
              await saveDiff(diff, isLearnCategoriesEnabled);
            }
            onRefetch();
          } else {
            onChange(changes.newTransaction, changes.data);
            void saveDiffAndApply(
              changes.diff,
              changes,
              onChange,
              isLearnCategoriesEnabled,
            );
          }
        }
      };

      await saveTransaction();
    },
    [isLearnCategoriesEnabled, onChange, onRefetch, hasViewRows, prepareDiff],
  );

  // A change to the rows of a split, for the page of a foreign currency
  // account. The rows go to the page state in its own form, and the diff
  // goes to the server with native amounts.
  const applyViewChanges = useCallback(
    (changes: ReturnType<typeof addSplitTransaction>) => {
      onChange(fromView(changes.newTransaction), changes.data.map(fromView));
      void prepareDiff(changes.diff).then(diff =>
        diff ? saveDiff(diff, isLearnCategoriesEnabled) : null,
      );
    },
    [isLearnCategoriesEnabled, onChange, prepareDiff],
  );

  const onAddSplit = useCallback(
    (id: TransactionEntity['id']) => {
      const changes = addSplitTransaction(transactionsLatest.current, id);
      if (hasViewRows) {
        applyViewChanges(changes);
        return changes.diff.added[0].id;
      }
      onChange(changes.newTransaction, changes.data);
      void saveDiffAndApply(
        changes.diff,
        changes,
        onChange,
        isLearnCategoriesEnabled,
      );
      return changes.diff.added[0].id;
    },
    [isLearnCategoriesEnabled, onChange, hasViewRows, applyViewChanges],
  );

  const onSplit = useCallback(
    (id: TransactionEntity['id']) => {
      const changes = splitTransaction(
        transactionsLatest.current,
        id,
        makeEmptySplitSubtransactions,
      );
      if (hasViewRows) {
        applyViewChanges(changes);
        return changes.diff.added[0].id;
      }
      onChange(changes.newTransaction, changes.data);
      void saveDiffAndApply(
        changes.diff,
        changes,
        onChange,
        isLearnCategoriesEnabled,
      );
      return changes.diff.added[0].id;
    },
    [isLearnCategoriesEnabled, onChange, hasViewRows, applyViewChanges],
  );

  const onApplyRules = useCallback(
    async (
      transaction: TransactionEntity,
      updatedFieldName: string | null = null,
    ) => {
      // A row in the view form goes to the rules with one number, the
      // amount in the currency of its account. The rules read a row with
      // one number that way, and the result has the same form.
      const isInViewForm =
        hasViewRows || foreignCurrencyOf(transaction.account) != null;
      const afterRules = await send('rules-run', {
        transaction: isInViewForm
          ? { ...transaction, native_amount: undefined }
          : transaction,
      });
      if (isInViewForm) {
        afterRules.native_amount = transaction.native_amount;
      }

      // Show formula errors if any
      if (afterRules._ruleErrors && afterRules._ruleErrors.length > 0) {
        dispatch(
          addNotification({
            notification: {
              type: 'error',
              message: `Formula errors in rules:\n${afterRules._ruleErrors.join('\n')}`,
              sticky: true,
            },
          }),
        );
      }

      const diff = getChangedValues(transaction, afterRules);

      const newTransaction: TransactionEntity = { ...transaction };
      if (diff) {
        Object.keys(diff).forEach(field => {
          if (
            shouldApplyRuleChange(field, newTransaction[field], diff[field])
          ) {
            newTransaction[field] = diff[field];
          }
        });

        // When a rule updates a parent transaction, overwrite all changes to the current field in subtransactions.
        if (
          transaction.is_parent &&
          diff.subtransactions !== undefined &&
          updatedFieldName !== null
        ) {
          newTransaction.subtransactions = diff.subtransactions.map(
            (st, idx) => ({
              ...(newTransaction.subtransactions?.[idx] || st),
              ...(st[updatedFieldName] != null && {
                [updatedFieldName]: st[updatedFieldName],
              }),
            }),
          );
        }
      }
      return newTransaction;
    },
    [dispatch, hasViewRows, foreignCurrencyOf],
  );

  const onManagePayees = useCallback(
    (id: PayeeEntity['id']) => {
      void navigate(
        '/payees',
        id ? { state: { selectedPayee: id } } : undefined,
      );
    },
    [navigate],
  );

  const onNavigateToTransferAccount = useCallback(
    (accountId: AccountEntity['id']) => {
      void navigate(`/accounts/${accountId}`);
    },
    [navigate],
  );

  const onNavigateToSchedule = useCallback(
    (scheduleId: ScheduleEntity['id']) => {
      dispatch(
        pushModal({
          modal: { name: 'schedule-edit', options: { id: scheduleId } },
        }),
      );
    },
    [dispatch],
  );

  const onNotesTagClick = useCallback(
    (tag: string) => {
      onApplyFilter({
        field: 'notes',
        op: 'hasTags',
        value: tag,
        type: 'string',
      });
    },
    [onApplyFilter],
  );

  const onReorder = useCallback(
    async (id: string, dropPos: DropPosition, targetId: string) => {
      // Don't support reorder while sorted by non-date field or filtered
      if ((sortField && sortField !== 'date') || isFiltered) {
        return;
      }

      if (id === targetId) {
        return;
      }

      // Find the transaction being dragged to determine if it's a child
      const draggedTrans = allTransactions.find(t => t.id === id);
      if (!draggedTrans) {
        return;
      }

      // Preview (upcoming schedule) reordering: only against other
      // previews on the same date. Never mix preview and real transactions.
      if (isPreviewId(id) !== isPreviewId(targetId)) {
        return;
      }
      if (isPreviewId(id)) {
        const targetTrans = allTransactions.find(t => t.id === targetId);
        if (!targetTrans || targetTrans.date !== draggedTrans.date) {
          return;
        }

        const previews = allTransactions.filter(
          t => isPreviewId(t.id) && t.date === draggedTrans.date,
        );
        const targetIdx = previews.findIndex(t => t.id === targetId);
        if (targetIdx === -1) {
          return;
        }

        let apiTargetId: string | null;
        if (dropPos === 'after') {
          apiTargetId = targetTrans.schedule ?? null;
        } else {
          const aboveIdx = targetIdx - 1;
          apiTargetId =
            aboveIdx >= 0 ? (previews[aboveIdx].schedule ?? null) : null;
        }

        if (!draggedTrans.schedule) {
          return;
        }

        await send('schedule/move', {
          id: draggedTrans.schedule,
          targetId: apiTargetId,
        });
        onRefetch();
        return;
      }

      // Child transaction reordering: siblings only
      if (draggedTrans.is_child && draggedTrans.parent_id) {
        const siblings = allTransactions.filter(
          t => t.parent_id === draggedTrans.parent_id && !isPreviewId(t.id),
        );

        const targetTransIdx = siblings.findIndex(t => t.id === targetId);
        if (targetTransIdx === -1) {
          return; // Target is not a sibling
        }

        // Convert dropPos to API targetId for child reordering
        // API places transaction AFTER targetId; null means move to top of siblings
        let apiTargetId: string | null;
        if (dropPos === 'after') {
          apiTargetId = targetId;
        } else {
          const aboveIdx = targetTransIdx - 1;
          apiTargetId = aboveIdx >= 0 ? siblings[aboveIdx].id : null;
        }

        await send('transaction-move', {
          id,
          accountId: draggedTrans.account,
          targetId: apiTargetId,
        });
        onRefetch();
        return;
      }

      // Build a reorderable list that excludes child and preview/scheduled transactions
      const reorderable = allTransactions.filter(
        t => !t.is_child && !isPreviewId(t.id),
      );

      const transIdx = reorderable.findIndex(t => t.id === id);
      const targetTransIdx = reorderable.findIndex(t => t.id === targetId);

      if (transIdx === -1 || targetTransIdx === -1) {
        return;
      }

      const trans = reorderable[transIdx];
      const targetTrans = reorderable[targetTransIdx];
      const isAscending = sortField === 'date' && ascDesc === 'asc';

      // Validate drop position: same date or at a date boundary
      let isValidDrop = targetTrans.date === trans.date;
      if (!isValidDrop) {
        const neighborIdx =
          dropPos === 'before' ? targetTransIdx - 1 : targetTransIdx + 1;
        const neighborTrans =
          neighborIdx >= 0 && neighborIdx < reorderable.length
            ? reorderable[neighborIdx]
            : null;
        isValidDrop = isValidBoundaryDrop(
          dropPos,
          targetTrans.date,
          trans.date,
          neighborTrans?.date ?? null,
          isAscending,
        );
      }

      if (!isValidDrop) {
        return;
      }

      // Convert dropPos to API targetId
      // API places transaction AFTER targetId; null means move to top
      let apiTargetId: string | null;
      if (dropPos === 'after') {
        // Prevent inserting immediately after a split parent
        if (targetTrans.is_parent) {
          return;
        }
        apiTargetId = targetTrans.date === trans.date ? targetId : null;
      } else {
        const aboveIdx = targetTransIdx - 1;
        const aboveTrans = aboveIdx >= 0 ? reorderable[aboveIdx] : null;
        // For parent-level reordering, always anchor to parent transactions.
        // Using a child id here makes the backend miss the target and append.
        if (aboveTrans?.is_parent) {
          apiTargetId = aboveTrans.date === trans.date ? aboveTrans.id : null;
        } else {
          apiTargetId =
            aboveTrans && aboveTrans.date === trans.date ? aboveTrans.id : null;
        }
      }

      await send('transaction-move', {
        id,
        accountId: trans.account,
        targetId: apiTargetId,
      });
      onRefetch();
    },
    [sortField, ascDesc, isFiltered, allTransactions, onRefetch],
  );

  return (
    <ErrorBoundary FallbackComponent={FeatureErrorFallback}>
      <TableCurrencyProvider
        pageCurrency={pageCurrency}
        foreignCurrencyOf={foreignCurrencyOf}
        transferAccountOf={transferAccountOf}
        onRefetch={onRefetch}
      >
        <TransactionTable
          ref={tableRef}
          transactions={allTransactions}
          loadMoreTransactions={loadMoreTransactions}
          accounts={accounts}
          categoryGroups={categoryGroups}
          payees={payees}
          balances={balances}
          showBalances={showBalances}
          showReconciled={showReconciled}
          showCleared={showCleared}
          showAccount={showAccount}
          showCategory
          showGroup={showGroup}
          columnOrder={columnOrder}
          currentAccountId={account && account.id}
          currentCategoryId={category && category.id}
          isAdding={isAdding}
          isNew={isNew}
          isMatched={isMatched}
          dateFormat={dateFormat}
          hideFraction={hideFraction}
          renderEmpty={renderEmpty}
          onSave={onSave}
          onApplyRules={onApplyRules}
          onSplit={onSplit}
          onCloseAddTransaction={onCloseAddTransaction}
          onAdd={onAdd}
          onAddSplit={onAddSplit}
          onManagePayees={onManagePayees}
          onCreatePayee={onCreatePayee}
          style={{ backgroundColor: theme.tableBackground }}
          onNavigateToTransferAccount={onNavigateToTransferAccount}
          onNavigateToSchedule={onNavigateToSchedule}
          onNotesTagClick={onNotesTagClick}
          onSort={onSort}
          sortField={sortField}
          ascDesc={ascDesc}
          isFiltered={isFiltered}
          onReorder={allowReorder ? onReorder : undefined}
          onBatchDelete={onBatchDelete}
          onBatchDuplicate={onBatchDuplicate}
          onBatchLinkSchedule={onBatchLinkSchedule}
          onBatchUnlinkSchedule={onBatchUnlinkSchedule}
          onCreateRule={onCreateRule}
          onScheduleAction={onScheduleAction}
          onMakeAsNonSplitTransactions={onMakeAsNonSplitTransactions}
          showSelection={showSelection}
          allowSplitTransaction={allowSplitTransaction}
        />
      </TableCurrencyProvider>
    </ErrorBoundary>
  );
}
