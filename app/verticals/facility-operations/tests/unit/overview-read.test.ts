// The overview read must show exactly what the browser used to compute from the full records read: same deadlines
// (none may silently disappear), same open incidents, same search rows and record counts, for every kind of
// principal, on the seeded Siampark data. Both sides go through their wire schema (encode -> JSON -> decode) like
// in production. The "legacy" functions below are the browser computation before the overview read existed.
import { expect, it, rstest } from '@rstest/core';
import type { OperationalScope } from '@app/core-runtime';
import { Effect, Schema } from 'effect';

rstest.mock('../../src/ui/ops-agenda/sources.ts', () => ({
  sourceKeys: ['property', 'occupancy', 'agreements', 'work', 'finance', 'ops', 'parties'],
}));
rstest.mock('@app/admin-ui', () => ({
  foldSearchText: (text: string) => text.normalize('NFD').replaceAll(/\p{M}/gu, '').toLocaleLowerCase('cs-CZ'),
  formatMoney: (value: number) => String(value),
}));

import { seedAgendaState } from '../../scripts/seed/agenda.mts';
import { seedAssetsState } from '../../scripts/seed/assets.mts';
import { seedDocumentsState } from '../../scripts/seed/documents.mts';
import { seedMetersState } from '../../scripts/seed/meters.mts';
import { seedPurchasingState } from '../../scripts/seed/purchasing.mts';
import { seedSecurityState } from '../../scripts/seed/security.mts';
import { agendaIds } from '../../shared/agendas.ts';
import { OverviewResponseSchema } from '../../shared/apis/overview.ts';
import { RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsResponse } from '../../shared/apis/records.ts';
import type { AgendaState } from '../../shared/domain/agenda.ts';
import { eventDeadlines, openOpsIncidents, opsAgendaDeadlines, opsRecordHref } from '../../shared/domain/ops-overview.ts';
import { finishFacilityOverview, finishFacilityRecords } from '../../src/services/persistence.service.ts';
import type { Grants, LoadedFacilityRecords } from '../../src/services/persistence.service.ts';
import { sortDeadlines } from '../../src/ui/ops-agenda/deadlines.ts';
import { buildDeadlines, buildKpis, buildSearchIndex } from '../../src/ui/ops-agenda/model.ts';
import type { RentalOverviewSources } from '../../src/ui/ops-agenda/sources.ts';

const tenantId = '70000000-0000-4000-8000-000000000020';
const legalEntityId = '71000000-0000-4000-8000-000000000021';
const principal = (suffix: string) => `72000000-0000-4000-8000-0000000000${suffix}`;
const today = '2026-10-22';

const seeded: LoadedFacilityRecords = {
  file: undefined,
  rows: new Map(
    Object.entries({
      agenda: seedAgendaState(),
      assets: seedAssetsState(),
      documents: seedDocumentsState(),
      meters: seedMetersState(),
      purchasing: seedPurchasingState(),
      security: seedSecurityState(),
    }).map(([agenda, state], index) => [
      agenda,
      // As stored: JSONB, so only JSON survives.
      { revision: index + 1, state: JSON.parse(JSON.stringify(state)) as unknown, updatedAt: new Date('2026-10-21T08:00:00Z') },
    ]),
  ),
};

const people: readonly { readonly name: string; readonly principalId: string; readonly grants: Grants }[] = [
  { grants: { readAll: true, readOperational: true, writeAll: true, writeOperational: true }, name: 'management', principalId: principal('21') },
  { grants: { readAll: true, readOperational: false, writeAll: false, writeOperational: false }, name: 'finance (read_all only)', principalId: principal('23') },
  { grants: { readAll: false, readOperational: true, writeAll: false, writeOperational: true }, name: 'operations (operational)', principalId: principal('22') },
  { grants: { readAll: false, readOperational: true, writeAll: false, writeOperational: false }, name: 'external partner', principalId: principal('24') },
  { grants: { readAll: false, readOperational: false, writeAll: false, writeOperational: false }, name: 'no grants', principalId: principal('25') },
];

const scopeOf = (principalId: string) => ({ legalEntityId, principalId, tenantId }) as unknown as OperationalScope;

/** What the browser receives: the server value encoded with the wire schema, sent as JSON and decoded again. */
const overWire = <S extends Schema.Codec<unknown, unknown>>(schema: S, value: S['Type']) =>
  Schema.encodeEffect(schema)(value).pipe(
    Effect.map((encoded) => JSON.parse(JSON.stringify(encoded)) as unknown),
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
  );

// ---- Legacy browser computation over the full records read (before the overview read) -------------------------

const legacyFold = (text: string) => text.normalize('NFD').replaceAll(/\p{M}/gu, '').toLocaleLowerCase('cs-CZ');

const legacyDeadlines = (records: RecordsResponse) => {
  const rows = [];
  for (const [agenda, envelope] of Object.entries(records.agendas)) {
    if (envelope === undefined) continue;
    rows.push(...(agenda === 'agenda' ? eventDeadlines((envelope.state as AgendaState).events) : opsAgendaDeadlines(agenda, envelope.state)));
  }
  return sortDeadlines(rows);
};

const legacyIncidents = (records: RecordsResponse) =>
  records.agendas.security === undefined
    ? undefined
    : Object.entries(records.agendas).flatMap(([agenda, envelope]) => (envelope === undefined ? [] : openOpsIncidents(agenda, envelope.state)));

const legacyRecordCount = (state: unknown) => {
  if (typeof state !== 'object' || state === null) return 0;
  const first = Object.values(state).find(Array.isArray);
  return Array.isArray(first) ? first.length : 0;
};

const legacySearchRows = (records: RecordsResponse) => {
  const loose = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : undefined;
  const opt = (value: string | null | undefined) => (value === null || value === undefined || value === '' ? {} : { subtitle: value });
  const row = (entry: { readonly title: string; readonly subtitle?: string; readonly id: string } & Record<string, unknown>, ...extra: readonly (string | null | undefined)[]) => ({
    ...entry,
    text: legacyFold([entry.title, entry.subtitle, entry.id, ...extra].filter((part) => typeof part === 'string').join(' ')),
  });
  const rows: unknown[] = [];
  for (const [agenda, envelope] of Object.entries(records.agendas)) {
    if (envelope === undefined) continue;
    if (agenda === 'agenda') {
      for (const event of (envelope.state as AgendaState).events) {
        rows.push(row({ href: `/provoz/agenda?event=${event.id}`, id: event.id, kind: 'event', source: 'ops', title: event.title, ...opt(event.date) }, event.note, event.related?.label));
      }
      continue;
    }
    for (const [field, list] of Object.entries(loose(envelope.state) ?? {})) {
      if (!Array.isArray(list) || /history|events|versions|readings|log|comments|threads|messages|preferences|exports|templates|signatures/iu.test(field)) continue;
      for (const entry of list) {
        const record = loose(entry);
        if (record === undefined || typeof record['id'] !== 'string') continue;
        const title = ['name', 'title', 'label', 'inventoryNumber', 'serialNumber', 'code', 'documentNumber', 'number', 'description', 'summary']
          .map((key) => record[key])
          .find((value): value is string => typeof value === 'string' && value !== '');
        if (title === undefined) continue;
        const extra = Object.values(record).filter((value): value is string => typeof value === 'string' && value.length < 200);
        const location = loose(record['location']) ?? loose(record['related']);
        rows.push(row({
          href: opsRecordHref(agenda, field, record['id']),
          id: record['id'],
          kind: 'ops',
          source: 'ops',
          title,
          ...opt(typeof location?.['label'] === 'string' ? location['label'] : undefined),
        }, agenda, ...extra));
      }
    }
  }
  return rows;
};

const absent = { status: 'unavailable' } as const;
const opsOnly = (ops: RentalOverviewSources['ops']): RentalOverviewSources => ({
  agreements: absent, finance: absent, occupancy: absent, ops, parties: absent, property: absent, sales: absent, work: absent,
});

for (const person of people) {
  it(`overview read equals the old browser computation on the seeded data: ${person.name}`, async () => {
    const scope = scopeOf(person.principalId);
    const records = await Effect.runPromise(
      finishFacilityRecords({}, seeded, person.grants, scope).pipe(Effect.flatMap((value) => overWire(RecordsResponseSchema, value))),
    );
    const overview = await Effect.runPromise(
      finishFacilityOverview({ includeSearch: true }, seeded, person.grants, scope).pipe(
        Effect.flatMap((value) => overWire(OverviewResponseSchema, value)),
      ),
    );
    const sources = opsOnly({ data: overview, status: 'ready' });

    // Deadlines: identical rows, so none disappears and none is invented.
    const expected = legacyDeadlines(records);
    const actual = buildDeadlines(sources, new Map());
    expect(actual).toEqual(expected);

    // Incidents (KPI + drill-down rows) and the upcoming-deadlines KPI.
    expect(overview.incidents).toEqual(legacyIncidents(records));
    const kpis = buildKpis(sources, new Map(), actual, today);
    const incidents = kpis.find((kpi) => kpi.id === 'incidents');
    expect(incidents?.value).toBe(legacyIncidents(records)?.length);

    // Search rows, in the same order.
    expect(buildSearchIndex(sources, new Map())).toEqual(legacySearchRows(records));

    // Calendar agenda envelope (events, own inbox and preferences) and the Přehled tiles.
    expect(overview.agenda).toEqual(records.agendas.agenda);
    expect(overview.access).toEqual(records.access);
    expect(overview.actorPrincipalRef).toEqual(records.actorPrincipalRef);
    expect(
      agendaIds.flatMap((agenda) => {
        const envelope = records.agendas[agenda];
        return envelope === undefined ? [] : [{ agenda, records: legacyRecordCount(envelope.state), revision: envelope.revision }];
      }).toSorted((left, right) => left.agenda.localeCompare(right.agenda)),
    ).toEqual(overview.agendas.toSorted((left, right) => left.agenda.localeCompare(right.agenda)));
  });
}

it('the seeded data exercises every part of the projection', async () => {
  const management = people[0]!;
  const overview = await Effect.runPromise(
    finishFacilityOverview({ includeSearch: true }, seeded, management.grants, scopeOf(management.principalId)),
  );
  const agendasWithDeadlines = new Set(overview.deadlines.map((row) => row.key.split(':')[0] === 'ops' ? row.key.split(':')[1] : 'agenda'));
  expect([...agendasWithDeadlines].toSorted()).toEqual(['agenda', 'assets', 'documents', 'purchasing', 'security']);
  expect(overview.incidents?.length).toBeGreaterThan(0);
  expect(overview.searchRows?.length).toBeGreaterThan(100);
  expect(overview.agendas).toHaveLength(6);
});

it('Moje agenda gets no search rows, and without security access no incident count', async () => {
  const operations = people[2]!;
  const overview = await Effect.runPromise(finishFacilityOverview({}, seeded, operations.grants, scopeOf(operations.principalId)));
  expect(overview.searchRows).toBeUndefined();
  expect(overview.incidents).toBeUndefined();
  expect(overview.deadlines.length).toBeGreaterThan(0);
});

it('the overview response is a fraction of the records read', async () => {
  const management = people[0]!;
  const scope = scopeOf(management.principalId);
  const size = <S extends Schema.Codec<unknown, unknown>>(schema: S, value: S['Type']) =>
    Schema.encodeEffect(schema)(value).pipe(Effect.map((encoded) => JSON.stringify(encoded).length));
  const records = await Effect.runPromise(finishFacilityRecords({}, seeded, management.grants, scope).pipe(Effect.flatMap((value) => size(RecordsResponseSchema, value))));
  const overview = await Effect.runPromise(
    finishFacilityOverview({ includeSearch: true }, seeded, management.grants, scope).pipe(Effect.flatMap((value) => size(OverviewResponseSchema, value))),
  );
  expect(overview).toBeLessThan(records / 2);
});
