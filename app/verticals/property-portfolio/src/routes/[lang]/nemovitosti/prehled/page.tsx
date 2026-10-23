import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { executeRecords as executeAgreements } from '@app/legal-agreements/clients/records';
import { executeRecords as executeFinance } from '@app/finance-billing/clients/records';
import { executeRecords as executeOccupancy } from '@app/property-leasing/clients/records';
import { executeRecords as executeWork } from '@app/work-tasks/clients/records';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { definePageData, modulePagePreload, pageDataPending } from '@app/shared-contracts/page-data';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { Effect, Random } from 'effect';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { executeRecords as executeProperty } from '../../../../api/records-client';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import csResource from '../../../../../locales/cs/property-portfolio.json';
import enResource from '../../../../../locales/en/property-portfolio.json';
import { pragueToday } from '../unit-story.tsx';
import {
  addDays,
  attentionItems,
  availabilityLabel,
  formatCzk,
  formatDay,
  isOpenTask,
  isOverdueInvoice,
  readyData,
  searchRentalOverview,
  unitAvailability,
  unitLabel,
} from './overview-model';
import type {
  AgreementsRecords,
  FinanceRecords,
  OccupancyRecords,
  OverviewSources,
  PropertyRecords,
  Source,
  SourceRow,
  WorkRecords,
} from './overview-model';
import '../../../index.css';
import './overview.css';

const propertyPortfolioI18nResources = {
  cs: { 'property-portfolio': csResource },
  en: { 'property-portfolio': enResource },
} as const;
type Overview = { agreements: AgreementsRecords; occupancy: OccupancyRecords; work: WorkRecords };
interface AgendaSources {
  readonly agreements: {
    readonly contracts: readonly Pick<
      Overview['agreements']['contracts'][number],
      'contractRef' | 'endDate' | 'lifecycleState'
    >[];
  };
  readonly occupancy: {
    readonly occupancies: readonly Pick<
      Overview['occupancy']['occupancies'][number],
      'occupancyRef' | 'unitRef' | 'startDate' | 'endDate' | 'state'
    >[];
  };
  readonly work: {
    readonly items: readonly Pick<Overview['work']['items'][number], 'ref' | 'title' | 'dueDate' | 'state'>[];
  };
}
export const projectOverviewAgenda = (records: AgendaSources) => {
  const tasks = records.work.items.flatMap((task) =>
    task.dueDate === undefined || ['DONE', 'CANCELLED'].includes(task.state)
      ? []
      : [
          {
            date: task.dueDate,
            id: `task:${task.ref.resourceId}`,
            kind: 'task' as const,
            label: task.title,
            owner: 'work',
            resourceId: task.ref.resourceId,
          },
        ],
  );
  const contracts = records.agreements.contracts.flatMap((contract) =>
    contract.endDate === null || contract.lifecycleState !== 'ACTIVE'
      ? []
      : [
          {
            date: contract.endDate,
            id: `contract:${contract.contractRef.resourceId}`,
            kind: 'contract' as const,
            label: contract.contractRef.resourceId,
            owner: 'agreements',
            resourceId: contract.contractRef.resourceId,
          },
        ],
  );
  const occupancies = records.occupancy.occupancies.flatMap((occupancy) => {
    if (!['CONFIRMED', 'ACTIVE'].includes(occupancy.state)) {
      return [];
    }
    const start = {
      date: occupancy.startDate,
      id: `occupancy-start:${occupancy.occupancyRef.resourceId}`,
      kind: 'occupancyStart' as const,
      label: occupancy.unitRef.resourceId,
      owner: 'occupancy',
      resourceId: occupancy.occupancyRef.resourceId,
    };
    return occupancy.endDate === null
      ? [start]
      : [
          start,
          {
            ...start,
            date: occupancy.endDate,
            id: `occupancy-end:${occupancy.occupancyRef.resourceId}`,
            kind: 'occupancyEnd' as const,
          },
        ];
  });
  return [...tasks, ...contracts, ...occupancies].toSorted(
    (left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id),
  );
};

/** Each source fails independently: no financial permissions must not erase the property portfolio. */
const governedSource = <A, E>(read: Effect.Effect<A, E>): Effect.Effect<Source<A>> =>
  read.pipe(
    Effect.match({
      onFailure: (error) =>
        ({
          status:
            typeof error === 'object' && error !== null && '_tag' in error && String(error._tag).includes('Forbidden')
              ? 'forbidden'
              : 'unavailable',
        }) as Source<A>,
      onSuccess: (data): Source<A> => ({ data, status: 'ready' }),
    }),
  );
const loadOverview = () => {
  const requestId = Random.nextInt.pipe(Effect.map((id) => `rental-overview:${id}`));
  return Effect.all(
    {
      agreements: governedSource(requestId.pipe(Effect.flatMap((id) => executeAgreements({}, id)))),
      finance: governedSource(requestId.pipe(Effect.flatMap((id) => executeFinance({}, id)))),
      occupancy: governedSource(requestId.pipe(Effect.flatMap((id) => executeOccupancy({}, id)))),
      property: governedSource(requestId.pipe(Effect.flatMap((id) => executeProperty({}, id)))),
      work: governedSource(requestId.pipe(Effect.flatMap((id) => executeWork({}, id)))),
    },
    // Independent owners: do not serialize the five governed reads into three waves.
    { concurrency: 5 },
  );
};
interface OverviewInput {
  readonly legalEntityId: string;
}
/** One dataset per legal entity: the five governed reads (and with them every permission check) settle before reveal. */
const overviewData = definePageData({
  key: (input: OverviewInput) => input.legalEntityId,
  load: loadOverview,
  runtime: browserRuntime,
});
const overviewInput = (context: ModulePageProps['context']): OverviewInput => ({
  legalEntityId: context?.legalEntityId ?? '',
});
export const preloadPage = modulePagePreload((props) => overviewData.preload(overviewInput(props.context)));
const sourceLabels: Record<keyof OverviewSources, string> = {
  agreements: 'Smlouvy',
  finance: 'Finance',
  occupancy: 'Nájmy a pobyty',
  property: 'Nemovitosti',
  work: 'Úkoly',
};
const sourceMessages = {
  forbidden: 'bez oprávnění',
  ready: 'aktuální data',
  unavailable: 'dočasně nedostupné',
} as const;
const availabilityTone = {
  AVAILABLE: 'success',
  OCCUPIED: 'info',
  OUT_OF_SERVICE: 'secondary',
  RESERVED: 'warning',
} as const;

const OverviewPageContent = ({ legalEntityId }: OverviewInput) => {
  const { language } = useModernI18n();
  const lang = language ?? 'cs';
  const snapshot = useSyncExternalStore(
    overviewData.subscribe,
    () => overviewData.snapshot({ legalEntityId }),
    () => pageDataPending,
  );
  useEffect(() => {
    overviewData.ensure({ legalEntityId });
  }, [legalEntityId]);
  const sources: OverviewSources | undefined = snapshot.state === 'ready' ? snapshot.value : undefined;
  const loading = snapshot.state === 'pending' || snapshot.refreshing;
  const [query, setQuery] = useState('');
  const [includeClosed, setIncludeClosed] = useState(false);
  const [selection, setSelection] = useState('');
  const today = pragueToday();
  const refresh = () => {
    void browserRuntime.runPromise(overviewData.refresh({ legalEntityId }));
  };
  const property = sources === undefined ? undefined : readyData(sources.property);
  const occupancy = sources === undefined ? undefined : readyData(sources.occupancy);
  const agreements = sources === undefined ? undefined : readyData(sources.agreements);
  const finance = sources === undefined ? undefined : readyData(sources.finance);
  const work = sources === undefined ? undefined : readyData(sources.work);
  // Only buildings in operation make up the portfolio; planned and archived ones stay in the register.
  const activeBuildings = property?.properties.filter((building) => building.lifecycleState === 'ACTIVE') ?? [];
  const closedBuildings = (property?.properties.length ?? 0) - activeBuildings.length;
  const units =
    property?.units.filter(
      (unit) =>
        unit.lifecycleState === 'ACTIVE' &&
        activeBuildings.some((building) => building.propertyRef.resourceId === unit.propertyRef.resourceId),
    ) ?? [];
  const occupied = units.filter((unit) => unitAvailability(unit, occupancy, today) === 'OCCUPIED');
  const available = units.filter((unit) => unitAvailability(unit, occupancy, today) === 'AVAILABLE');
  const activeLeases = occupancy?.occupancies.filter(
    (lease) =>
      lease.state === 'ACTIVE' && lease.startDate <= today && (lease.endDate === null || today < lease.endDate),
  );
  const knownRent = activeLeases?.filter((lease) => lease.rentTerms !== undefined) ?? [];
  const rent = knownRent.reduce(
    (sum, lease) => sum + (lease.rentTerms?.monthlyRentMinor ?? 0) + (lease.rentTerms?.serviceChargesMinor ?? 0),
    0,
  );
  const attention = sources === undefined ? [] : attentionItems(sources, today, lang);
  const hits = sources === undefined ? [] : searchRentalOverview(sources, query, lang, includeClosed);
  const href = (owner: string, id?: string) =>
    `/${lang}/${owner}${id === undefined ? '' : `?resourceId=${encodeURIComponent(id)}`}`;
  const rows: SourceRow[] = [];
  if (selection === 'occupied' || selection === 'available') {
    for (const unit of selection === 'occupied' ? occupied : available) {
      rows.push({
        detail: availabilityLabel[unitAvailability(unit, occupancy, today)],
        href: href('nemovitosti', unit.unitRef.resourceId),
        id: unit.unitRef.resourceId,
        label: unitLabel(property, unit.unitRef.resourceId) ?? unit.name,
      });
    }
  }
  if (selection === 'rent') {
    for (const lease of activeLeases ?? []) {
      rows.push({
        detail:
          lease.rentTerms === undefined
            ? 'Nájemné neuvedeno'
            : `${formatCzk(lease.rentTerms.monthlyRentMinor + lease.rentTerms.serviceChargesMinor)} / měsíc`,
        href: href('najmy', lease.occupancyRef.resourceId),
        id: lease.occupancyRef.resourceId,
        label: unitLabel(property, lease.unitRef.resourceId) ?? 'Nájem',
      });
    }
  }
  const agenda = projectOverviewAgenda({
    agreements: agreements ?? { contracts: [] },
    occupancy: occupancy ?? { occupancies: [] },
    work: work ?? { items: [] },
  })
    .filter((entry) => entry.date >= today && entry.date <= addDays(today, 60))
    .slice(0, 12);
  const agendaLabels = {
    contract: 'Konec smlouvy',
    occupancyEnd: 'Konec nájmu / pobytu',
    occupancyStart: 'Začátek nájmu / pobytu',
    task: 'Provozní úkol',
  };
  const agendaLabel = (entry: (typeof agenda)[number]) => {
    if (entry.kind === 'task') return entry.label;
    if (entry.kind === 'contract') {
      const contract = agreements?.contracts.find((item) => item.contractRef.resourceId === entry.resourceId);
      return contract?.subject ?? unitLabel(property, contract?.unitRef?.resourceId) ?? 'Smlouva';
    }
    const lease = occupancy?.occupancies.find((item) => item.occupancyRef.resourceId === entry.resourceId);
    return unitLabel(property, lease?.unitRef.resourceId) ?? 'Nájem / pobyt';
  };
  const overdueCount =
    (finance?.state.invoices.filter((invoice) => isOverdueInvoice(invoice, today)).length ?? 0) +
    (work?.items.filter((task) => isOpenTask(task) && task.dueDate !== undefined && task.dueDate < today).length ?? 0);
  const nav = [
    { label: 'Nemovitosti a jednotky', owner: 'properties', source: sources?.property },
    { label: 'Nájmy a pobyty', owner: 'occupancy', source: sources?.occupancy },
    { label: 'Smlouvy', owner: 'agreements', source: sources?.agreements },
    { label: 'Provozní úkoly', owner: 'work', source: sources?.work },
    { label: 'Faktury a finance', owner: 'finance', source: sources?.finance },
  ];
  return (
    <>
      <UltramodernRouteHead />
      <section aria-busy={loading} aria-labelledby="overview-heading" className="sp-overview">
        <header className="sp-heading">
          <div className="sp-stack">
            <span className="sp-eyebrow">SPRÁVA NEMOVITOSTÍ</span>
            <h1 id="overview-heading">Vaše nemovitosti v souvislostech</h1>
            <p className="sp-muted">
              Obsazenost, nájemci a nejbližší kroky na jednom místě. Stav k {formatDay(today)}.
            </p>
          </div>
          <Button isLoading={loading} onClick={refresh} size="sm" theme="outlined" variant="secondary">
            Obnovit přehled
          </Button>
        </header>
        <nav aria-label="Agendy nemovitostí" className="sp-quicklinks">
          {nav
            .filter((item) => item.source?.status === 'ready')
            .map((item) => (
              <a href={href(item.owner)} key={item.owner}>
                {item.label} →
              </a>
            ))}
        </nav>
        {sources !== undefined && (
          <>
            <div aria-label="Přehled dnešního dne" className="sp-stats">
              <button
                className="sp-stat"
                disabled={property === undefined || occupancy === undefined}
                onClick={() => setSelection('occupied')}
                type="button"
              >
                <span className="sp-muted">Obsazené jednotky</span>
                <strong>
                  {property === undefined || occupancy === undefined ? '—' : `${occupied.length} / ${units.length}`}
                </strong>
                <span className="sp-muted">Aktivní nájmy právě dnes · zobrazit →</span>
              </button>
              <button
                className="sp-stat"
                disabled={property === undefined || occupancy === undefined}
                onClick={() => setSelection('available')}
                type="button"
              >
                <span className="sp-muted">Volné jednotky</span>
                <strong>{property === undefined || occupancy === undefined ? '—' : available.length}</strong>
                <span className="sp-muted">Dnešní dostupnost · zobrazit →</span>
              </button>
              <button
                className="sp-stat"
                disabled={occupancy === undefined}
                onClick={() => setSelection('rent')}
                type="button"
              >
                <span className="sp-muted">Sjednaná měsíční platba</span>
                <strong>{occupancy === undefined || knownRent.length === 0 ? '—' : formatCzk(rent)}</strong>
                <span className="sp-muted">
                  Nájemné včetně záloh · {knownRent.length} z {activeLeases?.length ?? '—'} aktivních nájmů
                </span>
              </button>
              <button className="sp-stat" onClick={() => setSelection('attention')} type="button">
                <span className="sp-muted">Vyžaduje pozornost</span>
                <strong>{attention.length}</strong>
                <span className="sp-muted">{overdueCount} po termínu · další termíny do 60 dní</span>
              </button>
            </div>
            {selection !== '' && (
              <section aria-label="Zdrojové záznamy" className="sp-panel">
                <div className="sp-heading">
                  <h2>
                    {selection === 'occupied'
                      ? 'Dnes obsazené jednotky'
                      : selection === 'available'
                        ? 'Dnes volné jednotky'
                        : selection === 'rent'
                          ? 'Zdroj sjednaných měsíčních plateb'
                          : 'Co vyžaduje pozornost'}
                  </h2>
                  <Button onClick={() => setSelection('')} size="sm" theme="borderless" variant="secondary">
                    Zavřít
                  </Button>
                </div>
                {selection === 'attention'
                  ? attention.map((item) => (
                      <a className="sp-attention" href={item.href} key={item.id}>
                        <strong>{item.label}</strong>
                        <span className="sp-muted">{item.detail}</span>
                      </a>
                    ))
                  : rows.map((row) => (
                      <a className="sp-attention" href={row.href} key={row.id}>
                        <strong>{row.label}</strong>
                        <span className="sp-muted">{row.detail}</span>
                      </a>
                    ))}
                {selection !== 'attention' && rows.length === 0 && (
                  <p className="sp-muted">Žádné odpovídající záznamy.</p>
                )}
              </section>
            )}
            <div className="sp-columns">
              <section className="sp-panel">
                <div className="sp-heading">
                  <h2>Portfolio nemovitostí</h2>
                  <span className="sp-muted">
                    {property === undefined
                      ? 'Data nejsou dostupná'
                      : `${activeBuildings.length} ${activeBuildings.length === 1 ? 'budova' : activeBuildings.length < 5 ? 'budovy' : 'budov'} v provozu · ${units.length} aktivních jednotek`}
                  </span>
                </div>
                {activeBuildings.map((building) => (
                  <article className="sp-property" key={building.propertyRef.resourceId}>
                    <div className="sp-heading">
                      <div className="sp-stack">
                        <h3>
                          <a href={href('nemovitosti', building.propertyRef.resourceId)}>{building.name} →</a>
                        </h3>
                        <p className="sp-muted">{building.address}</p>
                      </div>
                      <Badge size="sm" variant={building.lifecycleState === 'ACTIVE' ? 'success' : 'outline'}>
                        {building.lifecycleState === 'ACTIVE' ? 'Aktivní' : 'Archivováno'}
                      </Badge>
                    </div>
                    <div className="sp-units">
                      {property?.units
                        .filter(
                          (unit) =>
                            unit.propertyRef.resourceId === building.propertyRef.resourceId &&
                            unit.lifecycleState !== 'RETIRED',
                        )
                        .map((unit) => {
                          const state = unitAvailability(unit, occupancy, today);
                          const next = occupancy?.occupancies
                            .filter(
                              (lease) =>
                                lease.unitRef.resourceId === unit.unitRef.resourceId &&
                                lease.state === 'CONFIRMED' &&
                                lease.startDate > today,
                            )
                            .toSorted((a, b) => a.startDate.localeCompare(b.startDate))[0];
                          return (
                            <a
                              className="sp-unit"
                              href={href('nemovitosti', unit.unitRef.resourceId)}
                              key={unit.unitRef.resourceId}
                            >
                              <strong>{unit.code}</strong>
                              <Badge size="sm" variant={occupancy === undefined ? 'outline' : availabilityTone[state]}>
                                {occupancy === undefined ? 'Bez dat' : availabilityLabel[state]}
                              </Badge>
                              <span className="sp-muted">
                                {next === undefined ? unit.name : `Rezervace od ${formatDay(next.startDate)}`}
                              </span>
                            </a>
                          );
                        })}
                    </div>
                  </article>
                ))}
                {property !== undefined && property.properties.length === 0 && (
                  <p className="sp-muted">Zatím nejsou evidovány žádné nemovitosti.</p>
                )}
                {closedBuildings > 0 && (
                  <p className="sp-muted">
                    Plánované a archivované nemovitosti ({closedBuildings}) najdete v{' '}
                    <a href={href('nemovitosti')}>evidenci nemovitostí →</a>
                  </p>
                )}
              </section>
              <aside className="sp-panel">
                <div className="sp-heading">
                  <h2>Na co nezapomenout</h2>
                  <Badge size="sm" variant="outline">
                    Nejbližších 60 dní
                  </Badge>
                </div>
                {attention.slice(0, 6).map((item) => (
                  <a className="sp-attention" href={item.href} key={item.id}>
                    <Badge size="sm" variant={item.tone}>
                      {item.kind}
                    </Badge>
                    <strong>{item.label}</strong>
                    <span className="sp-muted">{item.detail}</span>
                  </a>
                ))}
                {attention.length === 0 && (
                  <p className="sp-muted">V dostupných agendách nejsou žádné blížící se ani překročené termíny.</p>
                )}
              </aside>
            </div>
            <section className="sp-panel">
              <div className="sp-heading">
                <div className="sp-stack">
                  <h2>Kalendář nájmů a provozu</h2>
                  <p className="sp-muted">Termíny na příštích 60 dní. Každý řádek otevírá původní záznam.</p>
                </div>
                <a className="sp-muted" href={`/${lang}/provoz/agenda`}>
                  Otevřít celou agendu →
                </a>
              </div>
              <div className="sp-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Datum</th>
                      <th>Událost</th>
                      <th>Jednotka / předmět</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agenda.map((entry) => (
                      <tr key={entry.id}>
                        <td>{formatDay(entry.date)}</td>
                        <td>{agendaLabels[entry.kind]}</td>
                        <td>
                          <a href={href(entry.owner, entry.resourceId)}>{agendaLabel(entry)} →</a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {agenda.length === 0 && (
                <p className="sp-muted">V dostupných agendách nejsou v tomto období žádné termíny.</p>
              )}
            </section>
            <section className="sp-panel">
              <h2>Najít v nemovitostech</h2>
              <label className="sp-stack">
                <span className="sp-muted">Nemovitost, jednotka, smlouva, nájem, faktura nebo úkol</span>
                <input
                  className="sp-search"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Například R101, Parková nebo revize…"
                  type="search"
                  value={query}
                />
              </label>
              <label className="sp-muted">
                <input
                  checked={includeClosed}
                  onChange={(event) => setIncludeClosed(event.target.checked)}
                  type="checkbox"
                />{' '}
                Zahrnout ukončené a archivované
              </label>
              {hits.map((hit) => (
                <a className="sp-attention" href={hit.href} key={hit.id}>
                  <strong>
                    {hit.kind} · {hit.label}
                  </strong>
                  <span className="sp-muted">{hit.detail}</span>
                </a>
              ))}
              {query.trim().length >= 2 && hits.length === 0 && (
                <p className="sp-muted">Žádné výsledky v agendách, ke kterým máte oprávnění.</p>
              )}
            </section>
            <footer className="sp-sources" aria-label="Dostupnost zdrojů">
              {(Object.keys(sourceLabels) as (keyof OverviewSources)[]).map((key) => (
                <span className="sp-muted" key={key}>
                  {sourceLabels[key]}: {sourceMessages[sources[key].status]}
                </span>
              ))}
            </footer>
          </>
        )}
      </section>
    </>
  );
};
export const OverviewPage = ({ context }: Pick<ModulePageProps, 'context'>) => (
  <FederatedI18nBoundary
    defaultNamespace="property-portfolio"
    fallbackLanguage="en"
    resources={propertyPortfolioI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <OverviewPageContent {...overviewInput(context)} />
  </FederatedI18nBoundary>
);
export default OverviewPage;
