import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect } from 'effect';
import { useState } from 'react';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DetailList, SidePanel, formatDate } from '@app/admin-ui';

import type { CustomerListItem } from '../../../../api/customers-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { renameCustomer, renameFailureKey } from './customers-data.ts';
import { orDash } from './customers-model.ts';

const KEY = 'party-registry.pages.customers.detail';
const STATUS_KEY = 'party-registry.pages.customers.status';

export interface CustomerDetailDialogProps {
  readonly customer: CustomerListItem | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRenamed: () => void;
}

interface CustomerDetailViewProps {
  readonly customer: CustomerListItem;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRenamed: () => void;
}

const CustomerDetailView = ({ customer, onOpenChange, onRenamed }: CustomerDetailViewProps) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const [name, setName] = useState(customer.displayName ?? '');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const trimmed = name.trim();
  const nameError = submitted && trimmed.length === 0 ? t(`${KEY}.nameRequired`) : undefined;

  const applyRenamed = () => {
    toaster.create({ title: t(`${KEY}.toastRenamed`), type: 'success' });
    onRenamed();
    onOpenChange(false);
  };

  const save = () => {
    setSubmitted(true);
    if (trimmed.length === 0) {
      return;
    }
    setBusy(true);
    setNotice(null);
    void browserRuntime.runPromise(
      renameCustomer(customer, trimmed).pipe(
        Effect.matchEffect({
          onFailure: (error) => Effect.sync(() => setNotice(t(`${KEY}.${renameFailureKey(error)}`))),
          onSuccess: () => Effect.sync(applyRenamed),
        }),
        Effect.ensuring(Effect.sync(() => setBusy(false))),
      ),
    );
  };

  return (
    <SidePanel
      actions={
        <>
          <Button onClick={() => onOpenChange(false)} theme="outlined" variant="secondary">
            {t(`${KEY}.cancel`)}
          </Button>
          <Button isLoading={busy} loadingText={t(`${KEY}.saving`)} onClick={save} variant="primary">
            {t(`${KEY}.save`)}
          </Button>
        </>
      }
      onOpenChange={onOpenChange}
      open
      size="md"
      title={customer.displayName ?? t(`${KEY}.title`)}
    >
      <div className="flex flex-col gap-250 py-200">
        {notice !== null && (
          <StatusText showIcon status="error">
            {notice}
          </StatusText>
        )}
        <DetailList
          items={[
            { label: t(`${KEY}.companyId`), value: orDash(customer.companyId) },
            { label: t(`${KEY}.vatId`), value: orDash(customer.vatId) },
            { label: t(`${KEY}.email`), value: orDash(customer.email) },
            { label: t(`${KEY}.phone`), value: orDash(customer.phone) },
            { label: t(`${KEY}.city`), value: orDash(customer.city) },
            { label: t(`${KEY}.createdAt`), value: formatDate(customer.createdAt) },
            { label: t(`${KEY}.status`), value: t(`${STATUS_KEY}.${customer.status}`) },
          ]}
        />
        <FormInput
          autoComplete="off"
          helpText={nameError}
          id="customer-rename"
          label={t(`${KEY}.rename`)}
          name="displayName"
          onChange={(event) => setName(event.target.value)}
          required
          validateStatus={nameError === undefined ? 'default' : 'error'}
          value={name}
        />
      </div>
    </SidePanel>
  );
};

/** Keyed by customer so the rename field starts from the selected record every time. */
export const CustomerDetailDialog = ({ customer, onOpenChange, onRenamed }: CustomerDetailDialogProps) =>
  customer === null ? null : (
    <CustomerDetailView
      customer={customer}
      key={customer.counterpartyId}
      onOpenChange={onOpenChange}
      onRenamed={onRenamed}
    />
  );
