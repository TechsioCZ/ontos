import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { executeRecords as executeAgreements } from '@app/siampark-agreements/clients/records';
import { executeRecords as executeFinance } from '@app/siampark-billing-finance/clients/records';
import { executeRecords as executeOccupancy } from '@app/siampark-occupancy/clients/records';
import { executeRecords as executeRelationships } from '@app/siampark-relationships/clients/records';
import { executeRecords as executeWork } from '@app/siampark-work/clients/records';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { Table } from '@techsio/ui-kit/organisms/table';
import { Effect, Match, Random } from 'effect';
import { useState } from 'react';
import { executeRecords as executeProperty } from '../../../../api/records-client';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import csResource from '../../../../../locales/cs/siampark-property.json';
import enResource from '../../../../../locales/en/siampark-property.json';
import '../../../index.css';

const siamparkPropertyI18nResources = {
  cs: { 'siampark-property': csResource },
  en: { 'siampark-property': enResource },
} as const;
const referenceDate = '2026-10-05';
const periodStart = '2026-01-01';
const periodEndExclusive = '2027-01-01';
const moneyFormatters = {
  cs: new Intl.NumberFormat('cs', { currency: 'CZK', style: 'currency' }),
  en: new Intl.NumberFormat('en', { currency: 'CZK', style: 'currency' }),
};
const modules = ['properties', 'agreements', 'occupancy', 'finance', 'work', 'relationships', 'integrations'] as const;
const loadOverview = () => {
  const requestId = Random.nextInt.pipe(Effect.map((id) => `siampark-overview:${id}`));
  return Effect.all(
    {
      agreements: requestId.pipe(Effect.flatMap((id) => executeAgreements({}, id))),
      finance: requestId.pipe(Effect.flatMap((id) => executeFinance({}, id))),
      occupancy: requestId.pipe(Effect.flatMap((id) => executeOccupancy({}, id))),
      property: requestId.pipe(Effect.flatMap((id) => executeProperty({}, id))),
      relationships: requestId.pipe(Effect.flatMap((id) => executeRelationships({}, id))),
      work: requestId.pipe(Effect.flatMap((id) => executeWork({}, id))),
    },
    { concurrency: 1 },
  );
};
type Overview = Effect.Success<ReturnType<typeof loadOverview>>;
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
const unitAvailability = (unitId: string, records: Overview) => {
  const current = records.occupancy.occupancies.filter(
    (item) =>
      item.unitRef.resourceId === unitId &&
      item.startDate <= referenceDate &&
      (item.endDate === null || referenceDate < item.endDate),
  );
  if (current.some((item) => item.state === 'ACTIVE')) {
    return 'OCCUPIED' as const;
  }
  if (current.some((item) => item.state === 'CONFIRMED')) {
    return 'RESERVED' as const;
  }
  return 'AVAILABLE' as const;
};
const occupancyCounts = (units: Overview['property']['units'], records: Overview) => {
  const active = units.filter((unit) => unit.lifecycleState === 'ACTIVE');
  const occupied = active.filter((unit) => unitAvailability(unit.unitRef.resourceId, records) === 'OCCUPIED').length;
  const reserved = active.filter((unit) => unitAvailability(unit.unitRef.resourceId, records) === 'RESERVED').length;
  return { available: active.length - occupied - reserved, occupied, reserved, total: active.length };
};

const useOverviewRecords = () => {
  const { language, t } = useModernI18n();
  const key = 'siampark-property.pages.overview';
  const [records, setRecords] = useState<Overview>();
  const [propertyId, setPropertyId] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [drilldown, setDrilldown] = useState('');
  const refresh = () => {
    setPending(true);
    void browserRuntime.runPromise(
      loadOverview().pipe(
        Effect.match({
          onFailure: (error) => {
            setRecords(undefined);
            setMessage(
              Match.value(error).pipe(
                Match.tag('RecordsForbiddenProblem', () => t(`${key}.forbidden`)),
                Match.orElse(() => t(`${key}.unavailable`)),
              ),
            );
            setPending(false);
          },
          onSuccess: (result) => {
            setRecords(result);
            setMessage('');
            setPending(false);
          },
        }),
      ),
    );
  };
  const moneyFormatter = language === 'en' ? moneyFormatters.en : moneyFormatters.cs;
  const money = (minor: number) => moneyFormatter.format(minor / 100);
  const counts = records === undefined ? undefined : occupancyCounts(records.property.units, records);
  const property = records?.property.properties.find((item) => item.propertyRef.resourceId === propertyId);
  const units = records?.property.units.filter((item) => item.propertyRef.resourceId === propertyId) ?? [];
  const expiring =
    records?.agreements.contracts.filter((item) => item.lifecycleState === 'ACTIVE' && item.expiringSoon) ?? [];
  const bookingWarnings = records?.occupancy.bookingObservations.filter((item) => item.state !== 'SUCCESS') ?? [];
  const accountingWarnings =
    records?.finance.state.accountingObservations.filter((item) => item.latest && item.status === 'FAILED') ?? [];
  const ownerHref = (owner: string, id: string) =>
    `/${language ?? 'cs'}/siampark/${owner}?resourceId=${encodeURIComponent(id)}`;
  const sourceRows = (() => {
    if (records === undefined) {
      return [];
    }
    if (['occupied', 'available', 'reserved'].includes(drilldown)) {
      let desired = 'AVAILABLE';
      if (drilldown === 'occupied') {
        desired = 'OCCUPIED';
      }
      if (drilldown === 'reserved') {
        desired = 'RESERVED';
      }
      return records.property.units.flatMap((unit) =>
        unit.lifecycleState === 'ACTIVE' && unitAvailability(unit.unitRef.resourceId, records) === desired
          ? [
              {
                detail: t(`${key}.availability.${desired}`),
                href: ownerHref('properties', unit.unitRef.resourceId),
                id: unit.unitRef.resourceId,
                label: `${unit.code} · ${unit.name}`,
              },
            ]
          : [],
      );
    }
    if (['expiring', 'renewalMissing'].includes(drilldown)) {
      return expiring.flatMap((contract) =>
        drilldown !== 'renewalMissing' || !contract.hasSuccessorDraft
          ? [
              {
                detail: contract.endDate ?? '—',
                href: ownerHref('agreements', contract.contractRef.resourceId),
                id: contract.contractRef.resourceId,
                label:
                  records.property.units.find((unit) => unit.unitRef.resourceId === contract.unitRef?.resourceId)
                    ?.code ?? contract.contractRef.resourceId,
              },
            ]
          : [],
      );
    }
    if (['openTasks', 'overdueTasks'].includes(drilldown)) {
      return records.work.items.flatMap((task) =>
        !['DONE', 'CANCELLED'].includes(task.state) &&
        (drilldown !== 'overdueTasks' || (task.dueDate !== undefined && task.dueDate < referenceDate))
          ? [
              {
                detail: task.dueDate ?? '—',
                href: ownerHref('work', task.ref.resourceId),
                id: task.ref.resourceId,
                label: task.title,
              },
            ]
          : [],
      );
    }
    if (drilldown === 'activities') {
      return records.relationships.items.map((activity) => ({
        detail: '',
        href: ownerHref('relationships', activity.ref.resourceId),
        id: activity.ref.resourceId,
        label: activity.summary,
      }));
    }
    if (['planRevenue', 'planCost'].includes(drilldown)) {
      const planLabel = t(`${key}.${drilldown}`);
      const actualLabel = t(`${key}.${drilldown === 'planRevenue' ? 'revenue' : 'cost'}`);
      const plans = records.finance.state.financialPlanEntries.flatMap((entry) =>
        entry.state === 'CONFIRMED' &&
        entry.kind === (drilldown === 'planRevenue' ? 'REVENUE' : 'COST') &&
        entry.periodStart >= periodStart &&
        entry.periodStart < periodEndExclusive
          ? [
              {
                detail: `${planLabel} · ${entry.periodStart} → ${entry.periodEndExclusive} · ${money(entry.plannedMinor)}`,
                href: ownerHref('finance', entry.ref.resourceId),
                id: entry.ref.resourceId,
                label: entry.category,
              },
            ]
          : [],
      );
      const actuals = records.finance.state.invoices.flatMap((invoice) =>
        invoice.businessState === 'CONFIRMED' &&
        invoice.issueDate >= periodStart &&
        invoice.issueDate < periodEndExclusive &&
        invoice.direction === (drilldown === 'planRevenue' ? 'OUTGOING' : 'INCOMING')
          ? [
              {
                detail: `${actualLabel} · ${money(invoice.totalMinor)}`,
                href: ownerHref('finance', invoice.ref.resourceId),
                id: invoice.ref.resourceId,
                label: invoice.documentNumber,
              },
            ]
          : [],
      );
      return [...plans, ...actuals];
    }
    const invoices = records.finance.state.invoices.filter((invoice) => {
      if (invoice.businessState !== 'CONFIRMED') {
        return false;
      }
      if (drilldown === 'revenue' || drilldown === 'cost') {
        return (
          invoice.issueDate >= periodStart &&
          invoice.issueDate < periodEndExclusive &&
          invoice.direction === (drilldown === 'revenue' ? 'OUTGOING' : 'INCOMING')
        );
      }
      if (invoice.paidMinor >= invoice.totalMinor) {
        return false;
      }
      if (drilldown === 'receivables' || drilldown === 'payables') {
        return invoice.direction === (drilldown === 'receivables' ? 'OUTGOING' : 'INCOMING');
      }
      return drilldown === 'openInvoices' || (drilldown === 'overdueInvoices' && invoice.dueDate < referenceDate);
    });
    return invoices.map((invoice) => ({
      detail: money(
        ['receivables', 'payables', 'openInvoices', 'overdueInvoices'].includes(drilldown)
          ? invoice.totalMinor - invoice.paidMinor
          : invoice.totalMinor,
      ),
      href: ownerHref('finance', invoice.ref.resourceId),
      id: invoice.ref.resourceId,
      label: invoice.documentNumber,
    }));
  })();
  return {
    accountingWarnings,
    bookingWarnings,
    counts,
    drilldown,
    expiring,
    key,
    language,
    message,
    money,
    ownerHref,
    pending,
    property,
    records,
    refresh,
    setDrilldown,
    setPropertyId,
    sourceRows,
    t,
    units,
  };
};
const OverviewIndicators = ({ state }: { readonly state: ReturnType<typeof useOverviewRecords> }) => {
  const { counts, expiring, key, money, records, setDrilldown, t } = state;
  if (records === undefined || counts === undefined) {
    return null;
  }
  return (
    <dl className="siamparkproperty:grid siamparkproperty:grid-cols-2 siamparkproperty:gap-4 siamparkproperty:xl:grid-cols-4">
      <div className="siamparkproperty:min-w-0 siamparkproperty:space-y-2 siamparkproperty:rounded-lg siamparkproperty:bg-(--color-surface-subtle) siamparkproperty:p-5">
        <dt className="siamparkproperty:text-xs siamparkproperty:font-medium siamparkproperty:text-(--color-fg-secondary)">
          {t(`${key}.occupied`)}
        </dt>
        <dd className="siamparkproperty:min-w-0">
          <Button
            className="siamparkproperty:h-auto siamparkproperty:max-w-full siamparkproperty:justify-start siamparkproperty:p-0 siamparkproperty:text-left siamparkproperty:text-3xl siamparkproperty:font-semibold siamparkproperty:tabular-nums siamparkproperty:whitespace-normal"
            onClick={() => setDrilldown('occupied')}
            size="current"
            theme="borderless"
            variant="secondary"
          >
            {counts.occupied} / {counts.total}
          </Button>
        </dd>
      </div>
      <div className="siamparkproperty:min-w-0 siamparkproperty:space-y-2 siamparkproperty:rounded-lg siamparkproperty:bg-(--color-surface-subtle) siamparkproperty:p-5">
        <dt className="siamparkproperty:text-xs siamparkproperty:font-medium siamparkproperty:text-(--color-fg-secondary)">
          {t(`${key}.available`)}
        </dt>
        <dd className="siamparkproperty:min-w-0">
          <Button
            className="siamparkproperty:h-auto siamparkproperty:max-w-full siamparkproperty:justify-start siamparkproperty:p-0 siamparkproperty:text-left siamparkproperty:text-3xl siamparkproperty:font-semibold siamparkproperty:tabular-nums siamparkproperty:whitespace-normal"
            onClick={() => setDrilldown('available')}
            size="current"
            theme="borderless"
            variant="secondary"
          >
            {' '}
            {counts.available}{' '}
          </Button>
        </dd>
      </div>
      <div className="siamparkproperty:min-w-0 siamparkproperty:space-y-2 siamparkproperty:rounded-lg siamparkproperty:bg-(--color-surface-subtle) siamparkproperty:p-5">
        <dt className="siamparkproperty:text-xs siamparkproperty:font-medium siamparkproperty:text-(--color-fg-secondary)">
          {t(`${key}.reserved`)}
        </dt>
        <dd className="siamparkproperty:min-w-0">
          <Button
            className="siamparkproperty:h-auto siamparkproperty:max-w-full siamparkproperty:justify-start siamparkproperty:p-0 siamparkproperty:text-left siamparkproperty:text-3xl siamparkproperty:font-semibold siamparkproperty:tabular-nums siamparkproperty:whitespace-normal"
            onClick={() => setDrilldown('reserved')}
            size="current"
            theme="borderless"
            variant="secondary"
          >
            {' '}
            {counts.reserved}{' '}
          </Button>
        </dd>
      </div>
      <div className="siamparkproperty:min-w-0 siamparkproperty:space-y-2 siamparkproperty:rounded-lg siamparkproperty:bg-(--color-surface-subtle) siamparkproperty:p-5">
        <dt className="siamparkproperty:text-xs siamparkproperty:font-medium siamparkproperty:text-(--color-fg-secondary)">
          {t(`${key}.revenue`)}
        </dt>
        <dd className="siamparkproperty:min-w-0">
          <Button
            className="siamparkproperty:h-auto siamparkproperty:max-w-full siamparkproperty:justify-start siamparkproperty:p-0 siamparkproperty:text-left siamparkproperty:text-3xl siamparkproperty:font-semibold siamparkproperty:tabular-nums siamparkproperty:whitespace-normal"
            onClick={() => setDrilldown('revenue')}
            size="current"
            theme="borderless"
            variant="secondary"
          >
            {' '}
            {money(records.finance.indicators.revenueMinor)}{' '}
          </Button>
        </dd>
      </div>
      <div className="siamparkproperty:min-w-0 siamparkproperty:space-y-2 siamparkproperty:rounded-lg siamparkproperty:bg-(--color-surface-subtle) siamparkproperty:p-5">
        <dt className="siamparkproperty:text-xs siamparkproperty:font-medium siamparkproperty:text-(--color-fg-secondary)">
          {t(`${key}.cost`)}
        </dt>
        <dd className="siamparkproperty:min-w-0">
          <Button
            className="siamparkproperty:h-auto siamparkproperty:max-w-full siamparkproperty:justify-start siamparkproperty:p-0 siamparkproperty:text-left siamparkproperty:text-3xl siamparkproperty:font-semibold siamparkproperty:tabular-nums siamparkproperty:whitespace-normal"
            onClick={() => setDrilldown('cost')}
            size="current"
            theme="borderless"
            variant="secondary"
          >
            {' '}
            {money(records.finance.indicators.costMinor)}{' '}
          </Button>
        </dd>
      </div>
      <div className="siamparkproperty:min-w-0 siamparkproperty:space-y-2 siamparkproperty:rounded-lg siamparkproperty:bg-(--color-surface-subtle) siamparkproperty:p-5">
        <dt className="siamparkproperty:text-xs siamparkproperty:font-medium siamparkproperty:text-(--color-fg-secondary)">
          {t(`${key}.receivables`)}
        </dt>
        <dd className="siamparkproperty:min-w-0">
          <Button
            className="siamparkproperty:h-auto siamparkproperty:max-w-full siamparkproperty:justify-start siamparkproperty:p-0 siamparkproperty:text-left siamparkproperty:text-3xl siamparkproperty:font-semibold siamparkproperty:tabular-nums siamparkproperty:whitespace-normal"
            onClick={() => setDrilldown('receivables')}
            size="current"
            theme="borderless"
            variant="secondary"
          >
            {' '}
            {money(records.finance.indicators.receivablesOutstandingMinor)}{' '}
          </Button>
        </dd>
      </div>
      <div className="siamparkproperty:min-w-0 siamparkproperty:space-y-2 siamparkproperty:rounded-lg siamparkproperty:bg-(--color-surface-subtle) siamparkproperty:p-5">
        <dt className="siamparkproperty:text-xs siamparkproperty:font-medium siamparkproperty:text-(--color-fg-secondary)">
          {t(`${key}.payables`)}
        </dt>
        <dd className="siamparkproperty:min-w-0">
          <Button
            className="siamparkproperty:h-auto siamparkproperty:max-w-full siamparkproperty:justify-start siamparkproperty:p-0 siamparkproperty:text-left siamparkproperty:text-3xl siamparkproperty:font-semibold siamparkproperty:tabular-nums siamparkproperty:whitespace-normal"
            onClick={() => setDrilldown('payables')}
            size="current"
            theme="borderless"
            variant="secondary"
          >
            {' '}
            {money(records.finance.indicators.payablesOutstandingMinor)}{' '}
          </Button>
        </dd>
      </div>
      <div className="siamparkproperty:min-w-0 siamparkproperty:space-y-2 siamparkproperty:rounded-lg siamparkproperty:bg-(--color-surface-subtle) siamparkproperty:p-5">
        <dt className="siamparkproperty:text-xs siamparkproperty:font-medium siamparkproperty:text-(--color-fg-secondary)">
          {t(`${key}.planRevenue`)}
        </dt>
        <dd className="siamparkproperty:min-w-0">
          <Button
            className="siamparkproperty:h-auto siamparkproperty:max-w-full siamparkproperty:justify-start siamparkproperty:p-0 siamparkproperty:text-left siamparkproperty:text-3xl siamparkproperty:font-semibold siamparkproperty:tabular-nums siamparkproperty:whitespace-normal"
            onClick={() => setDrilldown('planRevenue')}
            size="current"
            theme="borderless"
            variant="secondary"
          >
            <span className="siamparkproperty:flex siamparkproperty:flex-col siamparkproperty:gap-2">
              <span>{money(records.finance.indicators.plannedRevenueMinor)}</span>
              <span className="siamparkproperty:text-sm siamparkproperty:text-(--color-fg-secondary) siamparkproperty:font-normal">
                {t(`${key}.variance`)} {money(records.finance.indicators.revenueVarianceMinor)}
              </span>
            </span>
          </Button>
        </dd>
      </div>
      <div className="siamparkproperty:min-w-0 siamparkproperty:space-y-2 siamparkproperty:rounded-lg siamparkproperty:bg-(--color-surface-subtle) siamparkproperty:p-5">
        <dt className="siamparkproperty:text-xs siamparkproperty:font-medium siamparkproperty:text-(--color-fg-secondary)">
          {t(`${key}.planCost`)}
        </dt>
        <dd className="siamparkproperty:min-w-0">
          <Button
            className="siamparkproperty:h-auto siamparkproperty:max-w-full siamparkproperty:justify-start siamparkproperty:p-0 siamparkproperty:text-left siamparkproperty:text-3xl siamparkproperty:font-semibold siamparkproperty:tabular-nums siamparkproperty:whitespace-normal"
            onClick={() => setDrilldown('planCost')}
            size="current"
            theme="borderless"
            variant="secondary"
          >
            <span className="siamparkproperty:flex siamparkproperty:flex-col siamparkproperty:gap-2">
              <span>{money(records.finance.indicators.plannedCostMinor)}</span>
              <span className="siamparkproperty:text-sm siamparkproperty:text-(--color-fg-secondary) siamparkproperty:font-normal">
                {t(`${key}.variance`)} {money(records.finance.indicators.costVarianceMinor)}
              </span>
            </span>
          </Button>
        </dd>
      </div>
      <div className="siamparkproperty:min-w-0 siamparkproperty:space-y-2 siamparkproperty:rounded-lg siamparkproperty:bg-(--color-surface-subtle) siamparkproperty:p-5">
        <dt className="siamparkproperty:text-xs siamparkproperty:font-medium siamparkproperty:text-(--color-fg-secondary)">
          {t(`${key}.openInvoices`)}
        </dt>
        <dd className="siamparkproperty:min-w-0">
          <Button
            className="siamparkproperty:h-auto siamparkproperty:max-w-full siamparkproperty:justify-start siamparkproperty:p-0 siamparkproperty:text-left siamparkproperty:text-3xl siamparkproperty:font-semibold siamparkproperty:tabular-nums siamparkproperty:whitespace-normal"
            onClick={() => setDrilldown('openInvoices')}
            size="current"
            theme="borderless"
            variant="secondary"
          >
            {' '}
            {records.finance.indicators.openInvoices}{' '}
          </Button>
        </dd>
      </div>
      <div className="siamparkproperty:min-w-0 siamparkproperty:space-y-2 siamparkproperty:rounded-lg siamparkproperty:bg-(--color-surface-subtle) siamparkproperty:p-5">
        <dt className="siamparkproperty:text-xs siamparkproperty:font-medium siamparkproperty:text-(--color-fg-secondary)">
          {t(`${key}.overdueInvoices`)}
        </dt>
        <dd className="siamparkproperty:min-w-0">
          <Button
            className="siamparkproperty:h-auto siamparkproperty:max-w-full siamparkproperty:justify-start siamparkproperty:p-0 siamparkproperty:text-left siamparkproperty:text-3xl siamparkproperty:font-semibold siamparkproperty:tabular-nums siamparkproperty:whitespace-normal"
            onClick={() => setDrilldown('overdueInvoices')}
            size="current"
            theme="borderless"
            variant="secondary"
          >
            {' '}
            {records.finance.indicators.overdueInvoices}{' '}
          </Button>
        </dd>
      </div>
      <div className="siamparkproperty:min-w-0 siamparkproperty:space-y-2 siamparkproperty:rounded-lg siamparkproperty:bg-(--color-surface-subtle) siamparkproperty:p-5">
        <dt className="siamparkproperty:text-xs siamparkproperty:font-medium siamparkproperty:text-(--color-fg-secondary)">
          {t(`${key}.openTasks`)}
        </dt>
        <dd className="siamparkproperty:min-w-0">
          <Button
            className="siamparkproperty:h-auto siamparkproperty:max-w-full siamparkproperty:justify-start siamparkproperty:p-0 siamparkproperty:text-left siamparkproperty:text-3xl siamparkproperty:font-semibold siamparkproperty:tabular-nums siamparkproperty:whitespace-normal"
            onClick={() => setDrilldown('openTasks')}
            size="current"
            theme="borderless"
            variant="secondary"
          >
            {' '}
            {records.work.indicators.open}{' '}
          </Button>
        </dd>
      </div>
      <div className="siamparkproperty:min-w-0 siamparkproperty:space-y-2 siamparkproperty:rounded-lg siamparkproperty:bg-(--color-surface-subtle) siamparkproperty:p-5">
        <dt className="siamparkproperty:text-xs siamparkproperty:font-medium siamparkproperty:text-(--color-fg-secondary)">
          {t(`${key}.overdueTasks`)}
        </dt>
        <dd className="siamparkproperty:min-w-0">
          <Button
            className="siamparkproperty:h-auto siamparkproperty:max-w-full siamparkproperty:justify-start siamparkproperty:p-0 siamparkproperty:text-left siamparkproperty:text-3xl siamparkproperty:font-semibold siamparkproperty:tabular-nums siamparkproperty:whitespace-normal"
            onClick={() => setDrilldown('overdueTasks')}
            size="current"
            theme="borderless"
            variant="secondary"
          >
            {' '}
            {records.work.indicators.overdue}{' '}
          </Button>
        </dd>
      </div>
      <div className="siamparkproperty:min-w-0 siamparkproperty:space-y-2 siamparkproperty:rounded-lg siamparkproperty:bg-(--color-surface-subtle) siamparkproperty:p-5">
        <dt className="siamparkproperty:text-xs siamparkproperty:font-medium siamparkproperty:text-(--color-fg-secondary)">
          {t(`${key}.expiring`)}
        </dt>
        <dd className="siamparkproperty:min-w-0">
          <Button
            className="siamparkproperty:h-auto siamparkproperty:max-w-full siamparkproperty:justify-start siamparkproperty:p-0 siamparkproperty:text-left siamparkproperty:text-3xl siamparkproperty:font-semibold siamparkproperty:tabular-nums siamparkproperty:whitespace-normal"
            onClick={() => setDrilldown('expiring')}
            size="current"
            theme="borderless"
            variant="secondary"
          >
            {' '}
            {expiring.length}{' '}
          </Button>
        </dd>
      </div>
      <div className="siamparkproperty:min-w-0 siamparkproperty:space-y-2 siamparkproperty:rounded-lg siamparkproperty:bg-(--color-surface-subtle) siamparkproperty:p-5">
        <dt className="siamparkproperty:text-xs siamparkproperty:font-medium siamparkproperty:text-(--color-fg-secondary)">
          {t(`${key}.renewalMissing`)}
        </dt>
        <dd className="siamparkproperty:min-w-0">
          <Button
            className="siamparkproperty:h-auto siamparkproperty:max-w-full siamparkproperty:justify-start siamparkproperty:p-0 siamparkproperty:text-left siamparkproperty:text-3xl siamparkproperty:font-semibold siamparkproperty:tabular-nums siamparkproperty:whitespace-normal"
            onClick={() => setDrilldown('renewalMissing')}
            size="current"
            theme="borderless"
            variant="secondary"
          >
            {' '}
            {expiring.filter((item) => !item.hasSuccessorDraft).length}{' '}
          </Button>
        </dd>
      </div>
      <div className="siamparkproperty:min-w-0 siamparkproperty:space-y-2 siamparkproperty:rounded-lg siamparkproperty:bg-(--color-surface-subtle) siamparkproperty:p-5">
        <dt className="siamparkproperty:text-xs siamparkproperty:font-medium siamparkproperty:text-(--color-fg-secondary)">
          {t(`${key}.activities`)}
        </dt>
        <dd className="siamparkproperty:min-w-0">
          <Button
            className="siamparkproperty:h-auto siamparkproperty:max-w-full siamparkproperty:justify-start siamparkproperty:p-0 siamparkproperty:text-left siamparkproperty:text-3xl siamparkproperty:font-semibold siamparkproperty:tabular-nums siamparkproperty:whitespace-normal"
            onClick={() => setDrilldown('activities')}
            size="current"
            theme="borderless"
            variant="secondary"
          >
            {' '}
            {records.relationships.items.length}{' '}
          </Button>
        </dd>
      </div>
    </dl>
  );
};
const OverviewPageContent = () => {
  const state = useOverviewRecords();
  const {
    accountingWarnings,
    bookingWarnings,
    counts,
    drilldown,
    key,
    language,
    message,
    ownerHref,
    pending,
    property,
    records,
    refresh,
    setPropertyId,
    sourceRows,
    t,
    units,
  } = state;
  return (
    <>
      <UltramodernRouteHead />
      <section
        aria-labelledby="overview-heading"
        className="siamparkproperty:w-full siamparkproperty:min-w-0 siamparkproperty:max-w-none siamparkproperty:space-y-6 siamparkproperty:p-0 siamparkproperty:text-(--color-page-fg)"
      >
        <header className="siamparkproperty:flex siamparkproperty:flex-wrap siamparkproperty:items-start siamparkproperty:justify-between siamparkproperty:gap-4 siamparkproperty:border-b siamparkproperty:border-(--color-border-muted) siamparkproperty:pb-5">
          <div className="siamparkproperty:min-w-0 siamparkproperty:space-y-2">
            <h1
              className="siamparkproperty:text-3xl siamparkproperty:font-semibold siamparkproperty:tracking-tight"
              id="overview-heading"
            >
              {t(`${key}.title`)}
            </h1>
            <p className="siamparkproperty:text-sm siamparkproperty:text-(--color-fg-secondary)">
              {t(`${key}.referenceDate`)}: {referenceDate} · {t(`${key}.period`)}
            </p>
          </div>
          <Button disabled={pending} onClick={refresh} size="sm" variant="warning">
            {t(`${key}.refresh`)}
          </Button>
        </header>
        <output
          aria-live="polite"
          className="siamparkproperty:block siamparkproperty:text-sm siamparkproperty:text-(--color-fg-secondary)"
        >
          {message}
        </output>
        {records !== undefined && counts !== undefined && (
          <>
            <OverviewIndicators state={state} />
            {drilldown !== '' && (
              <section
                aria-label={t(`${key}.sourceRecords`)}
                className="siamparkproperty:min-w-0 siamparkproperty:space-y-4 siamparkproperty:rounded-lg siamparkproperty:border siamparkproperty:border-(--color-border-muted) siamparkproperty:bg-(--color-surface) siamparkproperty:p-5"
              >
                <h2 className="siamparkproperty:text-lg siamparkproperty:font-semibold">
                  {t(`${key}.sourceRecords`)}: {t(`${key}.${drilldown}`)}
                </h2>
                {sourceRows.length === 0 && (
                  <p className="siamparkproperty:text-sm siamparkproperty:text-(--color-fg-secondary)">
                    {t(`${key}.emptySources`)}
                  </p>
                )}
                <ul className="siamparkproperty:space-y-2 siamparkproperty:text-sm">
                  {sourceRows.map((row) => (
                    <li key={row.id}>
                      <Link href={row.href}>{row.label}</Link> · {row.detail}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section
              aria-labelledby="overview-agenda-heading"
              className="siamparkproperty:min-w-0 siamparkproperty:space-y-4 siamparkproperty:rounded-lg siamparkproperty:border siamparkproperty:border-(--color-border-muted) siamparkproperty:bg-(--color-surface) siamparkproperty:p-5"
            >
              <h2 className="siamparkproperty:text-lg siamparkproperty:font-semibold" id="overview-agenda-heading">
                {t(`${key}.agenda.title`)}
              </h2>
              <p className="siamparkproperty:text-sm siamparkproperty:text-(--color-fg-secondary)">
                {t(`${key}.agenda.description`)}
              </p>
              <div className="siamparkproperty:min-w-0 siamparkproperty:overflow-x-auto siamparkproperty:rounded-lg siamparkproperty:bg-(--color-surface)">
                <Table className="siamparkproperty:w-full" size="sm" variant="outline">
                  <Table.Caption>{t(`${key}.agenda.title`)}</Table.Caption>
                  <Table.Header className="siamparkproperty:bg-(--color-surface-subtle)">
                    <Table.Row>
                      <Table.ColumnHeader>{t(`${key}.agenda.date`)}</Table.ColumnHeader>
                      <Table.ColumnHeader>{t(`${key}.agenda.kind`)}</Table.ColumnHeader>
                      <Table.ColumnHeader>{t(`${key}.detail`)}</Table.ColumnHeader>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {projectOverviewAgenda(records).map((entry) => (
                      <Table.Row key={entry.id}>
                        <Table.Cell>
                          <time dateTime={entry.date}>{entry.date}</time>
                        </Table.Cell>
                        <Table.Cell>{t(`${key}.agenda.kinds.${entry.kind}`)}</Table.Cell>
                        <Table.Cell>
                          <Link href={ownerHref(entry.owner, entry.resourceId)}>
                            {entry.kind === 'task' ? entry.label : t(`${key}.detail`)}
                          </Link>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </div>
              {projectOverviewAgenda(records).length === 0 && (
                <p className="siamparkproperty:text-sm siamparkproperty:text-(--color-fg-secondary)">
                  {t(`${key}.emptySources`)}
                </p>
              )}
            </section>
            <section className="siamparkproperty:min-w-0 siamparkproperty:space-y-3 siamparkproperty:rounded-lg siamparkproperty:bg-(--color-surface-subtle) siamparkproperty:p-4">
              <h2 className="siamparkproperty:text-lg siamparkproperty:font-semibold">{t(`${key}.warnings`)}</h2>
              <p className="siamparkproperty:text-sm siamparkproperty:text-(--color-fg-secondary)">
                {t(`${key}.bookingWarnings`)}: {bookingWarnings.length} · {t(`${key}.accountingWarnings`)}:{' '}
                {accountingWarnings.length}
              </p>
              <ul className="siamparkproperty:space-y-2 siamparkproperty:text-sm">
                {bookingWarnings.map((item) => (
                  <li key={item.observationId}>
                    {t(`${key}.booking`)} · {item.correlation} · {item.state}
                    <Link href={`/${language ?? 'cs'}/siampark/occupancy`}>{t(`${key}.openBooking`)}</Link>
                  </li>
                ))}
                {accountingWarnings.map((item) => (
                  <li key={item.attemptId}>
                    {t(`${key}.accounting`)} · {item.correlation} · {item.resultSummary}
                    <Link href={ownerHref('finance', item.invoiceRef.resourceId)}>{t(`${key}.detail`)}</Link>
                  </li>
                ))}
              </ul>
            </section>
            <div className="siamparkproperty:min-w-0 siamparkproperty:overflow-x-auto siamparkproperty:rounded-lg siamparkproperty:bg-(--color-surface)">
              <Table className="siamparkproperty:w-full" size="sm" variant="outline">
                <Table.Caption>{t(`${key}.properties`)}</Table.Caption>
                <Table.Header className="siamparkproperty:bg-(--color-surface-subtle)">
                  <Table.Row>
                    <Table.ColumnHeader>{t(`${key}.property`)}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t(`${key}.occupied`)}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t(`${key}.available`)}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t(`${key}.reserved`)}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t(`${key}.detail`)}</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {records.property.properties.map((item) => {
                    const ownUnits = records.property.units.filter(
                      (unit) => unit.propertyRef.resourceId === item.propertyRef.resourceId,
                    );
                    const ownCounts = occupancyCounts(ownUnits, records);
                    return (
                      <Table.Row key={item.propertyRef.resourceId}>
                        <Table.Cell>
                          {item.code} · {item.name}
                        </Table.Cell>
                        <Table.Cell>{ownCounts.occupied}</Table.Cell>
                        <Table.Cell>{ownCounts.available}</Table.Cell>
                        <Table.Cell>{ownCounts.reserved}</Table.Cell>
                        <Table.Cell>
                          <Button
                            onClick={() => setPropertyId(item.propertyRef.resourceId)}
                            size="sm"
                            theme="outlined"
                            variant="secondary"
                          >
                            {t(`${key}.detail`)}
                          </Button>
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table>
            </div>
            {property !== undefined && (
              <article className="siamparkproperty:min-w-0 siamparkproperty:space-y-4 siamparkproperty:rounded-lg siamparkproperty:border siamparkproperty:border-(--color-border-muted) siamparkproperty:bg-(--color-surface) siamparkproperty:p-5">
                <h2 className="siamparkproperty:text-lg siamparkproperty:font-semibold">
                  {property.code} · {property.name}
                </h2>
                <p className="siamparkproperty:text-sm siamparkproperty:text-(--color-fg-secondary)">
                  {property.address}
                </p>
                <ul className="siamparkproperty:space-y-2 siamparkproperty:text-sm">
                  {units.map((unit) => (
                    <li key={unit.unitRef.resourceId}>
                      {unit.code} · {unit.name} ·{' '}
                      {unit.lifecycleState === 'ACTIVE'
                        ? t(`${key}.availability.${unitAvailability(unit.unitRef.resourceId, records)}`)
                        : t(`${key}.outOfService`)}
                    </li>
                  ))}
                </ul>
              </article>
            )}
          </>
        )}
        <nav
          aria-label={t(`${key}.modules`)}
          className="siamparkproperty:min-w-0 siamparkproperty:space-y-3 siamparkproperty:rounded-lg siamparkproperty:bg-(--color-surface-subtle) siamparkproperty:p-4"
        >
          <ul className="siamparkproperty:flex siamparkproperty:flex-wrap siamparkproperty:gap-3 siamparkproperty:text-sm">
            {modules.map((module) => (
              <li key={module}>
                <Link href={`/${language ?? 'cs'}/siampark/${module}`}>{t(`${key}.modulesList.${module}`)}</Link>
              </li>
            ))}
          </ul>
        </nav>
      </section>
    </>
  );
};
export const OverviewPage = () => (
  <FederatedI18nBoundary
    defaultNamespace="siampark-property"
    fallbackLanguage="en"
    resources={siamparkPropertyI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <OverviewPageContent />
  </FederatedI18nBoundary>
);
export default OverviewPage;
