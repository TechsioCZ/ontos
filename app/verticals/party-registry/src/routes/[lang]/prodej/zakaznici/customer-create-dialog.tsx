import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Fiber, Option, Schema } from 'effect';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import {
  SaveBar,
  SidePanel,
  requiredLabelFor,
  saveLabelsFor,
  UnsavedChangesDialog,
  useDraftSave,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import {
  FormReact,
  FormRoot,
  NoticedTextField,
  TextField,
  fromPayload,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import type { FieldNotice } from '@app/core-runtime/ui/form';

import { browserAtomRuntime, browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { CreatedCustomer, CustomerListItem } from '../../../../api/customers-client.ts';
import { existingCustomerWithCompanyId } from '../../../../api/customer-create-decision.ts';
import {
  aresFailureKey,
  createCustomerFromDraft,
  createFailureKey,
  isCustomerWriteForbidden,
  lookupAres,
} from './customers-data.ts';
import {
  CreateDraftSchema,
  customerNameMaxLength,
  normalizedCustomerName,
  prefillFromAres,
} from './customers-model.ts';
import type { AresPrefill, CreateDraft } from './customers-model.ts';

const KEY = 'party-registry.pages.customers.create';

/** Pause after the last IČO keystroke before ARES is asked, so pasting or fixing a digit sends one lookup. */
const ARES_LOOKUP_DELAY = '600 millis';

/** Fields ARES may fill in. */
const prefillFields = [
  'city',
  'name',
  'postalCode',
  'street',
  'vatId',
] as const satisfies readonly (keyof AresPrefill)[];

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

/**
 * The create form: its fields and checks come from the create draft Schema, and every check shows under its field
 * as soon as the field changes. Only the Uložit button sends the draft (`useDraftSave`), so the form itself is never
 * submitted.
 */
const createForm = FormReact.make(fromPayload(CreateDraftSchema), {
  fields: {
    city: TextField,
    email: TextField,
    ico: NoticedTextField,
    name: NoticedTextField,
    phone: TextField,
    postalCode: TextField,
    street: TextField,
    vatId: TextField,
  },
  mode: { validation: 'onChange' },
  onSubmit: () => Effect.void,
  runtime: browserAtomRuntime,
});

const isCreateDraft = Schema.is(CreateDraftSchema);
const isCreateIco = Schema.is(CreateDraftSchema.fields.ico);

interface Notice {
  readonly status: 'error' | 'success' | 'warning';
  readonly text: string;
}

/** Messages about the IČO or name value (ARES lookup, duplicate IČO or name), shown under that field. */
interface FieldNotices {
  readonly ico: FieldNotice | null;
  readonly name: FieldNotice | null;
}

const NO_FIELD_NOTICES: FieldNotices = { ico: null, name: null };

/** Fields carrying a notice, for focusing the first of them. */
const noticedFields = (notices: FieldNotices) => (['ico', 'name'] as const).filter((field) => notices[field] !== null);

interface CreateFormFieldsProps {
  /** An ARES lookup of the IČO runs: the IČO field says so instead of its notice. */
  readonly aresBusy: boolean;
  readonly fieldNotices: FieldNotices;
  readonly notice: Notice | null;
  readonly noticeRef: RefObject<HTMLDivElement | null>;
}

/** The notice and every input of the create form, in visual order. The dialog owns the notices about them. */
const CreateFormFields = ({ aresBusy, fieldNotices, notice, noticeRef }: CreateFormFieldsProps) => {
  const { language, t } = useModernI18n();
  return (
    <>
      {notice !== null && (
        <div ref={noticeRef}>
          <StatusText showIcon status={notice.status}>
            {notice.text}
          </StatusText>
        </div>
      )}
      <createForm.ico
        autoComplete="off"
        helpText={t(`${KEY}.${aresBusy ? 'aresLoading' : 'icoHelp'}`)}
        id="customer-ico"
        inputMode="numeric"
        label={t(`${KEY}.ico`)}
        maxLength={8}
        notice={aresBusy ? null : fieldNotices.ico}
      />
      <createForm.name
        autoComplete="off"
        id="customer-name"
        label={t(`${KEY}.name`)}
        maxLength={customerNameMaxLength}
        notice={fieldNotices.name}
        required
        requiredLabel={requiredLabelFor(language)}
      />
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <createForm.vatId autoComplete="off" id="customer-vat-id" label={t(`${KEY}.vatId`)} />
        <createForm.email autoComplete="off" id="customer-email" label={t(`${KEY}.email`)} type="email" />
        <createForm.phone autoComplete="off" id="customer-phone" label={t(`${KEY}.phone`)} type="tel" />
      </div>
      <createForm.street autoComplete="off" id="customer-street" label={t(`${KEY}.street`)} />
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <createForm.city autoComplete="off" id="customer-city" label={t(`${KEY}.city`)} />
        <createForm.postalCode autoComplete="off" id="customer-postal-code" label={t(`${KEY}.postalCode`)} />
      </div>
    </>
  );
};

/**
 * Which fields of the create form the person typed into, and the values the form showed last. `onTyped` hears of every
 * change the person made; a change the dialog writes itself through `writeValues` (an ARES prefill, a reset) is not
 * typing.
 */
const useTypedFields = (onTyped: (fields: readonly (keyof CreateDraft)[]) => void) => {
  /** Fields the user typed into. ARES never overwrites them; it may replace what an earlier lookup filled in. */
  const typedFields = useRef(new Set<keyof CreateDraft>());
  /** The values the form showed last, so a change tells which fields it touched. */
  const shown = useRef<CreateDraft>(EMPTY_DRAFT);
  /** Set while the dialog itself writes the values: that is not typing. */
  const writing = useRef(false);
  useAtomSubscribe(
    createForm.values,
    (next) => {
      if (Option.isNone(next)) {
        return;
      }
      const previous = shown.current;
      shown.current = next.value;
      const typed = draftFields.filter((field) => next.value[field] !== previous[field]);
      if (writing.current || typed.length === 0) {
        return;
      }
      for (const field of typed) {
        typedFields.current.add(field);
      }
      onTyped(typed);
    },
    { immediate: false },
  );
  /** Writes the form's values without counting them as typed. */
  const writeValues = (write: () => void) => {
    writing.current = true;
    write();
    writing.current = false;
  };
  /** Starts over from an empty form, where nothing is typed. */
  const forgetTyping = () => {
    typedFields.current.clear();
    shown.current = EMPTY_DRAFT;
  };
  return { forgetTyping, shown, typedFields, writeValues };
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
  const { language, t } = useModernI18n();
  const labels = saveLabelsFor(language);
  const toaster = useToast();
  // The draft is the form's values, only on screen until Uložit sends it; typing never writes.
  const draft = Option.getOrElse(useAtomValue(createForm.values), () => EMPTY_DRAFT);
  const setValues = useAtomSet(createForm.setValues);
  const resetValues = useAtomSet(createForm.reset);
  const validate = useAtomSet(createForm.validate);
  const [aresBusy, setAresBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  /** Messages about the IČO or name value, shown under that field. Each clears as soon as its field changes. */
  const [fieldNotices, setFieldNotices] = useState<FieldNotices>(NO_FIELD_NOTICES);
  const noticeRef = useRef<HTMLDivElement>(null);
  /** IČO already sent to ARES in this form, so each IČO is looked up once. */
  const lookedUpIco = useRef<string | null>(null);
  // Typing into a field retires an error or warning, because it describes the values it was raised for.
  const { forgetTyping, shown, typedFields, writeValues } = useTypedFields((typed) => {
    setNotice((current) => (current?.status === 'success' ? current : null));
    setFieldNotices((current) => ({
      ico: typed.includes('ico') ? null : current.ico,
      name: typed.includes('name') ? null : current.name,
    }));
  });
  const ico = draft.ico.trim();
  /** A complete IČO with a valid checksum; only such an IČO reaches ARES. */
  const lookupIco = ico.length === 8 && isCreateIco(ico) ? ico : null;

  // The notice sits above the fields, so a message raised from the footer button is scrolled into view.
  useEffect(() => {
    if (notice !== null) {
      noticeRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [notice]);

  const showError = (failureKey: string) => setNotice({ status: 'error', text: t(`${KEY}.${failureKey}`) });

  /** A current customer already carries this IČO, so the owner would reuse it and write nothing. */
  const duplicateText = (displayName: string | null) =>
    displayName === null ? t(`${KEY}.duplicate`) : t(`${KEY}.duplicateNamed`, { name: displayName });

  const applyPrefill = (prefill: AresPrefill, lookedUp: string) => {
    const { current } = shown;
    const next = { ...current };
    for (const field of prefillFields) {
      const value = prefill[field];
      // A field the user typed into keeps its text unless it is empty again.
      if (value !== undefined && (!typedFields.current.has(field) || current[field].trim() === '')) {
        next[field] = value;
        typedFields.current.delete(field);
      }
    }
    writeValues(() => setValues(next));
    setNotice({ status: 'success', text: t(`${KEY}.aresDone`) });
    // The lookup succeeded, but the IČO is already on record: warn under the IČO before the user fills the rest.
    const listed = Option.getOrUndefined(existingCustomerWithCompanyId(existing, lookedUp));
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

  /** Returns the save outcome: the owner created or linked the customer, or nothing was written. */
  const applyCreated = (created: CreatedCustomer): 'saved' | 'failed' => {
    if (created.outcome === 'EXISTING_CUSTOMER') {
      // A current customer already carries this IČO and nothing was written, so the panel stays open with the reason.
      setFieldNotices({ ico: { status: 'error', text: duplicateText(created.displayName) }, name: null });
      revealFirstInvalid(['ico']);
      return 'failed';
    }
    toaster.create(
      created.outcome === 'LINKED_EXISTING_PARTY'
        ? { description: t(`${KEY}.toastMatched`), title: t(`${KEY}.toastCreated`), type: 'success' }
        : { title: t(`${KEY}.toastCreated`), type: 'success' },
    );
    onCreated();
    return 'saved';
  };

  // A complete, valid IČO is looked up in ARES once, after a short pause; a newer IČO or closing the form cancels it.
  const startLookup = useEffectEvent((target: string) =>
    browserRuntime.runFork(
      Effect.sleep(ARES_LOOKUP_DELAY).pipe(
        Effect.andThen(
          Effect.sync(() => {
            lookedUpIco.current = target;
            setAresBusy(true);
            setNotice(null);
            setFieldNotices(NO_FIELD_NOTICES);
          }),
        ),
        Effect.andThen(lookupAres(target)),
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() =>
              setFieldNotices({ ico: { status: 'error', text: t(`${KEY}.${aresFailureKey(error)}`) }, name: null }),
            ),
          onSuccess: (evidence) => Effect.sync(() => applyPrefill(prefillFromAres(evidence), target)),
        }),
        // An interrupted lookup did not answer, so the same IČO may be looked up again later.
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            if (lookedUpIco.current === target) {
              lookedUpIco.current = null;
            }
          }),
        ),
        Effect.ensuring(Effect.sync(() => setAresBusy(false))),
      ),
    ),
  );
  useEffect(() => {
    const lookup =
      open && lookupIco !== null && lookedUpIco.current !== lookupIco
        ? Option.some(startLookup(lookupIco))
        : Option.none();
    return () => {
      if (Option.isSome(lookup)) {
        browserRuntime.runFork(Fiber.interrupt(lookup.value));
      }
    };
  }, [open, lookupIco]);

  /**
   * Duplicates the page already knows about: a current customer with this IČO, or any listed customer with the
   * same name. The owner would refuse both (a same-name Party keeps its duplicate case open for review), so the
   * save answers at once, under the field concerned, without a slow round trip.
   */
  const knownDuplicates = (value: CreateDraft): FieldNotices => {
    const sameIco = Option.getOrUndefined(existingCustomerWithCompanyId(existing, value.ico));
    const name = normalizedCustomerName(value.name);
    const sameName = existing.find(
      (customer) => customer.displayName !== null && normalizedCustomerName(customer.displayName) === name,
    );
    return {
      ico: sameIco === undefined ? null : { status: 'error', text: duplicateText(sameIco.displayName) },
      name: sameName === undefined ? null : { status: 'error', text: t(`${KEY}.duplicateName`) },
    };
  };

  const createFailed = (error: Effect.Error<ReturnType<typeof createCustomerFromDraft>>) =>
    Effect.sync((): 'failed' => {
      showError(createFailureKey(error));
      if (isCustomerWriteForbidden(error)) {
        onWriteRefused();
      }
      return 'failed';
    });
  const createdCustomer = (created: CreatedCustomer) => Effect.sync(() => applyCreated(created));

  /** The one save: runs only for a changed, valid draft, once per click (`useDraftSave`). */
  const saveCustomer = (value: CreateDraft): Effect.Effect<'saved' | 'failed'> =>
    Effect.suspend(() => {
      setNotice(null);
      const duplicates = knownDuplicates(value);
      if (noticedFields(duplicates).length > 0) {
        setFieldNotices(duplicates);
        revealFirstInvalid(noticedFields(duplicates));
        return Effect.succeed('failed' as const);
      }
      return createCustomerFromDraft(value).pipe(
        Effect.matchEffect({ onFailure: createFailed, onSuccess: createdCustomer }),
      );
    });

  const record = useDraftSave({
    isValid: isCreateDraft,
    // The panel stays mounted while closed: only the open panel asks before leaving.
    open,
    runtime: browserRuntime,
    save: saveCustomer,
    value: draft,
  });

  // Field messages show once the draft is changed and invalid, the same moment the save bar says so.
  const invalid = record.status === 'invalid';
  useEffect(() => {
    if (invalid) {
      validate();
    }
  }, [invalid, validate]);

  /** Drops the draft and continues from an empty form: after a close, a discard or a successful create. */
  const resetForm = () => {
    lookedUpIco.current = null;
    writeValues(() => resetValues());
    forgetTyping();
    record.adopt(EMPTY_DRAFT);
    setNotice(null);
    setFieldNotices(NO_FIELD_NOTICES);
  };

  // Router navigation, browser Back and the panel's dismissal ask the same question as the Cancel button.
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: resetForm });
  // Every way out (Cancel, the panel's dismissal, a created customer) starts the next open from an empty form.
  const leave = () => {
    resetForm();
    onOpenChange(false);
  };
  // A created customer closes the panel.
  const handleSave = () => {
    record.save();
    record.afterSave((status) => {
      if (status === 'saved') {
        leave();
      }
    });
  };
  const handleReloadLatest = resetForm;

  return (
    <>
      <SidePanel
        actions={
          <>
            <Button appearance="outline" onClick={() => guard.request(leave)} severity="secondary" type="button">
              {t(`${KEY}.cancel`)}
            </Button>
            <SaveBar labels={labels} onReloadLatest={handleReloadLatest} onSave={handleSave} status={record.status} />
          </>
        }
        description={t(`${KEY}.description`)}
        guard={guard}
        // The IČO is the first field, so typing starts there at once.
        initialFocusEl={() => globalThis.document.querySelector<HTMLElement>('#customer-ico')}
        onOpenChange={(next) => {
          if (!next) {
            leave();
          }
        }}
        open={open}
        resizeLabel={t('party-registry.sidePanel.resize')}
        size="md"
        title={t(`${KEY}.title`)}
      >
        {/* The form has no submit button, so Enter does not save: only the Uložit button sends the draft. */}
        <FormRoot
          className="flex flex-col gap-200 py-200"
          defaultValues={EMPTY_DRAFT}
          form={createForm}
          translateMessage={(message) => t(message)}
        >
          <CreateFormFields aresBusy={aresBusy} fieldNotices={fieldNotices} notice={notice} noticeRef={noticeRef} />
        </FormRoot>
      </SidePanel>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};
