// A new firm or person in the counterparty registry, with an optional first timeline note. Typing changes only the
// draft; the shared Uložit creates it once; Enter never creates; Zrušit and leaving the page with typed input ask
// first, and an untouched form closes at once.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { SaveBar, UnsavedChangesDialog, saveLabelsFor, useDraftSave, useUnsavedChangesGuard } from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import type { Effect } from 'effect';
import { constVoid } from 'effect/Function';
import { useState } from 'react';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';

export interface NewCounterpartyInput {
  readonly companyId: string;
  readonly displayName: string;
  readonly email: string;
  readonly note: string;
  readonly partyType: 'ORGANIZATION' | 'PERSON';
  readonly phone: string;
}
interface NewCounterpartyErrors {
  companyId?: string;
  displayName?: string;
  email?: string;
  note?: string;
  phone?: string;
}
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const phonePattern = /^\+?[0-9 ]{9,20}$/u;
/** Czech inline validation of the new counterparty form (rules 3.8 and 3.9). */
export const validateNewCounterparty = (input: NewCounterpartyInput): NewCounterpartyErrors => {
  const errors: NewCounterpartyErrors = {};
  if (input.displayName.trim().length === 0) {
    errors.displayName = input.partyType === 'PERSON' ? 'Vyplňte jméno a příjmení.' : 'Vyplňte název firmy.';
  } else if (input.displayName.trim().length > 300) {
    errors.displayName = 'Název může mít nejvýše 300 znaků.';
  }
  if (input.partyType === 'ORGANIZATION' && input.companyId.trim() !== '' && !/^\d{8}$/u.test(input.companyId.trim())) {
    errors.companyId = 'IČO musí mít přesně 8 číslic.';
  }
  if (input.email.trim() !== '' && !emailPattern.test(input.email.trim())) {
    errors.email = 'Zadejte e-mail ve tvaru jmeno@firma.cz.';
  }
  if (input.phone.trim() !== '' && !phonePattern.test(input.phone.trim())) {
    errors.phone = 'Zadejte telefon, například +420 777 123 456.';
  }
  if (input.note.length > 500) {
    errors.note = 'Poznámka může mít nejvýše 500 znaků.';
  }
  return errors;
};
const emptyCounterparty: NewCounterpartyInput = {
  companyId: '',
  displayName: '',
  email: '',
  note: '',
  partyType: 'ORGANIZATION',
  phone: '',
};

/** Error props for a field, spread so `validateStatus` is absent (not undefined) when the field is valid. */
const invalidField = (message: string | undefined) =>
  message === undefined ? {} : { helpText: message, validateStatus: 'error' as const };

export const NewCounterpartyForm = ({
  error,
  existingHref,
  onCancel,
  onCreate,
}: {
  /** Why the last create was refused. */
  readonly error: string | undefined;
  /** Dossier link of a registry customer with the same name, so the user opens it instead of duplicating. */
  readonly existingHref: (name: string) => string | undefined;
  readonly onCancel: () => void;
  /** Creates the counterparty once. */
  readonly onCreate: (input: NewCounterpartyInput) => Effect.Effect<SaveOutcome>;
}) => {
  const { language, t } = useModernI18n();
  const labels = saveLabelsFor(language);
  const [input, setInput] = useState<NewCounterpartyInput>(emptyCounterparty);
  const duplicateHref = existingHref(input.displayName);
  const record = useDraftSave<NewCounterpartyInput, never>({
    initial: emptyCounterparty,
    // A name already in the registry is opened, never created twice.
    isValid: (value) =>
      Object.keys(validateNewCounterparty(value)).length === 0 && existingHref(value.displayName) === undefined,
    runtime: browserRuntime,
    save: onCreate,
    value: input,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({
    draft: record,
    navigation: blocker,
    onDiscard: () => setInput(record.confirmed),
  });
  const errors = record.status === 'invalid' ? validateNewCounterparty(input) : {};
  const set = (field: keyof NewCounterpartyInput, value: string) =>
    setInput((current) => ({ ...current, [field]: value }));
  const person = input.partyType === 'PERSON';
  const saving = record.status === 'saving';
  const handleCancel = () => guard.request(onCancel);
  const handleSave = record.save;
  return (
    <form
      className="sp-tenant-contact"
      noValidate
      onSubmit={(event) => {
        // Enter never creates: only Uložit does.
        event.preventDefault();
      }}
    >
      <h3>Nová protistrana</h3>
      <p className="sp-tenant-muted">
        Firma nebo osoba se založí ve společném registru protistran této společnosti. Kontaktní osoby, poznámky a
        obchodní případ doplníte hned po uložení, nájem k ní není potřeba.
      </p>
      <fieldset className="sp-tenant-actions" disabled={saving}>
        <legend className="sp-tenant-muted">Typ protistrany</legend>
        <label>
          <input
            checked={!person}
            name="counterparty-type"
            onChange={() => setInput((current) => ({ ...current, partyType: 'ORGANIZATION' }))}
            type="radio"
          />{' '}
          Firma
        </label>
        <label>
          <input
            checked={person}
            name="counterparty-type"
            onChange={() => setInput((current) => ({ ...current, companyId: '', partyType: 'PERSON' }))}
            type="radio"
          />{' '}
          Osoba
        </label>
      </fieldset>
      <div className="sp-tenant-fields">
        <FormInput
          disabled={saving}
          id="counterparty-name"
          label={person ? 'Jméno a příjmení' : 'Název firmy'}
          maxLength={300}
          onChange={(event) => set('displayName', event.target.value)}
          value={input.displayName}
          {...invalidField(errors.displayName)}
        />
        {!person && (
          <FormInput
            disabled={saving}
            id="counterparty-ico"
            inputMode="numeric"
            label={t('property-leasing.dossier.optionalCompanyId')}
            onChange={(event) => set('companyId', event.target.value)}
            value={input.companyId}
            {...invalidField(errors.companyId)}
          />
        )}
        <FormInput
          disabled={saving}
          id="counterparty-email"
          label={t('property-leasing.dossier.optionalEmail')}
          onChange={(event) => set('email', event.target.value)}
          type="email"
          value={input.email}
          {...invalidField(errors.email)}
        />
        <FormInput
          disabled={saving}
          id="counterparty-phone"
          label={t('property-leasing.dossier.optionalPhone')}
          onChange={(event) => set('phone', event.target.value)}
          type="tel"
          value={input.phone}
          {...invalidField(errors.phone)}
        />
      </div>
      <FormInput
        disabled={saving}
        id="counterparty-note"
        label={t('property-leasing.dossier.optionalTimelineNote')}
        maxLength={500}
        onChange={(event) => set('note', event.target.value)}
        placeholder={t('property-leasing.dossier.timelinePlaceholder')}
        value={input.note}
        {...invalidField(errors.note)}
      />
      {duplicateHref !== undefined && (
        <p className="sp-tenant-muted" role="alert">
          {person ? 'Osoba' : 'Firma'} „{input.displayName.trim()}“ už v registru této společnosti je.{' '}
          <a href={duplicateHref}>Otevřít její evidenci a doplnit kontakty →</a>
        </p>
      )}
      <div className="sp-tenant-actions">
        <Button disabled={saving} onClick={handleCancel} size="sm" theme="outlined" variant="secondary">
          {t('property-leasing.demo.cancel')}
        </Button>
        <SaveBar
          error={record.status === 'error' ? (error ?? null) : null}
          labels={labels}
          onReloadLatest={constVoid}
          onSave={handleSave}
          size="sm"
          status={record.status}
        />
      </div>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </form>
  );
};
