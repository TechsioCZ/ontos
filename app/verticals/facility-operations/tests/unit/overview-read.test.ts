import { NodeServices } from '@effect/platform-node';
// The overview read must show exactly what the browser used to compute from the full records read: same deadlines
// (none may silently disappear), same open incidents, same search rows and record counts, for every kind of
// principal, on the seeded Siampark data. Both sides go through their wire schema (encode -> JSON -> decode) like
// in production. The "legacy" functions below are the browser computation before the overview read existed.
import { expect, it, rstest } from 'effect-rstest';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { Array as EffectArray, DateTime, Effect, Order, Schema, Struct } from 'effect';

import { seedAgendaState } from '../../scripts/seed/agenda.mts';
import { seedAssetsState } from '../../scripts/seed/assets.mts';
import { seedDocumentsState } from '../../scripts/seed/documents.mts';
import { seedMetersState } from '../../scripts/seed/meters.mts';
import { seedPurchasingState } from '../../scripts/seed/purchasing.mts';
import { seedSecurityState } from '../../scripts/seed/security.mts';
import { agendaIds } from '../../shared/agendas.ts';
import type { OpsAgendaSummary } from '../../shared/domain/ops-overview.ts';
import { OverviewResponseSchema } from '../../shared/apis/overview.ts';
import { RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsAgendas, RecordsResponse } from '../../shared/apis/records.ts';
import {
  eventDeadlines,
  openOpsIncidents,
  opsAgendaDeadlines,
  opsRecordHref,
} from '../../shared/domain/ops-overview.ts';
import { finishFacilityOverview, finishFacilityRecords } from '../../src/services/persistence.service.ts';
import type { Grants, LoadedFacilityRecords } from '../../src/services/persistence.service.ts';
import { sortDeadlines } from '../../src/ui/ops-agenda/deadlines.ts';
import { buildDeadlines, buildKpis, buildSearchIndex } from '../../src/ui/ops-agenda/model.ts';
import type { SearchRow } from '../../src/ui/ops-agenda/model.ts';
import type { RentalOverviewSources } from '../../src/ui/ops-agenda/sources.ts';

rstest.mock('../../src/ui/ops-agenda/sources.ts', () => ({
  sourceKeys: ['property', 'occupancy', 'agreements', 'work', 'finance', 'ops', 'parties'],
}));
rstest.mock('@app/admin-ui', () => ({
  foldSearchText: (text: string) => text.normalize('NFD').replaceAll(/\p{M}/gu, '').toLocaleLowerCase('cs-CZ'),
  formatMoney: String,
}));

const tenantId = '70000000-0000-4000-8000-000000000020';
const legalEntityId = '71000000-0000-4000-8000-000000000021';
const principal = (suffix: string) => `72000000-0000-4000-8000-0000000000${suffix}`;
const today = '2026-10-22';

const seeded = Effect.gen(function* overviewSeed() {
  const purchasing = yield* seedPurchasingState();
  const documents = yield* seedDocumentsState();
  const loaded: LoadedFacilityRecords = {
    rows: new Map(
      Object.entries({
        agenda: seedAgendaState(),
        assets: seedAssetsState(),
        documents,
        meters: seedMetersState(),
        purchasing,
        security: seedSecurityState(),
      }).map(([agenda, state], index) => [
        agenda,
        // As stored: JSONB, so only JSON survives.
        {
          revision: index + 1,
          state: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(JSON.stringify(state)),
          updatedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-21T08:00:00Z')),
        },
      ]),
    ),
  };
  return loaded;
});

const people: readonly { readonly grants: Grants; readonly name: string; readonly principalId: string }[] = [
  {
    grants: { readAll: true, readOperational: true, writeAll: true, writeOperational: true },
    name: 'management',
    principalId: principal('21'),
  },
  {
    grants: { readAll: true, readOperational: false, writeAll: false, writeOperational: false },
    name: 'finance (read_all only)',
    principalId: principal('23'),
  },
  {
    grants: { readAll: false, readOperational: true, writeAll: false, writeOperational: true },
    name: 'operations (operational)',
    principalId: principal('22'),
  },
  {
    grants: { readAll: false, readOperational: true, writeAll: false, writeOperational: false },
    name: 'external partner',
    principalId: principal('24'),
  },
  {
    grants: { readAll: false, readOperational: false, writeAll: false, writeOperational: false },
    name: 'no grants',
    principalId: principal('25'),
  },
];

const scopeOf = (principalId: string): OperationalScope => ({
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: principal('99'),
    authContextRef: 'session:facility-overview-fixture',
    authMethod: 'session',
    legalEntityId,
    principalId,
    tenantId,
  }),
  correlationId: 'facility-overview-fixture',
});

/** What the browser receives: the server value encoded with the wire schema, sent as JSON and decoded again. */
const overWire = <S extends Schema.Codec<unknown, unknown>>(schema: S, value: S['Type']) => {
  const wire = Schema.fromJsonString(schema);
  return Schema.encodeEffect(wire)(value).pipe(Effect.flatMap(Schema.decodeUnknownEffect(wire)));
};

// ---- Legacy browser computation over the full records read (before the overview read) -------------------------

const legacyFold = (text: string) => text.normalize('NFD').replaceAll(/\p{M}/gu, '').toLocaleLowerCase('cs-CZ');

const legacyDeadlines = (records: RecordsResponse) =>
  sortDeadlines(
    Object.entries(records.agendas).flatMap(([agenda, envelope]) => {
      if (envelope === undefined) {
        return [];
      }
      return agenda === 'agenda'
        ? eventDeadlines(records.agendas.agenda?.state.events ?? [])
        : opsAgendaDeadlines(agenda, envelope.state);
    }),
  );

const legacyIncidents = (records: RecordsResponse) =>
  records.agendas.security === undefined
    ? undefined
    : Object.entries(records.agendas).flatMap(([agenda, envelope]) =>
        envelope === undefined ? [] : openOpsIncidents(agenda, envelope.state),
      );

type LegacyAgendaState = NonNullable<RecordsAgendas[keyof RecordsAgendas]>['state'];
const compareAgendaSummary = (left: OpsAgendaSummary, right: OpsAgendaSummary) =>
  Order.String(left.agenda, right.agenda);

const legacyRecordCount = (state: LegacyAgendaState) => {
  const first = Object.values(state).find(Array.isArray);
  return Array.isArray(first) ? first.length : 0;
};

// Keep the old field-order/text-selection algorithm independent of the new projection.
// Every collection here comes from a state decoded by its owner in RecordsResponseSchema.
type LegacySearchState = NonNullable<RecordsAgendas[Exclude<keyof RecordsAgendas, 'agenda'>]>['state'];
type LegacyCollectionItem<Collection> = Collection extends readonly (infer Item)[] ? Item : never;
type LegacySearchRecord<State = LegacySearchState> = State extends LegacySearchState
  ? LegacyCollectionItem<State[keyof State]>
  : never;
type LegacyCollections = Readonly<Record<string, readonly LegacySearchRecord[] | undefined>>;

const legacyTitle = (record: LegacySearchRecord): string | undefined =>
  [
    'name' in record ? record.name : undefined,
    'title' in record ? record.title : undefined,
    'label' in record ? record.label : undefined,
    'inventoryNumber' in record ? record.inventoryNumber : undefined,
    'serialNumber' in record ? record.serialNumber : undefined,
    'code' in record ? record.code : undefined,
    'documentNumber' in record ? record.documentNumber : undefined,
    'number' in record ? record.number : undefined,
    'description' in record ? record.description : undefined,
    'summary' in record ? record.summary : undefined,
  ].find((value): value is string => Schema.is(Schema.String)(value) && value !== '');

const legacySubtitle = (value: string | null | undefined): Pick<SearchRow, 'subtitle'> =>
  value === null || value === undefined || value === '' ? {} : { subtitle: value };
const legacyRow = (entry: Omit<SearchRow, 'text'>, ...extra: readonly (string | null | undefined)[]): SearchRow => ({
  ...entry,
  text: legacyFold([entry.title, entry.subtitle, entry.id, ...extra].filter(Schema.is(Schema.String)).join(' ')),
});

const legacyRecordRow = (agenda: string, field: string, record: LegacySearchRecord): SearchRow[] => {
  const title = legacyTitle(record);
  if (title === undefined) {
    return [];
  }
  const values: readonly unknown[] = Object.values(record);
  const extra = values.filter((value): value is string => Schema.is(Schema.String)(value) && value.length < 200);
  const location =
    ('location' in record ? record.location : undefined) ?? ('related' in record ? record.related : undefined);
  return [
    legacyRow(
      {
        href: opsRecordHref(agenda, field, record.id),
        id: record.id,
        kind: 'ops',
        source: 'ops',
        title,
        ...legacySubtitle(location?.label),
      },
      agenda,
      ...extra,
    ),
  ];
};

const legacyCollectionRows = (agenda: string, state: LegacyCollections): SearchRow[] =>
  Object.entries(state).flatMap(([field, list]) => {
    if (
      list === undefined ||
      /history|events|versions|readings|log|comments|threads|messages|preferences|exports|templates|signatures/iu.test(
        field,
      )
    ) {
      return [];
    }
    return list.flatMap((record) => legacyRecordRow(agenda, field, record));
  });

const legacySearchRows = (records: RecordsResponse): SearchRow[] =>
  Struct.keys(records.agendas).flatMap((agenda) => {
    if (agenda === 'agenda') {
      return (records.agendas.agenda?.state.events ?? []).map((event) =>
        legacyRow(
          {
            href: `/provoz/agenda?event=${event.id}`,
            id: event.id,
            kind: 'event',
            source: 'ops',
            title: event.title,
            ...legacySubtitle(event.date),
          },
          event.note,
          event.related?.label,
        ),
      );
    }
    const envelope = records.agendas[agenda];
    return envelope === undefined ? [] : legacyCollectionRows(agenda, envelope.state);
  });

const wireSize = <S extends Schema.Codec<unknown, unknown>>(schema: S, value: S['Type']) =>
  Schema.encodeEffect(Schema.fromJsonString(schema))(value).pipe(Effect.map((encoded) => encoded.length));

const absent = { status: 'unavailable' } as const;
const opsOnly = (ops: RentalOverviewSources['ops']): RentalOverviewSources => ({
  agreements: absent,
  finance: absent,
  occupancy: absent,
  ops,
  parties: absent,
  property: absent,
  sales: absent,
  work: absent,
});

for (const person of people) {
  it.effect(`overview read equals the old browser computation on the seeded data: ${person.name}`, () =>
    Effect.gen(function* overviewRead1() {
      const loaded = yield* seeded;
      const scope = scopeOf(person.principalId);
      const records = yield* finishFacilityRecords({}, loaded, person.grants, scope).pipe(
        Effect.flatMap((value) => overWire(RecordsResponseSchema, value)),
      );
      const overview = yield* finishFacilityOverview({ includeSearch: true }, loaded, person.grants, scope).pipe(
        Effect.flatMap((value) => overWire(OverviewResponseSchema, value)),
      );
      const sources = opsOnly({ data: overview, status: 'ready' });

      // Deadlines: identical rows, so none disappears and none is invented.
      const expected = legacyDeadlines(records);
      const actual = buildDeadlines(sources, new Map());
      expect(actual).toEqual(expected);

      // Incidents (KPI + drill-down rows) and the upcoming-deadlines KPI.
      expect(overview.incidents).toEqual(legacyIncidents(records));
      const kpis = buildKpis({ deadlines: actual, names: new Map(), sources, today });
      const incidents = kpis.find((kpi) => kpi.id === 'incidents');
      expect(incidents?.value).toBe(legacyIncidents(records)?.length);

      // Search rows, in the same order.
      expect(buildSearchIndex(sources, new Map())).toEqual(legacySearchRows(records));

      // Calendar agenda envelope (events, own inbox and preferences) and the Přehled tiles.
      expect(overview.agenda).toEqual(records.agendas.agenda);
      expect(overview.access).toEqual(records.access);
      expect(overview.actorPrincipalRef).toEqual(records.actorPrincipalRef);
      expect(
        EffectArray.sort(
          agendaIds.flatMap((agenda) => {
            const envelope = records.agendas[agenda];
            return envelope === undefined
              ? []
              : [{ agenda, records: legacyRecordCount(envelope.state), revision: envelope.revision }];
          }),
          compareAgendaSummary,
        ),
      ).toEqual(EffectArray.sort(overview.agendas, compareAgendaSummary));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.effect('the seeded data exercises every part of the projection', () =>
  Effect.gen(function* overviewRead2() {
    const loaded = yield* seeded;
    const [management] = people;
    const overview = yield* finishFacilityOverview(
      { includeSearch: true },
      loaded,
      management.grants,
      scopeOf(management.principalId),
    );
    const agendasWithDeadlines = new Set(
      overview.deadlines.map((row) => {
        const [source, agenda] = row.key.split(':');
        return source === 'ops' ? agenda : 'agenda';
      }),
    );
    expect(EffectArray.sort([...agendasWithDeadlines], Order.String)).toEqual([
      'agenda',
      'assets',
      'documents',
      'purchasing',
      'security',
    ]);
    expect(overview.incidents?.length).toBeGreaterThan(0);
    expect(overview.searchRows?.length).toBeGreaterThan(100);
    expect(overview.agendas).toHaveLength(6);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('Moje agenda gets no search rows, and without security access no incident count', () =>
  Effect.gen(function* overviewRead3() {
    const loaded = yield* seeded;
    const operations = people.at(2);
    if (operations === undefined) {
      throw new Error('Missing operations principal fixture');
    }
    const overview = yield* finishFacilityOverview({}, loaded, operations.grants, scopeOf(operations.principalId));
    expect(overview.searchRows).toBeUndefined();
    expect(overview.incidents).toBeUndefined();
    expect(overview.deadlines.length).toBeGreaterThan(0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('the overview response is a fraction of the records read', () =>
  Effect.gen(function* overviewRead4() {
    const loaded = yield* seeded;
    const [management] = people;
    const scope = scopeOf(management.principalId);
    const records = yield* finishFacilityRecords({}, loaded, management.grants, scope).pipe(
      Effect.flatMap((value) => wireSize(RecordsResponseSchema, value)),
    );
    const overview = yield* finishFacilityOverview({ includeSearch: true }, loaded, management.grants, scope).pipe(
      Effect.flatMap((value) => wireSize(OverviewResponseSchema, value)),
    );
    expect(overview).toBeLessThan(records / 2);
  }).pipe(Effect.provide(NodeServices.layer)),
);
