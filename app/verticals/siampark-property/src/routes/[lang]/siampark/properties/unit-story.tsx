import type { executeRecords as readAgreements } from '@app/siampark-agreements/clients/records';
import type { executeRecords as readOccupancy } from '@app/siampark-occupancy/clients/records';
import type { Task } from '@app/siampark-work/contracts/records';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { DateTime } from 'effect';
import type { Effect } from 'effect';

import type { RecordsResponse } from '../../../../../shared/apis/records';

type Translate = (key: string, options?: Record<string, unknown>) => string;
type Occupancies = Effect.Success<ReturnType<typeof readOccupancy>>;
type Agreements = Effect.Success<ReturnType<typeof readAgreements>>;
type Unit = RecordsResponse['units'][number];

const K = 'siampark-property.pages.records.unitStory';
const cardClass =
  'siamparkproperty:min-w-0 siamparkproperty:space-y-3 siamparkproperty:rounded-lg siamparkproperty:border siamparkproperty:border-(--color-border-muted) siamparkproperty:bg-(--color-surface) siamparkproperty:p-4';
const rowClass =
  'siamparkproperty:flex siamparkproperty:flex-wrap siamparkproperty:items-center siamparkproperty:justify-between siamparkproperty:gap-2 siamparkproperty:rounded-md siamparkproperty:bg-(--color-surface-subtle) siamparkproperty:p-3 siamparkproperty:text-sm';
const mutedClass = 'siamparkproperty:text-sm siamparkproperty:text-(--color-fg-secondary)';
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
  canLease,
  language,
  occupancy,
  t,
  tasks,
  unit,
}: {
  readonly agreements: Agreements | undefined;
  /** False for retired or archived units and units of a building out of operation: no new lease is offered. */
  readonly canLease: boolean;
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
    <div className="siamparkproperty:grid siamparkproperty:gap-4 siamparkproperty:lg:grid-cols-3">
      <section aria-label={t(`${K}.leases`)} className={cardClass}>
        <div className="siamparkproperty:flex siamparkproperty:items-center siamparkproperty:justify-between siamparkproperty:gap-2">
          <h3 className="siamparkproperty:text-sm siamparkproperty:font-semibold">{t(`${K}.leases`)}</h3>
          {canLease && (
            <LinkButton
              href={`/${language}/siampark/occupancy?create=lease&unitId=${unit.unitRef.resourceId}`}
              size="sm"
              theme="borderless"
              variant="secondary"
            >
              {t(`${K}.newLease`)}
            </LinkButton>
          )}
        </div>
        {occupancy === undefined && <p className={mutedClass}>{t(`${K}.notLoaded`)}</p>}
        {occupancy !== undefined && leases.length === 0 && <p className={mutedClass}>{t(`${K}.noLeases`)}</p>}
        {leases.map((item) => (
          <div className={rowClass} key={item.occupancyRef.resourceId}>
            <div className="siamparkproperty:min-w-0">
              <span className="siamparkproperty:block siamparkproperty:font-medium">
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
            <div className="siamparkproperty:flex siamparkproperty:items-center siamparkproperty:gap-2">
              <Badge size="sm" variant={occupancyBadge[item.state]}>
                {t(`siampark-property.pages.records.occupancyStates.${item.state}`)}
              </Badge>
              <LinkButton
                href={`/${language}/siampark/occupancy?resourceId=${item.occupancyRef.resourceId}`}
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
        <h3 className="siamparkproperty:text-sm siamparkproperty:font-semibold">{t(`${K}.contracts`)}</h3>
        {agreements === undefined && <p className={mutedClass}>{t(`${K}.notLoaded`)}</p>}
        {agreements !== undefined && contracts.length === 0 && <p className={mutedClass}>{t(`${K}.noContracts`)}</p>}
        {contracts.map((item) => (
          <div className={rowClass} key={item.contractRef.resourceId}>
            <div className="siamparkproperty:min-w-0">
              <span className="siamparkproperty:block siamparkproperty:font-medium">
                {item.subject ?? t(`${K}.contract`)}
              </span>
              <span className={mutedClass}>
                {formatDay(item.startDate)} – {item.endDate === null ? t(`${K}.openEnd`) : formatDay(item.endDate)}
              </span>
            </div>
            <div className="siamparkproperty:flex siamparkproperty:items-center siamparkproperty:gap-2">
              <Badge size="sm" variant={contractBadge[item.lifecycleState]}>
                {t(`siampark-property.pages.records.agreementStates.${item.lifecycleState}`)}
              </Badge>
              {item.expiringSoon && (
                <Badge size="sm" variant="warning">
                  {t(`${K}.expiring`)}
                </Badge>
              )}
              <LinkButton
                href={`/${language}/siampark/agreements?resourceId=${item.contractRef.resourceId}`}
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
        <div className="siamparkproperty:flex siamparkproperty:items-center siamparkproperty:justify-between siamparkproperty:gap-2">
          <h3 className="siamparkproperty:text-sm siamparkproperty:font-semibold">{t(`${K}.tasks`)}</h3>
          <LinkButton href={`/${language}/siampark/work`} size="sm" theme="borderless" variant="secondary">
            {t(`${K}.openTasks`)}
          </LinkButton>
        </div>
        {tasks === undefined && <p className={mutedClass}>{t(`${K}.notLoaded`)}</p>}
        {tasks !== undefined && unitTasks.length === 0 && <p className={mutedClass}>{t(`${K}.noTasks`)}</p>}
        {unitTasks.map((task) => (
          <div className={rowClass} key={task.ref.resourceId}>
            <div className="siamparkproperty:min-w-0">
              <a
                className="siamparkproperty:block siamparkproperty:font-medium"
                href={`/${language}/siampark/work?resourceId=${task.ref.resourceId}`}
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
