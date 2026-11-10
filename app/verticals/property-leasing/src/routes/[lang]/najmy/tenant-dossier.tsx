import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { SaveBar, DetailList, SectionCard, useRecordDraft } from '@app/admin-ui';
import type { RevisionedSaveResult } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Effect, Option, Schema } from 'effect';
import type { PlatformError } from 'effect';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { useEffect, useRef, useState } from 'react';
import type { Occupancy, RecordsResponse, TenantContact, TenantDossier } from '../../../../shared/apis/records.ts';
import { formatInstant, principalLabel } from './principal-labels.ts';
import type { TenantDirectoryEntry } from './lease-story.tsx';
import './tenant-dossier.css';
import { timelineEntries } from './timeline-entries.ts';
import { TenantActivityInputSchema, TenantCaseStateSchema } from '../../../../shared/apis/records.ts';
import { contactCountLabel } from './contact-count.ts';
import {
  caseChangesOf,
  caseDraftOf,
  caseProblems,
  caseUnchangedSince,
  contactProblems,
  contactsUnchangedSince,
  sameCaseDraft,
  sameContacts,
  trimmedContacts,
  validContacts,
} from './leasing-autosave.ts';
import type { CaseDraft, DossierChanges, UnchangedSince } from './leasing-autosave.ts';

const caseLabels = {
  CANCELLED: 'Zrušený',
  CLOSED: 'Uzavřený',
  CONFIRMED: 'Potvrzený',
  IN_PROGRESS: 'Řešený',
  NEW: 'Nový',
} as const;
const activityLabels = {
  ARCHIVE: 'Archivace',
  CALL: 'Hovor',
  CASE: 'Změna případu',
  CONTACTS: 'Kontakty',
  EMAIL: 'E-mail',
  MEETING: 'Schůzka',
  NOTE: 'Poznámka',
} as const;
const fold = (value: string) =>
  value
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .toLowerCase();
export type { DossierChanges } from './leasing-autosave.ts';

interface DossierSectionProps {
  readonly busy: boolean;
  readonly canWrite: boolean;
  readonly dossier: TenantDossier | undefined;
  readonly onUpdate: (changes: DossierChanges) => void;
}

/** Saves one dossier edit against the revision its draft builds on. */
export type DossierAutosave = (
  changes: DossierChanges,
  expectedRevision: number,
  unchanged: UnchangedSince,
) => Effect.Effect<RevisionedSaveResult>;

interface DossierAutosaveProps {
  readonly counterpartyId: string;
  readonly dossier: TenantDossier | undefined;
  readonly onAutosave: DossierAutosave;
  /** Revision of the records the dossier comes from. */
  readonly revision: number;
}

/**
 * One autosaving dossier section: its draft follows the dossier while nothing is pending and saves itself against
 * the revision it builds on; a change of the same section by someone else ends in a conflict.
 */
const useDossierAutosave = <V,>({
  changesOf,
  equals,
  onAutosave,
  revision,
  server,
  unchangedSince,
}: {
  readonly changesOf: (value: V) => Option.Option<DossierChanges>;
  readonly equals: (left: V, right: V) => boolean;
  readonly onAutosave: DossierAutosave;
  readonly revision: number;
  readonly server: V;
  readonly unchangedSince: (base: V) => UnchangedSince;
}) => {
  /** The version of the section the draft builds on: what it opened with, last saved or reloaded. */
  const base = useRef(server);
  const rememberSaved = (value: V, result: RevisionedSaveResult) => {
    if (result !== 'conflict' && result !== 'failed') {
      base.current = value;
    }
  };
  const send = (value: V, expectedRevision: number, changes: DossierChanges) =>
    onAutosave(changes, expectedRevision, unchangedSince(base.current)).pipe(
      Effect.tap((result) => Effect.sync(() => rememberSaved(value, result))),
    );
  const autosave = useRecordDraft<V, never>({
    equals,
    isValid: (value) => Option.isSome(changesOf(value)),
    revision,
    runtime: browserRuntime,
    save: (value, expectedRevision) =>
      Option.match(changesOf(value), {
        onNone: () => Effect.succeed<RevisionedSaveResult>('failed'),
        onSome: (changes) => send(value, expectedRevision, changes),
      }),
    server,
  });
  const settledOnServer = !autosave.pending && equals(autosave.draft, server);
  useEffect(() => {
    if (settledOnServer) {
      base.current = server;
    }
  }, [base, server, settledOnServer]);
  return autosave;
};

/** Error props for a field, spread so `validateStatus` is absent (not undefined) when the field is valid. */
const invalidField = (invalid: boolean, message: string) =>
  invalid ? { helpText: message, validateStatus: 'error' as const } : {};

const emptyContact = (id: string): TenantContact => ({ email: '', id, name: '', phone: '', role: '' });
const caseFieldRequiredKey = 'property-leasing.dossier.caseFieldRequired';

interface ContactsSectionProps extends DossierAutosaveProps {
  readonly canWrite: boolean;
  readonly newContactId: Effect.Effect<string, PlatformError.PlatformError>;
}
const noContacts: readonly TenantContact[] = [];
const DossierContacts = ({
  canWrite,
  counterpartyId,
  dossier,
  newContactId,
  onAutosave,
  revision,
}: ContactsSectionProps) => {
  const { t } = useModernI18n();
  const autosave = useDossierAutosave({
    changesOf: (contacts: readonly TenantContact[]) =>
      validContacts(contacts) ? Option.some({ contacts: trimmedContacts(contacts) }) : Option.none(),
    equals: sameContacts,
    onAutosave,
    revision,
    server: dossier?.contacts ?? noContacts,
    unchangedSince: (base) => contactsUnchangedSince(counterpartyId, base),
  });
  const contacts = autosave.draft;
  const [editing, setEditing] = useState(false);
  const editLabel = contacts.length === 0 ? 'Přidat kontaktní osoby' : 'Upravit kontakty';
  const updateContact = (id: string, field: 'name' | 'role' | 'email' | 'phone', value: string) =>
    autosave.setDraft((current) =>
      current.map((contact) => (contact.id === id ? { ...contact, [field]: value } : contact)),
    );
  const removeContact = (id: string) => autosave.setDraft((current) => current.filter((item) => item.id !== id));
  const appendContact = (id: string) => autosave.setDraft((current) => [...current, emptyContact(id)]);
  const toggleEditing = () => {
    setEditing(!editing);
  };
  const handleSave = autosave.save;
  const handleReloadLatest = autosave.reloadLatest;
  return (
    <>
      <div className="sp-tenant-heading">
        <h3>Kontaktní osoby</h3>
        {canWrite && (
          <Button onClick={toggleEditing} size="sm" theme="outlined" variant="secondary">
            {editing ? 'Zavřít úpravy' : editLabel}
          </Button>
        )}
      </div>
      {canWrite && <SaveBar onReloadLatest={handleReloadLatest} onSave={handleSave} status={autosave.status} />}
      {!editing && contacts.length === 0 && (
        <p className="sp-tenant-muted">
          Kontaktní osoby zatím nejsou doplněny. Hlavní e-mail a telefon protistrany najdete v kartě výše.
        </p>
      )}
      {!editing &&
        contacts.map((contact) => (
          <div className="sp-tenant-contact" key={contact.id}>
            <strong>{contact.name}</strong>
            <DetailList
              items={[
                { label: 'Role ve firmě', value: contact.role || 'Neuvedeno' },
                {
                  label: 'E-mail',
                  value: contact.email === '' ? 'Neuvedeno' : <a href={`mailto:${contact.email}`}>{contact.email}</a>,
                },
                {
                  label: 'Telefon',
                  value: contact.phone === '' ? 'Neuvedeno' : <a href={`tel:${contact.phone}`}>{contact.phone}</a>,
                },
              ]}
            />
          </div>
        ))}
      {editing && canWrite && (
        <div className="sp-tenant-stack">
          {contacts.map((contact, index) => {
            const problems = contactProblems(contact);
            return (
              <fieldset className="sp-tenant-contact" key={contact.id}>
                <legend>Kontakt {index + 1}</legend>
                <div className="sp-tenant-fields">
                  <FormInput
                    label={t('property-leasing.registration.fullName')}
                    onChange={(event) => updateContact(contact.id, 'name', event.target.value)}
                    required
                    value={contact.name}
                    {...invalidField(problems.name, t('property-leasing.dossier.contactNameRequired'))}
                  />
                  <FormInput
                    label={t('property-leasing.dossier.contactRole')}
                    onChange={(event) => updateContact(contact.id, 'role', event.target.value)}
                    value={contact.role}
                  />
                  <FormInput
                    label={t('property-leasing.dossier.contactEmail')}
                    onChange={(event) => updateContact(contact.id, 'email', event.target.value)}
                    type="email"
                    value={contact.email}
                    {...invalidField(problems.email, t('property-leasing.dossier.contactEmailInvalid'))}
                  />
                  <FormInput
                    label={t('property-leasing.dossier.contactPhone')}
                    onChange={(event) => updateContact(contact.id, 'phone', event.target.value)}
                    type="tel"
                    value={contact.phone}
                  />
                </div>
                <Button onClick={() => removeContact(contact.id)} size="sm" theme="borderless" variant="secondary">
                  Odebrat kontakt
                </Button>
              </fieldset>
            );
          })}
          <div className="sp-tenant-actions">
            <Button
              disabled={contacts.length >= 50}
              onClick={() => {
                void browserRuntime.runPromiseExit(
                  newContactId.pipe(Effect.tap((id) => Effect.sync(() => appendContact(id)))),
                );
              }}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              Přidat kontaktní osobu
            </Button>
          </div>
        </div>
      )}
    </>
  );
};

interface CaseSectionProps extends DossierAutosaveProps {
  readonly canWrite: boolean;
  readonly contractHref?: string | undefined;
  readonly counterpartyName: string;
  readonly leaseHref?: string | undefined;
  readonly taskHref?: string | undefined;
}
const DossierCase = ({
  canWrite,
  contractHref,
  counterpartyId,
  counterpartyName,
  dossier,
  leaseHref,
  onAutosave,
  revision,
  taskHref,
}: CaseSectionProps) => {
  const { t } = useModernI18n();
  const autosave = useDossierAutosave({
    changesOf: (draft: CaseDraft) => caseChangesOf(draft, dossier),
    equals: sameCaseDraft,
    onAutosave,
    revision,
    server: caseDraftOf(dossier),
    unchangedSince: (base) => caseUnchangedSince(counterpartyId, base),
  });
  const { draft } = autosave;
  const problems = caseProblems(draft, dossier);
  const change = (patch: Partial<CaseDraft>) => autosave.setDraft((current) => ({ ...current, ...patch }));
  const handleSave = autosave.save;
  const handleReloadLatest = autosave.reloadLatest;
  return (
    <div className="sp-tenant-contact">
      <h3>Obchodní případ</h3>
      <p className="sp-tenant-muted">Stav jednání nemění platnost smlouvy ani obsazenost jednotky.</p>
      {dossier?.caseDetails !== undefined && (
        <DetailList
          items={[
            { label: 'Předmět', value: dossier.caseDetails.subject },
            { label: 'Vlastník', value: dossier.caseDetails.owner },
            { label: 'Termín', value: dossier.caseDetails.deadline.split('-').toReversed().join('. ') },
            {
              label: 'Odhadovaná hodnota',
              value: Option.match(dossier.caseDetails.estimatedValueMinor, {
                onNone: () => 'Neuvedeno',
                onSome: (value) => `${(value / 100).toLocaleString('cs-CZ')} Kč`,
              }),
            },
            { label: 'Stav', value: caseLabels[dossier.caseState] },
          ]}
        />
      )}
      <DetailList items={[{ label: 'Protistrana případu', value: counterpartyName }]} />
      {canWrite && (
        <>
          <div className="sp-tenant-fields">
            <FormInput
              label={t('property-leasing.dossier.caseSubject')}
              maxLength={500}
              onChange={(event) => change({ subject: event.target.value })}
              required
              value={draft.subject}
              {...invalidField(problems.subject, t(caseFieldRequiredKey))}
            />
            <FormInput
              label={t('property-leasing.dossier.caseOwner')}
              maxLength={500}
              onChange={(event) => change({ owner: event.target.value })}
              required
              value={draft.owner}
              {...invalidField(problems.owner, t(caseFieldRequiredKey))}
            />
            <FormInput
              label={t('property-leasing.dossier.caseDeadline')}
              onChange={(event) => change({ deadline: event.target.value })}
              required
              type="date"
              value={draft.deadline}
              {...invalidField(problems.deadline, t(caseFieldRequiredKey))}
            />
            <FormInput
              inputMode="decimal"
              label={t('property-leasing.dossier.optionalCaseValue')}
              onChange={(event) => change({ value: event.target.value })}
              value={draft.value}
              {...invalidField(problems.value, t('property-leasing.rent.invalidAmount'))}
            />
          </div>
          <div className="sp-tenant-actions">
            <label className="sp-tenant-stack">
              <span>Stav případu</span>
              <select
                aria-label={t('property-leasing.dossier.caseState')}
                onChange={(event) => {
                  const selected = Schema.decodeUnknownOption(TenantCaseStateSchema)(event.target.value);
                  if (Option.isSome(selected)) {
                    change({ state: selected.value });
                  }
                }}
                value={draft.state}
              >
                {(['NEW', 'IN_PROGRESS', 'CONFIRMED', 'CLOSED', 'CANCELLED'] as const).map((value) => (
                  <option key={value} value={value}>
                    {caseLabels[value]}
                  </option>
                ))}
              </select>
            </label>
            <SaveBar onReloadLatest={handleReloadLatest} onSave={handleSave} status={autosave.status} />
          </div>
        </>
      )}
      <div className="sp-tenant-actions">
        {contractHref !== undefined && (
          <LinkButton href={contractHref} size="sm" theme="borderless" variant="secondary">
            Otevřít smlouvu případu →
          </LinkButton>
        )}
        {taskHref !== undefined && (
          <LinkButton href={taskHref} size="sm" theme="borderless" variant="secondary">
            Otevřít úkol případu →
          </LinkButton>
        )}
      </div>
      {leaseHref !== undefined && (
        <LinkButton href={leaseHref} size="sm" theme="borderless" variant="secondary">
          Otevřít nájem a související smlouvu →
        </LinkButton>
      )}
    </div>
  );
};
const DossierCommunication = ({
  busy,
  canWrite,
  onUpdate,
}: Pick<DossierSectionProps, 'busy' | 'canWrite' | 'onUpdate'>) => {
  const { t } = useModernI18n();
  const [kind, setKind] = useState<'CALL' | 'EMAIL' | 'MEETING' | 'NOTE'>('CALL');
  const [summary, setSummary] = useState('');
  if (!canWrite) {
    return null;
  }
  return (
    <div className="sp-tenant-contact">
      <h3>Zapsat komunikaci</h3>
      <div className="sp-tenant-fields">
        <label className="sp-tenant-stack">
          <span>Druh komunikace</span>
          <select
            aria-label={t('property-leasing.dossier.communicationKind')}
            onChange={(event) => {
              const selected = Schema.decodeUnknownOption(TenantActivityInputSchema.fields.kind)(event.target.value);
              if (Option.isSome(selected)) {
                setKind(selected.value);
              }
            }}
            value={kind}
          >
            {(['CALL', 'EMAIL', 'MEETING', 'NOTE'] as const).map((value) => (
              <option key={value} value={value}>
                {activityLabels[value]}
              </option>
            ))}
          </select>
        </label>
        <FormInput
          label={t('property-leasing.dossier.communicationSummary')}
          maxLength={500}
          onChange={(event) => setSummary(event.target.value)}
          placeholder={t('property-leasing.dossier.communicationPlaceholder')}
          value={summary}
        />
      </div>
      <Button
        disabled={busy || summary.trim().length === 0}
        onClick={() => {
          onUpdate({ activity: { kind, summary } });
          setSummary('');
        }}
        size="sm"
        variant="primary"
      >
        Uložit záznam komunikace
      </Button>
      <p className="sp-tenant-muted">Ruční evidence. E-mail ani SMS se touto akcí neodesílá.</p>
    </div>
  );
};

/** Contacts and the case timeline belong to the tenant, not to one selected contract. */
export const TenantDossierCard = ({
  busy,
  canWrite,
  contractHref,
  counterpartyId,
  counterpartyName,
  dossier,
  leaseHref,
  newContactId,
  onAutosave,
  onUpdate,
  revision,
  taskHref,
}: {
  readonly busy: boolean;
  readonly canWrite: boolean;
  readonly contractHref?: string | undefined;
  /** The counterparty whose dossier this is; autosave checks its contacts and case against it. */
  readonly counterpartyId: string;
  readonly counterpartyName: string;
  readonly dossier: TenantDossier | undefined;
  readonly leaseHref?: string | undefined;
  readonly newContactId: Effect.Effect<string, PlatformError.PlatformError>;
  /** Saves a contacts or case edit against the revision its draft builds on. */
  readonly onAutosave: DossierAutosave;
  /** Logs communication and archives: commands that stay explicit. */
  readonly onUpdate: (changes: DossierChanges) => void;
  /** Revision of the records the dossier comes from. */
  readonly revision: number;
  readonly taskHref?: string | undefined;
}) => {
  const { t } = useModernI18n();
  return (
    <div className="sp-tenant" id="tenant">
      <SectionCard
        actions={
          <Badge size="sm" variant={dossier?.archived === true ? 'outline' : 'info'}>
            {dossier?.archived === true ? 'Archivovaná protistrana' : 'Evidence protistrany'}
          </Badge>
        }
        title={t('property-leasing.dossier.title')}
      >
        <p className="sp-tenant-muted">
          Kontakty, komunikace a stav obchodního případu této protistrany, sdílené napříč všemi jejími nájmy. Zápisy se
          ukládají s autorem a časem.
        </p>
        <DossierContacts
          canWrite={canWrite}
          counterpartyId={counterpartyId}
          dossier={dossier}
          newContactId={newContactId}
          onAutosave={onAutosave}
          revision={revision}
        />
        <DossierCase
          canWrite={canWrite}
          contractHref={contractHref}
          counterpartyId={counterpartyId}
          counterpartyName={counterpartyName}
          dossier={dossier}
          leaseHref={leaseHref}
          onAutosave={onAutosave}
          revision={revision}
          taskHref={taskHref}
        />
        <DossierCommunication busy={busy} canWrite={canWrite} onUpdate={onUpdate} />
        <h3>Časová osa</h3>
        {timelineEntries(dossier?.history ?? []).map(({ entry, key }) => (
          <article className="sp-tenant-event" key={key}>
            <div className="sp-tenant-heading">
              <Badge size="sm" variant="outline">
                {activityLabels[entry.kind]}
              </Badge>
              <span className="sp-tenant-muted">
                {principalLabel(entry.authorPrincipalId)} · {formatInstant(entry.occurredAt)}
              </span>
            </div>
            <p>{entry.summary}</p>
          </article>
        ))}
        {(dossier?.history.length ?? 0) === 0 && (
          <p className="sp-tenant-muted">Zatím bez záznamů. První hovor, poznámka nebo změna případu se zobrazí zde.</p>
        )}
        <div className="sp-tenant-heading">
          <p className="sp-tenant-muted">
            Archivace skryje protistranu pouze z běžného přehledu kontaktů. Platné smlouvy, nájmy i historie zůstávají
            zachovány.
          </p>
          {canWrite && (
            <Button
              disabled={busy}
              onClick={() => onUpdate({ archived: dossier?.archived !== true })}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              {dossier?.archived === true ? 'Obnovit evidenci protistrany' : 'Archivovat evidenci protistrany'}
            </Button>
          )}
        </div>
      </SectionCard>
    </div>
  );
};

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

const NewCounterpartyForm = ({
  busy,
  error,
  existingHref,
  onCancel,
  onCreate,
}: {
  readonly busy: boolean;
  readonly error: string | undefined;
  /** Dossier link of a registry customer with the same name, so the user opens it instead of duplicating. */
  readonly existingHref: (name: string) => string | undefined;
  readonly onCancel: () => void;
  readonly onCreate: (input: NewCounterpartyInput) => void;
}) => {
  const { t } = useModernI18n();
  const [input, setInput] = useState<NewCounterpartyInput>(emptyCounterparty);
  const [submitted, setSubmitted] = useState(false);
  const [duplicateHref, setDuplicateHref] = useState<string>();
  const errors = submitted ? validateNewCounterparty(input) : {};
  const set = (field: keyof NewCounterpartyInput, value: string) => setInput({ ...input, [field]: value });
  const person = input.partyType === 'PERSON';
  return (
    <form
      className="sp-tenant-contact"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        const existing = existingHref(input.displayName);
        setDuplicateHref(existing);
        if (existing === undefined && Object.keys(validateNewCounterparty(input)).length === 0) {
          onCreate(input);
        }
      }}
    >
      <h3>Nová protistrana</h3>
      <p className="sp-tenant-muted">
        Firma nebo osoba se založí ve společném registru protistran této společnosti. Kontaktní osoby, poznámky a
        obchodní případ doplníte hned po uložení, nájem k ní není potřeba.
      </p>
      <fieldset className="sp-tenant-actions">
        <legend className="sp-tenant-muted">Typ protistrany</legend>
        <label>
          <input
            checked={!person}
            name="counterparty-type"
            onChange={() => setInput({ ...input, partyType: 'ORGANIZATION' })}
            type="radio"
          />{' '}
          Firma
        </label>
        <label>
          <input
            checked={person}
            name="counterparty-type"
            onChange={() => setInput({ ...input, companyId: '', partyType: 'PERSON' })}
            type="radio"
          />{' '}
          Osoba
        </label>
      </fieldset>
      <div className="sp-tenant-fields">
        <FormInput
          id="counterparty-name"
          label={person ? 'Jméno a příjmení' : 'Název firmy'}
          maxLength={300}
          onChange={(event) => set('displayName', event.target.value)}
          value={input.displayName}
          {...(errors.displayName === undefined ? {} : { helpText: errors.displayName, validateStatus: 'error' })}
        />
        {!person && (
          <FormInput
            id="counterparty-ico"
            inputMode="numeric"
            label={t('property-leasing.dossier.optionalCompanyId')}
            onChange={(event) => set('companyId', event.target.value)}
            value={input.companyId}
            {...(errors.companyId === undefined ? {} : { helpText: errors.companyId, validateStatus: 'error' })}
          />
        )}
        <FormInput
          id="counterparty-email"
          label={t('property-leasing.dossier.optionalEmail')}
          onChange={(event) => set('email', event.target.value)}
          type="email"
          value={input.email}
          {...(errors.email === undefined ? {} : { helpText: errors.email, validateStatus: 'error' })}
        />
        <FormInput
          id="counterparty-phone"
          label={t('property-leasing.dossier.optionalPhone')}
          onChange={(event) => set('phone', event.target.value)}
          type="tel"
          value={input.phone}
          {...(errors.phone === undefined ? {} : { helpText: errors.phone, validateStatus: 'error' })}
        />
      </div>
      <FormInput
        id="counterparty-note"
        label={t('property-leasing.dossier.optionalTimelineNote')}
        maxLength={500}
        onChange={(event) => set('note', event.target.value)}
        placeholder={t('property-leasing.dossier.timelinePlaceholder')}
        value={input.note}
        {...(errors.note === undefined ? {} : { helpText: errors.note, validateStatus: 'error' })}
      />
      {duplicateHref !== undefined && (
        <p className="sp-tenant-muted" role="alert">
          {person ? 'Osoba' : 'Firma'} „{input.displayName.trim()}“ už v registru této společnosti je.{' '}
          <a href={duplicateHref}>Otevřít její evidenci a doplnit kontakty →</a>
        </p>
      )}
      {error !== undefined && duplicateHref === undefined && (
        <p className="sp-tenant-muted" role="alert">
          {error}
        </p>
      )}
      <div className="sp-tenant-actions">
        <Button disabled={busy} size="sm" type="submit" variant="primary">
          {busy ? 'Ukládání…' : 'Založit protistranu'}
        </Button>
        <Button disabled={busy} onClick={onCancel} size="sm" theme="outlined" variant="secondary">
          Zrušit
        </Button>
      </div>
    </form>
  );
};

const relationshipLabel = (
  leases: readonly Occupancy[],
  dossier: TenantDossier | undefined,
  unitName: (id: string) => string,
) => {
  if (leases.length > 0) {
    return [...new Set(leases.map((record) => unitName(record.unitRef.resourceId)))].join(', ');
  }
  return dossier === undefined ? 'Zákazník z registru · zatím bez evidence' : 'Zájemce bez nájmu';
};

export const TenantDirectory = ({
  busy,
  canCreate,
  createError,
  directory,
  language,
  onCreate,
  snapshot,
  unitName,
}: {
  readonly busy: boolean;
  readonly canCreate: boolean;
  readonly createError: string | undefined;
  readonly directory: readonly TenantDirectoryEntry[];
  readonly language: string;
  readonly onCreate: (input: NewCounterpartyInput) => void;
  readonly snapshot: RecordsResponse;
  readonly unitName: (id: string) => string;
}) => {
  const { t } = useModernI18n();
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const leasesOf = (counterpartyId: string): readonly Occupancy[] =>
    snapshot.occupancies.filter((record) => record.customerCounterpartyRef?.resourceId === counterpartyId);
  const dossierOf = (counterpartyId: string) =>
    snapshot.tenantDossiers?.find((item) => item.counterpartyId === counterpartyId);
  // Every counterparty of the company: tenants, prospects with a dossier and firms entered in the registry.
  const dossierHref = (id: string) => `/${language}/najmy?counterpartyId=${id}#tenant`;
  const existingHref = (name: string) => {
    const wanted = fold(name.trim());
    const match = directory.find((entry) => entry.status === 'ACTIVE' && fold(entry.displayName ?? '') === wanted);
    return wanted === '' || match === undefined ? undefined : dossierHref(match.counterpartyRef.resourceId);
  };
  const visible = directory.filter((entry) => {
    const dossier = dossierOf(entry.counterpartyRef.resourceId);
    return (
      (archived || (dossier?.archived !== true && entry.status !== 'ARCHIVED')) &&
      fold(
        [
          entry.displayName,
          entry.email,
          entry.phone,
          entry.companyId,
          ...(dossier?.contacts ?? []).flatMap((contact) => [contact.name, contact.email, contact.phone]),
        ].join(' '),
      ).includes(fold(query))
    );
  });
  return (
    <section className="sp-tenant" id="tenants">
      <SectionCard
        actions={
          <div className="sp-tenant-actions">
            {canCreate && !creating && (
              <Button disabled={busy} onClick={() => setCreating(true)} size="sm" variant="primary">
                Nová protistrana
              </Button>
            )}
            <LinkButton href={`/${language}/prodej/zakaznici`} size="sm" theme="outlined" variant="secondary">
              Firemní registr zákazníků →
            </LinkButton>
          </div>
        }
        title={t('property-leasing.dossier.directoryTitle')}
      >
        <p className="sp-tenant-muted">
          Najděte firmu nebo osobu podle názvu, IČO, e-mailu, telefonu nebo jména kontaktní osoby. Seznam obsahuje
          nájemce i firmy z registru zákazníků; nového zájemce založíte tlačítkem Nová protistrana.
        </p>
        {creating && (
          <NewCounterpartyForm
            busy={busy}
            error={createError}
            existingHref={existingHref}
            onCancel={() => setCreating(false)}
            onCreate={onCreate}
          />
        )}
        <FormInput
          label={t('property-leasing.dossier.search')}
          onChange={(event) => setQuery(event.target.value)}
          type="search"
          value={query}
        />
        <label className="sp-tenant-muted">
          <input checked={archived} onChange={(event) => setArchived(event.target.checked)} type="checkbox" /> Zahrnout
          archivovanou evidenci
        </label>
        <div className="sp-tenant-directory">
          {visible.map((entry) => {
            const id = entry.counterpartyRef.resourceId;
            const dossier = dossierOf(id);
            const leases = leasesOf(id);
            const contactDetails = [entry.email, entry.phone]
              .filter((value) => value !== null && value !== undefined && value !== '')
              .join(' · ');
            return (
              <a className="sp-tenant-contact" href={dossierHref(id)} key={id}>
                <div className="sp-tenant-heading">
                  <strong>{entry.displayName ?? 'Protistrana'}</strong>
                  <Badge size="sm" variant={dossier?.archived === true ? 'outline' : 'info'}>
                    {dossier?.archived === true ? 'Archivováno' : caseLabels[dossier?.caseState ?? 'NEW']}
                  </Badge>
                </div>
                <span className="sp-tenant-muted">
                  {relationshipLabel(leases, dossier, unitName)} · {contactCountLabel(dossier?.contacts.length ?? 0)}
                </span>
                {contactDetails.length > 0 && <span className="sp-tenant-muted">{contactDetails}</span>}
                <span className="sp-tenant-muted">Kontakty, historie a obchodní případ →</span>
              </a>
            );
          })}
        </div>
        {visible.length === 0 && <p className="sp-tenant-muted">Žádné protistrany neodpovídají zadanému filtru.</p>}
      </SectionCard>
    </section>
  );
};
