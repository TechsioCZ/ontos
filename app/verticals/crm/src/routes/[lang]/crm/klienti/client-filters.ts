// Counted client filters over the server-authorized CRM projection. URL filters never grant access.
import { matchesSearch } from '@app/admin-ui';
import { DateTime, Option, Schema } from 'effect';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { Client, ContactPerson } from '../../../../../shared/domain/clients.ts';
import {
  activeContactsOf,
  cityOf,
  clientMatches,
  clientSegments,
  lastVisitOf,
  partyLinked,
  primaryContactOf,
} from './clients-model.ts';
import { canSeeEverything } from '../../../../../shared/domain/access.ts';
import type { CrmRouteSearch } from '../../../../../shared/route-search.ts';
import { CrmQueryStringSchema, mergeCrmRouteSearch } from '../../../../../shared/route-search.ts';
import type { CrmViewer } from '../../../../../shared/domain/access.ts';

/** Every vocabulary is a runtime array, so a hand-edited URL value is validated, never trusted. */
export const kpiEntities = ['client', 'contact'] as const;
export type ClientEntity = (typeof kpiEntities)[number];

export const kpiStatuses = ['active', 'archived', 'all'] as const;
export type ClientStatusFilter = (typeof kpiStatuses)[number];

export const kpiRegistryFilters = ['all', 'linked', 'unlinked'] as const;
export type ClientRegistryFilter = (typeof kpiRegistryFilters)[number];

/** `recent30` is the "contacted within 30 days" filter of the contacted-clients metric. */
export const kpiRecencyFilters = ['all', 'recent30'] as const;
export type ClientRecencyFilter = (typeof kpiRecencyFilters)[number];

export const kpiMetricIds = [
  'activeClients',
  'archivedClients',
  'unassignedClients',
  'contacts',
  'contactedRecently',
  'linkedActive',
  'unlinkedActive',
] as const;
export type ClientMetric = (typeof kpiMetricIds)[number];

export const defaultMetricId: ClientMetric = 'activeClients';

export const KPI_ALL = 'all';
export const KPI_UNASSIGNED = 'none';

const RECENT_WINDOW_DAYS = 30;

export interface ClientFilters {
  /** `all`, `none` (bez obchodníka) or a salesperson id of the authorized records. */
  readonly owner: string;
  readonly recency: ClientRecencyFilter;
  readonly registry: ClientRegistryFilter;
  readonly search: string;
  /** `all` or one of `clientSegments`. */
  readonly segment: string;
  readonly status: ClientStatusFilter;
}

export const defaultClientFilters: ClientFilters = {
  owner: KPI_ALL,
  recency: 'all',
  registry: 'all',
  search: '',
  segment: KPI_ALL,
  status: 'active',
};

/** Which role sees the metric. Owner and linkage cards never expose full firm totals to the assigned viewer. */
const metricVisibility = {
  activeClients: 'all',
  archivedClients: 'all',
  contactedRecently: 'all',
  contacts: 'all',
  linkedActive: 'manager',
  unassignedClients: 'manager',
  unlinkedActive: 'manager',
} satisfies Record<ClientMetric, 'manager' | 'all'>;

const metricEntity = {
  activeClients: 'client',
  archivedClients: 'client',
  contactedRecently: 'client',
  contacts: 'contact',
  linkedActive: 'client',
  unassignedClients: 'client',
  unlinkedActive: 'client',
} satisfies Record<ClientMetric, ClientEntity>;

/**
 * The exact filter patch a metric means. Count and destination both read this, so the number on the card is
 * always the number of rows the destination shows (zero stays zero, never a fallback to all rows).
 */
const metricTarget = {
  activeClients: () => ({ status: 'active' }),
  archivedClients: () => ({ status: 'archived' }),
  contactedRecently: () => ({ recency: 'recent30', status: 'active' }),
  contacts: () => ({ status: 'active' }),
  linkedActive: () => ({ registry: 'linked', status: 'active' }),
  unassignedClients: () => ({ owner: KPI_UNASSIGNED, status: 'active' }),
  unlinkedActive: () => ({ registry: 'unlinked', status: 'active' }),
} satisfies Record<ClientMetric, (records: RecordsResponse) => Partial<ClientFilters>>;

export const kpiMetricEntity = (metricId: ClientMetric): ClientEntity => metricEntity[metricId];

export const kpiMetricVisible = (viewer: CrmViewer, metricId: ClientMetric): boolean => {
  const visibility = metricVisibility[metricId];
  return visibility === 'all' || canSeeEverything(viewer);
};

/** Counted filters visible to the authenticated viewer. */
export const clientMetricsForViewer = (viewer: CrmViewer): readonly ClientMetric[] =>
  kpiMetricIds.filter((metricId) => kpiMetricVisible(viewer, metricId));

/** Exact filters of a metric, ready to replace the current ones when the metric is opened. */
export const kpiMetricFilters = (metricId: ClientMetric): ClientFilters => ({
  ...defaultClientFilters,
  ...metricTarget[metricId](),
});

export interface ClientRow {
  readonly city: string | undefined;
  readonly client: Client;
  readonly contactCount: number;
  readonly lastVisit: DateTime.Utc | undefined;
  readonly owner: string | undefined;
  readonly primaryContact: { readonly name: string; readonly role: string | undefined } | undefined;
  /** Last contact within the fixed 30-day window of `records.now`. */
  readonly recent: boolean;
}

export interface ContactRow {
  readonly client: Client;
  readonly clientRow: ClientRow;
  readonly contact: ContactPerson;
}

/** The server clock owns the inclusive 30-day window. Future contacts do not count. */
export const contactedRecently = (records: RecordsResponse, lastVisit: DateTime.Utc | undefined): boolean => {
  if (lastVisit === undefined) {
    return false;
  }
  const cutoff = DateTime.add(records.now, { days: -RECENT_WINDOW_DAYS });
  return !DateTime.isLessThan(lastVisit, cutoff) && !DateTime.isGreaterThan(lastVisit, records.now);
};

export const buildClientRows = (records: RecordsResponse): ClientRow[] =>
  records.state.clients.items.map((client) => {
    const primary = primaryContactOf(records, client.id);
    const lastVisit = lastVisitOf(records, client.id);
    return {
      city: cityOf(client.address),
      client,
      contactCount: activeContactsOf(records, client.id).length,
      lastVisit,
      owner: records.state.salespeople.find((person) => person.id === client.ownerSalespersonId)?.name,
      primaryContact: primary === undefined ? undefined : { name: primary.name, role: primary.role },
      recent: contactedRecently(records, lastVisit),
    };
  });

/** Contact rows of the visible clients only, each carrying the owning client and its client row. */
export const buildContactRows = (records: RecordsResponse): ContactRow[] =>
  buildClientRows(records).flatMap((clientRow) =>
    activeContactsOf(records, clientRow.client.id).map((contact) => ({
      client: clientRow.client,
      clientRow,
      contact,
    })),
  );

export const clientRowMatches = (records: RecordsResponse, row: ClientRow, filters: ClientFilters): boolean =>
  (filters.status === 'all' || row.client.status === filters.status) &&
  (filters.owner === KPI_ALL ||
    (filters.owner === KPI_UNASSIGNED
      ? row.client.ownerSalespersonId === undefined
      : row.client.ownerSalespersonId === filters.owner)) &&
  (filters.segment === KPI_ALL || row.client.segment === filters.segment) &&
  (filters.registry === KPI_ALL || (filters.registry === 'linked') === partyLinked(row.client)) &&
  (filters.recency === 'all' || row.recent) &&
  clientMatches(records, row.client, filters.search);

/** A contact row obeys the same client filters, then narrows on the person itself. */
export const contactRowMatches = (records: RecordsResponse, row: ContactRow, filters: ClientFilters): boolean =>
  clientRowMatches(records, row.clientRow, { ...filters, search: '' }) &&
  matchesSearch(
    [row.contact.name, row.contact.role, row.contact.email, row.contact.phone, row.client.name]
      .filter((part) => part !== undefined)
      .join(' | '),
    filters.search,
  );

export const filterClientRows = (
  records: RecordsResponse,
  rows: readonly ClientRow[],
  filters: ClientFilters,
): ClientRow[] => rows.filter((row) => clientRowMatches(records, row, filters));

export const filterContactRows = (
  records: RecordsResponse,
  rows: readonly ContactRow[],
  filters: ClientFilters,
): ContactRow[] => rows.filter((row) => contactRowMatches(records, row, filters));

/** Destination rows of a metric: the same predicate that produced its number. */
export const kpiMetricClientRows = (records: RecordsResponse, metricId: ClientMetric): ClientRow[] =>
  metricEntity[metricId] === 'client'
    ? filterClientRows(records, buildClientRows(records), kpiMetricFilters(metricId))
    : [];

export const kpiMetricContactRows = (records: RecordsResponse, metricId: ClientMetric): ContactRow[] =>
  metricEntity[metricId] === 'contact'
    ? filterContactRows(records, buildContactRows(records), kpiMetricFilters(metricId))
    : [];

export const metricCount = (records: RecordsResponse, metricId: ClientMetric): number =>
  metricEntity[metricId] === 'contact'
    ? kpiMetricContactRows(records, metricId).length
    : kpiMetricClientRows(records, metricId).length;

const isStatus = Schema.is(Schema.Literals(kpiStatuses));
const isRegistry = Schema.is(Schema.Literals(kpiRegistryFilters));
const isRecency = Schema.is(Schema.Literals(kpiRecencyFilters));
const isSegment = Schema.is(Schema.Literals(clientSegments));

// Form values arrive as `string | undefined`; these reuse the guards above, so nothing is asserted.
export const kpiStatusOf = (value: string | undefined): ClientStatusFilter | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return isStatus(value) ? value : undefined;
};

export const kpiRegistryOf = (value: string | undefined): ClientRegistryFilter | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return isRegistry(value) ? value : undefined;
};

export const kpiRecencyOf = (value: string | undefined): ClientRecencyFilter | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return isRecency(value) ? value : undefined;
};

export const kpiSegmentOf = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return isSegment(value) ? value : undefined;
};

/** Two filter sets are equal when every applied filter matches; used to keep selected shortcuts consistent with the rows. */
export const sameClientFilters = (left: ClientFilters, right: ClientFilters): boolean =>
  left.owner === right.owner &&
  left.recency === right.recency &&
  left.registry === right.registry &&
  left.search === right.search &&
  left.segment === right.segment &&
  left.status === right.status;

/** Shareable list state. `klient` remains exclusively the existing client detail selection. */
export interface ClientQuery {
  readonly entity: ClientEntity;
  readonly filters: ClientFilters;
}

const isEntity = Schema.is(Schema.Literals(kpiEntities));
export const parseClientQuery = (search: string): ClientQuery => {
  const values = Option.getOrElse(Schema.decodeOption(CrmQueryStringSchema)(search), (): CrmRouteSearch => ({}));
  return {
    entity: isEntity(values.zaznamy) ? values.zaznamy : 'client',
    filters: {
      owner: values.obchodnik ?? KPI_ALL,
      recency: isRecency(values.kontakt) ? values.kontakt : 'all',
      registry: isRegistry(values.evidence) ? values.evidence : 'all',
      search: values.hledat ?? '',
      segment: values.segment ?? KPI_ALL,
      status: isStatus(values.stav) ? values.stav : 'active',
    },
  };
};

/** Retains detail deep links, unrelated query parameters and opaque IDs. */
export const serializeClientQuery = (search: string, query: ClientQuery): string =>
  mergeCrmRouteSearch(search, {
    evidence: query.filters.registry === 'all' ? undefined : query.filters.registry,
    hledat: query.filters.search === '' ? undefined : query.filters.search,
    kontakt: query.filters.recency === 'all' ? undefined : query.filters.recency,
    obchodnik: query.filters.owner === KPI_ALL ? undefined : query.filters.owner,
    segment: query.filters.segment === KPI_ALL ? undefined : query.filters.segment,
    stav: query.filters.status === 'active' ? undefined : query.filters.status,
    zaznamy: query.entity === 'client' ? undefined : query.entity,
  });

/** Hidden manager filters cannot linger after following a shared link as an assigned viewer. */
export const clientQueryForViewer = (query: ClientQuery, viewer: CrmViewer): ClientQuery =>
  canSeeEverything(viewer) ? query : { ...query, filters: { ...query.filters, owner: KPI_ALL, registry: 'all' } };

export const metricQuery = (metric: ClientMetric): ClientQuery => ({
  entity: kpiMetricEntity(metric),
  filters: kpiMetricFilters(metric),
});

/** Selection describes the applied predicates, not the last shortcut clicked. */
export const selectedMetric = (query: ClientQuery, viewer: CrmViewer): ClientMetric | undefined =>
  clientMetricsForViewer(viewer).find(
    (metric) => kpiMetricEntity(metric) === query.entity && sameClientFilters(query.filters, kpiMetricFilters(metric)),
  );

export const resetClientFilters = (query: ClientQuery): ClientQuery => ({ ...query, filters: defaultClientFilters });
