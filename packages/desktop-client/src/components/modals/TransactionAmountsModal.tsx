import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Form } from 'react-aria-components';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { FormError } from '@actual-app/components/form-error';
import { InlineField } from '@actual-app/components/inline-field';
import { Input } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import { impliedRate } from '@actual-app/core/shared/currency-conversion';
import { q } from '@actual-app/core/shared/query';
import type { TransactionEntity } from '@actual-app/core/types/models';

import {
  Modal,
  ModalButtons,
  ModalCloseButton,
  ModalHeader,
  ModalTitle,
} from '#components/common/Modal';
import { FinancialText } from '#components/FinancialText';
import { useAccountCurrencies } from '#hooks/useAccountCurrencies';
import { useAccounts } from '#hooks/useAccounts';
import { useFormat } from '#hooks/useFormat';
import type { Modal as ModalType } from '#modals/modalsSlice';
import { aqlQuery } from '#queries/aqlQuery';
import { useDispatch } from '#redux';
import { getAmountFields } from '#transactions/amountFields';
import { ensureRatesOrNotify } from '#transactions/exchangeRates';

type TransactionAmountsModalProps = Extract<
  ModalType,
  { name: 'transaction-amounts' }
>['options'];

const LABEL_WIDTH = 150;

// The number that the user typed, with the sign of the stored amount.
// The dialog shows amounts with no sign.
function withSignOf(reference: number, typed: number): number {
  return reference < 0 ? -Math.abs(typed) : Math.abs(typed);
}

async function loadTransaction(
  id: TransactionEntity['id'],
): Promise<TransactionEntity | null> {
  const { data } = await aqlQuery(
    q('transactions').filter({ id }).select('*').options({ splits: 'all' }),
  );
  return data[0] ?? null;
}

/**
 * Lets a person set the amounts of a transaction that the exchange rate
 * cannot know: the amount on the other side of a transfer between two
 * currencies, and the value of a transaction in the currency of the
 * budget. `getAmountFields` decides which of the two fields show.
 */
export function TransactionAmountsModal({
  transactionId,
  onSaved,
}: TransactionAmountsModalProps) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const { baseCurrency, foreignCurrencyOf } = useAccountCurrencies();
  const { data: accounts = [] } = useAccounts();

  const [transaction, setTransaction] = useState<TransactionEntity | null>(
    null,
  );
  const [partner, setPartner] = useState<TransactionEntity | null>(null);
  // Null while the user did not type in the field
  const [otherSideText, setOtherSideText] = useState<string | null>(null);
  const [baseValueText, setBaseValueText] = useState<string | null>(null);
  const [hasNumberError, setHasNumberError] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let isCurrent = true;

    async function load() {
      const row = await loadTransaction(transactionId);
      const partnerRow = row?.transfer_id
        ? await loadTransaction(row.transfer_id)
        : null;
      if (isCurrent) {
        setTransaction(row);
        setPartner(partnerRow);
      }
    }

    void load();
    return () => {
      isCurrent = false;
    };
  }, [transactionId]);

  const currency = foreignCurrencyOf(transaction?.account);
  const partnerCurrency = foreignCurrencyOf(partner?.account);
  const format = useFormat(currency);
  const formatPartner = useFormat(partnerCurrency);
  const formatBase = useFormat();

  if (!transaction) {
    return null;
  }

  const { hasOtherSideField, hasBaseValueField } = getAmountFields({
    currency,
    hasPartner: partner != null,
    partnerCurrency,
  });

  const accountName = (id: string | null | undefined) =>
    accounts.find(account => account.id === id)?.name ?? '';
  const amount = transaction.native_amount ?? transaction.amount;
  const partnerAmount = partner ? (partner.native_amount ?? partner.amount) : 0;
  const rate = currency
    ? impliedRate({
        fromAmount: amount,
        toAmount: transaction.amount,
        fromCurrency: currency,
        toCurrency: baseCurrency,
      })
    : null;

  async function save(): Promise<boolean> {
    if (!transaction) {
      return false;
    }

    if (hasOtherSideField && partner && otherSideText != null) {
      const typed = formatPartner.fromEdit(otherSideText);
      if (typed == null) {
        setHasNumberError(true);
        return false;
      }
      // The other side has the opposite sign of this side
      const next = withSignOf(partnerAmount || -amount, typed);
      if (next !== partnerAmount) {
        await send('transactions-batch-update', {
          updated: [
            partnerCurrency
              ? { id: partner.id, native_amount: next }
              : { id: partner.id, amount: next },
          ],
        });
      }
    }

    if (hasBaseValueField && baseValueText != null) {
      const typed = formatBase.fromEdit(baseValueText);
      if (typed == null) {
        setHasNumberError(true);
        return false;
      }
      // An entry with an amount of zero, such as an exchange difference,
      // has no sign to follow, so the typed sign stays
      const next = amount === 0 ? typed : withSignOf(amount, typed);
      if (next !== transaction.amount) {
        await send('transactions-batch-update', {
          updated: [{ id: transaction.id, amount: next }],
          amountSemantics: 'explicit',
        });
      }
    }
    return true;
  }

  // Removes the lock, so that the value follows the exchange rate again
  async function resetToExchangeRate(): Promise<boolean> {
    if (!transaction || !currency) {
      return false;
    }
    const hasRates = await ensureRatesOrNotify({
      requests: [{ from: currency, to: baseCurrency, date: transaction.date }],
      dispatch,
    });
    if (!hasRates) {
      return false;
    }
    await send('transactions-batch-update', {
      updated: [{ id: transaction.id, amount_locked: false }],
    });
    return true;
  }

  async function run(action: () => Promise<boolean>, close: () => void) {
    setIsSaving(true);
    setHasNumberError(false);
    try {
      if (await action()) {
        onSaved?.();
        close();
      }
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Modal name="transaction-amounts">
      {({ state }) => (
        <>
          <ModalHeader
            title={
              <ModalTitle
                title={t('Amounts in two currencies')}
                shrinkOnOverflow
              />
            }
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <Form
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              void run(save, () => state.close());
            }}
          >
            <InlineField
              label={accountName(transaction.account)}
              labelWidth={LABEL_WIDTH}
              width="100%"
            >
              <FinancialText>{format(amount, 'financial')}</FinancialText>
            </InlineField>

            {hasOtherSideField && partner && (
              <InlineField
                label={accountName(partner.account)}
                labelWidth={LABEL_WIDTH}
                width="100%"
              >
                <Input
                  value={
                    otherSideText ??
                    formatPartner.forEdit(Math.abs(partnerAmount))
                  }
                  inputMode="decimal"
                  onChangeValue={setOtherSideText}
                  style={{ flex: 1 }}
                />
              </InlineField>
            )}

            {hasBaseValueField && (
              <>
                <InlineField
                  label={t('Value in {{currency}}', { currency: baseCurrency })}
                  labelWidth={LABEL_WIDTH}
                  width="100%"
                >
                  <Input
                    value={
                      baseValueText ??
                      formatBase.forEdit(Math.abs(transaction.amount))
                    }
                    inputMode="decimal"
                    onChangeValue={setBaseValueText}
                    style={{ flex: 1 }}
                  />
                </InlineField>
                <View style={{ marginLeft: LABEL_WIDTH, gap: 3 }}>
                  {rate != null && currency && (
                    <Text style={{ color: theme.pageTextSubdued }}>
                      <Trans>
                        This value is{' '}
                        {{
                          rate: formatBase(
                            Math.round(
                              rate *
                                Math.pow(10, formatBase.currency.decimalPlaces),
                            ),
                            'financial',
                          ),
                        }}{' '}
                        for 1 {{ currency }}.
                      </Trans>
                    </Text>
                  )}
                  <Text style={{ color: theme.pageTextSubdued }}>
                    {transaction.amount_locked ? (
                      <Trans>
                        A person set this value. It does not follow the exchange
                        rate.
                      </Trans>
                    ) : (
                      <Trans>
                        This value comes from the exchange rate of the date. A
                        value that you set here stays as it is.
                      </Trans>
                    )}
                  </Text>
                </View>
              </>
            )}

            {hasNumberError && (
              <FormError style={{ marginLeft: LABEL_WIDTH }}>
                <Trans>The amount must be a number</Trans>
              </FormError>
            )}

            <ModalButtons>
              {hasBaseValueField && transaction.amount_locked && (
                <Button
                  isDisabled={isSaving}
                  onPress={() =>
                    void run(resetToExchangeRate, () => state.close())
                  }
                  style={{ marginRight: 10 }}
                >
                  <Trans>Use the exchange rate</Trans>
                </Button>
              )}
              <Button onPress={() => state.close()}>
                <Trans>Cancel</Trans>
              </Button>
              <Button
                type="submit"
                variant="primary"
                isDisabled={isSaving}
                style={{ marginLeft: 10 }}
              >
                <Trans>Save</Trans>
              </Button>
            </ModalButtons>
          </Form>
        </>
      )}
    </Modal>
  );
}
