import type { executeRecords as readAgreements } from '@app/legal-agreements/clients/records';
import type { executeRecords as readOccupancy } from '@app/property-leasing/clients/records';
import type { Task } from '@app/work-tasks/contracts/records';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Link } from '@techsio/ui-kit/atoms/link';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { DateTime, Schema } from 'effect';
import type { Effect } from 'effect';

import type { RecordsResponse } from '../../../../shared/apis/records';

type Translate = (key: string, options?: { readonly amount?: string; readonly date?: string }) => string;
type Occupancies = Effect.Success<ReturnType<typeof readOccupancy>>;
type Agreements = Effect.Success<ReturnType<typeof readAgreements>>;
type Unit = RecordsResponse['units'][number];

const K = 'property-portfolio.pages.records.unitStory';

const LeaseBlockSchema = Schema.Literals(['building', 'outOfService', 'retired']);
export type LeaseBlock = typeof LeaseBlockSchema.Type;
const cardClass = 'ontos-tile rounded-lg bg-surface [&_.ontos-tile]:bg-base min-w-0 space-y-3 p-4';
const rowClass =
  'flex flex-wrap items-center justify-between gap-2 py-3 text-sm border-b border-border-primary/60 last:border-b-0';
const mutedClass = 'text-sm text-fg-secondary';
const occupancyBadge = {
  ACTIVE: 'success',
  CANCELLED: 'danger',
  COMPLETED: 'secondary',
  CONFIRMED: 'info',
  DRAFT: 'neutral',
} as const;
const contractBadge = { ACTIVE: 'success', DRAFT: 'neutral', EXPIRED: 'warning', TERMINATED: 'danger' } as const;
const taskBadge = {
  CANCELLED: 'secondary',
  DONE: 'success',
  IN_PROGRESS: 'info',
  NEW: 'neutral',
  WAITING: 'warning',
} as const;
const money = new Intl.NumberFormat('cs-CZ', { currency: 'CZK', maximumFractionDigits: 0, style: 'currency' });
const date = new Intl.DateTimeFormat('cs-CZ', { dateStyle: 'medium', timeZone: 'UTC' });
const formatDay = (value: string | null | undefined) =>
  value === null || value === undefined
    ? '—'
    : date.format(DateTime.toEpochMillis(DateTime.makeUnsafe(`${value}T00:00:00Z`)));

/** Today's calendar date in Prague, used for unit availability instead of a fixed demo date. */
const pragueDate = new Intl.DateTimeFormat('sv-SE', {
  day: '2-digit',
  month: '2-digit',
  timeZone: 'Europe/Prague',
  year: 'numeric',
});
export const pragueToday = () => pragueDate.format(DateTime.toEpochMillis(DateTime.nowUnsafe()));

interface UnitStoryProps {
  readonly agreements: Agreements | undefined;
  readonly language: string;
  /**
   * Why the unit cannot be let, or undefined when it can: retired or archived units, units out of service and units
   * of a building out of operation get no lease-creation link and never claim to be free to let.
   */
  readonly leaseBlock: LeaseBlock | undefined;
  readonly occupancy: Occupancies | undefined;
  readonly section?: 'leases' | 'agreements' | 'tasks';
  readonly t: Translate;
  readonly tasks: readonly Task[] | undefined;
  readonly unit: Unit;
  readonly unitAssets?: readonly RecordsResponse['assets'][number]['assetRef'][] | undefined;
}

type SectionProps = Pick<UnitStoryProps, 'language' | 't' | 'unit'> & {
  readonly showHeading: boolean;
};

const LeaseSection = ({
  language,
  leaseBlock,
  occupancy,
  showHeading,
  t,
  unit,
}: SectionProps & Pick<UnitStoryProps, 'leaseBlock' | 'occupancy'>) => {
  const leases = (occupancy?.occupancies ?? [])
    .filter(
      (item) =>
        item.unitRef.resourceId === unit.unitRef.resourceId &&
        item.unitRef.tenantId === unit.unitRef.tenantId &&
        item.unitRef.moduleId === unit.unitRef.moduleId &&
        item.unitRef.resourceType === unit.unitRef.resourceType,
    )
    .toSorted((left, right) => right.startDate.localeCompare(left.startDate));
  return (
    <section aria-label={t(`${K}.leases`)} className={cardClass}>
      <div className="flex items-center justify-between gap-2">
        {showHeading && <h3 className="text-sm font-semibold">{t(`${K}.leases`)}</h3>}
        {leaseBlock === undefined && (
          <LinkButton
            appearance="ghost"
            href={`/${language}/najmy?create=lease&unitId=${unit.unitRef.resourceId}`}
            severity="secondary"
            size="sm"
          >
            {t(`${K}.newLease`)}
          </LinkButton>
        )}
      </div>
      {occupancy === undefined && <p className={mutedClass}>{t(`${K}.notLoaded`)}</p>}
      {leaseBlock !== undefined && (
        <p className={mutedClass} data-testid="unit-lease-block">
          {t(`${K}.leaseBlock.${leaseBlock}`)}
        </p>
      )}
      {leaseBlock === undefined && occupancy !== undefined && leases.length === 0 && (
        <p className={mutedClass}>{t(`${K}.noLeases`)}</p>
      )}
      {leases.map((item) => (
        <div className={rowClass} key={item.occupancyRef.resourceId}>
          <div className="min-w-0">
            <span className="block font-medium">
              {formatDay(item.startDate)} – {item.endDate === null ? t(`${K}.openEnd`) : formatDay(item.endDate)}
            </span>
            <span className={mutedClass}>
              {item.rentTerms === undefined
                ? t(`${K}.noRent`)
                : t(`${K}.rent`, {
                    amount: money.format((item.rentTerms.monthlyRentMinor + item.rentTerms.serviceChargesMinor) / 100),
                  })}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Badge severity={occupancyBadge[item.state]} size="sm">
              {t(`property-portfolio.pages.records.occupancyStates.${item.state}`)}
            </Badge>
            <LinkButton
              appearance="outline"
              href={`/${language}/najmy?resourceId=${item.occupancyRef.resourceId}`}
              severity="secondary"
              size="sm"
            >
              {t(`${K}.openLease`)}
            </LinkButton>
          </div>
        </div>
      ))}
    </section>
  );
};

const AgreementSection = ({
  agreements,
  language,
  showHeading,
  t,
  unit,
}: SectionProps & Pick<UnitStoryProps, 'agreements'>) => {
  const contracts = (agreements?.contracts ?? [])
    .filter(
      (item) =>
        item.unitRef?.resourceId === unit.unitRef.resourceId &&
        item.unitRef.tenantId === unit.unitRef.tenantId &&
        item.unitRef.moduleId === unit.unitRef.moduleId &&
        item.unitRef.resourceType === unit.unitRef.resourceType,
    )
    .toSorted((left, right) => right.startDate.localeCompare(left.startDate));
  return (
    <section aria-label={t(`${K}.contracts`)} className={cardClass}>
      {showHeading && <h3 className="text-sm font-semibold">{t(`${K}.contracts`)}</h3>}
      {agreements === undefined && <p className={mutedClass}>{t(`${K}.notLoaded`)}</p>}
      {agreements !== undefined && contracts.length === 0 && <p className={mutedClass}>{t(`${K}.noContracts`)}</p>}
      {contracts.map((item) => (
        <div className={rowClass} key={item.contractRef.resourceId}>
          <div className="min-w-0">
            <span className="block font-medium">{item.subject ?? t(`${K}.contract`)}</span>
            <span className={mutedClass}>
              {formatDay(item.startDate)} – {item.endDate === null ? t(`${K}.openEnd`) : formatDay(item.endDate)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Badge severity={contractBadge[item.lifecycleState]} size="sm">
              {t(`property-portfolio.pages.records.agreementStates.${item.lifecycleState}`)}
            </Badge>
            {item.expiringSoon && (
              <Badge severity="warning" size="sm">
                {t(`${K}.expiring`)}
              </Badge>
            )}
            <LinkButton
              appearance="outline"
              href={`/${language}/smlouvy?resourceId=${item.contractRef.resourceId}`}
              severity="secondary"
              size="sm"
            >
              {t(`${K}.openContract`)}
            </LinkButton>
          </div>
        </div>
      ))}
    </section>
  );
};

const TaskSection = ({
  language,
  showHeading,
  t,
  tasks,
  unit,
  unitAssets,
}: SectionProps & Pick<UnitStoryProps, 'tasks' | 'unitAssets'>) => {
  const references = [unit.unitRef, ...(unitAssets ?? [])];
  const unitTasks = (tasks ?? []).filter((task) =>
    task.contextRefs.some((ref) =>
      references.some(
        (owned) =>
          ref.resourceType === owned.resourceType &&
          ref.resourceId === owned.resourceId &&
          ref.tenantId === owned.tenantId &&
          ref.moduleId === owned.moduleId,
      ),
    ),
  );
  return (
    <section aria-label={t(`${K}.tasks`)} className={cardClass}>
      <div className="flex items-center justify-between gap-2">
        {showHeading && <h3 className="text-sm font-semibold">{t(`${K}.tasks`)}</h3>}
        <LinkButton appearance="ghost" href={`/${language}/ukoly`} severity="secondary" size="sm">
          {t(`${K}.openTasks`)}
        </LinkButton>
      </div>
      {tasks === undefined && <p className={mutedClass}>{t(`${K}.notLoaded`)}</p>}
      {tasks !== undefined && unitTasks.length === 0 && <p className={mutedClass}>{t(`${K}.noTasks`)}</p>}
      {unitTasks.map((task) => (
        <div className={rowClass} key={task.ref.resourceId}>
          <div className="min-w-0">
            <Link
              className="block font-medium text-inherit no-underline"
              href={`/${language}/ukoly?resourceId=${task.ref.resourceId}`}
              size="current"
            >
              {task.title} →
            </Link>
            {task.dueDate !== undefined && (
              <span className={mutedClass}>{t(`${K}.due`, { date: formatDay(task.dueDate) })}</span>
            )}
          </div>
          <Badge severity={taskBadge[task.state]} size="sm">
            {t(`${K}.taskStates.${task.state}`)}
          </Badge>
        </div>
      ))}
    </section>
  );
};

/** Leases, contracts and service tasks of one unit, each linking to its owner's detail. */
export const UnitStory = ({
  agreements,
  language,
  leaseBlock,
  occupancy,
  section,
  t,
  tasks,
  unit,
  unitAssets,
}: UnitStoryProps) => (
  <div className={section === undefined ? 'grid gap-4 lg:grid-cols-3' : undefined}>
    {(section === undefined || section === 'leases') && (
      <LeaseSection
        language={language}
        leaseBlock={leaseBlock}
        occupancy={occupancy}
        showHeading={section === undefined}
        t={t}
        unit={unit}
      />
    )}
    {(section === undefined || section === 'agreements') && (
      <AgreementSection
        agreements={agreements}
        language={language}
        showHeading={section === undefined}
        t={t}
        unit={unit}
      />
    )}
    {(section === undefined || section === 'tasks') && (
      <TaskSection
        language={language}
        showHeading={section === undefined}
        t={t}
        tasks={tasks}
        unit={unit}
        unitAssets={unitAssets}
      />
    )}
  </div>
);
