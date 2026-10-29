import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';
import { RecordsResponseSchema } from '../../shared/apis/records.ts';
import { initialCrmState, CrmStateSchema, projectCrmState } from '../../shared/domain/state.ts';
import {
  buildClientRows,
  clientQueryForViewer,
  clientMetricsForViewer,
  buildContactRows,
  filterClientRows,
  filterContactRows,
  metricQuery,
  metricCount,
  selectedMetric,
  resetClientFilters,
  parseClientQuery,
  serializeClientQuery,
} from '../../src/routes/[lang]/crm/klienti/client-filters.ts';

const at = '2026-10-29T12:00:00.000Z';
const client = (id: string, status = 'active', owner = 'a') => ({
  createdAt: at,
  createdBy: 'admin',
  id,
  kind: 'organization',
  name: `Firma ${id}`,
  ownerSalespersonId: owner,
  status,
  updatedAt: at,
});
const records = Schema.decodeUnknownSync(RecordsResponseSchema)({
  assignmentCandidates: [],
  departedPrincipalIds: [],
  now: at,
  revision: 1,
  state: {
    ...Schema.encodeSync(CrmStateSchema)(initialCrmState),
    clients: {
      assignmentHistory: [],
      contacts: [
        { clientId: 'x', createdAt: at, createdBy: 'admin', id: 'cx', name: 'Alice', status: 'active', updatedAt: at },
        { clientId: 'x', createdAt: at, createdBy: 'admin', id: 'cx2', name: 'Bob', status: 'active', updatedAt: at },
        { clientId: 'y', createdAt: at, createdBy: 'admin', id: 'cy', name: 'Carol', status: 'active', updatedAt: at },
        { clientId: 'z', createdAt: at, createdBy: 'admin', id: 'cz', name: 'Dora', status: 'active', updatedAt: at },
        {
          clientId: 'x',
          createdAt: at,
          createdBy: 'admin',
          id: 'old',
          name: 'Removed',
          status: 'archived',
          updatedAt: at,
        },
      ],
      items: [client('x'), client('y', 'active', 'b'), client('z', 'archived')],
    },
    salespeople: [{ active: true, id: 'a', name: 'Anna', principalId: 'rep' }],
  },
  viewer: {
    assign: true,
    principalId: 'admin',
    readAll: true,
    readAssigned: false,
    writeAll: true,
    writeAssigned: false,
  },
});

describe('client counted filters over governed records', () => {
  it('opens person rows, not clients, for the contacts count', () => {
    const query = metricQuery('contacts');
    expect(metricCount(records, 'contacts')).toBe(3);
    expect(filterContactRows(records, buildContactRows(records), query.filters).map((row) => row.contact.id)).toEqual([
      'cx',
      'cx2',
      'cy',
    ]);
  });
  it('keeps zero-result shortcuts empty and makes every shortcut count its destination rows', () => {
    expect(metricCount(records, 'linkedActive')).toBe(0);
    expect(metricCount(records, 'activeClients')).toBe(2);
    expect(metricCount(records, 'archivedClients')).toBe(1);
    for (const metric of clientMetricsForViewer(records.viewer)) {
      const query = metricQuery(metric);
      const rows =
        query.entity === 'contact'
          ? filterContactRows(records, buildContactRows(records), query.filters)
          : filterClientRows(records, buildClientRows(records), query.filters);
      expect(rows.length).toBe(metricCount(records, metric));
    }
  });

  it('clears the linked shortcut selection when reset restores active clients', () => {
    const linked = metricQuery('linkedActive');
    expect(selectedMetric(linked, records.viewer)).toBe('linkedActive');
    const reset = resetClientFilters(linked);
    expect(selectedMetric(reset, records.viewer)).toBe('activeClients');
    expect(filterClientRows(records, buildClientRows(records), reset.filters)).toHaveLength(2);
    expect(
      selectedMetric({ ...linked, filters: { ...linked.filters, search: 'Firma' } }, records.viewer),
    ).toBeUndefined();
  });

  it('keeps person rows on reset and searches the individual person, not their siblings', () => {
    const query = parseClientQuery('?zaznamy=contact&hledat=Alice');
    expect(filterContactRows(records, buildContactRows(records), query.filters).map((row) => row.contact.id)).toEqual([
      'cx',
    ]);
    const reset = resetClientFilters(query);
    expect(reset.entity).toBe('contact');
    expect(selectedMetric(reset, records.viewer)).toBe('contacts');
  });

  it('uses the inclusive server-time window and counts a client only once for multiple visits', () => {
    const visit = (id: string, clientId: string, occurredAt: string) => ({
      authorPrincipalId: 'admin',
      clientId,
      corrections: [],
      createdAt: at,
      id,
      kind: 'visit',
      occurredAt,
      result: 'Done',
      salespersonId: 'a',
      updatedAt: at,
    });
    const timed = Schema.decodeUnknownSync(RecordsResponseSchema)({
      ...Schema.encodeSync(RecordsResponseSchema)(records),
      state: {
        ...Schema.encodeSync(CrmStateSchema)(records.state),
        visits: {
          items: [
            visit('vx', 'x', '2026-09-29T12:00:00.000Z'),
            visit('vx2', 'x', '2026-09-29T12:00:00.000Z'),
            visit('vy', 'y', '2026-10-29T12:00:00.001Z'),
          ],
          plan: [],
        },
      },
    });
    expect(metricCount(timed, 'contactedRecently')).toBe(1);
    expect(
      filterClientRows(timed, buildClientRows(timed), metricQuery('contactedRecently').filters).map(
        (row) => row.client.id,
      ),
    ).toEqual(['x']);
    const older = Schema.decodeUnknownSync(RecordsResponseSchema)({
      ...Schema.encodeSync(RecordsResponseSchema)(timed),
      now: '2026-10-29T12:00:00.000Z',
      state: {
        ...Schema.encodeSync(CrmStateSchema)(timed.state),
        visits: { items: [visit('vx', 'x', '2026-09-29T11:59:59.999Z')], plan: [] },
      },
    });
    expect(metricCount(older, 'contactedRecently')).toBe(0);
  });

  it('derives counts and person rows from the server ACL projection and real viewer permissions', () => {
    const rep = Schema.decodeUnknownSync(RecordsResponseSchema)({
      ...Schema.encodeSync(RecordsResponseSchema)(records),
      viewer: {
        assign: false,
        principalId: 'rep',
        readAll: false,
        readAssigned: true,
        salespersonId: 'a',
        writeAll: false,
        writeAssigned: true,
      },
    });
    const scoped = { ...rep, state: projectCrmState(rep.state, rep.viewer) };
    expect(metricCount(scoped, 'activeClients')).toBe(1);
    expect(metricCount(scoped, 'contacts')).toBe(2);
    expect(buildContactRows(scoped).map((row) => row.contact.name)).not.toContain('Carol');
    expect(clientMetricsForViewer(scoped.viewer)).not.toContain('linkedActive');
    const query = clientQueryForViewer(parseClientQuery('?obchodnik=b&evidence=linked'), scoped.viewer);
    expect(query.filters.owner).toBe('all');
    expect(query.filters.registry).toBe('all');
    expect(filterClientRows(scoped, buildClientRows(scoped), query.filters).map((row) => row.client.id)).toEqual(['x']);
  });

  it('round-trips business filters without changing detail links, unknown parameters or opaque IDs', () => {
    const query = parseClientQuery('?zaznamy=contact&obchodnik=00123&stav=all&hledat=Alice%20%26%20Bob&segment=custom');
    expect(query.filters.owner).toBe('00123');
    const result = serializeClientQuery('?klient=true&other=%7Bvalue%7D', query);
    expect(parseClientQuery(result)).toEqual(query);
    expect(result).toContain('klient=true');
    expect(result).toContain('other=%7Bvalue%7D');
    expect(parseClientQuery('?stav=invalid&kontakt=invalid&evidence=invalid&zaznamy=invalid')).toEqual(
      metricQuery('activeClients'),
    );
    expect(parseClientQuery('?obchodnik=00123&obchodnik=b').filters.owner).toBe('00123');
    const reset = serializeClientQuery(result, resetClientFilters(query));
    expect(reset).not.toContain('hledat=');
    expect(reset).not.toContain('obchodnik=');
    expect(reset).toContain('klient=true');
    expect(reset).toContain('zaznamy=contact');
  });

  it('does not broaden unknown owner or segment values to all records', () => {
    for (const search of ['?obchodnik=missing', '?segment=missing']) {
      expect(filterClientRows(records, buildClientRows(records), parseClientQuery(search).filters)).toHaveLength(0);
    }
  });
});
