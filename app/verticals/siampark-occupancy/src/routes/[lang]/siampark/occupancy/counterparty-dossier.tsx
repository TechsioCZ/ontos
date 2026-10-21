import { DetailList, PageHeader, SectionCard, formatDate } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import type { Effect, PlatformError } from 'effect';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { TenantDirectoryEntry } from './lease-story.tsx';
import { TenantDossierCard } from './tenant-dossier.tsx';
import type { DossierChanges } from './tenant-dossier.tsx';

const stateLabels = {
  DRAFT: 'Návrh',
  CONFIRMED: 'Potvrzeno',
  ACTIVE: 'Aktivní',
  COMPLETED: 'Dokončeno',
  CANCELLED: 'Zrušeno',
} as const;

/** S01: contacts, timeline and business case of one counterparty, with or without a lease. */
export const CounterpartyDossierView = ({
  busy,
  canWrite,
  counterpartyId,
  directoryLoaded,
  entry,
  feedbackText,
  language,
  newContactId,
  onUpdate,
  snapshot,
  unitName,
}: {
  readonly busy: boolean;
  readonly canWrite: boolean;
  readonly counterpartyId: string;
  readonly directoryLoaded: boolean;
  readonly entry: TenantDirectoryEntry | undefined;
  readonly feedbackText: string | undefined;
  readonly language: string;
  readonly newContactId: Effect.Effect<string, PlatformError.PlatformError>;
  readonly onUpdate: (changes: DossierChanges) => void;
  readonly snapshot: RecordsResponse | undefined;
  readonly unitName: (id: string) => string;
}) => {
  const leases = snapshot?.occupancies.filter(
    (record) => record.customerCounterpartyRef?.resourceId === counterpartyId,
  );
  const dossier = snapshot?.tenantDossiers?.find((item) => item.counterpartyId === counterpartyId);
  const name = entry?.displayName ?? (directoryLoaded ? 'Protistrana' : 'Načítání…');
  return (
    <>
      <div>
        <LinkButton
          href={`/${language}/siampark/occupancy#tenants`}
          icon="icon-[mdi--arrow-left]"
          size="sm"
          theme="borderless"
          variant="secondary"
        >
          Zpět na nájemce a zájemce
        </LinkButton>
      </div>
      <PageHeader
        description={
          leases === undefined || leases.length === 0 ? 'Zájemce bez nájmu' : `Nájmy a pobyty: ${leases.length}`
        }
        meta={
          entry?.status === 'ARCHIVED' ? (
            <Badge size="sm" variant="outline">
              Archivováno v registru
            </Badge>
          ) : undefined
        }
        title={name}
      />
      {feedbackText !== undefined && <output aria-live="polite">{feedbackText}</output>}
      {directoryLoaded && entry === undefined && (
        <p className="siamparkoccupancy:text-sm siamparkoccupancy:text-(--color-fg-secondary)">
          Protistrana není v registru této společnosti nebo k ní nemáte oprávnění.
        </p>
      )}
      {entry !== undefined && (
        <div className="siamparkoccupancy:grid siamparkoccupancy:grid-cols-1 siamparkoccupancy:items-start siamparkoccupancy:gap-6 siamparkoccupancy:xl:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="siamparkoccupancy:min-w-0 siamparkoccupancy:space-y-6">
            {snapshot !== undefined && (
              <TenantDossierCard
                busy={busy}
                canWrite={canWrite}
                counterpartyName={name}
                dossier={dossier}
                key={`counterparty:${snapshot.revision}`}
                newContactId={newContactId}
                onUpdate={onUpdate}
              />
            )}
          </div>
          <div className="siamparkoccupancy:min-w-0 siamparkoccupancy:space-y-6">
            <SectionCard title="Údaje protistrany">
              <DetailList
                items={[
                  { label: 'Název / jméno', value: name },
                  { label: 'IČO', value: entry.companyId ?? 'neuvedeno' },
                  {
                    label: 'E-mail',
                    value: entry.email === null ? 'neuvedeno' : <a href={`mailto:${entry.email}`}>{entry.email}</a>,
                  },
                  {
                    label: 'Telefon',
                    value: entry.phone === null ? 'neuvedeno' : <a href={`tel:${entry.phone}`}>{entry.phone}</a>,
                  },
                  { label: 'V registru od', value: formatDate(entry.createdAt.slice(0, 10)) },
                ]}
              />
              <LinkButton href={`/${language}/prodej/zakaznici`} size="sm" theme="borderless" variant="secondary">
                Otevřít v registru zákazníků →
              </LinkButton>
            </SectionCard>
            <SectionCard title="Nájmy a pobyty">
              {leases === undefined || leases.length === 0 ? (
                <p className="siamparkoccupancy:text-sm siamparkoccupancy:text-(--color-fg-secondary)">
                  Zatím bez nájmu. Až bude dohodnut, založte ho tlačítkem Nový nájem v přehledu nájmů.
                </p>
              ) : (
                <ul className="siamparkoccupancy:space-y-2 siamparkoccupancy:text-sm">
                  {leases.map((record) => (
                    <li key={record.occupancyRef.resourceId}>
                      <a
                        className="siamparkoccupancy:underline"
                        href={`/${language}/siampark/occupancy?resourceId=${record.occupancyRef.resourceId}`}
                      >
                        {unitName(record.unitRef.resourceId)} · {formatDate(record.startDate)} –{' '}
                        {record.endDate === null ? 'bez konce' : formatDate(record.endDate)} ·{' '}
                        {stateLabels[record.state]}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>
        </div>
      )}
    </>
  );
};
