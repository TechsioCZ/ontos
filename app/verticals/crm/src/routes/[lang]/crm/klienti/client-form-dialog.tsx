import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { Effect } from 'effect';
import { assignableSalespeople } from '../../../../crm/records.ts';
import type { CrmCommandSubmit } from '../../../../crm/records.ts';
// Create / edit a client (company or person). On create, contact persons can be entered right away (C01-01) and
// someone with demo.crm.assign may pick the salesperson; a salesperson always creates the client for themself.
import { SidePanel, dialogCloseLabel, foldSearchText, surfaceTileClassName } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { ActionIcon } from '@techsio/ui-kit/atoms/action-icon';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { RadioGroup } from '@techsio/ui-kit/molecules/radio-group';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { useState } from 'react';
import type { ComponentProps } from 'react';
import type { CrmCommandInput } from '../../../../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { Client } from '../../../../../shared/domain/clients.ts';

import { clientSegments, segmentLabels } from './clients-model.ts';

type Kind = Client['kind'];

type InputHelp = Pick<ComponentProps<typeof FormInput>, 'helpText'>;

interface Draft {
  readonly address: string;
  readonly email: string;
  readonly kind: Kind;
  readonly name: string;
  readonly note: string;
  readonly owner: string;
  readonly phone: string;
  readonly regNo: string;
  readonly segment: string;
  readonly vatNo: string;
  readonly website: string;
}

interface ContactDraft {
  readonly email: string;
  readonly key: number;
  readonly name: string;
  readonly phone: string;
  readonly role: string;
}

const NONE = 'none';
const emptyContact = (key: number): ContactDraft => ({ email: '', key, name: '', phone: '', role: '' });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

const draftOf = (client: Client | undefined, defaultOwner: string): Draft => {
  if (client === undefined) {
    return {
      address: '',
      email: '',
      kind: 'organization',
      name: '',
      note: '',
      owner: defaultOwner,
      phone: '',
      regNo: '',
      segment: NONE,
      vatNo: '',
      website: '',
    };
  }
  return {
    address: client.address ?? '',
    email: client.email ?? '',
    kind: client.kind,
    name: client.name,
    note: client.note ?? '',
    owner: client.ownerSalespersonId ?? defaultOwner,
    phone: client.phone ?? '',
    regNo: client.regNo ?? '',
    segment: client.segment ?? NONE,
    vatNo: client.vatNo ?? '',
    website: client.website ?? '',
  };
};

/** Only the fields that differ; `''` clears a field on the server. */
const patchOf = (draft: Draft, client: Client) => {
  type Patch = Extract<CrmCommandInput, { readonly _tag: 'UpdateClient' }>['patch'];
  const patch: Patch = {};
  const compare = (key: Exclude<keyof Patch, 'kind'>, value: string) => {
    if (value.trim() !== (client[key] ?? '')) {
      Object.assign(patch, { [key]: value.trim() });
    }
  };
  compare('name', draft.name);
  compare('address', draft.address);
  compare('email', draft.email);
  compare('phone', draft.phone);
  compare('website', draft.website);
  compare('note', draft.note);
  compare('regNo', draft.kind === 'organization' ? draft.regNo : '');
  compare('vatNo', draft.kind === 'organization' ? draft.vatNo : '');
  compare('segment', draft.segment === NONE ? '' : draft.segment);
  if (draft.kind !== client.kind) {
    Object.assign(patch, { kind: draft.kind });
  }
  return patch;
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

const ContactDraftFields = ({
  entry,
  index,
  onRemove,
  patchContact,
  removable,
  touched,
}: {
  readonly entry: ContactDraft;
  readonly index: number;
  readonly onRemove: (key: number) => void;
  readonly patchContact: (key: number, next: Partial<ContactDraft>) => void;
  readonly removable: boolean;
  readonly touched: boolean;
}) => {
  const contactHelp: InputHelp = {};
  if (touched && incompleteContact(entry)) {
    contactHelp.helpText = 'Doplňte jméno kontaktní osoby.';
  }
  return (
    <div className={`${surfaceTileClassName} relative grid grid-cols-1 gap-150 p-200 sm:grid-cols-2`}>
      <FormInput
        autoComplete="off"
        id={`crm-new-contact-${entry.key}-name`}
        label={index === 0 ? 'Jméno (hlavní kontakt)' : 'Jméno'}
        onChange={(event) => patchContact(entry.key, { name: event.target.value })}
        validateStatus={touched && incompleteContact(entry) ? 'error' : 'default'}
        {...contactHelp}
        value={entry.name}
      />
      <FormInput
        autoComplete="off"
        id={`crm-new-contact-${entry.key}-role`}
        label="Pracovní role"
        onChange={(event) => patchContact(entry.key, { role: event.target.value })}
        placeholder="např. Nákupčí"
        value={entry.role}
      />
      <FormInput
        autoComplete="off"
        id={`crm-new-contact-${entry.key}-phone`}
        label="Telefon"
        onChange={(event) => patchContact(entry.key, { phone: event.target.value })}
        type="tel"
        value={entry.phone}
      />
      <FormInput
        autoComplete="off"
        id={`crm-new-contact-${entry.key}-email`}
        label="E-mail"
        onChange={(event) => patchContact(entry.key, { email: event.target.value })}
        type="email"
        value={entry.email}
      />
      {removable && (
        <ActionIcon
          aria-label="Odebrat osobu z formuláře"
          className="absolute end-100 top-100"
          icon="icon-[mdi--close]"
          onClick={() => onRemove(entry.key)}
          size="sm"
          tone="neutral"
          type="button"
        />
      )}
    </div>
  );
};

const useClientForm = ({
  busy,
  client,
  mode,
  onClose,
  onSaved,
  records,
  submit,
}: {
  readonly busy: boolean;
  readonly client?: Client;
  readonly mode: 'create' | 'edit';
  readonly onClose: () => void;
  readonly onSaved: (clientId: string) => void;
  readonly records: RecordsResponse;
  readonly submit: CrmCommandSubmit;
}) => {
  const toaster = useToast();
  const { viewer } = records;
  const defaultOwner = viewer.salespersonId ?? NONE;
  const [draft, setDraft] = useState<Draft>(() => draftOf(client, defaultOwner));
  const [contacts, setContacts] = useState<readonly ContactDraft[]>(() => (mode === 'create' ? [emptyContact(0)] : []));
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const patch = (next: Partial<Draft>) => setDraft((current) => ({ ...current, ...next }));
  const patchContact = (key: number, next: Partial<ContactDraft>) =>
    setContacts((current) => current.map((entry) => (entry.key === key ? { ...entry, ...next } : entry)));

  const handleRemoveContact = (key: number) => setContacts((current) => current.filter((item) => item.key !== key));

  const organization = draft.kind === 'organization';
  const nameError = touched && draft.name.trim() === '' ? 'Vyplňte název' : undefined;
  const emailError = draft.email.trim() !== '' && !EMAIL.test(draft.email.trim()) ? 'Neplatný e-mail' : undefined;
  const regNoError =
    organization && draft.regNo.trim() !== '' && !/^\d{8}$/u.test(draft.regNo.trim()) ? 'IČO má 8 číslic' : undefined;
  // C01-02: never merged automatically — only a visible hint about clients that look the same.
  const lookalikes =
    mode === 'create'
      ? records.state.clients.items.filter(
          (other) =>
            (draft.regNo.trim() !== '' && other.regNo === draft.regNo.trim()) ||
            (draft.name.trim().length > 3 && foldSearchText(other.name) === foldSearchText(draft.name.trim())),
        )
      : [];

  const contactNameError = mode === 'create' && organization && contacts.some(incompleteContact);
  const filledContacts = organization ? contacts.filter((entry) => entry.name.trim() !== '') : [];
  const contactEmailError = filledContacts.some(
    (entry) => entry.email.trim() !== '' && !EMAIL.test(entry.email.trim()),
  );

  const finish = (command: CrmCommandInput) => {
    browserRuntime.runFork(
      submit(command).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            if (!outcome.ok) {
              const message = outcome.message ?? 'Uložení se nezdařilo. Zkuste to prosím znovu.';
              setFailure(message);
              toaster.create({ description: message, title: 'Klienta se nepodařilo uložit', type: 'error' });
              return;
            }
            const toast: Parameters<typeof toaster.create>[0] = {
              title: mode === 'create' ? `Klient ${draft.name.trim()} založen` : 'Změny klienta uloženy',
              type: 'success',
            };
            if (mode === 'create') {
              Object.assign(toast, {
                description: 'Identitu firmy v evidenci zákazníků zapsal systém; najdete ji na kartě klienta.',
              });
            }
            toaster.create(toast);
            onSaved(mode === 'create' ? (outcome.entityIds[0] ?? '') : (client?.id ?? ''));
          }),
        ),
      ),
    );
  };

  const save = () => {
    setTouched(true);
    setFailure(undefined);
    if (
      draft.name.trim() === '' ||
      emailError !== undefined ||
      regNoError !== undefined ||
      contactEmailError ||
      contactNameError
    ) {
      return;
    }
    const segment = draft.segment === NONE ? '' : draft.segment;
    let command: CrmCommandInput;
    if (mode === 'create' || client === undefined) {
      command = {
        _tag: 'CreateClient',
        kind: draft.kind,
        name: draft.name.trim(),
        ...optionalField('address', draft.address),
        ...optionalField('email', draft.email),
        ...optionalField('note', draft.note),
        ...optionalField('phone', draft.phone),
        ...optionalField('website', draft.website),
        ...optionalField('segment', segment),
      };
      if (organization) {
        Object.assign(command, optionalField('regNo', draft.regNo), optionalField('vatNo', draft.vatNo));
      }
      if (viewer.assign && draft.owner !== NONE) {
        Object.assign(command, { ownerSalespersonId: draft.owner });
      }
      if (filledContacts.length > 0) {
        const proposedContacts = filledContacts.map((entry, index) => {
          const contact: NonNullable<Extract<CrmCommandInput, { readonly _tag: 'CreateClient' }>['contacts']>[number] =
            {
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
    } else {
      const changes = patchOf(draft, client);
      if (Object.keys(changes).length === 0) {
        onClose();
        return;
      }
      command = { _tag: 'UpdateClient', id: client.id, patch: changes };
    }
    // CRM.md §3: the server creates (or reuses by IČO / name) the Party Registry identity of a new client through
    // its governed intake, for a salesperson too; the browser never writes the registry nor sends a registry claim.
    finish(command);
  };

  const nameHelp: InputHelp = {};
  if (nameError !== undefined) {
    nameHelp.helpText = nameError;
  }
  const emailHelp: InputHelp = {};
  if (emailError !== undefined) {
    emailHelp.helpText = emailError;
  }
  const regNoHelp: InputHelp = {};
  if (regNoError !== undefined) {
    regNoHelp.helpText = regNoError;
  }

  const owners = [
    ...assignableSalespeople(records).map((person) => ({ label: person.name, value: person.id })),
    { label: 'Zatím bez obchodníka', value: NONE },
  ];

  return {
    busy,
    contactEmailError,
    contacts,
    draft,
    emailError,
    emailHelp,
    failure,
    handleRemoveContact,
    lookalikes,
    mode,
    nameError,
    nameHelp,
    onClose,
    organization,
    owners,
    patch,
    patchContact,
    regNoError,
    regNoHelp,
    save,
    setContacts,
    touched,
    viewer,
  };
};

export const ClientFormDialog = (props: Parameters<typeof useClientForm>[0]) => {
  const {
    busy,
    contactEmailError,
    contacts,
    draft,
    emailError,
    emailHelp,
    failure,
    handleRemoveContact,
    lookalikes,
    mode,
    nameError,
    nameHelp,
    onClose,
    organization,
    owners,
    patch,
    patchContact,
    regNoError,
    regNoHelp,
    save,
    setContacts,
    touched,
    viewer,
  } = useClientForm(props);

  return (
    <SidePanel
      actions={
        <>
          <Button disabled={busy} onClick={onClose} theme="outlined" variant="secondary">
            Zrušit
          </Button>
          <Button
            isLoading={busy}
            loadingText={mode === 'create' ? 'Zakládám klienta…' : 'Ukládám…'}
            onClick={save}
            variant="primary"
          >
            {mode === 'create' ? 'Založit klienta' : 'Uložit změny'}
          </Button>
        </>
      }
      closeLabel={dialogCloseLabel}
      closeOnInteractOutside={false}
      description={
        mode === 'create'
          ? 'Neuvedené údaje zůstanou prázdné. Kontaktní osoby můžete doplnit i později na kartě klienta.'
          : 'Změna se zapíše do historie klienta.'
      }
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      resizeLabel="Změnit šířku panelu"
      size="lg"
      title={mode === 'create' ? 'Nový klient' : `Upravit klienta`}
    >
      <form
        className="flex flex-col gap-250 py-100"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <RadioGroup
          onValueChange={(next) => {
            const kind = (['organization', 'person'] as const).find((candidate) => candidate === next);
            if (kind !== undefined) {
              patch({ kind });
            }
          }}
          size="sm"
          value={draft.kind}
        >
          <RadioGroup.Label>Typ klienta</RadioGroup.Label>
          <RadioGroup.ItemGroup className="inline-flex w-fit gap-150 rounded-lg border border-border-primary p-100">
            {(['organization', 'person'] as const).map((kind) => (
              <RadioGroup.Item key={kind} value={kind}>
                <RadioGroup.ItemHiddenInput />
                <RadioGroup.ItemControl />
                <RadioGroup.ItemText>
                  <span
                    aria-hidden
                    className={`${kind === 'organization' ? 'icon-[mdi--office-building-outline]' : 'icon-[mdi--account-outline]'} me-50 inline-block size-200 align-middle`}
                  />
                  {kind === 'organization' ? 'Firma' : 'Fyzická osoba'}
                </RadioGroup.ItemText>
              </RadioGroup.Item>
            ))}
          </RadioGroup.ItemGroup>
        </RadioGroup>
        <div className="grid grid-cols-1 gap-150 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <FormInput
              autoComplete="off"
              id="crm-client-name"
              label={organization ? 'Název firmy' : 'Jméno a příjmení'}
              name="name"
              onChange={(event) => patch({ name: event.target.value })}
              required
              validateStatus={nameError === undefined ? 'default' : 'error'}
              {...nameHelp}
              value={draft.name}
            />
          </div>
          {organization && (
            <>
              <FormInput
                autoComplete="off"
                id="crm-client-regno"
                inputMode="numeric"
                label="IČO"
                name="regNo"
                onChange={(event) => patch({ regNo: event.target.value })}
                validateStatus={regNoError === undefined ? 'default' : 'error'}
                {...regNoHelp}
                value={draft.regNo}
              />
              <FormInput
                autoComplete="off"
                id="crm-client-vatno"
                label="DIČ"
                name="vatNo"
                onChange={(event) => patch({ vatNo: event.target.value })}
                value={draft.vatNo}
              />
            </>
          )}
          <SelectTemplate
            items={[
              { label: 'Neuvedeno', value: NONE },
              ...clientSegments.map((key) => ({ label: segmentLabels[key], value: key })),
            ]}
            label="Segment"
            name="segment"
            onValueChange={(details) => patch({ segment: details.value[0] ?? NONE })}
            value={[draft.segment]}
          />
          {mode === 'create' && viewer.assign ? (
            <SelectTemplate
              items={owners}
              label="Obchodník"
              name="owner"
              onValueChange={(details) => patch({ owner: details.value[0] ?? NONE })}
              value={[draft.owner]}
            />
          ) : (
            <div />
          )}
          <FormInput
            autoComplete="off"
            id="crm-client-phone"
            label={organization ? 'Pracovní telefon' : 'Telefon'}
            name="phone"
            onChange={(event) => patch({ phone: event.target.value })}
            type="tel"
            value={draft.phone}
          />
          <FormInput
            autoComplete="off"
            id="crm-client-email"
            label="E-mail"
            name="email"
            onChange={(event) => patch({ email: event.target.value })}
            type="email"
            validateStatus={emailError === undefined ? 'default' : 'error'}
            {...emailHelp}
            value={draft.email}
          />
          <div className="sm:col-span-2">
            <FormInput
              autoComplete="off"
              id="crm-client-address"
              label="Adresa"
              name="address"
              onChange={(event) => patch({ address: event.target.value })}
              placeholder="Ulice a číslo, PSČ Město"
              value={draft.address}
            />
          </div>
          <div className="sm:col-span-2">
            <FormInput
              autoComplete="off"
              id="crm-client-website"
              label="Web"
              name="website"
              onChange={(event) => patch({ website: event.target.value })}
              value={draft.website}
            />
          </div>
          <div className="sm:col-span-2">
            <FormTextarea
              id="crm-client-note"
              label="Poznámka"
              maxLength={4000}
              name="note"
              onChange={(event) => patch({ note: event.target.value })}
              rows={3}
              value={draft.note}
            />
          </div>
        </div>
        {mode === 'create' && organization && (
          <section className="flex flex-col gap-150">
            <div className="flex items-center justify-between gap-100">
              <h3 className="font-semibold text-sm">Kontaktní osoby</h3>
              <Button
                icon="icon-[mdi--account-plus-outline]"
                onClick={() => setContacts((current) => [...current, emptyContact((current.at(-1)?.key ?? 0) + 1)])}
                size="sm"
                theme="borderless"
                type="button"
                variant="secondary"
              >
                Další osoba
              </Button>
            </div>
            {contacts.map((entry, index) => (
              <ContactDraftFields
                entry={entry}
                index={index}
                key={entry.key}
                onRemove={handleRemoveContact}
                patchContact={patchContact}
                removable={contacts.length > 1}
                touched={touched}
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
        <button aria-label={mode === 'create' ? 'Založit klienta' : 'Uložit změny'} className="hidden" type="submit" />
      </form>
    </SidePanel>
  );
};
