// Create / edit a client (company or person). On create, contact persons can be entered right away (C01-01) and
// someone with demo.crm.assign may pick the salesperson; a salesperson always creates the client for themself.
import { SidePanel, dialogCloseLabel } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { ActionIcon } from '@techsio/ui-kit/atoms/action-icon';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { useState } from 'react';
import type { CrmCommand } from '../../../../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { Client } from '../../../../../shared/domain/clients.ts';
import type { CrmCommandOutcome } from '../../../../crm/records.ts';
import { clientSegments, segmentLabels } from './clients-model.ts';

type Kind = Client['kind'];

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

const draftOf = (client: Client | undefined, defaultOwner: string): Draft => ({
  address: client?.address ?? '',
  email: client?.email ?? '',
  kind: client?.kind ?? 'organization',
  name: client?.name ?? '',
  note: client?.note ?? '',
  owner: client?.ownerSalespersonId ?? defaultOwner,
  phone: client?.phone ?? '',
  regNo: client?.regNo ?? '',
  segment: client?.segment ?? NONE,
  vatNo: client?.vatNo ?? '',
  website: client?.website ?? '',
});

/** Only the fields that differ; `''` clears a field on the server. */
const patchOf = (draft: Draft, client: Client) => {
  const patch: Record<string, string> = {};
  const compare = (key: keyof Draft & keyof Client, value: string) => {
    if (value.trim() !== (client[key] ?? '')) {
      patch[key] = value.trim();
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
  return { ...patch, ...(draft.kind === client.kind ? {} : { kind: draft.kind }) };
};

const optionalField = <K extends string>(key: K, value: string) =>
  (value.trim() === '' ? {} : { [key]: value.trim() }) as Partial<Record<K, string>>;

export const ClientFormDialog = ({
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
  readonly submit: (command: CrmCommand) => Promise<CrmCommandOutcome>;
}) => {
  const toaster = useToast();
  const viewer = records.viewer;
  const defaultOwner = viewer.salespersonId ?? NONE;
  const [draft, setDraft] = useState<Draft>(() => draftOf(client, defaultOwner));
  const [contacts, setContacts] = useState<readonly ContactDraft[]>(() => (mode === 'create' ? [emptyContact(0)] : []));
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const patch = (next: Partial<Draft>) => setDraft((current) => ({ ...current, ...next }));
  const patchContact = (key: number, next: Partial<ContactDraft>) =>
    setContacts((current) => current.map((entry) => (entry.key === key ? { ...entry, ...next } : entry)));

  const organization = draft.kind === 'organization';
  const nameError = touched && draft.name.trim() === '' ? 'Vyplňte název' : undefined;
  const emailError = draft.email.trim() !== '' && !EMAIL.test(draft.email.trim()) ? 'Neplatný e-mail' : undefined;
  const regNoError =
    organization && draft.regNo.trim() !== '' && !/^\d{8}$/u.test(draft.regNo.trim()) ? 'IČO má 8 číslic' : undefined;
  const filledContacts = contacts.filter((entry) => entry.name.trim() !== '');
  const contactEmailError = filledContacts.some(
    (entry) => entry.email.trim() !== '' && !EMAIL.test(entry.email.trim()),
  );

  const save = () => {
    setTouched(true);
    setFailure(undefined);
    if (draft.name.trim() === '' || emailError !== undefined || regNoError !== undefined || contactEmailError) {
      return;
    }
    const segment = draft.segment === NONE ? '' : draft.segment;
    let command: CrmCommand;
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
        ...(organization ? { ...optionalField('regNo', draft.regNo), ...optionalField('vatNo', draft.vatNo) } : {}),
        ...(viewer.assign && draft.owner !== NONE ? { ownerSalespersonId: draft.owner } : {}),
        ...(filledContacts.length === 0
          ? {}
          : {
              contacts: filledContacts.map((entry, index) => ({
                name: entry.name.trim(),
                ...optionalField('role', entry.role),
                ...optionalField('phone', entry.phone),
                ...optionalField('email', entry.email),
                ...(index === 0 ? { primary: true } : {}),
              })),
            }),
      };
    } else {
      const changes = patchOf(draft, client);
      if (Object.keys(changes).length === 0) {
        onClose();
        return;
      }
      command = { _tag: 'UpdateClient', id: client.id, patch: changes };
    }
    void submit(command).then((outcome) => {
      if (!outcome.ok) {
        setFailure(outcome.message ?? 'Uložení se nezdařilo. Zkuste to prosím znovu.');
        return;
      }
      toaster.create({
        title: mode === 'create' ? `Klient ${draft.name.trim()} založen` : 'Změny klienta uloženy',
        type: 'success',
      });
      onSaved(mode === 'create' ? (outcome.entityIds[0] ?? '') : (client?.id ?? ''));
    });
  };

  const owners = [
    ...records.state.salespeople
      .filter((person) => person.active)
      .map((person) => ({ label: person.name, value: person.id })),
    { label: 'Zatím bez obchodníka', value: NONE },
  ];

  return (
    <SidePanel
      actions={
        <>
          <Button disabled={busy} onClick={onClose} theme="outlined" variant="secondary">
            Zrušit
          </Button>
          <Button isLoading={busy} loadingText="Ukládám…" onClick={save} variant="primary">
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
        <div className="flex flex-col gap-100">
          <span className="font-medium text-sm">Typ klienta</span>
          <div className="inline-flex w-fit gap-50 rounded-lg border border-border-primary p-50" role="radiogroup">
            {(['organization', 'person'] as const).map((kind) => (
              <Button
                aria-checked={draft.kind === kind}
                icon={kind === 'organization' ? 'icon-[mdi--office-building-outline]' : 'icon-[mdi--account-outline]'}
                key={kind}
                onClick={() => patch({ kind })}
                role="radio"
                size="sm"
                theme={draft.kind === kind ? 'solid' : 'borderless'}
                type="button"
                variant={draft.kind === kind ? 'primary' : 'secondary'}
              >
                {kind === 'organization' ? 'Firma' : 'Fyzická osoba'}
              </Button>
            ))}
          </div>
        </div>
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
              {...(nameError === undefined ? {} : { helpText: nameError })}
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
                {...(regNoError === undefined ? {} : { helpText: regNoError })}
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
            {...(emailError === undefined ? {} : { helpText: emailError })}
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
                onClick={() =>
                  setContacts((current) => [...current, emptyContact((current.at(-1)?.key ?? 0) + 1)])
                }
                size="sm"
                theme="borderless"
                type="button"
                variant="secondary"
              >
                Další osoba
              </Button>
            </div>
            {contacts.map((entry, index) => (
              <div
                className="relative grid grid-cols-1 gap-150 rounded-lg border border-border-primary p-200 sm:grid-cols-2"
                key={entry.key}
              >
                <FormInput
                  autoComplete="off"
                  id={`crm-new-contact-${entry.key}-name`}
                  label={index === 0 ? 'Jméno (hlavní kontakt)' : 'Jméno'}
                  onChange={(event) => patchContact(entry.key, { name: event.target.value })}
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
                {contacts.length > 1 && (
                  <ActionIcon
                    aria-label="Odebrat osobu z formuláře"
                    className="absolute end-100 top-100"
                    icon="icon-[mdi--close]"
                    onClick={() => setContacts((current) => current.filter((item) => item.key !== entry.key))}
                    size="sm"
                    tone="neutral"
                    type="button"
                  />
                )}
              </div>
            ))}
            {contactEmailError && (
              <StatusText showIcon status="error">
                Některý e-mail kontaktní osoby není platný.
              </StatusText>
            )}
          </section>
        )}
        {failure !== undefined && (
          <StatusText showIcon status="error">
            {failure}
          </StatusText>
        )}
        <button className="hidden" type="submit" />
      </form>
    </SidePanel>
  );
};
