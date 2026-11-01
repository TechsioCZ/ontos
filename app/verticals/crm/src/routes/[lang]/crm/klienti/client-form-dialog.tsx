import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { Effect } from 'effect';
import { assignableSalespeople } from '../../../../crm/records.ts';
import type { CrmCommandSubmit } from '../../../../crm/records.ts';
// Create / edit a client (company or person). On create, contact persons can be entered right away (C01-01) and
// someone with demo.crm.assign may pick the salesperson; a salesperson always creates the client for themself.
import {
  AutosaveStatus,
  SidePanel,
  dialogCloseLabel,
  foldSearchText,
  surfaceTileClassName,
  useAutosaveDraft,
} from '@app/admin-ui';
import type { AutosaveOutcome } from '@app/admin-ui';
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
import { EMAIL, NONE, draftOf, patchOf, sameClientDraft, validClientDraft } from './client-draft.ts';
import type { Draft } from './client-draft.ts';

type InputHelp = Pick<ComponentProps<typeof FormInput>, 'helpText'>;

interface ContactDraft {
  readonly email: string;
  readonly key: number;
  readonly name: string;
  readonly phone: string;
  readonly role: string;
}

const emptyContact = (key: number): ContactDraft => ({ email: '', key, name: '', phone: '', role: '' });

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
  const { t } = useModernI18n();
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
        label={t('crm.ciClientsVisits.fields.jobRole')}
        onChange={(event) => patchContact(entry.key, { role: event.target.value })}
        placeholder={t('crm.ciClientsVisits.contacts.roleExample')}
        value={entry.role}
      />
      <FormInput
        autoComplete="off"
        id={`crm-new-contact-${entry.key}-phone`}
        label={t('crm.ciClientsVisits.fields.phone')}
        onChange={(event) => patchContact(entry.key, { phone: event.target.value })}
        type="tel"
        value={entry.phone}
      />
      <FormInput
        autoComplete="off"
        id={`crm-new-contact-${entry.key}-email`}
        label={t('crm.ciClientsVisits.fields.email')}
        onChange={(event) => patchContact(entry.key, { email: event.target.value })}
        type="email"
        value={entry.email}
      />
      {removable && (
        <ActionIcon
          aria-label={t('crm.ciClientsVisits.contacts.removeFromForm')}
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
  const editing = mode === 'edit' && client !== undefined;
  const [failure, setFailure] = useState<string | undefined>();
  // Edit mode autosaves the changed fields (UpdateClient is a patch; the CRM submit retries it on the latest
  // revision). Create mode keeps its explicit "Založit klienta" and never autosaves.
  const autosave = useAutosaveDraft<Draft, never>({
    equals: sameClientDraft,
    isValid: (value) => editing && validClientDraft(value),
    runtime: browserRuntime,
    save: (value): Effect.Effect<AutosaveOutcome> => {
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
    },
    server: draftOf(client, defaultOwner),
  });
  const { draft, setDraft } = autosave;
  const [contacts, setContacts] = useState<readonly ContactDraft[]>(() => (mode === 'create' ? [emptyContact(0)] : []));
  const [touched, setTouched] = useState(editing);
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
            toaster.create({
              description: 'Identitu firmy v evidenci zákazníků zapsal systém; najdete ji na kartě klienta.',
              title: `Klient ${draft.name.trim()} založen`,
              type: 'success',
            });
            onSaved(outcome.entityIds[0] ?? '');
          }),
        ),
      ),
    );
  };

  const save = () => {
    if (editing) {
      autosave.flush();
      return;
    }
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
    const command: CrmCommandInput = {
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

  const close = () => {
    autosave.flush();
    onClose();
  };

  return {
    autosave,
    busy,
    close,
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
  const { t } = useModernI18n();
  const {
    autosave,
    busy,
    close,
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
  const handleRetry = autosave.retry;
  const handleReloadLatest = autosave.reloadLatest;

  return (
    <SidePanel
      actions={
        mode === 'create' ? (
          <>
            <Button disabled={busy} onClick={onClose} theme="outlined" variant="secondary">
              Zrušit
            </Button>
            <Button isLoading={busy} loadingText="Zakládám klienta…" onClick={save} variant="primary">
              Založit klienta
            </Button>
          </>
        ) : (
          <>
            <AutosaveStatus onReloadLatest={handleReloadLatest} onRetry={handleRetry} status={autosave.status} />
            <Button onClick={close} theme="outlined" variant="secondary">
              Zavřít
            </Button>
          </>
        )
      }
      closeLabel={dialogCloseLabel}
      description={
        mode === 'create'
          ? 'Neuvedené údaje zůstanou prázdné. Kontaktní osoby můžete doplnit i později na kartě klienta.'
          : 'Změny se ukládají samy a zapisují se do historie klienta.'
      }
      onOpenChange={(open) => {
        if (!open) {
          close();
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
                label={t('crm.ciClientsVisits.fields.registrationNumber')}
                name="regNo"
                onChange={(event) => patch({ regNo: event.target.value })}
                validateStatus={regNoError === undefined ? 'default' : 'error'}
                {...regNoHelp}
                value={draft.regNo}
              />
              <FormInput
                autoComplete="off"
                id="crm-client-vatno"
                label={t('crm.ciClientsVisits.fields.taxId')}
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
            label={t('crm.ciClientsVisits.fields.segment')}
            name="segment"
            onValueChange={(details) => patch({ segment: details.value[0] ?? NONE })}
            value={[draft.segment]}
          />
          {mode === 'create' && viewer.assign ? (
            <SelectTemplate
              items={owners}
              label={t('crm.ciClientsVisits.fields.salesperson')}
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
            label={t('crm.ciClientsVisits.fields.email')}
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
              label={t('crm.ciClientsVisits.fields.address')}
              name="address"
              onChange={(event) => patch({ address: event.target.value })}
              placeholder={t('crm.ciClientsVisits.fields.addressPlaceholder')}
              value={draft.address}
            />
          </div>
          <div className="sm:col-span-2">
            <FormInput
              autoComplete="off"
              id="crm-client-website"
              label={t('crm.ciClientsVisits.fields.website')}
              name="website"
              onChange={(event) => patch({ website: event.target.value })}
              value={draft.website}
            />
          </div>
          <div className="sm:col-span-2">
            <FormTextarea
              id="crm-client-note"
              label={t('crm.ciClientsVisits.fields.note')}
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
        <button aria-label={mode === 'create' ? 'Založit klienta' : 'Uložit'} className="hidden" type="submit" />
      </form>
    </SidePanel>
  );
};
