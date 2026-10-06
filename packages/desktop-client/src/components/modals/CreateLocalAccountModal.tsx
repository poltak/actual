// @ts-strict-ignore
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Form } from 'react-aria-components';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { FormError } from '@actual-app/components/form-error';
import { InitialFocus } from '@actual-app/components/initial-focus';
import { InlineField } from '@actual-app/components/inline-field';
import { Input } from '@actual-app/components/input';
import { Select } from '@actual-app/components/select';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import { isForeignCurrency } from '@actual-app/core/shared/currencies';
import { currentDay } from '@actual-app/core/shared/months';
import { toRelaxedNumber } from '@actual-app/core/shared/util';

import { useCreateAccountMutation } from '#accounts';
import { Link } from '#components/common/Link';
import {
  Modal,
  ModalButtons,
  ModalCloseButton,
  ModalHeader,
  ModalTitle,
} from '#components/common/Modal';
import { Checkbox } from '#components/forms';
import { useCurrencyOptions } from '#components/settings/Currency';
import { validateAccountName } from '#components/util/accountValidation';
import { useAccounts } from '#hooks/useAccounts';
import { useFeatureFlag } from '#hooks/useFeatureFlag';
import { useNavigate } from '#hooks/useNavigate';
import { useSyncedPref } from '#hooks/useSyncedPref';
import { useSyncServerStatus } from '#hooks/useSyncServerStatus';
import { closeModal } from '#modals/modalsSlice';
import { useDispatch } from '#redux';

export function CreateLocalAccountModal() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const isUsingServer = useSyncServerStatus() !== 'no-server';
  const { data: accounts = [] } = useAccounts();
  const [name, setName] = useState('');
  const [offbudget, setOffbudget] = useState(false);
  const [balance, setBalance] = useState('0');

  const [nameError, setNameError] = useState(null);
  const [balanceError, setBalanceError] = useState(false);

  // An account can have its own currency when the budget has one
  const isMultiCurrencyEnabled = useFeatureFlag('multiCurrency');
  const [defaultCurrencyCode] = useSyncedPref('defaultCurrencyCode');
  const baseCurrency = defaultCurrencyCode || '';
  const showCurrency = isMultiCurrencyEnabled && baseCurrency !== '';
  const currencyOptions = useCurrencyOptions().filter(([code]) => code !== '');
  const [currency, setCurrency] = useState(baseCurrency);
  const [hasRateError, setHasRateError] = useState(false);

  const validateBalance = balance => !isNaN(parseFloat(balance));

  const validateAndSetName = (name: string) => {
    const nameError = validateAccountName(name, '', accounts);
    if (nameError) {
      setNameError(nameError);
    } else {
      setName(name);
      setNameError(null);
    }
  };

  const createAccount = useCreateAccountMutation();

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const nameError = validateAccountName(name, '', accounts);

    const balanceError = !validateBalance(balance);
    setBalanceError(balanceError);

    if (!nameError && !balanceError) {
      const isForeign =
        showCurrency && isForeignCurrency({ currency, baseCurrency });
      const startingBalance = toRelaxedNumber(balance);

      // The starting balance gets a value in the currency of the budget,
      // and that needs the rate of today
      setHasRateError(false);
      if (isForeign && startingBalance !== 0) {
        const { missing } = await send('rates-ensure', {
          requests: [{ from: currency, to: baseCurrency, date: currentDay() }],
        });
        if (missing.length > 0) {
          setHasRateError(true);
          return;
        }
      }

      createAccount.mutate(
        {
          name,
          balance: startingBalance,
          offBudget: offbudget,
          ...(isForeign && { currency }),
        },
        {
          onSuccess: id => {
            dispatch(closeModal());
            void navigate('/accounts/' + id);
          },
        },
      );
    }
  };
  return (
    <Modal name="add-local-account">
      {({ state }) => (
        <>
          <ModalHeader
            title={
              <ModalTitle
                title={
                  isUsingServer ? t('Create Local Account') : t('Add account')
                }
                shrinkOnOverflow
              />
            }
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View>
            {!isUsingServer && (
              <Text
                style={{
                  color: theme.pageTextSubdued,
                  lineHeight: 1.5,
                  marginBottom: 15,
                }}
              >
                <Trans>
                  Once the account is created, you can also{' '}
                  <Link
                    variant="external"
                    linkColor="muted"
                    to="https://actualbudget.org/docs/transactions/importing"
                  >
                    import QIF/OFX/QFX files
                  </Link>{' '}
                  into it.
                </Trans>
              </Text>
            )}
            <Form onSubmit={onSubmit}>
              <InlineField label={t('Name')} width="100%">
                <InitialFocus>
                  <Input
                    name="name"
                    value={name}
                    placeholder={t('e.g. Bank, Savings, Credit Card, Cash')}
                    onChangeValue={setName}
                    onUpdate={value => {
                      const name = value.trim();
                      validateAndSetName(name);
                    }}
                    style={{ flex: 1 }}
                  />
                </InitialFocus>
              </InlineField>
              {nameError && (
                <FormError style={{ marginLeft: 75, color: theme.warningText }}>
                  {nameError}
                </FormError>
              )}

              <View
                style={{
                  width: '100%',
                  flexDirection: 'row',
                  justifyContent: 'flex-end',
                }}
              >
                <View style={{ flexDirection: 'column' }}>
                  <View
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'flex-end',
                    }}
                  >
                    <Checkbox
                      id="offbudget"
                      name="offbudget"
                      checked={offbudget}
                      onChange={() => setOffbudget(!offbudget)}
                    />
                    <label
                      htmlFor="offbudget"
                      style={{
                        userSelect: 'none',
                        verticalAlign: 'center',
                      }}
                    >
                      <Trans>Off budget</Trans>
                    </label>
                  </View>
                  <div
                    style={{
                      textAlign: 'right',
                      fontSize: '0.7em',
                      color: theme.pageTextLight,
                      marginTop: 3,
                    }}
                  >
                    <Text style={{ display: 'block' }}>
                      <Trans>
                        Off-budget accounts (like investments, loans, or your
                        house) are tracked but not part of your spending budget.
                      </Trans>
                    </Text>
                    <Text style={{ display: 'block' }}>
                      <Trans>
                        This cannot be changed later. See{' '}
                        <Link
                          variant="external"
                          linkColor="muted"
                          to="https://actualbudget.org/docs/accounts/#off-budget-accounts"
                        >
                          Accounts Overview
                        </Link>{' '}
                        for more information.
                      </Trans>
                    </Text>
                  </div>
                </View>
              </View>

              {showCurrency && (
                <>
                  <InlineField label={t('Currency')} width="100%">
                    <Select
                      value={currency}
                      onChange={code => {
                        setCurrency(code);
                        setHasRateError(false);
                      }}
                      options={currencyOptions}
                      style={{ flex: 1 }}
                    />
                  </InlineField>
                  <div
                    style={{
                      textAlign: 'right',
                      fontSize: '0.7em',
                      color: theme.pageTextLight,
                      marginBottom: 3,
                    }}
                  >
                    <Text style={{ display: 'block' }}>
                      <Trans>
                        The balance and the transactions of this account are in
                        this currency. This cannot be changed later.
                      </Trans>
                    </Text>
                  </div>
                </>
              )}

              <InlineField label={t('Balance')} width="100%">
                <Input
                  name="balance"
                  inputMode="decimal"
                  value={balance}
                  onChangeValue={setBalance}
                  onUpdate={value => {
                    const balance = value.trim();
                    setBalance(balance);
                    if (validateBalance(balance) && balanceError) {
                      setBalanceError(false);
                    }
                  }}
                  style={{ flex: 1 }}
                />
              </InlineField>
              {balanceError && (
                <FormError style={{ marginLeft: 75 }}>
                  <Trans>Balance must be a number</Trans>
                </FormError>
              )}
              {hasRateError && (
                <FormError style={{ marginLeft: 75 }}>
                  <Trans>
                    No exchange rate for today is available for this currency.
                    Turn on &quot;Download exchange rates&quot; in the settings,
                    or use a balance of 0.
                  </Trans>
                </FormError>
              )}

              <ModalButtons>
                <Button onPress={() => state.close()}>
                  {isUsingServer ? <Trans>Back</Trans> : <Trans>Cancel</Trans>}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  style={{ marginLeft: 10 }}
                >
                  <Trans>Create</Trans>
                </Button>
              </ModalButtons>
            </Form>
          </View>
        </>
      )}
    </Modal>
  );
}
