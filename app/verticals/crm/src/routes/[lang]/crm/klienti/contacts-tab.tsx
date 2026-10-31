import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { pipe, Effect } from 'effect';
import { orderDateText } from '../../../../../shared/domain/imports.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';

// "Kontakty" tab of the client card: contact persons with work role, phone, e-mail and note (C01). Add / edit
// inline; "Odebrat" archives the person (kept in history, never deleted). One person can be the main contact.
import { EmptyState, dialogCloseLabel, formatDate, surfaceTileClassName } from '@app/admin-ui';
import { ActionIcon } from '@techsio/ui-kit/atoms/action-icon';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { useState } from 'react';
import type { ComponentProps } from 'react';
import type { ContactPerson } from '../../../../../shared/domain/clients.ts';
import type { ClientCardTabProps } from './card-tab-props.ts';
import { activeContactsOf } from './clients-model.ts';

type InputHelp = Pick<ComponentProps<typeof FormInput>, 'helpText'>;

interface ContactDraft {
  readonly email: string;
  readonly name: string;
  readonly note: string;
  readonly phone: string;
  readonly primary: boolean;
  readonly role: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

const draftOf = (contact: ContactPerson | undefined, primary: boolean): ContactDraft => ({
  email: contact?.email ?? '',
  name: contact?.name ?? '',
  note: contact?.note ?? '',
  phone: contact?.phone ?? '',
  primary: contact?.primary ?? primary,
  role: contact?.role ?? '',
});

const ContactForm = ({
  busy,
  contact,
  isFirst,
  onCancel,
  onSave,
}: {
  readonly busy: boolean;
  readonly contact?: ContactPerson;
  readonly isFirst: boolean;
  readonly onCancel: () => void;
  readonly onSave: (draft: ContactDraft) => void;
}) => {
  const { t } = useModernI18n();
  const [draft, setDraft] = useState<ContactDraft>(() => draftOf(contact, isFirst));
  const [touched, setTouched] = useState(false);
  const patch = (next: Partial<ContactDraft>) => setDraft((current) => ({ ...current, ...next }));
  const prefix = contact?.id ?? 'new';
  const nameError = touched && draft.name.trim() === '' ? 'Vyplňte jméno' : undefined;
  const emailError = draft.email.trim() !== '' && !EMAIL.test(draft.email.trim()) ? 'Neplatný e-mail' : undefined;
  const nameHelp: InputHelp = {};
  if (nameError !== undefined) {
    nameHelp.helpText = nameError;
  }
  const emailHelp: InputHelp = {};
  if (emailError !== undefined) {
    emailHelp.helpText = emailError;
  }
  return (
    <form
      className={`${surfaceTileClassName} flex flex-col gap-150 p-200`}
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (draft.name.trim() !== '' && emailError === undefined) {
          onSave(draft);
        }
      }}
    >
      <h4 className="font-semibold text-sm">
        {contact === undefined ? 'Nová kontaktní osoba' : `Upravit: ${contact.name}`}
      </h4>
      <div className="grid grid-cols-1 gap-150 sm:grid-cols-2">
        <FormInput
          autoComplete="off"
          id={`crm-contact-${prefix}-name`}
          label={t('crm.ciClientsVisits.fields.fullName')}
          onChange={(event) => patch({ name: event.target.value })}
          required
          validateStatus={nameError === undefined ? 'default' : 'error'}
          {...nameHelp}
          value={draft.name}
        />
        <FormInput
          autoComplete="off"
          id={`crm-contact-${prefix}-role`}
          label={t('crm.ciClientsVisits.fields.jobRole')}
          onChange={(event) => patch({ role: event.target.value })}
          placeholder={t('crm.ciClientsVisits.contacts.rolesExample')}
          value={draft.role}
        />
        <FormInput
          autoComplete="off"
          id={`crm-contact-${prefix}-phone`}
          label={t('crm.ciClientsVisits.fields.phone')}
          onChange={(event) => patch({ phone: event.target.value })}
          type="tel"
          value={draft.phone}
        />
        <FormInput
          autoComplete="off"
          id={`crm-contact-${prefix}-email`}
          label={t('crm.ciClientsVisits.fields.email')}
          onChange={(event) => patch({ email: event.target.value })}
          type="email"
          validateStatus={emailError === undefined ? 'default' : 'error'}
          {...emailHelp}
          value={draft.email}
        />
        <div className="sm:col-span-2">
          <FormTextarea
            id={`crm-contact-${prefix}-note`}
            label={t('crm.ciClientsVisits.fields.note')}
            maxLength={4000}
            onChange={(event) => patch({ note: event.target.value })}
            rows={2}
            value={draft.note}
          />
        </div>
      </div>
      <FormCheckbox
        checked={draft.primary}
        id={`crm-contact-${prefix}-primary`}
        label={t('crm.ciClientsVisits.contacts.primary')}
        onCheckedChange={(checked) => patch({ primary: checked })}
        size="sm"
      />
      <div className="flex justify-end gap-100">
        <Button disabled={busy} onClick={onCancel} size="sm" theme="outlined" type="button" variant="secondary">
          Zrušit
        </Button>
        <Button isLoading={busy} loadingText="Ukládám…" size="sm" type="submit" variant="primary">
          {contact === undefined ? 'Přidat osobu' : 'Uložit'}
        </Button>
      </div>
    </form>
  );
};

const ContactCard = ({
  contact,
  onEdit,
  onRemove,
  writable,
}: {
  readonly contact: ContactPerson;
  readonly onEdit?: () => void;
  readonly onRemove?: () => void;
  readonly writable: boolean;
}) => {
  const archived = contact.status === 'archived';
  return (
    <li className={`${surfaceTileClassName} flex flex-col gap-100 p-200 ${archived ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between gap-100">
        <div className="flex min-w-0 items-center gap-150">
          <span
            aria-hidden
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-secondary text-fg-secondary"
          >
            <span className="icon-[mdi--account-outline] size-5" />
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="flex flex-wrap items-center gap-100">
              <span className="break-words font-medium">{contact.name}</span>
              {contact.primary === true && (
                <Badge size="sm" variant="primary">
                  Hlavní kontakt
                </Badge>
              )}
              {archived && (
                <Badge size="sm" variant="outline">
                  {`Odebrán ${pipe(contact.archivedAt, orderDateText, formatDate)}`}
                </Badge>
              )}
            </span>
            <span className="text-fg-secondary text-sm">{contact.role ?? 'pracovní role neuvedena'}</span>
          </div>
        </div>
        {writable && !archived && (
          <div className="flex shrink-0 gap-50">
            <ActionIcon
              aria-label={`Upravit ${contact.name}`}
              icon="icon-[mdi--pencil-outline]"
              onClick={onEdit}
              size="sm"
              tone="neutral"
            />
            <ActionIcon
              aria-label={`Odebrat ${contact.name}`}
              icon="icon-[mdi--account-remove-outline]"
              onClick={onRemove}
              size="sm"
              tone="neutral"
            />
          </div>
        )}
      </div>
      <div className="flex flex-col gap-50 text-sm">
        <span className="flex items-center gap-100">
          <span aria-hidden className="icon-[mdi--phone-outline] size-200 text-fg-secondary" />
          {contact.phone === undefined ? (
            <span className="text-fg-secondary">telefon neuveden</span>
          ) : (
            <Link href={`tel:${contact.phone.replaceAll(' ', '')}`}>{contact.phone}</Link>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-100">
          <span aria-hidden className="icon-[mdi--email-outline] size-200 text-fg-secondary" />
          {contact.email === undefined ? (
            <span className="text-fg-secondary">e-mail neuveden</span>
          ) : (
            <Link className="min-w-0 break-all" href={`mailto:${contact.email}`}>
              {contact.email}
            </Link>
          )}
        </span>
      </div>
      {contact.note !== undefined && (
        <p className="whitespace-pre-line rounded-md bg-surface-secondary px-150 py-100 text-fg-secondary text-sm">
          {contact.note}
        </p>
      )}
    </li>
  );
};

/** Only changed fields; `''` clears a field on the server. */
const contactPatch = (draft: ContactDraft, contact: ContactPerson) => {
  const patch: Record<string, string | boolean> = {};
  for (const key of ['name', 'role', 'phone', 'email', 'note'] as const) {
    if (draft[key].trim() !== (contact[key] ?? '')) {
      patch[key] = draft[key].trim();
    }
  }
  if (draft.primary !== (contact.primary === true)) {
    patch['primary'] = draft.primary;
  }
  return patch;
};

const optionalText = (draft: ContactDraft) => {
  type TextFields = Pick<ContactPerson, 'email' | 'note' | 'phone' | 'role'>;
  const fields: { -readonly [K in keyof TextFields]: TextFields[K] } = {};
  for (const key of ['role', 'phone', 'email', 'note'] as const) {
    const value = draft[key].trim();
    if (value !== '') {
      fields[key] = value;
    }
  }
  return fields;
};

export const ContactsTab = ({
  busy,
  client,
  records,
  submit,
  writable,
}: ClientCardTabProps & { readonly writable: boolean }) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const [editing, setEditing] = useState<string | undefined>();
  const [removing, setRemoving] = useState<ContactPerson | undefined>();
  const [showRemoved, setShowRemoved] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const active = activeContactsOf(records, client.id);
  const removed = records.state.clients.contacts.filter(
    (contact) => contact.clientId === client.id && contact.status === 'archived',
  );

  const run = (command: Parameters<typeof submit>[0], success: string, done: () => void) => {
    setFailure(undefined);
    browserRuntime.runFork(
      submit(command).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            if (outcome.ok) {
              toaster.create({ title: success, type: 'success' });
              done();
            } else {
              setFailure(outcome.message ?? 'Uložení se nezdařilo.');
            }
          }),
        ),
      ),
    );
  };

  return (
    <div className="flex flex-col gap-200">
      {writable && editing === undefined && (
        <div>
          <Button icon="icon-[mdi--account-plus-outline]" onClick={() => setEditing('new')} size="sm" variant="primary">
            Přidat kontaktní osobu
          </Button>
        </div>
      )}
      {failure !== undefined && (
        <StatusText showIcon status="error">
          {failure}
        </StatusText>
      )}
      {editing === 'new' && (
        <ContactForm
          busy={busy}
          isFirst={active.length === 0}
          onCancel={() => setEditing(undefined)}
          onSave={(draft) => {
            const command: Parameters<typeof submit>[0] = {
              _tag: 'AddContactPerson',
              clientId: client.id,
              name: draft.name.trim(),
              ...optionalText(draft),
            };
            if (draft.primary) {
              Object.assign(command, { primary: true });
            }
            run(command, `Kontaktní osoba ${draft.name.trim()} přidána`, () => setEditing(undefined));
          }}
        />
      )}
      {active.length === 0 && editing !== 'new' ? (
        <EmptyState
          description={
            writable
              ? 'Přidejte první kontaktní osobu klienta.'
              : 'U klienta zatím není evidovaná žádná kontaktní osoba.'
          }
          title={t('crm.ciClientsVisits.contacts.empty')}
        />
      ) : (
        <ul className="grid grid-cols-1 gap-150">
          {active.map((contact) =>
            editing === contact.id ? (
              <li key={contact.id}>
                <ContactForm
                  busy={busy}
                  contact={contact}
                  isFirst={false}
                  onCancel={() => setEditing(undefined)}
                  onSave={(draft) => {
                    const patch = contactPatch(draft, contact);
                    if (Object.keys(patch).length === 0) {
                      setEditing(undefined);
                      return;
                    }
                    run({ _tag: 'UpdateContactPerson', contactId: contact.id, patch }, 'Kontaktní osoba uložena', () =>
                      setEditing(undefined),
                    );
                  }}
                />
              </li>
            ) : (
              <ContactCard
                contact={contact}
                key={contact.id}
                onEdit={() => setEditing(contact.id)}
                onRemove={() => setRemoving(contact)}
                writable={writable}
              />
            ),
          )}
        </ul>
      )}
      {removed.length > 0 && (
        <div className="flex flex-col gap-150">
          <Button
            className="w-fit"
            icon={showRemoved ? 'icon-[mdi--chevron-up]' : 'icon-[mdi--chevron-down]'}
            onClick={() => setShowRemoved((value) => !value)}
            size="sm"
            theme="borderless"
            variant="secondary"
          >
            {showRemoved ? 'Skrýt odebrané osoby' : `Zobrazit odebrané osoby (${removed.length})`}
          </Button>
          {showRemoved && (
            <ul className="grid grid-cols-1 gap-150">
              {removed.map((contact) => (
                <ContactCard contact={contact} key={contact.id} writable={false} />
              ))}
            </ul>
          )}
        </div>
      )}
      <Dialog
        actions={
          <>
            <Button onClick={() => setRemoving(undefined)} theme="outlined" variant="secondary">
              Zrušit
            </Button>
            <Button
              isLoading={busy}
              onClick={() => {
                if (removing !== undefined) {
                  run(
                    { _tag: 'RemoveContactPerson', contactId: removing.id },
                    `${removing.name} odebrán(a) z kontaktů`,
                    () => setRemoving(undefined),
                  );
                }
              }}
              variant="primary"
            >
              Odebrat
            </Button>
          </>
        }
        closeLabel={dialogCloseLabel}
        customTrigger
        description="Osoba zmizí z aktivních kontaktů klienta. Záznam zůstane v historii a mezi odebranými osobami."
        onOpenChange={({ open }) => {
          if (!open) {
            setRemoving(undefined);
          }
        }}
        open={removing !== undefined}
        size="sm"
        title={removing === undefined ? 'Odebrat osobu' : `Odebrat ${removing.name}?`}
      />
    </div>
  );
};
