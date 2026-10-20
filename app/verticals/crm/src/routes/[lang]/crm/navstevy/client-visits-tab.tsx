// Client-card "Návštěvy" tab. OWNER: crm-visits (first read-only version committed by crm-clients; rewrite
// freely, keep the export name and ClientCardTabProps).
import { EmptyState, formatDateTime } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import type { ClientCardTabProps } from '../klienti/card-tab-props.ts';
import { salespersonName } from '../../../../crm/records.ts';

const kindLabel: Record<string, string> = { call: 'Telefonát', email: 'E-mail', video: 'Videohovor', visit: 'Návštěva' };

export const ClientVisitsTab = ({ client, records }: ClientCardTabProps) => {
  const visits = records.state.visits.items
    .filter((visit) => visit.clientId === client.id)
    .toSorted((left, right) => right.occurredAt.localeCompare(left.occurredAt));
  if (visits.length === 0) {
    return <EmptyState description="U klienta zatím není zapsaná žádná návštěva." title="Bez návštěv" />;
  }
  return (
    <ol className="flex flex-col gap-150">
      {visits.map((visit) => (
        <li className="flex flex-col gap-50 rounded-lg border border-border-primary p-200" key={visit.id}>
          <div className="flex flex-wrap items-center gap-100 text-sm">
            <Badge size="sm" variant="outline">
              {kindLabel[visit.kind] ?? visit.kind}
            </Badge>
            <span className="font-medium">{formatDateTime(visit.occurredAt)}</span>
            <span className="text-fg-secondary">
              {salespersonName(records, visit.salespersonId) ?? 'údaj neposkytnut'}
            </span>
          </div>
          <p className="text-sm">{visit.result}</p>
          {visit.note === undefined ? null : <p className="text-fg-secondary text-sm">{visit.note}</p>}
        </li>
      ))}
    </ol>
  );
};
