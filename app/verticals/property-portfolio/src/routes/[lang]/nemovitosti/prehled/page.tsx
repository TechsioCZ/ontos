import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { executeRecords as executeAgreements } from '@app/legal-agreements/clients/records';
import { executeRecords as executeFinance } from '@app/finance-billing/clients/records';
import { executeRecords as executeOccupancy } from '@app/property-leasing/clients/records';
import { executeRecords as executeWork } from '@app/work-tasks/clients/records';
import { surfaceCardClassName, surfaceTileClassName } from '@app/admin-ui';
import { FormInput } from '@app/admin-ui/form-controls';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { Breadcrumb } from '@techsio/ui-kit/molecules/breadcrumb';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
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
  overviewHref,
  ownerRoutes,
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

const overviewClass = 'grid min-w-0 gap-6 max-[480px]:gap-4';
const headingClass = 'flex flex-wrap items-start justify-between gap-4';
const stackClass = 'grid min-w-0 gap-2';
const titleClass = 'text-[28px] font-[650] tracking-tight max-[480px]:text-[24px]';
const sectionTitleClass = 'text-[18px] font-semibold';
const mutedClass = 'text-[13px] leading-[1.6] text-fg-secondary';
/** Panels are the one outlined surface; KPI tiles are tinted, the same as SectionCard and StatCard elsewhere. */
const panelClass = `${surfaceCardClassName} grid min-w-0 gap-4 p-5 max-[480px]:p-4`;
const statsClass = 'grid grid-cols-4 gap-4 max-[1000px]:grid-cols-2 max-[480px]:gap-2';
const statClass = `${surfaceTileClassName} grid min-w-0 items-stretch justify-stretch gap-1.5 p-5 text-left hover:bg-overlay max-[480px]:p-4`;
const statValueClass = 'text-[28px] font-[650] leading-[1.4] tabular-nums max-[480px]:text-[23px]';
const columnsClass = 'grid grid-cols-[minmax(0,1.5fr)_minmax(280px,1fr)] items-start gap-6 max-[1000px]:grid-cols-1';
/** A link that reads as the text around it: no underline, the surrounding colour. */
const plainLinkClass = 'text-inherit no-underline';
const attentionClass =
  'grid gap-1.5 border-b border-border-primary/60 py-3 text-inherit no-underline last:border-0 last:pb-0';
const attentionLabelClass = 'text-[13px] font-semibold';
const unitsClass = 'grid grid-cols-4 gap-2 max-[480px]:grid-cols-2';
const unitClass = 'grid min-w-0 gap-2 rounded-md p-3 text-inherit no-underline hover:bg-surface';
const cellClass = 'border-b border-border-primary/60 px-2 py-3 align-top';

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
            owner: 'work' as const,
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
            owner: 'agreements' as const,
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
      owner: 'occupancy' as const,
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
  changesFrom: ['finance-billing', 'legal-agreements', 'property-leasing', 'property-portfolio', 'work-tasks'],
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
    <section aria-label={t('property-portfolio.overview.todaySummary')} className={statsClass}>
      <Button
        className={statClass}
        composition
        disabled={property === undefined || occupancy === undefined}
        onClick={() => setSelection('occupied')}
        size="current"
        unstyled
      >
        <span className={mutedClass}>Obsazené jednotky</span>
        <strong className={statValueClass}>
          {property === undefined || occupancy === undefined ? '—' : `${occupied.length} / ${units.length}`}
        </strong>
        <span className={mutedClass}>Aktivní nájmy právě dnes · zobrazit →</span>
      </Button>
      <Button
        className={statClass}
        composition
        disabled={property === undefined || occupancy === undefined}
        onClick={() => setSelection('available')}
        size="current"
        unstyled
      >
        <span className={mutedClass}>Volné jednotky</span>
        <strong className={statValueClass}>
          {property === undefined || occupancy === undefined ? '—' : available.length}
        </strong>
        <span className={mutedClass}>Dnešní dostupnost · zobrazit →</span>
      </Button>
      <Button
        className={statClass}
        composition
        disabled={occupancy === undefined}
        onClick={() => setSelection('rent')}
        size="current"
        unstyled
      >
        <span className={mutedClass}>Sjednaná měsíční platba</span>
        <strong className={statValueClass}>
          {occupancy === undefined || knownRent.length === 0 ? '—' : formatCzk(rent)}
        </strong>
        <span className={mutedClass}>
          Nájemné včetně záloh · {knownRent.length} z {activeLeases?.length ?? '—'} aktivních nájmů
        </span>
      </Button>
      <Button className={statClass} composition onClick={() => setSelection('attention')} size="current" unstyled>
        <span className={mutedClass}>Vyžaduje pozornost</span>
        <strong className={statValueClass}>{attention.length}</strong>
        <span className={mutedClass}>{overdueCount} po termínu · další termíny do 60 dní</span>
      </Button>
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
      <section aria-label={t('property-portfolio.pages.overview.sourceRecords')} className={panelClass}>
        <div className={headingClass}>
          <h2 className={sectionTitleClass}>{selectionTitle(selection)}</h2>
          <Button appearance="ghost" onClick={() => setSelection('')} severity="secondary" size="sm">
            Zavřít
          </Button>
        </div>
        {selection === 'attention'
          ? attention.map((item) => (
              <Link className={attentionClass} href={item.href} key={item.id} size="current">
                <strong className={`justify-self-start ${attentionLabelClass}`}>{item.label}</strong>
                <span className={mutedClass}>{item.detail}</span>
              </Link>
            ))
          : rows.map((row) => (
              <Link className={attentionClass} href={row.href} key={row.id} size="current">
                <strong className={`justify-self-start ${attentionLabelClass}`}>{row.label}</strong>
                <span className={mutedClass}>{row.detail}</span>
              </Link>
            ))}
        {selection !== 'attention' && rows.length === 0 && <p className={mutedClass}>Žádné odpovídající záznamy.</p>}
      </section>
    )
  );
};

const OverviewBuildings = ({ view }: { readonly view: OverviewView }) => {
  const { activeBuildings, closedBuildings, href, occupancy, property, today } = view;
  return (
    <section className={panelClass}>
      <div className={headingClass}>
        <h2 className={sectionTitleClass}>Portfolio nemovitostí</h2>
        <span className={mutedClass}>{portfolioDescription(view)}</span>
      </div>
      {activeBuildings.map((building) => {
        const buildingId = building.propertyRef.resourceId;
        return (
          <article
            className="grid gap-4 border-b border-border-primary/60 pb-5 last:border-0 last:p-0"
            key={buildingId}
          >
            <div className={headingClass}>
              <div className={stackClass}>
                <h3 className="text-[16px] font-semibold">
                  <Link className={plainLinkClass} href={href('nemovitosti', buildingId)} size="current">
                    {building.name} →
                  </Link>
                </h3>
                <p className={mutedClass}>{building.address}</p>
              </div>
              <Badge severity={building.lifecycleState === 'ACTIVE' ? 'success' : 'neutral'} size="sm">
                {building.lifecycleState === 'ACTIVE' ? 'Aktivní' : 'Archivováno'}
              </Badge>
            </div>
            <div className={unitsClass}>
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
                  <Link className={unitClass} href={href('nemovitosti', unitId)} key={unitId} size="current">
                    <strong className="text-[17px]">{unit.code}</strong>
                    <Badge
                      className="justify-self-start text-[12px]"
                      severity={occupancy === undefined ? 'neutral' : availabilityTone[state]}
                      size="sm"
                    >
                      {occupancy === undefined ? 'Bez dat' : availabilityLabel[state]}
                    </Badge>
                    <span className="text-[12px] leading-[1.6] text-fg-secondary">
                      {next === undefined ? unit.name : `Rezervace od ${formatDay(next.startDate)}`}
                    </span>
                  </Link>,
                ];
              })}
            </div>
          </article>
        );
      })}
      {property !== undefined && property.properties.length === 0 && (
        <p className={mutedClass}>Zatím nejsou evidovány žádné nemovitosti.</p>
      )}
      {closedBuildings > 0 && (
        <p className={mutedClass}>
          Plánované a archivované nemovitosti ({closedBuildings}) najdete v{' '}
          <Link className={plainLinkClass} href={href('nemovitosti')} size="current">
            evidenci nemovitostí →
          </Link>
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
  <section className={panelClass}>
    <div className={headingClass}>
      <div className={stackClass}>
        <h2 className={sectionTitleClass}>Kalendář nájmů a provozu</h2>
        <p className={mutedClass}>Termíny na příštích 60 dní. Každý řádek otevírá původní záznam.</p>
      </div>
      <Link className={`no-underline ${mutedClass}`} href={`/${lang}/provoz/agenda`}>
        Otevřít celou agendu →
      </Link>
    </div>
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[13px]">
        <thead>
          <tr>
            <th className={`${cellClass} text-[12px] font-medium text-fg-secondary`}>Datum</th>
            <th className={`${cellClass} text-[12px] font-medium text-fg-secondary`}>Událost</th>
            <th className={`${cellClass} text-[12px] font-medium text-fg-secondary`}>Jednotka / předmět</th>
          </tr>
        </thead>
        <tbody>
          {agenda.map((entry) => (
            <tr key={entry.id}>
              <td className={`${cellClass} whitespace-nowrap`}>{formatDay(entry.date)}</td>
              <td className={cellClass}>{agendaLabels[entry.kind]}</td>
              <td className={cellClass}>
                <Link className={plainLinkClass} href={href(ownerRoutes[entry.owner], entry.resourceId)} size="current">
                  {agendaLabel(entry)} →
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {agenda.length === 0 && <p className={mutedClass}>V dostupných agendách nejsou v tomto období žádné termíny.</p>}
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
    <section className={panelClass}>
      <h2 className={sectionTitleClass}>Najít v nemovitostech</h2>
      <FormInput
        label="Nemovitost, jednotka, smlouva, nájem, faktura nebo úkol"
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t('property-portfolio.overview.searchPlaceholder')}
        type="search"
        value={query}
      />
      <FormCheckbox
        checked={includeClosed}
        label="Zahrnout ukončené a archivované"
        onCheckedChange={setIncludeClosed}
        size="sm"
      />
      {hits.map((hit) => (
        <Link className={attentionClass} href={hit.href} key={hit.id} size="current">
          <strong className={`justify-self-start ${attentionLabelClass}`}>
            {hit.kind} · {hit.label}
          </strong>
          <span className={mutedClass}>{hit.detail}</span>
        </Link>
      ))}
      {query.trim().length >= 2 && hits.length === 0 && (
        <p className={mutedClass}>Žádné výsledky v agendách, ke kterým máte oprávnění.</p>
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
  ] as const;
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
  const portfolio = overviewPortfolio(sources, today);
  const { agreements, occupancy, property, work } = portfolio;
  const attention = sources === undefined ? [] : attentionItems(sources, today, lang);
  const hits = sources === undefined ? [] : searchRentalOverview(sources, query, lang, includeClosed);
  const href = (route: string, id?: string) => overviewHref(lang, route, id);
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
      <section aria-busy={loading} aria-labelledby="overview-heading" className={overviewClass}>
        <header className={headingClass}>
          <div className={stackClass}>
            <Breadcrumb aria-label={t('property-portfolio.overview.breadcrumb')} size="sm">
              <Breadcrumb.List>
                <Breadcrumb.Item>
                  <Breadcrumb.Link href={href('nemovitosti')}>{t('property-portfolio.title')}</Breadcrumb.Link>
                </Breadcrumb.Item>
                <Breadcrumb.Separator />
                <Breadcrumb.Item>
                  <Breadcrumb.CurrentLink>{t('property-portfolio.pages.overview.title')}</Breadcrumb.CurrentLink>
                </Breadcrumb.Item>
              </Breadcrumb.List>
            </Breadcrumb>
            <h1 className={titleClass} id="overview-heading">
              Vaše nemovitosti v souvislostech
            </h1>
            <p className={mutedClass}>
              Obsazenost, nájemci a nejbližší kroky na jednom místě. Stav k {formatDay(today)}.
            </p>
          </div>
        </header>
        <nav aria-label={t('property-portfolio.overview.propertyAgendas')} className="flex flex-wrap gap-2">
          {nav.flatMap((item) =>
            item.source?.status === 'ready'
              ? [
                  <Link
                    className="rounded-md px-3 py-2 text-[13px] text-inherit no-underline"
                    href={href(ownerRoutes[item.owner])}
                    key={item.owner}
                  >
                    {item.label} →
                  </Link>,
                ]
              : [],
          )}
        </nav>
        {sources !== undefined && (
          <>
            <OverviewStats view={view} />
            <OverviewSelection rows={rows} selection={selection} view={view} />
            <div className={columnsClass}>
              <OverviewBuildings view={view} />
              <aside className={panelClass}>
                <div className={headingClass}>
                  <h2 className={sectionTitleClass}>Na co nezapomenout</h2>
                  <Badge appearance="outline" severity="neutral" size="sm">
                    Nejbližších 60 dní
                  </Badge>
                </div>
                {attention.slice(0, 6).map((item) => (
                  <Link className={attentionClass} href={item.href} key={item.id} size="current">
                    <Badge className="justify-self-start" severity={item.tone} size="sm">
                      {item.kind}
                    </Badge>
                    <strong className={attentionLabelClass}>{item.label}</strong>
                    <span className={mutedClass}>{item.detail}</span>
                  </Link>
                ))}
                {attention.length === 0 && (
                  <p className={mutedClass}>V dostupných agendách nejsou žádné blížící se ani překročené termíny.</p>
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
            <footer
              aria-label={t('property-portfolio.overview.sourceAvailability')}
              className="flex flex-wrap gap-x-4 gap-y-2"
            >
              {EffectRecord.keys(sourceLabels).map((key) => (
                <span className={mutedClass} key={key}>
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
