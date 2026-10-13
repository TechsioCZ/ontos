import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect } from 'effect';
import { useState } from 'react';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SidePanel } from '@app/admin-ui';

import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { CreatedCustomer } from '../../../../api/customers-client.ts';
import { aresFailureKey, createCustomerFromDraft, createFailureKey, lookupAres } from './customers-data.ts';
import { prefillFromAres, validateCreateDraft } from './customers-model.ts';
import type { AresPrefill, CreateDraft } from './customers-model.ts';

const KEY = 'party-registry.pages.customers.create';

const EMPTY_DRAFT: CreateDraft = {
  city: '',
  email: '',
  ico: '',
  name: '',
  phone: '',
  postalCode: '',
  street: '',
  vatId: '',
};

interface Notice {
  readonly status: 'error' | 'success';
  readonly text: string;
}

export interface CustomerCreateDialogProps {
  readonly onCreated: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}

export const CustomerCreateDialog = ({ onCreated, onOpenChange, open }: CustomerCreateDialogProps) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const [draft, setDraft] = useState<CreateDraft>(EMPTY_DRAFT);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [aresBusy, setAresBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const errors = validateCreateDraft(draft);

  const set = (patch: Partial<CreateDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const close = (next: boolean) => {
    if (!next) {
      setDraft(EMPTY_DRAFT);
      setSubmitted(false);
      setNotice(null);
    }
    onOpenChange(next);
  };

  const fieldProps = (key: keyof CreateDraft, help?: string) => {
    const error = submitted ? errors[key] : undefined;
    if (error !== undefined) {
      return { helpText: t(`${KEY}.validation.${error}`), validateStatus: 'error' as const };
    }
    return help === undefined ? {} : { helpText: help };
  };

  const showError = (failureKey: string) => setNotice({ status: 'error', text: t(`${KEY}.${failureKey}`) });

  const applyPrefill = (prefill: AresPrefill) => {
    setDraft((current) => ({
      ...current,
      city: prefill.city ?? current.city,
      name: prefill.name ?? current.name,
      postalCode: prefill.postalCode ?? current.postalCode,
      street: prefill.street ?? current.street,
      vatId: prefill.vatId ?? current.vatId,
    }));
    setNotice({ status: 'success', text: t(`${KEY}.aresDone`) });
  };

  const applyCreated = (created: CreatedCustomer) => {
    toaster.create(
      created.matchedExistingParty
        ? { description: t(`${KEY}.toastMatched`), title: t(`${KEY}.toastCreated`), type: 'success' }
        : { title: t(`${KEY}.toastCreated`), type: 'success' },
    );
    close(false);
    onCreated();
  };

  const loadFromAres = () => {
    const ico = draft.ico.trim();
    if (!/^\d{8}$/u.test(ico)) {
      setNotice({ status: 'error', text: t(`${KEY}.validation.icoInvalid`) });
      return;
    }
    setAresBusy(true);
    setNotice(null);
    void browserRuntime.runPromise(
      lookupAres(ico).pipe(
        Effect.matchEffect({
          onFailure: (error) => Effect.sync(() => showError(aresFailureKey(error))),
          onSuccess: (evidence) => Effect.sync(() => applyPrefill(prefillFromAres(evidence))),
        }),
        Effect.ensuring(Effect.sync(() => setAresBusy(false))),
      ),
    );
  };

  const submit = () => {
    setSubmitted(true);
    if (Object.keys(errors).length > 0) {
      return;
    }
    setBusy(true);
    setNotice(null);
    void browserRuntime.runPromise(
      createCustomerFromDraft(draft).pipe(
        Effect.matchEffect({
          onFailure: (error) => Effect.sync(() => showError(createFailureKey(error))),
          onSuccess: (created) => Effect.sync(() => applyCreated(created)),
        }),
        Effect.ensuring(Effect.sync(() => setBusy(false))),
      ),
    );
  };

  return (
    <SidePanel
      actions={
        <>
          <Button onClick={() => close(false)} theme="outlined" variant="secondary">
            {t(`${KEY}.cancel`)}
          </Button>
          <Button isLoading={busy} loadingText={t(`${KEY}.saving`)} onClick={submit} variant="primary">
            {t(`${KEY}.submit`)}
          </Button>
        </>
      }
      description={t(`${KEY}.description`)}
      onOpenChange={close}
      open={open}
      size="md"
      title={t(`${KEY}.title`)}
    >
      <form
        className="flex flex-col gap-200 py-200"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {notice !== null && (
          <StatusText showIcon status={notice.status}>
            {notice.text}
          </StatusText>
        )}
        <div className="flex items-end gap-150">
          <div className="min-w-0 flex-1">
            <FormInput
              autoComplete="off"
              id="customer-ico"
              inputMode="numeric"
              label={t(`${KEY}.ico`)}
              maxLength={8}
              name="ico"
              onChange={(event) => set({ ico: event.target.value })}
              value={draft.ico}
              {...fieldProps('ico', t(`${KEY}.icoHelp`))}
            />
          </div>
          <Button
            isLoading={aresBusy}
            loadingText={t(`${KEY}.aresLoading`)}
            onClick={loadFromAres}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {t(`${KEY}.aresLoad`)}
          </Button>
        </div>
        <FormInput
          autoComplete="off"
          id="customer-name"
          label={t(`${KEY}.name`)}
          name="name"
          onChange={(event) => set({ name: event.target.value })}
          required
          value={draft.name}
          {...fieldProps('name')}
        />
        <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
          <FormInput
            autoComplete="off"
            id="customer-vat-id"
            label={t(`${KEY}.vatId`)}
            name="vatId"
            onChange={(event) => set({ vatId: event.target.value })}
            value={draft.vatId}
            {...fieldProps('vatId')}
          />
          <FormInput
            autoComplete="off"
            id="customer-email"
            label={t(`${KEY}.email`)}
            name="email"
            onChange={(event) => set({ email: event.target.value })}
            type="email"
            value={draft.email}
            {...fieldProps('email')}
          />
          <FormInput
            autoComplete="off"
            id="customer-phone"
            label={t(`${KEY}.phone`)}
            name="phone"
            onChange={(event) => set({ phone: event.target.value })}
            type="tel"
            value={draft.phone}
          />
        </div>
        <FormInput
          autoComplete="off"
          id="customer-street"
          label={t(`${KEY}.street`)}
          name="street"
          onChange={(event) => set({ street: event.target.value })}
          value={draft.street}
        />
        <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
          <FormInput
            autoComplete="off"
            id="customer-city"
            label={t(`${KEY}.city`)}
            name="city"
            onChange={(event) => set({ city: event.target.value })}
            value={draft.city}
          />
          <FormInput
            autoComplete="off"
            id="customer-postal-code"
            label={t(`${KEY}.postalCode`)}
            name="postalCode"
            onChange={(event) => set({ postalCode: event.target.value })}
            value={draft.postalCode}
          />
        </div>
      </form>
    </SidePanel>
  );
};
