// AREA: visits — owned by the crm-visits lane. Chronological timeline of visits (C02), grouped by month.
import { Badge } from '@techsio/ui-kit/atoms/badge';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { Visit } from '../../../../../shared/domain/visits.ts';
import {
  clientLabel,
  formatClock,
  formatVisitDay,
  groupByMonth,
  principalLabel,
  salespersonLabel,
  visitKindMeta,
} from './visits-model.ts';

export const VisitKindIcon = ({ kind }: { readonly kind: Visit['kind'] }) => {
  const meta = visitKindMeta[kind];
  return (
    <span
      aria-hidden="true"
      className={`flex size-400 shrink-0 items-center justify-center rounded-full ${meta.tone}`}
      title={meta.label}
    >
      <span className={`${meta.icon} size-250`} />
    </span>
  );
};

export const VisitKindBadge = ({ kind }: { readonly kind: Visit['kind'] }) => (
  <span className="inline-flex items-center gap-100 text-sm">
    <span aria-hidden="true" className={`${visitKindMeta[kind].icon} size-200 text-fg-secondary`} />
    {visitKindMeta[kind].label}
  </span>
);

const TimelineEntry = ({
  onOpen,
  records,
  showClient,
  visit,
}: {
  readonly onOpen: (visit: Visit) => void;
  readonly records: RecordsResponse;
  readonly showClient: boolean;
  readonly visit: Visit;
}) => {
  const author = principalLabel(records, visit.authorPrincipalId);
  const salesperson = salespersonLabel(records, visit.salespersonId);
  return (
    <li className="relative flex gap-200 pb-300 last:pb-0">
      <span aria-hidden="true" className="absolute top-450 bottom-0 left-200 w-px bg-border-primary" />
      <VisitKindIcon kind={visit.kind} />
      <button
        className="flex min-w-0 flex-1 cursor-pointer flex-col gap-50 rounded-md p-100 text-start hover:bg-fill-hover focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => onOpen(visit)}
        type="button"
      >
        <span className="flex flex-wrap items-center gap-x-150 gap-y-50 text-fg-secondary text-xs">
          <span className="font-medium text-fg-primary">
            {formatVisitDay(visit.occurredAt)} · {formatClock(visit.occurredAt)}
          </span>
          <span>{visitKindMeta[visit.kind].label}</span>
          {showClient && <span className="font-medium text-fg-primary">{clientLabel(records, visit.clientId)}</span>}
          <span>{salesperson}</span>
          {visit.corrections.length > 0 && (
            <Badge size="sm" variant="warning">
              {`Opraveno ${visit.corrections.length}×`}
            </Badge>
          )}
          {visit.planItemId !== undefined && (
            <Badge size="sm" variant="info">
              Z plánu
            </Badge>
          )}
        </span>
        <span className="font-semibold text-sm">{visit.result}</span>
        {visit.note !== undefined && <span className="line-clamp-2 text-fg-secondary text-sm">{visit.note}</span>}
        {visit.nextStep !== undefined && (
          <span className="flex items-center gap-100 text-sm">
            <span aria-hidden="true" className="icon-[mdi--arrow-right-circle-outline] size-200 text-primary" />
            <span>
              {visit.nextStep}
              {visit.nextStepDate === undefined ? '' : ` · do ${formatVisitDay(`${visit.nextStepDate}T12:00:00.000Z`)}`}
            </span>
          </span>
        )}
        {records.state.salespeople.find((person) => person.id === visit.salespersonId)?.principalId !==
          visit.authorPrincipalId && <span className="text-fg-secondary text-xs">{`Zapsal(a): ${author}`}</span>}
      </button>
    </li>
  );
};

/** Visits grouped by month, newest first. Clicking an entry opens its detail. */
export const VisitTimeline = ({
  onOpen,
  records,
  showClient = true,
  visits,
}: {
  readonly onOpen: (visit: Visit) => void;
  readonly records: RecordsResponse;
  readonly showClient?: boolean;
  readonly visits: readonly Visit[];
}) => (
  <div className="flex flex-col gap-300">
    {groupByMonth(visits).map((group) => (
      <section className="flex flex-col gap-150" key={group.key}>
        <h3 className="font-semibold text-fg-secondary text-xs uppercase tracking-wide">
          {`${group.label} · ${group.visits.length}`}
        </h3>
        <ol className="flex flex-col">
          {group.visits.map((visit) => (
            <TimelineEntry key={visit.id} onOpen={onOpen} records={records} showClient={showClient} visit={visit} />
          ))}
        </ol>
      </section>
    ))}
  </div>
);
