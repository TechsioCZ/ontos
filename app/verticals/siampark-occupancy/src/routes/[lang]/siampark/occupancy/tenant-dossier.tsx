import { DetailList, SectionCard } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { DateTime, Effect, type PlatformError } from 'effect';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { useState } from 'react';
import type { OccupancyCommand } from '../../../../../shared/actions/apply-command.ts';
import type { Occupancy, RecordsResponse, TenantContact, TenantDossier } from '../../../../../shared/apis/records.ts';
import { parseCrowns } from './lease-story.tsx';
import type { TenantDirectoryEntry } from './lease-story.tsx';
import './tenant-dossier.css';

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
const authorLabel = (id: string) =>
  ({
    '72000000-0000-4000-8000-000000000021': 'Vedení Siampark',
    '72000000-0000-4000-8000-000000000022': 'Provoz Siampark',
    '72000000-0000-4000-8000-000000000023': 'Účetní Siampark',
  })[id] ?? 'Pověřený uživatel';
const time = new Intl.DateTimeFormat('cs-CZ', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Prague' });
const fold = (value: string) =>
  value
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .toLowerCase();
type DossierCommand = Extract<OccupancyCommand, { readonly _tag: 'UpdateTenantDossier' }>;

/** Contacts and the case timeline belong to the tenant, not to one selected contract. */
export const TenantDossierCard = ({
  busy,
  dossier,
  language,
  newContactId,
  onCommand,
  record,
  counterpartyName,
  contractHref,
  taskHref,
}: {
  readonly busy: boolean;
  readonly dossier: TenantDossier | undefined;
  readonly language: string;
  readonly newContactId: Effect.Effect<string, PlatformError.PlatformError>;
  readonly onCommand: (command: OccupancyCommand) => void;
  readonly record: Occupancy;
  readonly counterpartyName: string;
  readonly contractHref?: string | undefined;
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
  const update = (changes: Omit<DossierCommand, '_tag' | 'occupancyRef'>) =>
    onCommand({ _tag: 'UpdateTenantDossier', occupancyRef: record.occupancyRef, ...changes });
  const updateContact = (id: string, field: 'name' | 'role' | 'email' | 'phone', value: string) =>
    setContacts(contacts.map((contact) => (contact.id === id ? { ...contact, [field]: value } : contact)));
  return (
    <div className="sp-tenant" id="tenant">
      <SectionCard
        actions={
          <Badge size="sm" variant={dossier?.archived === true ? 'outline' : 'info'}>
            {dossier?.archived === true ? 'Archivovaný nájemce' : 'Evidence nájemce'}
          </Badge>
        }
        title="Kontaktní osoby a historie vztahu"
      >
        <p className="sp-tenant-muted">
          Kontakty, komunikace a stav případu sdílené napříč nájmy této firmy. Zápisy se ukládají s autorem a časem.
        </p>
        <div className="sp-tenant-heading">
          <h3>Kontaktní osoby</h3>
          <Button disabled={busy} onClick={() => setEditing(!editing)} size="sm" theme="outlined" variant="secondary">
            {editing ? 'Zavřít úpravy' : 'Upravit kontakty'}
          </Button>
        </div>
        {!editing && contacts.length === 0 && (
          <p className="sp-tenant-muted">
            Kontaktní osoby zatím nejsou doplněny. Hlavní e-mail a telefon najdete v kartě nájemce výše.
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
        {editing && (
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
          <h3>Obchodní případ · nájemní vztah</h3>
          <p className="sp-tenant-muted">Stav jednání nemění platnost smlouvy ani obsazenost jednotky.</p>
          <DetailList items={[{ label: 'Protistrana případu', value: counterpartyName }]} />
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
          <LinkButton
            href={`/${language}/siampark/occupancy?resourceId=${record.occupancyRef.resourceId}`}
            size="sm"
            theme="borderless"
            variant="secondary"
          >
            Otevřít nájem a související smlouvu →
          </LinkButton>
        </div>
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
        <h3>Časová osa</h3>
        {(dossier?.history ?? []).toReversed().map((entry, index) => (
          <article className="sp-tenant-event" key={`${entry.occurredAt}:${index}`}>
            <div className="sp-tenant-heading">
              <Badge size="sm" variant="outline">
                {activityLabels[entry.kind]}
              </Badge>
              <span className="sp-tenant-muted">
                {authorLabel(entry.authorPrincipalId)} ·{' '}
                {time.format(DateTime.toEpochMillis(DateTime.makeUnsafe(entry.occurredAt)))}
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
            Archivace skryje nájemce pouze z běžného přehledu kontaktů. Platné smlouvy, nájmy i historie zůstávají
            zachovány.
          </p>
          <Button
            disabled={busy}
            onClick={() => update({ archived: dossier?.archived !== true })}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {dossier?.archived === true ? 'Obnovit evidenci nájemce' : 'Archivovat evidenci nájemce'}
          </Button>
        </div>
      </SectionCard>
    </div>
  );
};

export const TenantDirectory = ({
  language,
  snapshot,
  tenantOf,
  unitName,
}: {
  readonly language: string;
  readonly snapshot: RecordsResponse;
  readonly tenantOf: (record: Occupancy | undefined) => TenantDirectoryEntry | undefined;
  readonly unitName: (id: string) => string;
}) => {
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const unique = snapshot.occupancies.filter(
    (record, index, all) =>
      record.customerCounterpartyRef !== null &&
      all.findIndex(
        (other) => other.customerCounterpartyRef?.resourceId === record.customerCounterpartyRef?.resourceId,
      ) === index,
  );
  const visible = unique.filter((record) => {
    const dossier = snapshot.tenantDossiers?.find(
      (item) => item.counterpartyId === record.customerCounterpartyRef?.resourceId,
    );
    const tenant = tenantOf(record);
    return (
      (archived || dossier?.archived !== true) &&
      fold(
        [
          tenant?.displayName,
          tenant?.email,
          tenant?.phone,
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
        title="Nájemci a kontaktní osoby"
      >
        <p className="sp-tenant-muted">
          Najděte firmu podle názvu, e-mailu, telefonu nebo jména kontaktní osoby. Novou firmu založíte ve firemním
          registru a přiřadíte k nájmu.
        </p>
        <FormInput
          label="Hledat nájemce nebo kontakt"
          onChange={(event) => setQuery(event.target.value)}
          type="search"
          value={query}
        />
        <label className="sp-tenant-muted">
          <input checked={archived} onChange={(event) => setArchived(event.target.checked)} type="checkbox" /> Zahrnout
          archivovanou evidenci nájemců
        </label>
        <div className="sp-tenant-directory">
          {visible.map((record) => {
            const dossier = snapshot.tenantDossiers?.find(
              (item) => item.counterpartyId === record.customerCounterpartyRef?.resourceId,
            );
            const tenant = tenantOf(record);
            return (
              <a
                className="sp-tenant-contact"
                href={`/${language}/siampark/occupancy?resourceId=${record.occupancyRef.resourceId}#tenant`}
                key={record.occupancyRef.resourceId}
              >
                <div className="sp-tenant-heading">
                  <strong>{tenant?.displayName ?? 'Nájemce'}</strong>
                  <Badge size="sm" variant={dossier?.archived === true ? 'outline' : 'info'}>
                    {dossier?.archived === true ? 'Archivováno' : caseLabels[dossier?.caseState ?? 'NEW']}
                  </Badge>
                </div>
                <span className="sp-tenant-muted">
                  {unitName(record.unitRef.resourceId)} · {dossier?.contacts.length ?? 0} kontaktních osob
                </span>
                <span className="sp-tenant-muted">
                  {tenant?.email ?? 'E-mail neuveden'} · {tenant?.phone ?? 'Telefon neuveden'}
                </span>
                <span className="sp-tenant-muted">Kontakty, historie a smlouvy →</span>
              </a>
            );
          })}
        </div>
        {visible.length === 0 && <p className="sp-tenant-muted">Žádní nájemci neodpovídají zadanému filtru.</p>}
      </SectionCard>
    </section>
  );
};
