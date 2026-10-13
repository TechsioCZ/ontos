import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect } from 'effect';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SidePanel, dialogCloseLabel } from '@app/admin-ui';

import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { CreatedCustomer } from '../../../../api/customers-client.ts';
import { aresFailureKey, createCustomerFromDraft, createFailureKey, lookupAres } from './customers-data.ts';
import { customerNameMaxLength, prefillFromAres, validateCreateDraft } from './customers-model.ts';
import type { AresPrefill, CreateDraft, CreateDraftErrors } from './customers-model.ts';

const KEY = 'party-registry.pages.customers.create';

/** Validated fields in visual order, with the DOM ids of their inputs. */
const fieldIdsInOrder = [
  ['ico', 'customer-ico'],
  ['name', 'customer-name'],
  ['vatId', 'customer-vat-id'],
  ['email', 'customer-email'],
  ['street', 'customer-street'],
  ['city', 'customer-city'],
  ['postalCode', 'customer-postal-code'],
] as const satisfies readonly (readonly [keyof CreateDraft, string])[];

/**
 * Focuses the first failing field and scrolls it to the middle of the panel body, clear of the footer. Runs on
 * the next frame, after React has rendered the field's message, so the message lands in view too.
 */
const revealFirstInvalid = (failing: CreateDraftErrors) => {
  const [, id] = fieldIdsInOrder.find(([field]) => failing[field] !== undefined) ?? [];
  if (id !== undefined) {
    globalThis.requestAnimationFrame(() => {
      const element = globalThis.document.querySelector<HTMLElement>(`#${id}`);
      element?.focus();
      element?.scrollIntoView({ block: 'center' });
    });
  }
};

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

const draftFields = [
  'city',
  'email',
  'ico',
  'name',
  'phone',
  'postalCode',
  'street',
  'vatId',
] as const satisfies readonly (keyof CreateDraft)[];

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
  const formId = useId();
  const [draft, setDraft] = useState<CreateDraft>(EMPTY_DRAFT);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [aresBusy, setAresBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const noticeRef = useRef<HTMLDivElement>(null);
  const errors = validateCreateDraft(draft);

  // The notice sits above the fields, so a message raised from the footer button is scrolled into view.
  useEffect(() => {
    if (notice !== null) {
      noticeRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [notice]);

  const set = (patch: Partial<CreateDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const close = (next: boolean) => {
    if (!next) {
      setDraft(EMPTY_DRAFT);
      setSubmitted(false);
      setNotice(null);
    }
    onOpenChange(next);
  };

  /** Anything typed, ARES prefill included. A dirty form asks before Escape, the close button or Zrušit drop it. */
  const dirty = draftFields.some((field) => draft[field].trim() !== '');
  const requestClose = (next: boolean) => {
    if (!next && dirty && !busy) {
      setDiscardOpen(true);
      return;
    }
    close(next);
  };

  const discard = () => {
    setDiscardOpen(false);
    close(false);
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
    if (created.outcome === 'EXISTING_CUSTOMER') {
      // A current customer already carries this IČO and nothing was written, so the panel stays open with the reason.
      setNotice({
        status: 'error',
        text:
          created.displayName === null
            ? t(`${KEY}.duplicate`)
            : t(`${KEY}.duplicateNamed`, { name: created.displayName }),
      });
      return;
    }
    toaster.create(
      created.outcome === 'LINKED_EXISTING_PARTY'
        ? { description: t(`${KEY}.toastMatched`), title: t(`${KEY}.toastCreated`), type: 'success' }
        : { title: t(`${KEY}.toastCreated`), type: 'success' },
    );
    close(false);
    onCreated();
  };

  const loadFromAres = () => {
    const ico = draft.ico.trim();
    // The same format and checksum checks as submit, so a mistyped IČO never reaches ARES.
    const icoError = ico.length === 0 ? 'icoInvalid' : errors.ico;
    if (icoError !== undefined) {
      setNotice({ status: 'error', text: t(`${KEY}.validation.${icoError}`) });
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
    if (busy) {
      return;
    }
    setSubmitted(true);
    if (Object.keys(errors).length > 0) {
      revealFirstInvalid(errors);
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
    <>
      <SidePanel
        actions={
          <>
            <Button onClick={() => requestClose(false)} theme="outlined" type="button" variant="secondary">
              {t(`${KEY}.cancel`)}
            </Button>
            {/* Submits the form below, so Enter in any field saves the customer too. */}
            <Button form={formId} isLoading={busy} loadingText={t(`${KEY}.saving`)} type="submit" variant="primary">
              {t(`${KEY}.submit`)}
            </Button>
          </>
        }
        // A stray click outside must not drop typed input; Escape, the close button and Zrušit still ask first.
        closeOnInteractOutside={false}
        description={t(`${KEY}.description`)}
        // The IČO is the first field, so typing starts there at once.
        initialFocusEl={() => globalThis.document.querySelector<HTMLElement>('#customer-ico')}
        onOpenChange={requestClose}
        open={open}
        size="md"
        title={t(`${KEY}.title`)}
      >
        <form
          className="flex flex-col gap-200 py-200"
          id={formId}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {notice !== null && (
            <div ref={noticeRef}>
              <StatusText showIcon status={notice.status}>
                {notice.text}
              </StatusText>
            </div>
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
            {/* ui-kit Button sets no type, so inside the form it would be the submit button Enter clicks. */}
            <Button
              isLoading={aresBusy}
              loadingText={t(`${KEY}.aresLoading`)}
              onClick={loadFromAres}
              size="sm"
              theme="outlined"
              type="button"
              variant="secondary"
            >
              {t(`${KEY}.aresLoad`)}
            </Button>
          </div>
          <FormInput
            autoComplete="off"
            id="customer-name"
            label={t(`${KEY}.name`)}
            maxLength={customerNameMaxLength}
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
            {...fieldProps('street')}
          />
          <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
            <FormInput
              autoComplete="off"
              id="customer-city"
              label={t(`${KEY}.city`)}
              name="city"
              onChange={(event) => set({ city: event.target.value })}
              value={draft.city}
              {...fieldProps('city')}
            />
            <FormInput
              autoComplete="off"
              id="customer-postal-code"
              label={t(`${KEY}.postalCode`)}
              name="postalCode"
              onChange={(event) => set({ postalCode: event.target.value })}
              value={draft.postalCode}
              {...fieldProps('postalCode')}
            />
          </div>
        </form>
      </SidePanel>
      <Dialog
        actions={
          <>
            <Button onClick={() => setDiscardOpen(false)} theme="outlined" type="button" variant="secondary">
              {t(`${KEY}.discard.keep`)}
            </Button>
            <Button onClick={discard} type="button" variant="danger">
              {t(`${KEY}.discard.confirm`)}
            </Button>
          </>
        }
        closeLabel={dialogCloseLabel}
        customTrigger
        description={t(`${KEY}.discard.description`)}
        hideCloseButton
        onOpenChange={(details) => setDiscardOpen(details.open)}
        open={discardOpen}
        role="alertdialog"
        size="sm"
        title={t(`${KEY}.discard.title`)}
      />
    </>
  );
};
