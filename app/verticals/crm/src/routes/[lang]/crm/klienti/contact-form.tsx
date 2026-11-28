// Inline form of one contact person on the client card (add or edit). Typing changes only the form; the shared
// Save button ("Uložit", last in the footer) sends one AddContactPerson / UpdateContactPerson command, and leaving
// with unsaved input asks Uložit / Zahodit změny / Zůstat.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { requiredLabelFor, surfaceTileClassName } from '@app/admin-ui';
import {
  CheckboxField,
  FormBuilder,
  FormReact,
  FormRoot,
  TextAreaField,
  TextField,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { Effect, Option, Schema } from 'effect';
import { useEffect, useState } from 'react';
import type { CrmCommandInput } from '../../../../../shared/actions/apply-command.ts';
import type { ContactPerson } from '../../../../../shared/domain/clients.ts';
import { CrmFormSaveActions, useCrmFormSave } from '../../../../crm/form-save.tsx';
import type { CrmCommandSubmit } from '../../../../crm/records.ts';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime.ts';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/**
 * One contact person as the form edits it; its checks are the field schemas, and their messages are i18n keys. Only
 * one contact form is open at a time, so the form holds one state. Enter sends nothing: only Uložit does.
 */
const contactForm = FormReact.make(
  FormBuilder.empty
    .addField(
      'email',
      Schema.String.check(
        Schema.makeFilter(
          (email: string) =>
            email.trim() === '' || EMAIL.test(email.trim()) || 'crm.ciClientsVisits.contacts.emailInvalid',
        ),
      ),
    )
    .addField(
      'name',
      Schema.String.check(
        Schema.makeFilter((name: string) => name.trim() !== '' || 'crm.ciClientsVisits.contacts.nameRequired'),
      ),
    )
    .addField('note', Schema.String)
    .addField('phone', Schema.String)
    .addField('primary', Schema.Boolean)
    .addField('role', Schema.String),
  {
    fields: {
      email: TextField,
      name: TextField,
      note: TextAreaField,
      phone: TextField,
      primary: CheckboxField,
      role: TextField,
    },
    mode: { validation: 'onChange' },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

export interface ContactDraft {
  readonly email: string;
  readonly name: string;
  readonly note: string;
  readonly phone: string;
  readonly primary: boolean;
  readonly role: string;
}

const completeContact = Schema.is(contactForm.schema);
const nameField = contactForm.getFieldAtoms(contactForm.fields.name);

const draftOf = (contact: ContactPerson | undefined, primary: boolean): ContactDraft => ({
  email: contact?.email ?? '',
  name: contact?.name ?? '',
  note: contact?.note ?? '',
  phone: contact?.phone ?? '',
  primary: contact?.primary ?? primary,
  role: contact?.role ?? '',
});

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

/** The command that saves `draft`; none while it fails the form's checks or changes nothing. */
const contactCommand = (
  clientId: string,
  contact: ContactPerson | undefined,
  draft: ContactDraft,
): Option.Option<CrmCommandInput> => {
  if (!completeContact(draft)) {
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

/**
 * Rendered inside `FormRoot`, which renders its children only once this mount initialized the form: until then the
 * form's atoms can still hold what the contact form open before it left, so its values are read only after this.
 */
const FormReady = ({ onReady }: { readonly onReady: (ready: boolean) => void }) => {
  useEffect(() => onReady(true), [onReady]);
  return null;
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
  const { language, t } = useModernI18n();
  // The values the form opens with; it reads them once, when it starts.
  const opened = draftOf(contact, isFirst);
  const [ready, setReady] = useState(false);
  const draft = Option.getOrElse(
    Option.filter(useAtomValue(contactForm.values), () => ready),
    () => opened,
  );
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
  const validateName = useAtomSet(nameField.validate);
  const reset = useAtomSet(contactForm.reset);
  // The name's message shows once the draft is changed and cannot be saved, the moment the save bar says so.
  const invalid = form.record.status === 'invalid';
  useEffect(() => {
    if (invalid) {
      validateName();
    }
  }, [invalid, validateName]);
  // Back at the values it opened with, the form shows no messages.
  useAtomSubscribe(
    contactForm.isDirty,
    (dirty) => {
      if (!dirty) {
        reset();
      }
    },
    { immediate: false },
  );
  const prefix = contact?.id ?? 'new';
  const requiredLabel = requiredLabelFor(language);
  return (
    <div className={`${surfaceTileClassName} flex flex-col gap-150 p-200`} data-testid={`crm-contact-${prefix}-form`}>
      <FormRoot
        className="flex flex-col gap-150"
        defaultValues={opened}
        form={contactForm}
        translateMessage={(message) => t(message, { defaultValue: message })}
      >
        <FormReady onReady={setReady} />
        <h4 className="font-semibold text-sm">
          {contact === undefined
            ? t('crm.ciClientsVisits.contacts.newTitle')
            : `${t('crm.ciClientsVisits.contacts.editTitle')}: ${contact.name}`}
        </h4>
        <div className="grid grid-cols-1 gap-150 sm:grid-cols-2">
          <contactForm.name
            autoComplete="off"
            id={`crm-contact-${prefix}-name`}
            label={t('crm.ciClientsVisits.fields.fullName')}
            required
            requiredLabel={requiredLabel}
          />
          <contactForm.role
            autoComplete="off"
            id={`crm-contact-${prefix}-role`}
            label={t('crm.ciClientsVisits.fields.jobRole')}
            placeholder={t('crm.ciClientsVisits.contacts.rolesExample')}
          />
          <contactForm.phone
            autoComplete="off"
            id={`crm-contact-${prefix}-phone`}
            label={t('crm.ciClientsVisits.fields.phone')}
            type="tel"
          />
          <contactForm.email
            autoComplete="off"
            id={`crm-contact-${prefix}-email`}
            label={t('crm.ciClientsVisits.fields.email')}
            type="email"
          />
          <div className="sm:col-span-2">
            <contactForm.note
              id={`crm-contact-${prefix}-note`}
              label={t('crm.ciClientsVisits.fields.note')}
              maxLength={4000}
              rows={2}
            />
          </div>
        </div>
        <contactForm.primary id={`crm-contact-${prefix}-primary`} label={t('crm.ciClientsVisits.contacts.primary')} />
      </FormRoot>
      <div className="flex flex-wrap items-center justify-end gap-100">
        <CrmFormSaveActions form={form} onCancel={onClose} />
      </div>
    </div>
  );
};
