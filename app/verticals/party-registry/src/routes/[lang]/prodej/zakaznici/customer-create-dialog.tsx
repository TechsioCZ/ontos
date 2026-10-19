import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect, Option } from 'effect';
import { useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SidePanel } from '@app/admin-ui';

import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { CreatedCustomer, CustomerListItem } from '../../../../api/customers-client.ts';
import { existingCustomerWithCompanyId } from '../../../../api/customer-create-decision.ts';
import { DiscardDialog } from './customer-discard-dialog.tsx';
import {
  aresFailureKey,
  createCustomerFromDraft,
  createFailureKey,
  isCustomerWriteForbidden,
  lookupAres,
} from './customers-data.ts';
import {
  customerNameMaxLength,
  normalizedCustomerName,
  prefillFromAres,
  validateCreateDraft,
} from './customers-model.ts';
import type { AresPrefill, CreateDraft } from './customers-model.ts';

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
const revealFirstInvalid = (failing: readonly string[]) => {
  const [, id] = fieldIdsInOrder.find(([field]) => failing.includes(field)) ?? [];
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
  readonly status: 'error' | 'success' | 'warning';
  readonly text: string;
}

/** A message about one field's value (ARES lookup, duplicate IČO or name), shown under that field. */
interface FieldNotice {
  readonly status: 'error' | 'warning';
  readonly text: string;
}

interface FieldNotices {
  readonly ico: FieldNotice | null;
  readonly name: FieldNotice | null;
}

const NO_FIELD_NOTICES: FieldNotices = { ico: null, name: null };

/** Fields carrying a notice, for focusing the first of them. */
const noticedFields = (notices: FieldNotices) => (['ico', 'name'] as const).filter((field) => notices[field] !== null);

/** Message props one field takes from the dialog: help text, or an error or warning about its value. */
interface FieldMessage {
  readonly helpText?: string;
  readonly validateStatus?: FieldNotice['status'];
}

interface CreateFormFieldsProps {
  readonly aresBusy: boolean;
  readonly draft: CreateDraft;
  readonly fieldProps: (key: keyof CreateDraft, help?: string) => FieldMessage;
  readonly notice: Notice | null;
  readonly noticeRef: RefObject<HTMLDivElement | null>;
  readonly onLoadFromAres: () => void;
  readonly set: (patch: Partial<CreateDraft>) => void;
}

/** The notice and every input of the create form, in visual order. The dialog owns the state behind them. */
const CreateFormFields = ({
  aresBusy,
  draft,
  fieldProps,
  notice,
  noticeRef,
  onLoadFromAres,
  set,
}: CreateFormFieldsProps) => {
  const { t } = useModernI18n();
  return (
    <>
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
          onClick={onLoadFromAres}
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
    </>
  );
};

export interface CustomerCreateDialogProps {
  /** Customers already listed on the page; the duplicate checks read them before the owner is asked. */
  readonly existing: readonly CustomerListItem[];
  readonly onCreated: () => void;
  readonly onOpenChange: (open: boolean) => void;
  /** The owner refused the create with 403: this role may not write customers. */
  readonly onWriteRefused: () => void;
  readonly open: boolean;
}

export const CustomerCreateDialog = ({
  existing,
  onCreated,
  onOpenChange,
  onWriteRefused,
  open,
}: CustomerCreateDialogProps) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const formId = useId();
  const [draft, setDraft] = useState<CreateDraft>(EMPTY_DRAFT);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [aresBusy, setAresBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  /** Messages about the IČO or name value, shown under that field. Each clears as soon as its field changes. */
  const [fieldNotices, setFieldNotices] = useState<FieldNotices>(NO_FIELD_NOTICES);
  const [discardOpen, setDiscardOpen] = useState(false);
  const noticeRef = useRef<HTMLDivElement>(null);
  const errors = validateCreateDraft(draft);

  // The notice sits above the fields, so a message raised from the footer button is scrolled into view.
  useEffect(() => {
    if (notice !== null) {
      noticeRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [notice]);

  // Editing a field retires an error or warning, because it describes the values it was raised for.
  const set = (patch: Partial<CreateDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setNotice((current) => (current?.status === 'success' ? current : null));
    setFieldNotices((current) => ({
      ico: patch.ico === undefined ? current.ico : null,
      name: patch.name === undefined ? current.name : null,
    }));
  };

  const close = (next: boolean) => {
    if (!next) {
      setDraft(EMPTY_DRAFT);
      setSubmitted(false);
      setNotice(null);
      setFieldNotices(NO_FIELD_NOTICES);
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

  const fieldProps = (key: keyof CreateDraft, help?: string): FieldMessage => {
    const error = submitted ? errors[key] : undefined;
    if (error !== undefined) {
      return { helpText: t(`${KEY}.validation.${error}`), validateStatus: 'error' };
    }
    const fieldNotice = key === 'ico' || key === 'name' ? fieldNotices[key] : null;
    if (fieldNotice !== null) {
      return { helpText: fieldNotice.text, validateStatus: fieldNotice.status };
    }
    return help === undefined ? {} : { helpText: help };
  };

  const showError = (failureKey: string) => setNotice({ status: 'error', text: t(`${KEY}.${failureKey}`) });

  /** A current customer already carries this IČO, so the owner would reuse it and write nothing. */
  const duplicateText = (displayName: string | null) =>
    displayName === null ? t(`${KEY}.duplicate`) : t(`${KEY}.duplicateNamed`, { name: displayName });

  const applyPrefill = (prefill: AresPrefill, ico: string) => {
    setDraft((current) => ({
      ...current,
      city: prefill.city ?? current.city,
      name: prefill.name ?? current.name,
      postalCode: prefill.postalCode ?? current.postalCode,
      street: prefill.street ?? current.street,
      vatId: prefill.vatId ?? current.vatId,
    }));
    setNotice({ status: 'success', text: t(`${KEY}.aresDone`) });
    // The lookup succeeded, but the IČO is already on record: warn under the IČO before the user fills the rest.
    const listed = Option.getOrUndefined(existingCustomerWithCompanyId(existing, ico));
    if (listed !== undefined) {
      setFieldNotices({
        ico: {
          status: 'warning',
          text:
            listed.displayName === null
              ? t(`${KEY}.aresDuplicate`)
              : t(`${KEY}.aresDuplicateNamed`, { name: listed.displayName }),
        },
        name: null,
      });
    }
  };

  const applyCreated = (created: CreatedCustomer) => {
    if (created.outcome === 'EXISTING_CUSTOMER') {
      // A current customer already carries this IČO and nothing was written, so the panel stays open with the reason.
      setFieldNotices({ ico: { status: 'error', text: duplicateText(created.displayName) }, name: null });
      revealFirstInvalid(['ico']);
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
      setFieldNotices({ ico: { status: 'error', text: t(`${KEY}.validation.${icoError}`) }, name: null });
      return;
    }
    setAresBusy(true);
    setNotice(null);
    setFieldNotices(NO_FIELD_NOTICES);
    void browserRuntime.runPromise(
      lookupAres(ico).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() =>
              setFieldNotices({ ico: { status: 'error', text: t(`${KEY}.${aresFailureKey(error)}`) }, name: null }),
            ),
          onSuccess: (evidence) => Effect.sync(() => applyPrefill(prefillFromAres(evidence), ico)),
        }),
        Effect.ensuring(Effect.sync(() => setAresBusy(false))),
      ),
    );
  };

  /**
   * Duplicates the page already knows about: a current customer with this IČO, or any listed customer with the
   * same name. The owner would refuse both (a same-name Party keeps its duplicate case open for review), so the
   * panel answers at once, under the field concerned, without a slow round trip.
   */
  const knownDuplicates = (): FieldNotices => {
    const sameIco = Option.getOrUndefined(existingCustomerWithCompanyId(existing, draft.ico));
    const name = normalizedCustomerName(draft.name);
    const sameName = existing.find(
      (customer) => customer.displayName !== null && normalizedCustomerName(customer.displayName) === name,
    );
    return {
      ico: sameIco === undefined ? null : { status: 'error', text: duplicateText(sameIco.displayName) },
      name: sameName === undefined ? null : { status: 'error', text: t(`${KEY}.duplicateName`) },
    };
  };

  const submit = () => {
    if (busy) {
      return;
    }
    setSubmitted(true);
    if (Object.keys(errors).length > 0) {
      revealFirstInvalid(Object.keys(errors));
      return;
    }
    const duplicates = knownDuplicates();
    if (noticedFields(duplicates).length > 0) {
      setNotice(null);
      setFieldNotices(duplicates);
      revealFirstInvalid(noticedFields(duplicates));
      return;
    }
    setBusy(true);
    setNotice(null);
    void browserRuntime.runPromise(
      createCustomerFromDraft(draft).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              showError(createFailureKey(error));
              if (isCustomerWriteForbidden(error)) {
                onWriteRefused();
              }
            }),
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
        resizeLabel={t('party-registry.sidePanel.resize')}
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
          <CreateFormFields
            aresBusy={aresBusy}
            draft={draft}
            fieldProps={fieldProps}
            notice={notice}
            noticeRef={noticeRef}
            onLoadFromAres={loadFromAres}
            set={set}
          />
        </form>
      </SidePanel>
      <DiscardDialog
        copyKey={KEY}
        onCancel={() => setDiscardOpen(false)}
        onConfirm={discard}
        onOpenChange={setDiscardOpen}
        open={discardOpen}
      />
    </>
  );
};
