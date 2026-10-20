// "Historie" tab: readable timeline of the client card — creation, edits, archive/restore, contact persons and
// every change of the salesperson with author, time and reason (C00-03, C01). Newest first.
import { EmptyState, formatDateTime } from '@app/admin-ui';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { Client } from '../../../../../shared/domain/clients.ts';
import { salespersonName } from '../../../../crm/records.ts';
import { eventLabels, fieldLabels, principalLabel } from './clients-model.ts';

interface TimelineEntry {
  readonly at: string;
  readonly by: string;
  readonly detail?: string;
  readonly icon: string;
  readonly id: string;
  readonly title: string;
}

const iconOf: Record<string, string> = {
  assigned: 'icon-[mdi--account-switch-outline]',
  client_archived: 'icon-[mdi--archive-outline]',
  client_created: 'icon-[mdi--star-four-points-outline]',
  client_restored: 'icon-[mdi--archive-arrow-up-outline]',
  client_updated: 'icon-[mdi--pencil-outline]',
  contact_added: 'icon-[mdi--account-plus-outline]',
  contact_removed: 'icon-[mdi--account-remove-outline]',
  contact_updated: 'icon-[mdi--account-edit-outline]',
};

const timelineOf = (records: RecordsResponse, client: Client): TimelineEntry[] => {
  const events = (records.state.clients.events ?? []).filter(
    (event) => event.clientId === client.id && event.kind !== 'assigned',
  );
  const entries: TimelineEntry[] = events.map((event) => {
    const fields = event.fields?.map((field) => fieldLabels[field] ?? field).join(', ');
    const subject = event.kind.startsWith('contact_') ? event.subject : undefined;
    const detail = [subject, fields === undefined ? undefined : `změněno: ${fields}`]
      .filter((part) => part !== undefined)
      .join(' · ');
    return {
      at: event.at,
      by: event.by,
      ...(detail === '' ? {} : { detail }),
      icon: iconOf[event.kind] ?? 'icon-[mdi--circle-small]',
      id: event.id,
      title: eventLabels[event.kind],
    };
  });
  if (!events.some((event) => event.kind === 'client_created')) {
    entries.push({
      at: client.createdAt,
      by: client.createdBy,
      icon: iconOf['client_created'] ?? '',
      id: `${client.id}-created`,
      title: eventLabels.client_created,
    });
  }
  for (const change of records.state.clients.assignmentHistory.filter((entry) => entry.clientId === client.id)) {
    const from = salespersonName(records, change.fromSalespersonId);
    const to = salespersonName(records, change.toSalespersonId) ?? 'bez obchodníka';
    entries.push({
      at: change.at,
      by: change.by,
      ...(change.reason === undefined ? {} : { detail: `Důvod: ${change.reason}` }),
      icon: iconOf['assigned'] ?? '',
      id: change.id,
      title: from === undefined ? `Přidělen obchodníkovi ${to}` : `Převeden: ${from} → ${to}`,
    });
  }
  return entries.toSorted((left, right) => right.at.localeCompare(left.at));
};

export const HistoryTab = ({ client, records }: { readonly client: Client; readonly records: RecordsResponse }) => {
  const entries = timelineOf(records, client);
  if (entries.length === 0) {
    return <EmptyState title="Bez historie" />;
  }
  return (
    <ol className="relative flex flex-col gap-200 ps-50">
      {entries.map((entry, index) => (
        <li className="relative flex gap-150" key={entry.id}>
          {index < entries.length - 1 && (
            <span aria-hidden className="absolute start-[0.95rem] top-9 bottom-[-1rem] w-px bg-border-primary" />
          )}
          <span className="z-10 inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-border-primary bg-surface">
            <span aria-hidden className={`${entry.icon} size-4 text-fg-secondary`} />
          </span>
          <div className="flex min-w-0 flex-col gap-25 pt-50">
            <span className="font-medium text-sm">{entry.title}</span>
            {entry.detail !== undefined && <span className="text-sm">{entry.detail}</span>}
            <span className="text-fg-secondary text-xs">
              {formatDateTime(entry.at)} · {principalLabel(records, entry.by)}
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
};
