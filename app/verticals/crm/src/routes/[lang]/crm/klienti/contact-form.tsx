// Inline form of one contact person on the client card (add or edit). Typing changes only the draft; the shared
// Save button ("Uložit", last in the footer) sends one AddContactPerson / UpdateContactPerson command, and leaving
// with unsaved input asks Uložit / Zahodit změny / Zůstat.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { surfaceTileClassName } from '@app/admin-ui';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput, FormTextarea } from '@app/admin-ui/form-controls';
import { Option } from 'effect';
import { useState } from 'react';
import type { ComponentProps } from 'react';
import type { CrmCommandInput } from '../../../../../shared/actions/apply-command.ts';
import type { ContactPerson } from '../../../../../shared/domain/clients.ts';
import { CrmFormSaveActions, useCrmFormSave } from '../../../../crm/form-save.tsx';
import type { CrmCommandSubmit } from '../../../../crm/records.ts';

type InputHelp = Pick<ComponentProps<typeof FormInput>, 'helpText'>;

export interface ContactDraft {
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

const emailValid = (draft: ContactDraft): boolean => draft.email.trim() === '' || EMAIL.test(draft.email.trim());

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

/** The command that saves `draft`; none while it is incomplete or changes nothing. */
const contactCommand = (
  clientId: string,
  contact: ContactPerson | undefined,
  draft: ContactDraft,
): Option.Option<CrmCommandInput> => {
  if (draft.name.trim() === '' || !emailValid(draft)) {
    return Option.none();
  }
  if (contact === undefined) {
    const command: CrmCommandInput = {
      _tag: 'AddContactPerson',
      clientId,
      name: draft.name.trim(),
      ...optionalText(draft),
    };
    return Option.some(draft.primary ? { ...command, primary: true } : command);
  }
  const patch = contactPatch(draft, contact);
  return Object.keys(patch).length === 0
    ? Option.none()
    : Option.some({ _tag: 'UpdateContactPerson', contactId: contact.id, patch });
};

export const ContactForm = ({
  clientId,
  contact,
  isFirst,
  onClose,
  onSaved,
  submit,
}: {
  readonly clientId: string;
  readonly contact?: ContactPerson | undefined;
  readonly isFirst: boolean;
  /** Leaves the form; called after a save and after Zrušit (through the unsaved-changes guard). */
  readonly onClose: () => void;
  /** The command went through: the tab shows its toast. */
  readonly onSaved: (draft: ContactDraft) => void;
  readonly submit: CrmCommandSubmit;
}) => {
  const { t } = useModernI18n();
  const [draft, setDraft] = useState<ContactDraft>(() => draftOf(contact, isFirst));
  const form = useCrmFormSave<ContactDraft>({
    command: (value) => contactCommand(clientId, contact, value),
    failureText: (message) => message ?? t('crm.ciClientsVisits.contacts.saveFailed'),
    onSaved: (value) => {
      onSaved(value);
      onClose();
    },
    submit,
    value: draft,
  });
  const patch = (next: Partial<ContactDraft>) => setDraft((current) => ({ ...current, ...next }));
  const prefix = contact?.id ?? 'new';
  const nameError =
    form.record.status === 'invalid' && draft.name.trim() === ''
      ? t('crm.ciClientsVisits.contacts.nameRequired')
      : undefined;
  const emailError = emailValid(draft) ? undefined : t('crm.ciClientsVisits.contacts.emailInvalid');
  const nameHelp: InputHelp = {};
  if (nameError !== undefined) {
    nameHelp.helpText = nameError;
  }
  const emailHelp: InputHelp = {};
  if (emailError !== undefined) {
    emailHelp.helpText = emailError;
  }
  return (
    <div className={`${surfaceTileClassName} flex flex-col gap-150 p-200`} data-testid={`crm-contact-${prefix}-form`}>
      <form className="flex flex-col gap-150" onSubmit={(event) => event.preventDefault()}>
        <h4 className="font-semibold text-sm">
          {contact === undefined
            ? t('crm.ciClientsVisits.contacts.newTitle')
            : `${t('crm.ciClientsVisits.contacts.editTitle')}: ${contact.name}`}
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
      </form>
      <div className="flex flex-wrap items-center justify-end gap-100">
        <CrmFormSaveActions form={form} onCancel={onClose} />
      </div>
    </div>
  );
};
