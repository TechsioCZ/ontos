import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import {
  DetailList,
  SaveBar,
  SectionCard,
  UnsavedChangesDialog,
  saveLabelsFor,
  useRecordDraft,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { RevisionedSaveResult } from '@app/admin-ui';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { FormInput } from '@app/admin-ui/form-controls';
import { Effect, Option, Predicate, Schema } from 'effect';
import type { PlatformError } from 'effect';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { useEffect, useRef, useState } from 'react';
import type { Occupancy, RecordsResponse, TenantContact, TenantDossier } from '../../../../shared/apis/records.ts';
import { formatInstant, principalLabel } from './principal-labels.ts';
import type { TenantDirectoryEntry } from './lease-story.tsx';
import './tenant-dossier.css';
import { timelineEntries } from './timeline-entries.ts';
import { TenantCaseStateSchema } from '../../../../shared/apis/records.ts';
import { contactCountLabel } from './contact-count.ts';
import { DossierCommunication } from './dossier-communication.tsx';
import type { DossierLog } from './dossier-communication.tsx';
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
} from './leasing-save.ts';
import type { CaseDraft, DossierChanges, UnchangedSince } from './leasing-save.ts';

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
export type { DossierChanges } from './leasing-save.ts';

/** The Save button of a dossier section: one save against the revision its draft builds on. */
export type DossierSave = (
  changes: DossierChanges,
  expectedRevision: number,
  unchanged: UnchangedSince,
) => Effect.Effect<RevisionedSaveResult>;

export type { DossierLog } from './dossier-communication.tsx';

interface DossierDraftProps {
  readonly counterpartyId: string;
  readonly dossier: TenantDossier | undefined;
  readonly onSave: DossierSave;
  /** Revision of the records the dossier comes from. */
  readonly revision: number;
}

/**
 * The draft of one dossier section: it follows the dossier while nothing is pending, and only its Save button sends it,
 * against the revision it builds on; a change of the same section by someone else ends in a conflict. Leaving the page
 * with unsaved changes asks first.
 */
const useDossierDraft = <V,>({
  changesOf,
  equals,
  onSave,
  revision,
  server,
  unchangedSince,
}: {
  readonly changesOf: (value: V) => Option.Option<DossierChanges>;
  readonly equals: (left: V, right: V) => boolean;
  readonly onSave: DossierSave;
  readonly revision: number;
  readonly server: V;
  readonly unchangedSince: (base: V) => UnchangedSince;
}) => {
  /** The version of the section the draft builds on: what it opened with, last saved or reloaded. */
  const base = useRef(server);
  const rememberSaved = (value: V, result: RevisionedSaveResult) => {
    if (Predicate.isNumber(result) || result === 'saved') {
      base.current = value;
    }
  };
  const send = (value: V, expectedRevision: number, changes: DossierChanges) =>
    onSave(changes, expectedRevision, unchangedSince(base.current)).pipe(
      Effect.tap((result) => Effect.sync(() => rememberSaved(value, result))),
    );
  const record = useRecordDraft<V, never>({
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
  const settledOnServer = !record.pending && equals(record.draft, server);
  useEffect(() => {
    if (settledOnServer) {
      base.current = server;
    }
  }, [base, server, settledOnServer]);
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: record.discard });
  return { guard, record };
};

/** Error props for a field, spread so `validateStatus` is absent (not undefined) when the field is valid. */
const invalidField = (invalid: boolean, message: string) =>
  invalid ? { helpText: message, validateStatus: 'error' as const } : {};

const emptyContact = (id: string): TenantContact => ({ email: '', id, name: '', phone: '', role: '' });
const caseFieldRequiredKey = 'property-leasing.dossier.caseFieldRequired';

interface ContactsSectionProps extends DossierDraftProps {
  readonly canWrite: boolean;
  readonly newContactId: Effect.Effect<string, PlatformError.PlatformError>;
}
const noContacts: readonly TenantContact[] = [];
const DossierContacts = ({
  canWrite,
  counterpartyId,
  dossier,
  newContactId,
  onSave,
  revision,
}: ContactsSectionProps) => {
  const { language, t } = useModernI18n();
  const labels = saveLabelsFor(language);
  const { guard, record } = useDossierDraft({
    changesOf: (contacts: readonly TenantContact[]) =>
      validContacts(contacts) ? Option.some({ contacts: trimmedContacts(contacts) }) : Option.none(),
    equals: sameContacts,
    onSave,
    revision,
    server: dossier?.contacts ?? noContacts,
    unchangedSince: (base) => contactsUnchangedSince(counterpartyId, base),
  });
  const contacts = record.draft;
  const [editing, setEditing] = useState(false);
  const editLabel = contacts.length === 0 ? 'Přidat kontaktní osoby' : 'Upravit kontakty';
  const updateContact = (id: string, field: 'name' | 'role' | 'email' | 'phone', value: string) =>
    record.setDraft((current) =>
      current.map((contact) => (contact.id === id ? { ...contact, [field]: value } : contact)),
    );
  const removeContact = (id: string) => record.setDraft((current) => current.filter((item) => item.id !== id));
  const appendContact = (id: string) => record.setDraft((current) => [...current, emptyContact(id)]);
  const toggleEditing = () => {
    if (editing) {
      guard.request(() => setEditing(false));
      return;
    }
    setEditing(true);
  };
  const handleSave = record.save;
  const handleReloadLatest = record.reloadLatest;
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
        <form
          className="sp-tenant-stack"
          noValidate
          onSubmit={(event) => {
            // Enter never saves: only Uložit does.
            event.preventDefault();
          }}
        >
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
        </form>
      )}
      {canWrite && (
        <SaveBar
          labels={labels}
          onReloadLatest={handleReloadLatest}
          onSave={handleSave}
          size="sm"
          status={record.status}
        />
      )}
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};

interface CaseSectionProps extends DossierDraftProps {
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
  onSave,
  revision,
  taskHref,
}: CaseSectionProps) => {
  const { language, t } = useModernI18n();
  const labels = saveLabelsFor(language);
  const { guard, record } = useDossierDraft({
    changesOf: (draft: CaseDraft) => caseChangesOf(draft, dossier),
    equals: sameCaseDraft,
    onSave,
    revision,
    server: caseDraftOf(dossier),
    unchangedSince: (base) => caseUnchangedSince(counterpartyId, base),
  });
  const { draft } = record;
  const problems = caseProblems(draft, dossier);
  const change = (patch: Partial<CaseDraft>) => record.setDraft((current) => ({ ...current, ...patch }));
  const handleSave = record.save;
  const handleReloadLatest = record.reloadLatest;
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
        <form
          className="sp-tenant-stack"
          noValidate
          onSubmit={(event) => {
            // Enter never saves: only Uložit does.
            event.preventDefault();
          }}
        >
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
          </div>
          <SaveBar
            labels={labels}
            onReloadLatest={handleReloadLatest}
            onSave={handleSave}
            size="sm"
            status={record.status}
          />
        </form>
      )}
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
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
  onLog,
  onSave,
  onUpdate,
  revision,
  taskHref,
}: {
  readonly busy: boolean;
  readonly canWrite: boolean;
  readonly contractHref?: string | undefined;
  /** The counterparty whose dossier this is; a save checks its contacts and case against it. */
  readonly counterpartyId: string;
  readonly counterpartyName: string;
  readonly dossier: TenantDossier | undefined;
  readonly leaseHref?: string | undefined;
  readonly newContactId: Effect.Effect<string, PlatformError.PlatformError>;
  /** Logs a call, e-mail, meeting or note in the timeline. */
  readonly onLog: DossierLog;
  /** Saves a contacts or case edit against the revision its draft builds on. */
  readonly onSave: DossierSave;
  /** Archives or restores the dossier: a command that stays explicit. */
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
          onSave={onSave}
          revision={revision}
        />
        <DossierCase
          canWrite={canWrite}
          contractHref={contractHref}
          counterpartyId={counterpartyId}
          counterpartyName={counterpartyName}
          dossier={dossier}
          leaseHref={leaseHref}
          onSave={onSave}
          revision={revision}
          taskHref={taskHref}
        />
        <DossierCommunication activityLabels={activityLabels} canWrite={canWrite} onSave={onLog} />
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
  directory,
  language,
  snapshot,
  unitName,
}: {
  readonly directory: readonly TenantDirectoryEntry[];
  readonly language: string;
  readonly snapshot: RecordsResponse;
  readonly unitName: (id: string) => string;
}) => {
  const { t } = useModernI18n();
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const leasesOf = (counterpartyId: string): readonly Occupancy[] =>
    snapshot.occupancies.filter((record) => record.customerCounterpartyRef?.resourceId === counterpartyId);
  const dossierOf = (counterpartyId: string) =>
    snapshot.tenantDossiers?.find((item) => item.counterpartyId === counterpartyId);
  // Every counterparty of the company: tenants, prospects with a dossier and firms entered in the registry.
  const dossierHref = (id: string) => `/${language}/najmy?counterpartyId=${id}#tenant`;
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
          <LinkButton href={`/${language}/prodej/zakaznici`} size="sm" theme="outlined" variant="secondary">
            Firemní registr zákazníků →
          </LinkButton>
        }
        title={t('property-leasing.dossier.directoryTitle')}
      >
        <p className="sp-tenant-muted">
          Najděte firmu nebo osobu podle názvu, IČO, e-mailu, telefonu nebo jména kontaktní osoby. Seznam obsahuje
          nájemce i firmy z registru zákazníků; nového zájemce založíte ve firemním registru zákazníků tlačítkem Nový
          zákazník.
        </p>
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
