import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { executeRecords as executeAgreements } from '@app/legal-agreements/clients/records';
import { executeRecords as executeFinance } from '@app/finance-billing/clients/records';
import { executeRecords as executeOccupancy } from '@app/property-leasing/clients/records';
import { executeRecords as executeWork } from '@app/work-tasks/clients/records';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { definePageData, modulePagePreload, pageDataPending } from '@app/shared-contracts/page-data';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { Effect, Match, Random, Record as EffectRecord } from 'effect';
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
  OccupancyRecords,
  OverviewSources,
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
interface Overview {
  agreements: AgreementsRecords;
  occupancy: OccupancyRecords;
  work: WorkRecords;
}
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
type OverviewReadFailure = Effect.Error<
  ReturnType<
    | typeof executeAgreements
    | typeof executeFinance
    | typeof executeOccupancy
    | typeof executeProperty
    | typeof executeWork
  >
>;
const governedSource = <A,>(read: Effect.Effect<A, OverviewReadFailure>): Effect.Effect<Source<A>> =>
  read.pipe(
    Effect.match({
      onFailure: (error): Source<A> =>
        Match.value(error).pipe(
          Match.tag('RecordsForbiddenProblem', 'GatewayForbiddenProblem', (): Source<A> => ({ status: 'forbidden' })),
          Match.orElse((): Source<A> => ({ status: 'unavailable' })),
        ),
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
const sourceLabels = {
  agreements: 'Smlouvy',
  finance: 'Finance',
  occupancy: 'Nájmy a pobyty',
  property: 'Nemovitosti',
  work: 'Úkoly',
} satisfies Record<keyof OverviewSources, string>;
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

const overviewPortfolio = (sources: OverviewSources | undefined, today: string) => {
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
  return {
    activeBuildings,
    activeLeases,
    agreements,
    available,
    closedBuildings,
    finance,
    knownRent,
    occupancy,
    occupied,
    property,
    rent,
    units,
    work,
  };
};
type OverviewPortfolio = ReturnType<typeof overviewPortfolio>;

const overviewRows = ({
  href,
  portfolio,
  selection,
  today,
}: {
  readonly href: (owner: string, id?: string) => string;
  readonly portfolio: OverviewPortfolio;
  readonly selection: string;
  readonly today: string;
}) => {
  const { activeLeases, available, occupancy, occupied, property } = portfolio;
  const rows: SourceRow[] = [];
  if (selection === 'occupied' || selection === 'available') {
    for (const unit of selection === 'occupied' ? occupied : available) {
      const unitId = unit.unitRef.resourceId;
      rows.push({
        detail: availabilityLabel[unitAvailability(unit, occupancy, today)],
        href: href('nemovitosti', unitId),
        id: unitId,
        label: unitLabel(property, unitId) ?? unit.name,
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
  return rows;
};

const agendaLabels = {
  contract: 'Konec smlouvy',
  occupancyEnd: 'Konec nájmu / pobytu',
  occupancyStart: 'Začátek nájmu / pobytu',
  task: 'Provozní úkol',
};

type OverviewView = OverviewPortfolio & {
  readonly attention: ReturnType<typeof attentionItems>;
  readonly href: (owner: string, id?: string) => string;
  readonly overdueCount: number;
  readonly setSelection: (selection: string) => void;
  readonly today: string;
};
const selectionTitle = (selection: string) =>
  Match.value(selection).pipe(
    Match.when('occupied', () => 'Dnes obsazené jednotky'),
    Match.when('available', () => 'Dnes volné jednotky'),
    Match.when('rent', () => 'Zdroj sjednaných měsíčních plateb'),
    Match.orElse(() => 'Co vyžaduje pozornost'),
  );
const portfolioDescription = (view: OverviewView) => {
  if (view.property === undefined) {
    return 'Data nejsou dostupná';
  }
  let buildings = 'budov';
  if (view.activeBuildings.length === 1) {
    buildings = 'budova';
  } else if (view.activeBuildings.length < 5) {
    buildings = 'budovy';
  }
  return `${view.activeBuildings.length} ${buildings} v provozu · ${view.units.length} aktivních jednotek`;
};

const OverviewStats = ({ view }: { readonly view: OverviewView }) => {
  const { t } = useModernI18n();
  const {
    activeLeases,
    attention,
    available,
    knownRent,
    occupancy,
    occupied,
    overdueCount,
    property,
    rent,
    setSelection,
    units,
  } = view;
  return (
    <section aria-label={t('property-portfolio.overview.todaySummary')} className="sp-stats">
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
      <button className="sp-stat" disabled={occupancy === undefined} onClick={() => setSelection('rent')} type="button">
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
    </section>
  );
};

const OverviewSelection = ({
  rows,
  selection,
  view,
}: {
  readonly rows: readonly SourceRow[];
  readonly selection: string;
  readonly view: OverviewView;
}) => {
  const { t } = useModernI18n();
  const { attention, setSelection } = view;
  return (
    selection !== '' && (
      <section aria-label={t('property-portfolio.pages.overview.sourceRecords')} className="sp-panel">
        <div className="sp-heading">
          <h2>{selectionTitle(selection)}</h2>
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
        {selection !== 'attention' && rows.length === 0 && <p className="sp-muted">Žádné odpovídající záznamy.</p>}
      </section>
    )
  );
};

const OverviewBuildings = ({ view }: { readonly view: OverviewView }) => {
  const { activeBuildings, closedBuildings, href, occupancy, property, today } = view;
  return (
    <section className="sp-panel">
      <div className="sp-heading">
        <h2>Portfolio nemovitostí</h2>
        <span className="sp-muted">{portfolioDescription(view)}</span>
      </div>
      {activeBuildings.map((building) => {
        const buildingId = building.propertyRef.resourceId;
        return (
          <article className="sp-property" key={buildingId}>
            <div className="sp-heading">
              <div className="sp-stack">
                <h3>
                  <a href={href('nemovitosti', buildingId)}>{building.name} →</a>
                </h3>
                <p className="sp-muted">{building.address}</p>
              </div>
              <Badge size="sm" variant={building.lifecycleState === 'ACTIVE' ? 'success' : 'outline'}>
                {building.lifecycleState === 'ACTIVE' ? 'Aktivní' : 'Archivováno'}
              </Badge>
            </div>
            <div className="sp-units">
              {property?.units.flatMap((unit) => {
                if (unit.propertyRef.resourceId !== buildingId || unit.lifecycleState === 'RETIRED') {
                  return [];
                }
                const unitId = unit.unitRef.resourceId;
                const state = unitAvailability(unit, occupancy, today);
                const next = occupancy?.occupancies
                  .filter(
                    (lease) =>
                      lease.unitRef.resourceId === unitId && lease.state === 'CONFIRMED' && lease.startDate > today,
                  )
                  .toSorted((a, b) => a.startDate.localeCompare(b.startDate))[0];
                return [
                  <a className="sp-unit" href={href('nemovitosti', unitId)} key={unitId}>
                    <strong>{unit.code}</strong>
                    <Badge size="sm" variant={occupancy === undefined ? 'outline' : availabilityTone[state]}>
                      {occupancy === undefined ? 'Bez dat' : availabilityLabel[state]}
                    </Badge>
                    <span className="sp-muted">
                      {next === undefined ? unit.name : `Rezervace od ${formatDay(next.startDate)}`}
                    </span>
                  </a>,
                ];
              })}
            </div>
          </article>
        );
      })}
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
  );
};

const OverviewAgenda = ({
  agenda,
  agendaLabel,
  href,
  lang,
}: {
  readonly agenda: ReturnType<typeof projectOverviewAgenda>;
  readonly agendaLabel: (entry: ReturnType<typeof projectOverviewAgenda>[number]) => string;
  readonly href: OverviewView['href'];
  readonly lang: string;
}) => (
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
    {agenda.length === 0 && <p className="sp-muted">V dostupných agendách nejsou v tomto období žádné termíny.</p>}
  </section>
);

const OverviewSearch = ({
  hits,
  includeClosed,
  query,
  setIncludeClosed,
  setQuery,
}: {
  readonly hits: ReturnType<typeof searchRentalOverview>;
  readonly includeClosed: boolean;
  readonly query: string;
  readonly setIncludeClosed: (value: boolean) => void;
  readonly setQuery: (query: string) => void;
}) => {
  const { t } = useModernI18n();
  return (
    <section className="sp-panel">
      <h2>Najít v nemovitostech</h2>
      <label className="sp-stack">
        <span className="sp-muted">Nemovitost, jednotka, smlouva, nájem, faktura nebo úkol</span>
        <input
          className="sp-search"
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('property-portfolio.overview.searchPlaceholder')}
          type="search"
          value={query}
        />
      </label>
      <label className="sp-muted">
        <input checked={includeClosed} onChange={(event) => setIncludeClosed(event.target.checked)} type="checkbox" />{' '}
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
  );
};

const overviewOverdueCount = ({ finance, work }: OverviewPortfolio, today: string) => {
  const overdueCount =
    (finance?.state.invoices.filter((invoice) => isOverdueInvoice(invoice, today)).length ?? 0) +
    (work?.items.filter((task) => isOpenTask(task) && task.dueDate !== undefined && task.dueDate < today).length ?? 0);
  return overdueCount;
};
const overviewNavigation = (sources: OverviewSources | undefined) => {
  const nav = [
    { label: 'Nemovitosti a jednotky', owner: 'properties', source: sources?.property },
    { label: 'Nájmy a pobyty', owner: 'occupancy', source: sources?.occupancy },
    { label: 'Smlouvy', owner: 'agreements', source: sources?.agreements },
    { label: 'Provozní úkoly', owner: 'work', source: sources?.work },
    { label: 'Faktury a finance', owner: 'finance', source: sources?.finance },
  ];
  return nav;
};

const OverviewPageContent = ({ legalEntityId }: OverviewInput) => {
  const { language, t } = useModernI18n();
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
  const portfolio = overviewPortfolio(sources, today);
  const { agreements, occupancy, property, work } = portfolio;
  const attention = sources === undefined ? [] : attentionItems(sources, today, lang);
  const hits = sources === undefined ? [] : searchRentalOverview(sources, query, lang, includeClosed);
  const href = (owner: string, id?: string) => {
    const queryString = id === undefined ? '' : `?resourceId=${encodeURIComponent(id)}`;
    return `/${lang}/${owner}${queryString}`;
  };
  const rows = overviewRows({ href, portfolio, selection, today });
  const agenda = projectOverviewAgenda({
    agreements: agreements ?? { contracts: [] },
    occupancy: occupancy ?? { occupancies: [] },
    work: work ?? { items: [] },
  })
    .filter((entry) => entry.date >= today && entry.date <= addDays(today, 60))
    .slice(0, 12);
  const agendaLabel = (entry: (typeof agenda)[number]) => {
    if (entry.kind === 'task') {
      return entry.label;
    }
    if (entry.kind === 'contract') {
      const contract = agreements?.contracts.find((item) => item.contractRef.resourceId === entry.resourceId);
      return contract?.subject ?? unitLabel(property, contract?.unitRef?.resourceId) ?? 'Smlouva';
    }
    const lease = occupancy?.occupancies.find((item) => item.occupancyRef.resourceId === entry.resourceId);
    return unitLabel(property, lease?.unitRef.resourceId) ?? 'Nájem / pobyt';
  };
  const overdueCount = overviewOverdueCount(portfolio, today);
  const nav = overviewNavigation(sources);
  const view: OverviewView = { ...portfolio, attention, href, overdueCount, setSelection, today };
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
        <nav aria-label={t('property-portfolio.overview.propertyAgendas')} className="sp-quicklinks">
          {nav.flatMap((item) =>
            item.source?.status === 'ready'
              ? [
                  <a href={href(item.owner)} key={item.owner}>
                    {item.label} →
                  </a>,
                ]
              : [],
          )}
        </nav>
        {sources !== undefined && (
          <>
            <OverviewStats view={view} />
            <OverviewSelection rows={rows} selection={selection} view={view} />
            <div className="sp-columns">
              <OverviewBuildings view={view} />
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
            <OverviewAgenda agenda={agenda} agendaLabel={agendaLabel} href={href} lang={lang} />
            <OverviewSearch
              hits={hits}
              includeClosed={includeClosed}
              query={query}
              setIncludeClosed={setIncludeClosed}
              setQuery={setQuery}
            />
            <footer aria-label={t('property-portfolio.overview.sourceAvailability')} className="sp-sources">
              {EffectRecord.keys(sourceLabels).map((key) => (
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
