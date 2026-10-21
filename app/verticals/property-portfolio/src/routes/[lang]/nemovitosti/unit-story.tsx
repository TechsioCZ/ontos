import type { executeRecords as readAgreements } from '@app/legal-agreements/clients/records';
import type { executeRecords as readOccupancy } from '@app/property-leasing/clients/records';
import type { Task } from '@app/work-tasks/contracts/records';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { DateTime } from 'effect';
import type { Effect } from 'effect';

import type { RecordsResponse } from '../../../../../shared/apis/records';

type Translate = (key: string, options?: Record<string, unknown>) => string;
type Occupancies = Effect.Success<ReturnType<typeof readOccupancy>>;
type Agreements = Effect.Success<ReturnType<typeof readAgreements>>;
type Unit = RecordsResponse['units'][number];

const K = 'property-portfolio.pages.records.unitStory';

export type LeaseBlock = 'building' | 'outOfService' | 'retired';
const cardClass =
  'ontos-tile rounded-lg bg-surface [&_.ontos-tile]:bg-base propertyportfolio:min-w-0 propertyportfolio:space-y-3 propertyportfolio:p-4';
const rowClass =
  'propertyportfolio:flex propertyportfolio:flex-wrap propertyportfolio:items-center propertyportfolio:justify-between propertyportfolio:gap-2 propertyportfolio:py-3 propertyportfolio:text-sm border-b border-border-primary/60 last:border-b-0';
const mutedClass = 'propertyportfolio:text-sm propertyportfolio:text-(--color-fg-secondary)';
const occupancyBadge = {
  ACTIVE: 'success',
  CANCELLED: 'danger',
  COMPLETED: 'secondary',
  CONFIRMED: 'info',
  DRAFT: 'outline',
} as const;
const contractBadge = { ACTIVE: 'success', DRAFT: 'outline', EXPIRED: 'warning', TERMINATED: 'danger' } as const;
const taskBadge = {
  CANCELLED: 'secondary',
  DONE: 'success',
  IN_PROGRESS: 'info',
  NEW: 'outline',
  WAITING: 'warning',
} as const;
const money = new Intl.NumberFormat('cs-CZ', { currency: 'CZK', maximumFractionDigits: 0, style: 'currency' });
const date = new Intl.DateTimeFormat('cs-CZ', { dateStyle: 'medium', timeZone: 'UTC' });
const formatDay = (value: string | null | undefined) =>
  value === null || value === undefined
    ? '—'
    : date.format(DateTime.toEpochMillis(DateTime.makeUnsafe(`${value}T00:00:00Z`)));

/** Today's calendar date in Prague, used for unit availability instead of a fixed demo date. */
export const pragueToday = () =>
  new Intl.DateTimeFormat('sv-SE', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Europe/Prague',
    year: 'numeric',
  }).format(DateTime.toEpochMillis(DateTime.nowUnsafe()));

/** Leases, contracts and service tasks of one unit, each linking to its owner's detail. */
export const UnitStory = ({
  agreements,
  leaseBlock,
  language,
  occupancy,
  t,
  tasks,
  unit,
}: {
  readonly agreements: Agreements | undefined;
  /**
   * Why the unit cannot be let, or undefined when it can: retired or archived units, units out of service and units
   * of a building out of operation get no lease-creation link and never claim to be free to let.
   */
  readonly leaseBlock: LeaseBlock | undefined;
  readonly language: string;
  readonly occupancy: Occupancies | undefined;
  readonly t: Translate;
  readonly tasks: readonly Task[] | undefined;
  readonly unit: Unit;
}) => {
  const leases = (occupancy?.occupancies ?? [])
    .filter((item) => item.unitRef.resourceId === unit.unitRef.resourceId)
    .toSorted((left, right) => right.startDate.localeCompare(left.startDate));
  const contracts = (agreements?.contracts ?? [])
    .filter((item) => item.unitRef?.resourceId === unit.unitRef.resourceId)
    .toSorted((left, right) => right.startDate.localeCompare(left.startDate));
  const unitTasks = (tasks ?? []).filter((task) =>
    task.contextRefs.some(
      (ref) => ref.resourceType === unit.unitRef.resourceType && ref.resourceId === unit.unitRef.resourceId,
    ),
  );
  return (
    <div className="propertyportfolio:grid propertyportfolio:gap-4 propertyportfolio:lg:grid-cols-3">
      <section aria-label={t(`${K}.leases`)} className={cardClass}>
        <div className="propertyportfolio:flex propertyportfolio:items-center propertyportfolio:justify-between propertyportfolio:gap-2">
          <h3 className="propertyportfolio:text-sm propertyportfolio:font-semibold">{t(`${K}.leases`)}</h3>
          {leaseBlock === undefined && (
            <LinkButton
              href={`/${language}/najmy?create=lease&unitId=${unit.unitRef.resourceId}`}
              size="sm"
              theme="borderless"
              variant="secondary"
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
            <div className="propertyportfolio:min-w-0">
              <span className="propertyportfolio:block propertyportfolio:font-medium">
                {formatDay(item.startDate)} – {item.endDate === null ? t(`${K}.openEnd`) : formatDay(item.endDate)}
              </span>
              <span className={mutedClass}>
                {item.rentTerms === undefined
                  ? t(`${K}.noRent`)
                  : t(`${K}.rent`, {
                      amount: money.format(
                        (item.rentTerms.monthlyRentMinor + item.rentTerms.serviceChargesMinor) / 100,
                      ),
                    })}
              </span>
            </div>
            <div className="propertyportfolio:flex propertyportfolio:items-center propertyportfolio:gap-2">
              <Badge size="sm" variant={occupancyBadge[item.state]}>
                {t(`property-portfolio.pages.records.occupancyStates.${item.state}`)}
              </Badge>
              <LinkButton
                href={`/${language}/najmy?resourceId=${item.occupancyRef.resourceId}`}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                {t(`${K}.openLease`)}
              </LinkButton>
            </div>
          </div>
        ))}
      </section>
      <section aria-label={t(`${K}.contracts`)} className={cardClass}>
        <h3 className="propertyportfolio:text-sm propertyportfolio:font-semibold">{t(`${K}.contracts`)}</h3>
        {agreements === undefined && <p className={mutedClass}>{t(`${K}.notLoaded`)}</p>}
        {agreements !== undefined && contracts.length === 0 && <p className={mutedClass}>{t(`${K}.noContracts`)}</p>}
        {contracts.map((item) => (
          <div className={rowClass} key={item.contractRef.resourceId}>
            <div className="propertyportfolio:min-w-0">
              <span className="propertyportfolio:block propertyportfolio:font-medium">
                {item.subject ?? t(`${K}.contract`)}
              </span>
              <span className={mutedClass}>
                {formatDay(item.startDate)} – {item.endDate === null ? t(`${K}.openEnd`) : formatDay(item.endDate)}
              </span>
            </div>
            <div className="propertyportfolio:flex propertyportfolio:items-center propertyportfolio:gap-2">
              <Badge size="sm" variant={contractBadge[item.lifecycleState]}>
                {t(`property-portfolio.pages.records.agreementStates.${item.lifecycleState}`)}
              </Badge>
              {item.expiringSoon && (
                <Badge size="sm" variant="warning">
                  {t(`${K}.expiring`)}
                </Badge>
              )}
              <LinkButton
                href={`/${language}/smlouvy?resourceId=${item.contractRef.resourceId}`}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                {t(`${K}.openContract`)}
              </LinkButton>
            </div>
          </div>
        ))}
      </section>
      <section aria-label={t(`${K}.tasks`)} className={cardClass}>
        <div className="propertyportfolio:flex propertyportfolio:items-center propertyportfolio:justify-between propertyportfolio:gap-2">
          <h3 className="propertyportfolio:text-sm propertyportfolio:font-semibold">{t(`${K}.tasks`)}</h3>
          <LinkButton href={`/${language}/ukoly`} size="sm" theme="borderless" variant="secondary">
            {t(`${K}.openTasks`)}
          </LinkButton>
        </div>
        {tasks === undefined && <p className={mutedClass}>{t(`${K}.notLoaded`)}</p>}
        {tasks !== undefined && unitTasks.length === 0 && <p className={mutedClass}>{t(`${K}.noTasks`)}</p>}
        {unitTasks.map((task) => (
          <div className={rowClass} key={task.ref.resourceId}>
            <div className="propertyportfolio:min-w-0">
              <a
                className="propertyportfolio:block propertyportfolio:font-medium"
                href={`/${language}/ukoly?resourceId=${task.ref.resourceId}`}
              >
                {task.title} →
              </a>
              {task.dueDate !== undefined && (
                <span className={mutedClass}>{t(`${K}.due`, { date: formatDay(task.dueDate) })}</span>
              )}
            </div>
            <Badge size="sm" variant={taskBadge[task.state]}>
              {t(`${K}.taskStates.${task.state}`)}
            </Badge>
          </div>
        ))}
      </section>
    </div>
  );
};
