import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import {
  DetailList,
  SaveBar,
  SectionCard,
  UnsavedChangesDialog,
  requiredLabelFor,
  saveLabelsFor,
  useRecordDraft,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import {
  CheckboxField,
  CheckedTextField,
  ChoiceField,
  Field,
  FormBuilder,
  FormReact,
  FormRoot,
  TextField,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import type { RevisionedSaveResult } from '@app/admin-ui';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { Effect, Option, Predicate, Schema } from 'effect';
import type { PlatformError } from 'effect';
import { Atom } from 'effect/reactivity';
import { browserAtomRuntime, browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { useEffect, useRef, useState } from 'react';
import type { Feedback } from '../../../../shared/actions/apply-command.ts';
import type { Occupancy, RecordsResponse, TenantContact, TenantDossier } from '../../../../shared/apis/records.ts';
import {
  dossierActionsClass,
  dossierEventClass,
  dossierFieldsClass,
  dossierHeadingClass,
  dossierMutedClass,
  dossierSectionClass,
  dossierStackClass,
  dossierTileClass,
  dossierTitleClass,
  plainLinkClass,
} from './dossier-classes.ts';
import { formatInstant, principalLabel } from './principal-labels.ts';
import type { TenantDirectoryEntry } from './lease-story.tsx';
import { timelineEntries } from './timeline-entries.ts';
import { TenantCaseStateSchema } from '../../../../shared/apis/records.ts';
import { contactCountLabel } from './contact-count.ts';
import { FormReady, useDraftFields } from './draft-fields.ts';
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

/**
 * The Save button of a dossier section: one save against the revision its draft builds on; `onReason` hears why it
 * failed (None otherwise), for the section's Save bar.
 */
export type DossierSave = (
  changes: DossierChanges,
  expectedRevision: number,
  unchanged: UnchangedSince,
  onReason: (reason: Option.Option<Feedback>) => void,
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
  /** Why the last save failed, for the Save bar; None after any other outcome. */
  const [reason, setReason] = useState(() => Option.none<Feedback>());
  const rememberSaved = (value: V, result: RevisionedSaveResult) => {
    if (Predicate.isNumber(result) || result === 'saved') {
      base.current = value;
    }
  };
  const send = (value: V, expectedRevision: number, changes: DossierChanges) =>
    onSave(changes, expectedRevision, unchangedSince(base.current), setReason).pipe(
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
  return { guard, reason, record };
};

/** Error props for a field, spread so they are absent (not undefined) when the field is valid. */
const invalidField = (invalid: boolean, message: string) => (invalid ? { helpText: message, invalid: true } : {});

const emptyContact = (id: string): TenantContact => ({ email: '', id, name: '', phone: '', role: '' });
const caseFieldRequiredKey = 'property-leasing.dossier.caseFieldRequired';

interface ContactsSectionProps extends DossierDraftProps {
  readonly canWrite: boolean;
  readonly newContactId: Effect.Effect<string, PlatformError.PlatformError>;
}
const noContacts: readonly TenantContact[] = [];

/**
 * The contact people of one dossier as its section edits them; every dossier on screen has its own. Only the section's
 * Uložit sends them, so Enter submits nothing.
 */
const contactsFormOf = Atom.family((_counterpartyId: string) =>
  FormReact.make(
    FormBuilder.empty.addField(
      Field.makeArrayField(
        'contacts',
        Schema.Struct({
          email: Schema.String,
          id: Schema.String,
          name: Schema.String,
          phone: Schema.String,
          role: Schema.String,
        }),
      ),
    ),
    {
      fields: {
        contacts: {
          email: CheckedTextField,
          id: TextField,
          name: CheckedTextField,
          phone: TextField,
          role: TextField,
        },
      },
      onSubmit: () => Effect.void,
      runtime: browserAtomRuntime,
    },
  ),
);
const contactsOf = (values: { readonly contacts: readonly TenantContact[] }): readonly TenantContact[] =>
  values.contacts;
const contactValuesOf = (contacts: readonly TenantContact[]) => ({ contacts });
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
  const { guard, reason, record } = useDossierDraft({
    changesOf: (contacts: readonly TenantContact[]) =>
      validContacts(contacts) ? Option.some({ contacts: trimmedContacts(contacts) }) : Option.none(),
    equals: sameContacts,
    onSave,
    revision,
    server: dossier?.contacts ?? noContacts,
    unchangedSince: (base) => contactsUnchangedSince(counterpartyId, base),
  });
  const contacts = record.draft;
  const contactsForm = contactsFormOf(counterpartyId);
  useDraftFields({
    draft: contacts,
    form: contactsForm,
    setDraft: record.setDraft,
    toDraft: contactsOf,
    toValues: contactValuesOf,
  });
  const [editing, setEditing] = useState(false);
  /** Adds an empty contact under a fresh id. */
  const addContact = (append: (contact: TenantContact) => void) => {
    void browserRuntime.runPromiseExit(
      newContactId.pipe(Effect.tap((id) => Effect.sync(() => append(emptyContact(id))))),
    );
  };
  const editLabel = contacts.length === 0 ? 'Přidat kontaktní osoby' : 'Upravit kontakty';
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
      <div className={dossierHeadingClass}>
        <h3 className={dossierTitleClass}>Kontaktní osoby</h3>
        {canWrite && (
          <Button appearance="outline" onClick={toggleEditing} severity="secondary" size="sm">
            {editing ? 'Zavřít úpravy' : editLabel}
          </Button>
        )}
      </div>
      {!editing && contacts.length === 0 && (
        <p className={dossierMutedClass}>
          Kontaktní osoby zatím nejsou doplněny. Hlavní e-mail a telefon protistrany najdete v kartě výše.
        </p>
      )}
      {!editing &&
        contacts.map((contact) => (
          <div className={dossierTileClass} key={contact.id}>
            <strong>{contact.name}</strong>
            <DetailList
              items={[
                { label: 'Role ve firmě', value: contact.role || 'Neuvedeno' },
                {
                  label: 'E-mail',
                  value:
                    contact.email === '' ? (
                      'Neuvedeno'
                    ) : (
                      <Link className={plainLinkClass} href={`mailto:${contact.email}`} size="current">
                        {contact.email}
                      </Link>
                    ),
                },
                {
                  label: 'Telefon',
                  value:
                    contact.phone === '' ? (
                      'Neuvedeno'
                    ) : (
                      <Link className={plainLinkClass} href={`tel:${contact.phone}`} size="current">
                        {contact.phone}
                      </Link>
                    ),
                },
              ]}
            />
          </div>
        ))}
      {editing && canWrite && (
        <FormRoot
          className={dossierStackClass}
          defaultValues={contactValuesOf(contacts)}
          form={contactsForm}
          translateMessage={(message) => t(message)}
        >
          <contactsForm.contacts>
            {({ append, items, remove }) => (
              <>
                {items.map((contact, index) => {
                  const problems = contactProblems(contact);
                  return (
                    <contactsForm.contacts.Item index={index} key={contact.id}>
                      <fieldset className={dossierTileClass}>
                        <legend>Kontakt {index + 1}</legend>
                        <div className={dossierFieldsClass}>
                          <contactsForm.contacts.name
                            label={t('property-leasing.registration.fullName')}
                            required
                            requiredLabel={requiredLabelFor(language)}
                            {...invalidField(problems.name, t('property-leasing.dossier.contactNameRequired'))}
                          />
                          <contactsForm.contacts.role label={t('property-leasing.dossier.contactRole')} />
                          <contactsForm.contacts.email
                            label={t('property-leasing.dossier.contactEmail')}
                            type="email"
                            {...invalidField(problems.email, t('property-leasing.dossier.contactEmailInvalid'))}
                          />
                          <contactsForm.contacts.phone label={t('property-leasing.dossier.contactPhone')} type="tel" />
                        </div>
                        <Button appearance="ghost" onClick={() => remove(index)} severity="secondary" size="sm">
                          Odebrat kontakt
                        </Button>
                      </fieldset>
                    </contactsForm.contacts.Item>
                  );
                })}
                <div className={dossierActionsClass}>
                  <Button
                    appearance="outline"
                    disabled={items.length >= 50}
                    onClick={() => addContact(append)}
                    severity="secondary"
                    size="sm"
                  >
                    Přidat kontaktní osobu
                  </Button>
                </div>
              </>
            )}
          </contactsForm.contacts>
        </FormRoot>
      )}
      {canWrite && (
        <SaveBar
          error={Option.match(reason, {
            onNone: () => null,
            onSome: (value) => t(`property-leasing.demo.feedback.${value}`),
          })}
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

const caseStates = ['NEW', 'IN_PROGRESS', 'CONFIRMED', 'CLOSED', 'CANCELLED'] as const;
const caseStateItems = caseStates.map((value) => ({ label: caseLabels[value], value }));

/** The business case of one dossier as its section edits it. Only the section's Uložit sends it. */
const caseFormOf = Atom.family((_counterpartyId: string) =>
  FormReact.make(
    FormBuilder.empty
      .addField('deadline', Schema.String)
      .addField('owner', Schema.String)
      .addField('state', Schema.String)
      .addField('subject', Schema.String)
      .addField('value', Schema.String),
    {
      fields: {
        deadline: CheckedTextField,
        owner: CheckedTextField,
        state: ChoiceField,
        subject: CheckedTextField,
        value: CheckedTextField,
      },
      onSubmit: () => Effect.void,
      runtime: browserAtomRuntime,
    },
  ),
);
interface CaseValues {
  readonly deadline: string;
  readonly owner: string;
  readonly state: string;
  readonly subject: string;
  readonly value: string;
}
const caseValuesOf = (draft: CaseDraft): CaseValues => ({
  deadline: draft.deadline,
  owner: draft.owner,
  state: draft.state,
  subject: draft.subject,
  value: draft.value,
});
/** The picker offers only the case states, so its value is always one. */
const caseDraftOfValues = (values: CaseValues): CaseDraft => ({
  deadline: values.deadline,
  owner: values.owner,
  state: Option.getOrElse(Schema.decodeUnknownOption(TenantCaseStateSchema)(values.state), () => 'NEW' as const),
  subject: values.subject,
  value: values.value,
});

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
  const { guard, reason, record } = useDossierDraft({
    changesOf: (draft: CaseDraft) => caseChangesOf(draft, dossier),
    equals: sameCaseDraft,
    onSave,
    revision,
    server: caseDraftOf(dossier),
    unchangedSince: (base) => caseUnchangedSince(counterpartyId, base),
  });
  const { draft } = record;
  const caseForm = caseFormOf(counterpartyId);
  useDraftFields({
    draft,
    form: caseForm,
    setDraft: record.setDraft,
    toDraft: caseDraftOfValues,
    toValues: caseValuesOf,
  });
  const problems = caseProblems(draft, dossier);
  const required = { required: true, requiredLabel: requiredLabelFor(language) };
  const handleSave = record.save;
  const handleReloadLatest = record.reloadLatest;
  return (
    <div className={dossierTileClass}>
      <h3 className={dossierTitleClass}>Obchodní případ</h3>
      <p className={dossierMutedClass}>Stav jednání nemění platnost smlouvy ani obsazenost jednotky.</p>
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
        <FormRoot
          className={dossierStackClass}
          defaultValues={caseValuesOf(draft)}
          form={caseForm}
          translateMessage={(message) => t(message)}
        >
          <div className={dossierFieldsClass}>
            <caseForm.subject
              label={t('property-leasing.dossier.caseSubject')}
              maxLength={500}
              {...required}
              {...invalidField(problems.subject, t(caseFieldRequiredKey))}
            />
            <caseForm.owner
              label={t('property-leasing.dossier.caseOwner')}
              maxLength={500}
              {...required}
              {...invalidField(problems.owner, t(caseFieldRequiredKey))}
            />
            <caseForm.deadline
              label={t('property-leasing.dossier.caseDeadline')}
              type="date"
              {...required}
              {...invalidField(problems.deadline, t(caseFieldRequiredKey))}
            />
            <caseForm.value
              inputMode="decimal"
              label={t('property-leasing.dossier.optionalCaseValue')}
              {...invalidField(problems.value, t('property-leasing.rent.invalidAmount'))}
            />
          </div>
          <div className={dossierActionsClass}>
            <caseForm.state items={caseStateItems} label={t('property-leasing.dossier.caseState')} />
          </div>
          <SaveBar
            error={Option.match(reason, {
              onNone: () => null,
              onSome: (value) => t(`property-leasing.demo.feedback.${value}`),
            })}
            labels={labels}
            onReloadLatest={handleReloadLatest}
            onSave={handleSave}
            size="sm"
            status={record.status}
          />
        </FormRoot>
      )}
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
      <div className={dossierActionsClass}>
        {contractHref !== undefined && (
          <LinkButton appearance="ghost" href={contractHref} severity="secondary" size="sm">
            Otevřít smlouvu případu →
          </LinkButton>
        )}
        {taskHref !== undefined && (
          <LinkButton appearance="ghost" href={taskHref} severity="secondary" size="sm">
            Otevřít úkol případu →
          </LinkButton>
        )}
      </div>
      {leaseHref !== undefined && (
        <LinkButton appearance="ghost" href={leaseHref} severity="secondary" size="sm">
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
    <div className={dossierSectionClass} id="tenant">
      <SectionCard
        actions={
          <Badge severity={dossier?.archived === true ? 'neutral' : 'info'} size="sm">
            {dossier?.archived === true ? 'Archivovaná protistrana' : 'Evidence protistrany'}
          </Badge>
        }
        title={t('property-leasing.dossier.title')}
      >
        <p className={dossierMutedClass}>
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
        <h3 className={dossierTitleClass}>Časová osa</h3>
        {timelineEntries(dossier?.history ?? []).map(({ entry, key }) => (
          <article className={dossierEventClass} key={key}>
            <div className={dossierHeadingClass}>
              <Badge appearance="outline" severity="neutral" size="sm">
                {activityLabels[entry.kind]}
              </Badge>
              <span className={dossierMutedClass}>
                {principalLabel(entry.authorPrincipalId)} · {formatInstant(entry.occurredAt)}
              </span>
            </div>
            <p>{entry.summary}</p>
          </article>
        ))}
        {(dossier?.history.length ?? 0) === 0 && (
          <p className={dossierMutedClass}>
            Zatím bez záznamů. První hovor, poznámka nebo změna případu se zobrazí zde.
          </p>
        )}
        <div className={dossierHeadingClass}>
          <p className={dossierMutedClass}>
            Archivace skryje protistranu pouze z běžného přehledu kontaktů. Platné smlouvy, nájmy i historie zůstávají
            zachovány.
          </p>
          {canWrite && (
            <Button
              appearance="outline"
              disabled={busy}
              onClick={() => onUpdate({ archived: dossier?.archived !== true })}
              severity="secondary"
              size="sm"
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

/** The search box and the archive switch of the directory: both filter the list at once, nothing is submitted. */
const directoryFilterForm = FormReact.make(
  FormBuilder.empty.addField('archived', Schema.Boolean).addField('query', Schema.String),
  {
    fields: { archived: CheckboxField, query: TextField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
const noDirectoryFilter = { archived: false, query: '' };

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
  const [ready, setReady] = useState(false);
  const filter = Option.getOrElse(
    Option.filter(useAtomValue(directoryFilterForm.values), () => ready),
    () => noDirectoryFilter,
  );
  const { archived, query } = filter;
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
    <section className={dossierSectionClass} id="tenants">
      <SectionCard
        actions={
          <LinkButton appearance="outline" href={`/${language}/prodej/zakaznici`} severity="secondary" size="sm">
            Firemní registr zákazníků →
          </LinkButton>
        }
        title={t('property-leasing.dossier.directoryTitle')}
      >
        <p className={dossierMutedClass}>
          Najděte firmu nebo osobu podle názvu, IČO, e-mailu, telefonu nebo jména kontaktní osoby. Seznam obsahuje
          nájemce i firmy z registru zákazníků; nového zájemce založíte ve firemním registru zákazníků tlačítkem Nový
          zákazník.
        </p>
        <FormRoot
          className={dossierStackClass}
          defaultValues={noDirectoryFilter}
          form={directoryFilterForm}
          translateMessage={(message) => t(message)}
        >
          <FormReady onReady={setReady} />
          <directoryFilterForm.query label={t('property-leasing.dossier.search')} type="search" />
          <directoryFilterForm.archived label="Zahrnout archivovanou evidenci" />
        </FormRoot>
        <div className={dossierFieldsClass}>
          {visible.map((entry) => {
            const id = entry.counterpartyRef.resourceId;
            const dossier = dossierOf(id);
            const leases = leasesOf(id);
            const contactDetails = [entry.email, entry.phone]
              .filter((value) => value !== null && value !== undefined && value !== '')
              .join(' · ');
            return (
              <Link className={`${dossierTileClass} ${plainLinkClass}`} href={dossierHref(id)} key={id} size="current">
                <div className={dossierHeadingClass}>
                  <strong>{entry.displayName ?? 'Protistrana'}</strong>
                  <Badge severity={dossier?.archived === true ? 'neutral' : 'info'} size="sm">
                    {dossier?.archived === true ? 'Archivováno' : caseLabels[dossier?.caseState ?? 'NEW']}
                  </Badge>
                </div>
                <span className={dossierMutedClass}>
                  {relationshipLabel(leases, dossier, unitName)} · {contactCountLabel(dossier?.contacts.length ?? 0)}
                </span>
                {contactDetails.length > 0 && <span className={dossierMutedClass}>{contactDetails}</span>}
                <span className={dossierMutedClass}>Kontakty, historie a obchodní případ →</span>
              </Link>
            );
          })}
        </div>
        {visible.length === 0 && <p className={dossierMutedClass}>Žádné protistrany neodpovídají zadanému filtru.</p>}
      </SectionCard>
    </section>
  );
};
