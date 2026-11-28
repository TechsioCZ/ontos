import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { browserAtomRuntime, browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { Effect, Option, Schema } from 'effect';
import { assignableSalespeople } from '../../../../crm/records.ts';
import type { CrmCommandSubmit } from '../../../../crm/records.ts';
// Create / edit a client (company or person). On create, contact persons can be entered right away (C01-01) and
// someone with the reassignment authority (`demo.crm.client-owner.assign`) may pick the salesperson; a
// salesperson always creates the client for themself.
import {
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  dialogCloseLabel,
  foldSearchText,
  requiredLabelFor,
  saveLabelsFor,
  surfaceTileClassName,
  useRecordDraft,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { SaveOutcome, SaveState } from '@app/admin-ui';
import {
  EntryTextField,
  FormBuilder,
  FormReact,
  FormRoot,
  RichRadioField,
  SelectTemplateField,
  TextAreaField,
  TextField,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { Button } from '@techsio/ui-kit/atoms/button';
import { ActionIcon } from '@techsio/ui-kit/atoms/action-icon';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { useEffect, useRef, useState } from 'react';
import type { CrmCommandInput } from '../../../../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { Client } from '../../../../../shared/domain/clients.ts';

import { clientSegments, segmentLabels } from './clients-model.ts';
import { EMAIL, NONE, draftOf, patchOf, sameClientDraft, validClientDraft } from './client-draft.ts';
import type { Draft } from './client-draft.ts';

const kinds = ['organization', 'person'] as const;
const kindOf = (value: string): Draft['kind'] => kinds.find((kind) => kind === value) ?? 'organization';

/** A text a person types; its check and message, when it has one, are the schema's. */
const checkedText = (valid: (text: string) => boolean, message: string) =>
  Schema.String.check(Schema.makeFilter((text: string) => valid(text.trim()) || message));

/** One text per contact person of a new client, keyed by the contact's row. */
const ContactTextsSchema = Schema.Record(Schema.String, Schema.String);

/**
 * The client as the panel edits it, and the contact persons of a new company, one record per contact field keyed by
 * the contact's row. The field checks show their messages on the fields; Enter sends nothing (the form has no submit
 * button): only Uložit does.
 */
const makeClientForm = () =>
  FormReact.make(
    FormBuilder.empty
      .addField('address', Schema.String)
      .addField('contactEmail', ContactTextsSchema)
      .addField('contactName', ContactTextsSchema)
      .addField('contactPhone', ContactTextsSchema)
      .addField('contactRole', ContactTextsSchema)
      .addField(
        'email',
        checkedText((email) => email === '' || EMAIL.test(email), 'Neplatný e-mail'),
      )
      .addField('kind', Schema.String)
      .addField(
        'name',
        checkedText((name) => name !== '', 'Vyplňte název'),
      )
      .addField('note', Schema.String)
      .addField('owner', Schema.String)
      .addField('phone', Schema.String)
      .addField(
        'regNo',
        checkedText((regNo) => regNo === '' || /^\d{8}$/u.test(regNo), 'IČO má 8 číslic'),
      )
      .addField('segment', Schema.String)
      .addField('vatNo', Schema.String)
      .addField('website', Schema.String),
    {
      fields: {
        address: TextField,
        contactEmail: EntryTextField,
        contactName: EntryTextField,
        contactPhone: EntryTextField,
        contactRole: EntryTextField,
        email: TextField,
        kind: RichRadioField,
        name: TextField,
        note: TextAreaField,
        owner: SelectTemplateField,
        phone: TextField,
        regNo: TextField,
        segment: SelectTemplateField,
        vatNo: TextField,
        website: TextField,
      },
      mode: { validation: 'onChange' },
      onSubmit: () => Effect.void,
      runtime: browserAtomRuntime,
    },
  );

type ClientForm = ReturnType<typeof makeClientForm>;
type ClientValues = ClientForm['schema']['Encoded'];

/** A new client and an edited one can be on screen together, so each mode has its own form. */
const clientForms = { create: makeClientForm(), edit: makeClientForm() };

interface ContactDraft {
  readonly email: string;
  readonly key: number;
  readonly name: string;
  readonly phone: string;
  readonly role: string;
}

/** The contact rows of the form, in the order they were added. */
const contactsOf = (values: ClientValues): readonly ContactDraft[] =>
  Object.keys(values.contactName)
    .map(Number)
    .toSorted((left, right) => left - right)
    .map((key) => ({
      email: values.contactEmail[key] ?? '',
      key,
      name: values.contactName[key] ?? '',
      phone: values.contactPhone[key] ?? '',
      role: values.contactRole[key] ?? '',
    }));

const draftFromValues = (values: ClientValues): Draft => ({
  address: values.address,
  email: values.email,
  kind: kindOf(values.kind),
  name: values.name,
  note: values.note,
  owner: values.owner,
  phone: values.phone,
  regNo: values.regNo,
  segment: values.segment,
  vatNo: values.vatNo,
  website: values.website,
});

const emptyTexts = (keys: readonly number[]) => Object.fromEntries(keys.map((key) => [String(key), '']));

const valuesOf = (draft: Draft, contactKeys: readonly number[]): ClientValues => ({
  ...draft,
  contactEmail: emptyTexts(contactKeys),
  contactName: emptyTexts(contactKeys),
  contactPhone: emptyTexts(contactKeys),
  contactRole: emptyTexts(contactKeys),
});

/** The contact texts with one more row, or without one. */
const withContact = (values: ClientValues, key: number): ClientValues => {
  const add = (texts: Readonly<Record<string, string>>) => ({ ...texts, [String(key)]: '' });
  return {
    ...values,
    contactEmail: add(values.contactEmail),
    contactName: add(values.contactName),
    contactPhone: add(values.contactPhone),
    contactRole: add(values.contactRole),
  };
};
const withoutContact = (values: ClientValues, key: number): ClientValues => {
  const drop = (texts: Readonly<Record<string, string>>) =>
    Object.fromEntries(Object.entries(texts).filter(([entry]) => entry !== String(key)));
  return {
    ...values,
    contactEmail: drop(values.contactEmail),
    contactName: drop(values.contactName),
    contactPhone: drop(values.contactPhone),
    contactRole: drop(values.contactRole),
  };
};

const optionalField = <K extends string>(key: K, value: string) => {
  const field: Partial<Record<K, string>> = {};
  if (value.trim() !== '') {
    Object.defineProperty(field, key, { configurable: true, enumerable: true, value: value.trim(), writable: true });
  }
  return field;
};

const incompleteContact = (entry: ContactDraft) =>
  entry.name.trim() === '' && [entry.role, entry.phone, entry.email].some((value) => value.trim() !== '');

const contactWithInvalidEmail = (entry: ContactDraft) =>
  entry.name.trim() !== '' && entry.email.trim() !== '' && !EMAIL.test(entry.email.trim());

const contactFilled = (entry: ContactDraft) =>
  [entry.name, entry.role, entry.phone, entry.email].some((value) => value.trim() !== '');

// Contacts of a new company that would block its creation (the form shows the field messages).
const contactsBlock = (value: Draft, contacts: readonly ContactDraft[]) =>
  value.kind === 'organization' && (contacts.some(incompleteContact) || contacts.some(contactWithInvalidEmail));

/**
 * The save status a client form shows. A new client's contact persons are typed input outside the draft: typing only
 * them still shows the shared status, and contacts that would block the create make the form invalid, like an empty
 * name does.
 */
const shownStatus = (
  mode: 'create' | 'edit',
  status: SaveState,
  input: { readonly contacts: readonly ContactDraft[]; readonly draft: Draft; readonly otherChanges: boolean },
): SaveState =>
  mode === 'create' &&
  ((status === 'idle' && input.otherChanges) || (status === 'dirty' && contactsBlock(input.draft, input.contacts)))
    ? 'invalid'
    : status;

const createCommandOf = (
  value: Draft,
  { canAssign, contacts }: { readonly canAssign: boolean; readonly contacts: readonly ContactDraft[] },
): CrmCommandInput => {
  const organization = value.kind === 'organization';
  const filledContacts = organization ? contacts.filter((entry) => entry.name.trim() !== '') : [];
  const segment = value.segment === NONE ? '' : value.segment;
  const command: CrmCommandInput = {
    _tag: 'CreateClient',
    kind: value.kind,
    name: value.name.trim(),
    ...optionalField('address', value.address),
    ...optionalField('email', value.email),
    ...optionalField('note', value.note),
    ...optionalField('phone', value.phone),
    ...optionalField('website', value.website),
    ...optionalField('segment', segment),
  };
  if (organization) {
    Object.assign(command, optionalField('regNo', value.regNo), optionalField('vatNo', value.vatNo));
  }
  if (canAssign && value.owner !== NONE) {
    Object.assign(command, { ownerSalespersonId: value.owner });
  }
  if (filledContacts.length > 0) {
    const proposedContacts = filledContacts.map((entry, index) => {
      const contact: NonNullable<Extract<CrmCommandInput, { readonly _tag: 'CreateClient' }>['contacts']>[number] = {
        name: entry.name.trim(),
        ...optionalField('role', entry.role),
        ...optionalField('phone', entry.phone),
        ...optionalField('email', entry.email),
      };
      if (index === 0) {
        Object.assign(contact, { primary: true });
      }
      return contact;
    });
    Object.assign(command, { contacts: proposedContacts });
  }
  return command;
};

const ContactDraftFields = ({
  entry,
  form,
  index,
  onRemove,
  removable,
  touched,
}: {
  readonly entry: ContactDraft;
  readonly form: ClientForm;
  readonly index: number;
  readonly onRemove: (key: number) => void;
  readonly removable: boolean;
  readonly touched: boolean;
}) => {
  const { t } = useModernI18n();
  const row = String(entry.key);
  const incomplete = touched && incompleteContact(entry);
  return (
    <div className={`${surfaceTileClassName} relative grid grid-cols-1 gap-150 p-200 sm:grid-cols-2`}>
      <form.contactName
        autoComplete="off"
        entry={row}
        helpText={incomplete ? 'Doplňte jméno kontaktní osoby.' : undefined}
        id={`crm-new-contact-${row}-name`}
        invalid={incomplete}
        label={index === 0 ? 'Jméno (hlavní kontakt)' : 'Jméno'}
      />
      <form.contactRole
        autoComplete="off"
        entry={row}
        id={`crm-new-contact-${row}-role`}
        label={t('crm.ciClientsVisits.fields.jobRole')}
        placeholder={t('crm.ciClientsVisits.contacts.roleExample')}
      />
      <form.contactPhone
        autoComplete="off"
        entry={row}
        id={`crm-new-contact-${row}-phone`}
        label={t('crm.ciClientsVisits.fields.phone')}
        type="tel"
      />
      <form.contactEmail
        autoComplete="off"
        entry={row}
        id={`crm-new-contact-${row}-email`}
        label={t('crm.ciClientsVisits.fields.email')}
        type="email"
      />
      {removable && (
        <ActionIcon
          aria-label={t('crm.ciClientsVisits.contacts.removeFromForm')}
          className="absolute end-100 top-100"
          icon="icon-[mdi--close]"
          onClick={() => onRemove(entry.key)}
          severity="neutral"
          size="sm"
          type="button"
        />
      )}
    </div>
  );
};

/**
 * Rendered inside `FormRoot`, which renders its children only once this mount initialized the form: until then the
 * form's atoms can still hold what an earlier panel left, so its values are read only after this.
 */
const FormReady = ({ onReady }: { readonly onReady: (ready: boolean) => void }) => {
  useEffect(() => onReady(true), [onReady]);
  return null;
};

/** Built when rendered, not at module load: the module contract generator imports this module without a JSX runtime. */
const kindChoices = () =>
  kinds.map((kind) => ({
    label: (
      <>
        <span
          aria-hidden
          className={`${kind === 'organization' ? 'icon-[mdi--office-building-outline]' : 'icon-[mdi--account-outline]'} me-50 inline-block size-200 align-middle`}
        />
        {kind === 'organization' ? 'Firma' : 'Fyzická osoba'}
      </>
    ),
    value: kind,
  }));

interface ClientFormDialogProps {
  readonly busy: boolean;
  readonly client?: Client;
  readonly mode: 'create' | 'edit';
  readonly onClose: () => void;
  readonly onSaved: (clientId: string) => void;
  readonly records: RecordsResponse;
  readonly submit: CrmCommandSubmit;
}

const useClientForm = ({ busy, client, mode, onClose, onSaved, records, submit }: ClientFormDialogProps) => {
  const toaster = useToast();
  const { viewer } = records;
  const defaultOwner = viewer.salespersonId ?? NONE;
  const editing = mode === 'edit' && client !== undefined;
  const form = clientForms[mode];
  const [failure, setFailure] = useState<string | undefined>();
  // The values the panel opens with; the form reads them once, when it starts.
  const opened = valuesOf(draftOf(client, defaultOwner), mode === 'create' ? [0] : []);
  const [ready, setReady] = useState(false);
  const values = Option.getOrElse(
    Option.filter(useAtomValue(form.values), () => ready),
    () => opened,
  );
  const setValues = useAtomSet(form.setValues);
  const validate = useAtomSet(form.validate);
  const validateName = useAtomSet(form.getFieldAtoms(form.fields.name).validate);
  const reset = useAtomSet(form.reset);
  const checked = useAtomValue(form.validationCount) > 0;
  const contacts = contactsOf(values);

  // Edit: sends only the changed fields (UpdateClient is a patch; the CRM submit retries it on the latest revision).
  const sendUpdate = (value: Draft): Effect.Effect<SaveOutcome> => {
    if (client === undefined) {
      return Effect.succeed('failed');
    }
    const changes = patchOf(value, client);
    if (Object.keys(changes).length === 0) {
      return Effect.succeed('saved');
    }
    return submit({ _tag: 'UpdateClient', id: client.id, patch: changes }).pipe(
      Effect.tap((outcome) => Effect.sync(() => setFailure(outcome.ok ? undefined : outcome.message))),
      Effect.map((outcome) => (outcome.ok ? 'saved' : 'failed')),
    );
  };

  // Create: Uložit sends the new client with its contacts. Contacts that block it show their messages instead.
  const sendCreate = (value: Draft): Effect.Effect<SaveOutcome> => {
    if (!validClientDraft(value) || contactsBlock(value, contacts)) {
      return Effect.sync(() => {
        validate();
        return 'failed' as const;
      });
    }
    return submit(createCommandOf(value, { canAssign: viewer.assign, contacts })).pipe(
      Effect.tap((outcome) =>
        Effect.sync(() => {
          if (!outcome.ok) {
            const message = outcome.message ?? 'Uložení se nezdařilo. Zkuste to prosím znovu.';
            setFailure(message);
            toaster.create({ description: message, title: 'Klienta se nepodařilo uložit', type: 'error' });
            return;
          }
          toaster.create({
            description: 'Identitu firmy v evidenci zákazníků zapsal systém; najdete ji na kartě klienta.',
            title: `Klient ${value.name.trim()} založen`,
            type: 'success',
          });
          onSaved(outcome.entityIds[0] ?? '');
        }),
      ),
      Effect.map((outcome) => (outcome.ok ? 'saved' : 'failed')),
    );
  };

  // The draft is sent only by `record.save()`, the one Save button of both modes. Nothing else sends it.
  const record = useRecordDraft<Draft, never>({
    equals: sameClientDraft,
    isValid: (value) => validClientDraft(value),
    runtime: browserRuntime,
    save: (value) => (editing ? sendUpdate(value) : sendCreate(value)),
    server: draftOf(client, defaultOwner),
  });
  const { draft, setDraft } = record;
  // Typing is the draft: a change of the form changes it at once.
  useAtomSubscribe(
    form.values,
    (next) => {
      if (Option.isSome(next)) {
        setDraft(draftFromValues(next.value));
      }
    },
    { immediate: false },
  );
  // The draft also moves without typing (a newer server version, Zahodit změny): the form follows it.
  const shownDraft = useRef(draft);
  useEffect(() => {
    if (shownDraft.current === draft) {
      return;
    }
    shownDraft.current = draft;
    if (ready && !sameClientDraft(draftFromValues(values), draft)) {
      setValues({ ...values, ...draft });
    }
  }, [draft, ready, setValues, shownDraft, values]);

  // A new client's contact persons are not part of the draft, but they are typed input that a leave would lose.
  const otherChanges = mode === 'create' && contacts.some(contactFilled);
  const blocker = useBlocker({
    enableBeforeUnload: false,
    shouldBlockFn: () => record.dirty || otherChanges,
    withResolver: true,
  });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: record.discard, otherChanges });

  const organization = draft.kind === 'organization';
  const status = shownStatus(mode, record.status, { contacts, draft, otherChanges });
  // A new client shows its field messages once the draft cannot be sent or Uložit was refused; an edited one always.
  const shown = editing || checked || status === 'invalid';
  useEffect(() => {
    if (ready && shown) {
      validateName();
    }
  }, [ready, shown, validateName]);
  // Back at the values it opened with, the form shows no messages.
  useAtomSubscribe(
    form.isDirty,
    (dirty) => {
      if (!dirty) {
        reset();
      }
    },
    { immediate: false },
  );
  // C01-02: never merged automatically — only a visible hint about clients that look the same.
  const lookalikes =
    mode === 'create'
      ? records.state.clients.items.filter(
          (other) =>
            (draft.regNo.trim() !== '' && other.regNo === draft.regNo.trim()) ||
            (draft.name.trim().length > 3 && foldSearchText(other.name) === foldSearchText(draft.name.trim())),
        )
      : [];

  const contactEmailError = mode === 'create' && organization && contacts.some(contactWithInvalidEmail);

  const close = () => guard.request(onClose);

  const owners = [
    ...assignableSalespeople(records).map((person) => ({ label: person.name, value: person.id })),
    { label: 'Zatím bez obchodníka', value: NONE },
  ];

  const handleAddContact = () => setValues(withContact(values, (contacts.at(-1)?.key ?? 0) + 1));
  const handleRemoveContact = (key: number) => setValues(withoutContact(values, key));

  return {
    busy,
    close,
    contactEmailError,
    contacts,
    failure,
    form,
    guard,
    handleAddContact,
    handleRemoveContact,
    lookalikes,
    mode,
    onClose,
    opened,
    organization,
    owners,
    record,
    setReady,
    shown,
    status,
    viewer,
  };
};

export const ClientFormDialog = (props: ClientFormDialogProps) => {
  const { language, t } = useModernI18n();
  const {
    busy,
    close,
    contactEmailError,
    contacts,
    failure,
    form,
    guard,
    handleAddContact,
    handleRemoveContact,
    lookalikes,
    mode,
    onClose,
    opened,
    organization,
    owners,
    record,
    setReady,
    shown,
    status,
    viewer,
  } = useClientForm(props);
  const labels = saveLabelsFor(language);

  const handleReloadLatest = record.reloadLatest;
  const handleSave = record.save;
  return (
    <SidePanel
      actions={
        <>
          <Button appearance="outline" disabled={busy} onClick={close} severity="secondary">
            {mode === 'create' ? 'Zrušit' : 'Zavřít'}
          </Button>
          <SaveBar labels={labels} onReloadLatest={handleReloadLatest} onSave={handleSave} status={status} />
        </>
      }
      closeLabel={dialogCloseLabel}
      description={
        mode === 'create'
          ? 'Neuvedené údaje zůstanou prázdné. Kontaktní osoby můžete doplnit i později na kartě klienta.'
          : undefined
      }
      guard={guard}
      onOpenChange={(open) => {
        // Escape, the close button and an outside click ask the guard first; this runs once it allowed the leave.
        if (!open) {
          onClose();
        }
      }}
      open
      resizeLabel="Změnit šířku panelu"
      size="lg"
      title={mode === 'create' ? 'Nový klient' : `Upravit klienta`}
    >
      <FormRoot
        className="flex flex-col gap-250 py-100"
        defaultValues={opened}
        form={form}
        translateMessage={(message) => t(message, { defaultValue: message })}
      >
        <FormReady onReady={setReady} />
        <form.kind
          itemGroupClassName="inline-flex w-fit gap-150 rounded-lg border border-border-primary p-100"
          items={kindChoices()}
          label="Typ klienta"
          size="sm"
        />
        <div className="grid grid-cols-1 gap-150 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <form.name
              autoComplete="off"
              id="crm-client-name"
              label={organization ? 'Název firmy' : 'Jméno a příjmení'}
              name="name"
              required
              requiredLabel={requiredLabelFor(language)}
            />
          </div>
          {organization && (
            <>
              <form.regNo
                autoComplete="off"
                id="crm-client-regno"
                inputMode="numeric"
                label={t('crm.ciClientsVisits.fields.registrationNumber')}
                name="regNo"
              />
              <form.vatNo
                autoComplete="off"
                id="crm-client-vatno"
                label={t('crm.ciClientsVisits.fields.taxId')}
                name="vatNo"
              />
            </>
          )}
          <form.segment
            items={[
              { label: 'Neuvedeno', value: NONE },
              ...clientSegments.map((key) => ({ label: segmentLabels[key], value: key })),
            ]}
            label={t('crm.ciClientsVisits.fields.segment')}
            name="segment"
          />
          {mode === 'create' && viewer.assign ? (
            <form.owner items={owners} label={t('crm.ciClientsVisits.fields.salesperson')} name="owner" />
          ) : (
            <div />
          )}
          <form.phone
            autoComplete="off"
            id="crm-client-phone"
            label={organization ? 'Pracovní telefon' : 'Telefon'}
            name="phone"
            type="tel"
          />
          <form.email
            autoComplete="off"
            id="crm-client-email"
            label={t('crm.ciClientsVisits.fields.email')}
            name="email"
            type="email"
          />
          <div className="sm:col-span-2">
            <form.address
              autoComplete="off"
              id="crm-client-address"
              label={t('crm.ciClientsVisits.fields.address')}
              name="address"
              placeholder={t('crm.ciClientsVisits.fields.addressPlaceholder')}
            />
          </div>
          <div className="sm:col-span-2">
            <form.website
              autoComplete="off"
              id="crm-client-website"
              label={t('crm.ciClientsVisits.fields.website')}
              name="website"
            />
          </div>
          <div className="sm:col-span-2">
            <form.note
              id="crm-client-note"
              label={t('crm.ciClientsVisits.fields.note')}
              maxLength={4000}
              name="note"
              rows={3}
            />
          </div>
        </div>
        {mode === 'create' && organization && (
          <section className="flex flex-col gap-150">
            <div className="flex items-center justify-between gap-100">
              <h3 className="font-semibold text-sm">Kontaktní osoby</h3>
              <Button
                appearance="ghost"
                icon="icon-[mdi--account-plus-outline]"
                onClick={handleAddContact}
                severity="secondary"
                size="sm"
                type="button"
              >
                Další osoba
              </Button>
            </div>
            {contacts.map((entry, index) => (
              <ContactDraftFields
                entry={entry}
                form={form}
                index={index}
                key={entry.key}
                onRemove={handleRemoveContact}
                removable={contacts.length > 1}
                touched={shown}
              />
            ))}
            {contactEmailError && (
              <StatusText showIcon status="error">
                Některý e-mail kontaktní osoby není platný.
              </StatusText>
            )}
          </section>
        )}
        {lookalikes.length > 0 && (
          <StatusText showIcon status="warning">
            {`Podobný klient už existuje: ${lookalikes.map((other) => other.name).join(', ')}. Systém klienty sám neslučuje — zkontrolujte, zda nejde o duplicitu.`}
          </StatusText>
        )}
        {failure !== undefined && (
          <StatusText showIcon status="error">
            {failure}
          </StatusText>
        )}
      </FormRoot>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </SidePanel>
  );
};
