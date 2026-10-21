import { DetailList, SectionCard } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Effect, type PlatformError } from 'effect';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { useState } from 'react';
import type { OccupancyCommand } from '../../../../../shared/actions/apply-command.ts';
import type { Occupancy, RecordsResponse, TenantContact, TenantDossier } from '../../../../../shared/apis/records.ts';
import { formatInstant, principalLabel } from './principal-labels.ts';
import { parseCrowns } from './lease-story.tsx';
import type { TenantDirectoryEntry } from './lease-story.tsx';
import './tenant-dossier.css';
import { contactCountLabel } from './contact-count.ts';

const caseLabels = {
  NEW: 'Nový',
  IN_PROGRESS: 'Řešený',
  CONFIRMED: 'Potvrzený',
  CLOSED: 'Uzavřený',
  CANCELLED: 'Zrušený',
} as const;
const activityLabels = {
  CALL: 'Hovor',
  EMAIL: 'E-mail',
  MEETING: 'Schůzka',
  NOTE: 'Poznámka',
  CASE: 'Změna případu',
  CONTACTS: 'Kontakty',
  ARCHIVE: 'Archivace',
} as const;
const fold = (value: string) =>
  value
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .toLowerCase();
type DossierCommand = Extract<OccupancyCommand, { readonly _tag: 'UpdateTenantDossier' }>;
export type DossierChanges = Omit<DossierCommand, '_tag' | 'occupancyRef'>;

/** Contacts and the case timeline belong to the tenant, not to one selected contract. */
export const TenantDossierCard = ({
  busy,
  canWrite,
  dossier,
  newContactId,
  onUpdate,
  counterpartyName,
  contractHref,
  leaseHref,
  taskHref,
}: {
  readonly busy: boolean;
  readonly canWrite: boolean;
  readonly dossier: TenantDossier | undefined;
  readonly newContactId: Effect.Effect<string, PlatformError.PlatformError>;
  readonly onUpdate: (changes: DossierChanges) => void;
  readonly counterpartyName: string;
  readonly contractHref?: string | undefined;
  readonly leaseHref?: string | undefined;
  readonly taskHref?: string | undefined;
}) => {
  const [contacts, setContacts] = useState<readonly TenantContact[]>(dossier?.contacts ?? []);
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<'CALL' | 'EMAIL' | 'MEETING' | 'NOTE'>('CALL');
  const [summary, setSummary] = useState('');
  const [caseState, setCaseState] = useState(dossier?.caseState ?? 'NEW');
  const [caseSubject, setCaseSubject] = useState(dossier?.caseDetails?.subject ?? '');
  const [caseOwner, setCaseOwner] = useState(dossier?.caseDetails?.owner ?? '');
  const [caseDeadline, setCaseDeadline] = useState(dossier?.caseDetails?.deadline ?? '');
  const [caseValue, setCaseValue] = useState(
    dossier?.caseDetails?.estimatedValueMinor == null ? '' : String(dossier.caseDetails.estimatedValueMinor / 100),
  );
  const estimatedValueMinor = caseValue.trim() === '' ? null : parseCrowns(caseValue);
  const update = onUpdate;
  const updateContact = (id: string, field: 'name' | 'role' | 'email' | 'phone', value: string) =>
    setContacts(contacts.map((contact) => (contact.id === id ? { ...contact, [field]: value } : contact)));
  return (
    <div className="sp-tenant" id="tenant">
      <SectionCard
        actions={
          <Badge size="sm" variant={dossier?.archived === true ? 'outline' : 'info'}>
            {dossier?.archived === true ? 'Archivovaná protistrana' : 'Evidence protistrany'}
          </Badge>
        }
        title="Kontaktní osoby a historie vztahu"
      >
        <p className="sp-tenant-muted">
          Kontakty, komunikace a stav obchodního případu této protistrany, sdílené napříč všemi jejími nájmy. Zápisy se
          ukládají s autorem a časem.
        </p>
        <div className="sp-tenant-heading">
          <h3>Kontaktní osoby</h3>
          {canWrite && (
            <Button disabled={busy} onClick={() => setEditing(!editing)} size="sm" theme="outlined" variant="secondary">
              {editing ? 'Zavřít úpravy' : contacts.length === 0 ? 'Přidat kontaktní osoby' : 'Upravit kontakty'}
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
                    value: contact.email !== '' ? <a href={`mailto:${contact.email}`}>{contact.email}</a> : 'Neuvedeno',
                  },
                  {
                    label: 'Telefon',
                    value: contact.phone !== '' ? <a href={`tel:${contact.phone}`}>{contact.phone}</a> : 'Neuvedeno',
                  },
                ]}
              />
            </div>
          ))}
        {editing && canWrite && (
          <div className="sp-tenant-stack">
            {contacts.map((contact, index) => (
              <fieldset className="sp-tenant-contact" key={contact.id}>
                <legend>Kontakt {index + 1}</legend>
                <div className="sp-tenant-fields">
                  <FormInput
                    label="Jméno a příjmení"
                    onChange={(event) => updateContact(contact.id, 'name', event.target.value)}
                    required
                    value={contact.name}
                  />
                  <FormInput
                    label="Role ve firmě"
                    onChange={(event) => updateContact(contact.id, 'role', event.target.value)}
                    value={contact.role}
                  />
                  <FormInput
                    label="E-mail kontaktu"
                    onChange={(event) => updateContact(contact.id, 'email', event.target.value)}
                    type="email"
                    value={contact.email}
                  />
                  <FormInput
                    label="Telefon kontaktu"
                    onChange={(event) => updateContact(contact.id, 'phone', event.target.value)}
                    type="tel"
                    value={contact.phone}
                  />
                </div>
                <Button
                  onClick={() => setContacts(contacts.filter((item) => item.id !== contact.id))}
                  size="sm"
                  theme="borderless"
                  variant="secondary"
                >
                  Odebrat kontakt
                </Button>
              </fieldset>
            ))}
            <div className="sp-tenant-actions">
              <Button
                disabled={contacts.length >= 50}
                onClick={() => {
                  void browserRuntime.runPromiseExit(
                    newContactId.pipe(
                      Effect.tap((id) =>
                        Effect.sync(() => setContacts([...contacts, { id, name: '', role: '', email: '', phone: '' }])),
                      ),
                    ),
                  );
                }}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                Přidat kontaktní osobu
              </Button>
              <Button
                disabled={
                  busy ||
                  contacts.some(
                    (contact) =>
                      contact.name.trim().length === 0 ||
                      (contact.email !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(contact.email)),
                  )
                }
                onClick={() => update({ contacts })}
                size="sm"
                variant="primary"
              >
                Uložit kontakty
              </Button>
            </div>
          </div>
        )}
        <div className="sp-tenant-contact">
          <h3>Obchodní případ</h3>
          <p className="sp-tenant-muted">Stav jednání nemění platnost smlouvy ani obsazenost jednotky.</p>
          {dossier?.caseDetails !== undefined && (
            <DetailList
              items={[
                { label: 'Předmět', value: dossier.caseDetails.subject },
                { label: 'Vlastník', value: dossier.caseDetails.owner },
                { label: 'Termín', value: dossier.caseDetails.deadline.split('-').reverse().join('. ') },
                {
                  label: 'Odhadovaná hodnota',
                  value:
                    dossier.caseDetails.estimatedValueMinor === null
                      ? 'Neuvedeno'
                      : `${(dossier.caseDetails.estimatedValueMinor / 100).toLocaleString('cs-CZ')} Kč`,
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
                  label="Předmět případu"
                  maxLength={500}
                  required
                  value={caseSubject}
                  onChange={(event) => setCaseSubject(event.target.value)}
                />
                <FormInput
                  label="Vlastník případu"
                  maxLength={500}
                  required
                  value={caseOwner}
                  onChange={(event) => setCaseOwner(event.target.value)}
                />
                <FormInput
                  label="Termín případu"
                  type="date"
                  required
                  value={caseDeadline}
                  onChange={(event) => setCaseDeadline(event.target.value)}
                />
                <FormInput
                  label="Odhadovaná hodnota (Kč, nepovinné)"
                  inputMode="decimal"
                  value={caseValue}
                  onChange={(event) => setCaseValue(event.target.value)}
                />
              </div>
              <div className="sp-tenant-actions">
                <label className="sp-tenant-stack">
                  <span>Stav případu</span>
                  <select
                    aria-label="Stav případu"
                    onChange={(event) => setCaseState(event.target.value as TenantDossier['caseState'])}
                    value={caseState}
                  >
                    {(Object.keys(caseLabels) as TenantDossier['caseState'][]).map((value) => (
                      <option key={value} value={value}>
                        {caseLabels[value]}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  disabled={busy || caseState === (dossier?.caseState ?? 'NEW')}
                  onClick={() => update({ caseState })}
                  size="sm"
                  theme="outlined"
                  variant="secondary"
                >
                  Uložit stav případu
                </Button>
              </div>
              <Button
                disabled={
                  busy ||
                  caseSubject.trim().length === 0 ||
                  caseOwner.trim().length === 0 ||
                  caseDeadline.length === 0 ||
                  estimatedValueMinor === undefined
                }
                onClick={() => {
                  if (estimatedValueMinor !== undefined)
                    update({
                      caseState,
                      caseDetails: {
                        subject: caseSubject.trim(),
                        owner: caseOwner.trim(),
                        deadline: caseDeadline,
                        estimatedValueMinor,
                      },
                    });
                }}
                size="sm"
                variant="primary"
              >
                Uložit případ
              </Button>
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
        {canWrite && (
          <div className="sp-tenant-contact">
            <h3>Zapsat komunikaci</h3>
            <div className="sp-tenant-fields">
              <label className="sp-tenant-stack">
                <span>Druh komunikace</span>
                <select
                  aria-label="Druh komunikace"
                  onChange={(event) => setKind(event.target.value as typeof kind)}
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
                label="Shrnutí komunikace"
                maxLength={500}
                onChange={(event) => setSummary(event.target.value)}
                placeholder="Například domluva termínu předání jednotky"
                value={summary}
              />
            </div>
            <Button
              disabled={busy || summary.trim().length === 0}
              onClick={() => update({ activity: { kind, summary } })}
              size="sm"
              variant="primary"
            >
              Uložit záznam komunikace
            </Button>
            <p className="sp-tenant-muted">Ruční evidence. E-mail ani SMS se touto akcí neodesílá.</p>
          </div>
        )}
        <h3>Časová osa</h3>
        {(dossier?.history ?? []).toReversed().map((entry, index) => (
          <article className="sp-tenant-event" key={`${entry.occurredAt}:${index}`}>
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
              onClick={() => update({ archived: dossier?.archived !== true })}
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
  readonly partyType: 'ORGANIZATION' | 'PERSON';
  readonly displayName: string;
  readonly companyId: string;
  readonly email: string;
  readonly phone: string;
  readonly note: string;
}
type NewCounterpartyErrors = Partial<Record<'displayName' | 'companyId' | 'email' | 'phone' | 'note', string>>;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const phonePattern = /^\+?[0-9 ]{9,20}$/u;
/** Czech inline validation of the new counterparty form (rules 3.8 and 3.9). */
export const validateNewCounterparty = (input: NewCounterpartyInput): NewCounterpartyErrors => ({
  ...(input.displayName.trim().length === 0
    ? { displayName: input.partyType === 'PERSON' ? 'Vyplňte jméno a příjmení.' : 'Vyplňte název firmy.' }
    : input.displayName.trim().length > 300
      ? { displayName: 'Název může mít nejvýše 300 znaků.' }
      : {}),
  ...(input.partyType === 'ORGANIZATION' && input.companyId.trim() !== '' && !/^\d{8}$/u.test(input.companyId.trim())
    ? { companyId: 'IČO musí mít přesně 8 číslic.' }
    : {}),
  ...(input.email.trim() !== '' && !emailPattern.test(input.email.trim())
    ? { email: 'Zadejte e-mail ve tvaru jmeno@firma.cz.' }
    : {}),
  ...(input.phone.trim() !== '' && !phonePattern.test(input.phone.trim())
    ? { phone: 'Zadejte telefon, například +420 777 123 456.' }
    : {}),
  ...(input.note.length > 500 ? { note: 'Poznámka může mít nejvýše 500 znaků.' } : {}),
});
const emptyCounterparty: NewCounterpartyInput = {
  partyType: 'ORGANIZATION',
  displayName: '',
  companyId: '',
  email: '',
  phone: '',
  note: '',
};

const NewCounterpartyForm = ({
  busy,
  error,
  onCancel,
  onCreate,
}: {
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly onCancel: () => void;
  readonly onCreate: (input: NewCounterpartyInput) => void;
}) => {
  const [input, setInput] = useState<NewCounterpartyInput>(emptyCounterparty);
  const [submitted, setSubmitted] = useState(false);
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
        if (Object.keys(validateNewCounterparty(input)).length === 0) onCreate(input);
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
            onChange={() => setInput({ ...input, partyType: 'PERSON', companyId: '' })}
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
          {...(errors.displayName === undefined ? {} : { validateStatus: 'error', helpText: errors.displayName })}
        />
        {!person && (
          <FormInput
            id="counterparty-ico"
            inputMode="numeric"
            label="IČO (nepovinné)"
            onChange={(event) => set('companyId', event.target.value)}
            value={input.companyId}
            {...(errors.companyId === undefined ? {} : { validateStatus: 'error', helpText: errors.companyId })}
          />
        )}
        <FormInput
          id="counterparty-email"
          label="E-mail (nepovinné)"
          onChange={(event) => set('email', event.target.value)}
          type="email"
          value={input.email}
          {...(errors.email === undefined ? {} : { validateStatus: 'error', helpText: errors.email })}
        />
        <FormInput
          id="counterparty-phone"
          label="Telefon (nepovinné)"
          onChange={(event) => set('phone', event.target.value)}
          type="tel"
          value={input.phone}
          {...(errors.phone === undefined ? {} : { validateStatus: 'error', helpText: errors.phone })}
        />
      </div>
      <FormInput
        id="counterparty-note"
        label="Poznámka do časové osy (nepovinné)"
        maxLength={500}
        onChange={(event) => set('note', event.target.value)}
        placeholder="Například první kontakt na veletrhu, zájem o kancelář od jara"
        value={input.note}
        {...(errors.note === undefined ? {} : { validateStatus: 'error', helpText: errors.note })}
      />
      {error !== undefined && (
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
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const leasesOf = (counterpartyId: string): readonly Occupancy[] =>
    snapshot.occupancies.filter((record) => record.customerCounterpartyRef?.resourceId === counterpartyId);
  const dossierOf = (counterpartyId: string) =>
    snapshot.tenantDossiers?.find((item) => item.counterpartyId === counterpartyId);
  // Tenants and prospects: every customer with a lease or with a dossier (contacts, notes, case).
  const relevant = directory.filter(
    (entry) =>
      leasesOf(entry.counterpartyRef.resourceId).length > 0 ||
      dossierOf(entry.counterpartyRef.resourceId) !== undefined,
  );
  const visible = relevant.filter((entry) => {
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
        title="Nájemci, zájemci a kontaktní osoby"
      >
        <p className="sp-tenant-muted">
          Najděte firmu nebo osobu podle názvu, IČO, e-mailu, telefonu nebo jména kontaktní osoby. Zájemce bez nájmu
          založíte tlačítkem Nová protistrana.
        </p>
        {creating && (
          <NewCounterpartyForm
            busy={busy}
            error={createError}
            onCancel={() => setCreating(false)}
            onCreate={onCreate}
          />
        )}
        <FormInput
          label="Hledat protistranu nebo kontakt"
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
            return (
              <a
                className="sp-tenant-contact"
                href={`/${language}/siampark/occupancy?counterpartyId=${id}#tenant`}
                key={id}
              >
                <div className="sp-tenant-heading">
                  <strong>{entry.displayName ?? 'Protistrana'}</strong>
                  <Badge size="sm" variant={dossier?.archived === true ? 'outline' : 'info'}>
                    {dossier?.archived === true ? 'Archivováno' : caseLabels[dossier?.caseState ?? 'NEW']}
                  </Badge>
                </div>
                <span className="sp-tenant-muted">
                  {leases.length === 0
                    ? 'Zájemce bez nájmu'
                    : [...new Set(leases.map((record) => unitName(record.unitRef.resourceId)))].join(', ')}{' '}
                  · {contactCountLabel(dossier?.contacts.length ?? 0)}
                </span>
                <span className="sp-tenant-muted">
                  {entry.email ?? 'E-mail neuveden'} · {entry.phone ?? 'Telefon neuveden'}
                </span>
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
