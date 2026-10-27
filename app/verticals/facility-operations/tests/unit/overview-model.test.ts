import { expect, it, rstest } from 'effect-rstest';
import { Schema, Struct, pipe } from 'effect';
import { RecordsResponseSchema as WorkRecordsResponseSchema } from '@app/work-tasks/contracts/records';
import { CalendarEventSchema, NotificationSchema } from '../../shared/domain/agenda.ts';
import type { AgendaState, NotificationCategory } from '../../shared/domain/agenda.ts';
import type { OverviewResponse } from '../../shared/apis/overview.ts';
import type { OccupancyData, PropertyData, RentalOverviewSources } from '../../src/ui/ops-agenda/sources.ts';

import { principalLabel as assetPrincipalLabel } from '../../src/routes/[lang]/provoz/majetek/assets-model.ts';
import { personLabel as meterPersonLabel } from '../../src/routes/[lang]/provoz/meridla/meters-view.ts';
import { opsAgendaDeadlines, opsRecordHref, opsSearchRows, opsSegments } from '../../shared/domain/ops-overview.ts';
import {
  agendaPeople,
  buildKpis,
  buildSearchIndex,
  currentAgendaState,
  personalGreetingName,
} from '../../src/ui/ops-agenda/model.ts';

rstest.mock('../../src/ui/ops-agenda/sources.ts', () => ({
  sourceKeys: ['property', 'occupancy', 'agreements', 'work', 'finance', 'ops', 'parties'],
}));
rstest.mock('@app/admin-ui', () => ({ foldSearchText: (value: string) => value.toLowerCase() }));

const tenantId = '70000000-0000-4000-8000-000000000020';
const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const at = '2026-10-20T08:00:00Z';
const translate = (key: string) => key;
const event = Schema.decodeUnknownSync(CalendarEventSchema)({
  createdAt: at,
  createdBy: actor,
  date: '2026-10-22',
  id: 'fixture-event',
  kind: 'MEETING',
  title: 'Fixture event',
  updatedAt: at,
  updatedBy: actor,
});
const notification = (category: NotificationCategory, eventKey: string, source: string) =>
  Schema.decodeUnknownSync(NotificationSchema)({
    category,
    createdAt: at,
    createdBy: actor,
    eventKey,
    id: eventKey,
    recipient: actor,
    source,
    title: eventKey,
  });
const overview = (extra: Partial<OverviewResponse> = {}): OverviewResponse => ({
  access: [],
  actorPrincipalRef: actor,
  agendas: [],
  deadlines: [],
  ...extra,
});
const agendaOverview = (state: AgendaState) =>
  overview({
    agenda: { canWrite: false, revision: 0, state, updatedAt: event.createdAt },
  });

const absent = { status: 'unavailable' } as const;
const sources = (extra: Partial<RentalOverviewSources> = {}): RentalOverviewSources => ({
  agreements: absent,
  finance: absent,
  occupancy: absent,
  ops: absent,
  parties: absent,
  property: absent,
  sales: absent,
  work: absent,
  ...extra,
});

it('active lease KPI and drill-down use exactly the same current active records', () => {
  const occupancy = (
    id: string,
    state: OccupancyData['occupancies'][number]['state'],
    startDate: string,
    endDate: string | null,
  ): OccupancyData['occupancies'][number] => ({
    contractRef: null,
    customerCounterpartyRef: null,
    endDate,
    externalBookingCorrelation: null,
    guestPartyRef: null,
    kind: 'LONG_TERM_LEASE',
    note: null,
    occupancyRef: {
      moduleId: 'property.leasing',
      resourceId: id,
      resourceType: 'property.leasing.occupancy',
      tenantId,
    },
    peopleCount: null,
    startDate,
    state,
    unitRef: { moduleId: 'property.portfolio', resourceId: id, resourceType: 'property.portfolio.unit', tenantId },
  });
  const source = sources({
    occupancy: {
      data: {
        occupancies: [
          occupancy('current', 'ACTIVE', '2026-01-01', null),
          occupancy('expired', 'ACTIVE', '2026-01-01', '2026-10-19'),
          occupancy('future', 'CONFIRMED', '2026-11-01', null),
          occupancy('ended', 'COMPLETED', '2026-01-01', '2026-10-01'),
        ],
        revision: 0,
      },
      status: 'ready',
    },
  });
  const kpi = buildKpis({ deadlines: [], names: new Map(), sources: source, today: '2026-10-20' }).find(
    (entry) => entry.id === 'leases',
  );
  expect(kpi?.value).toBe(1);
  expect(kpi?.rows.map((entry) => entry.id)).toEqual(['current']);
  expect(kpi?.secondary?.confirmed).toBe(1);
});

it('missing sources never produce a numeric zero and forbidden sources contribute no search rows', () => {
  const source = sources({ finance: { status: 'forbidden' } });
  const kpis = buildKpis({ deadlines: [], names: new Map(), sources: source, today: '2026-10-20' });
  expect(kpis.every((entry) => entry.value === undefined)).toBe(true);
  expect(kpis.find((entry) => entry.id === 'overdueInvoices')?.status).toBe('forbidden');
  expect(buildSearchIndex(source, new Map())).toEqual([]);
});

it('operations search preserves the camera and document selection in source links', () => {
  const searchRows = [
    ...opsSearchRows('security', { devices: [{ id: 'cam-12', name: 'Kamera K-12' }] }),
    ...opsSearchRows('documents', { documents: [{ id: 'doc-1', title: 'Úklid Parková' }] }),
  ];
  const source = sources({
    ops: { data: overview({ searchRows }), status: 'ready' },
  });
  const index = buildSearchIndex(source, new Map());
  expect(index.find((row) => row.id === 'cam-12')?.href).toBe('/provoz/bezpecnost?device=cam-12');
  expect(index.find((row) => row.id === 'doc-1')?.href).toBe('/provoz/dokumenty?doc=doc-1');
});

it('operations projection preserves nested deadline ties, source dates and parent closure', () => {
  // JSON member order is part of this fixture: traversal chooses the final tied service first.
  const fixture = Schema.decodeSync(Schema.fromJsonString(Schema.Json))(`{
    "assets": [
      {
        "id": "roof 1",
        "name": "   ",
        "title": "Roof",
        "status": "CANCELLED",
        "services": [
          { "id": "older", "kind": "review", "title": "Annual", "performedOn": "2026-01-01", "nextDueOn": "2026-12-01" },
          { "id": "winner", "kind": "review", "title": "Annual", "performedOn": "2026-01-01", "nextDueOn": "2026-11-01" }
        ],
        "contract": { "validTo": "2026-10-25T08:00:00Z" },
        "followUp": { "detail": { "deadline": "2026-10-26" }, "beyond": { "detail": { "deadline": "2026-10-27" } } }
      }
    ]
  }`);
  const deadlines = opsAgendaDeadlines('assets', fixture);
  expect(deadlines.map(({ date, done, href, title }) => ({ date, done, href, title }))).toEqual([
    { date: '2026-11-01', done: true, href: '/provoz/majetek?asset=roof%201', title: 'Annual' },
    { date: '2026-10-25', done: true, href: '/provoz/majetek?asset=roof%201', title: 'Roof' },
    { date: '2026-10-26', done: true, href: '/provoz/majetek?asset=roof%201', title: 'Roof' },
  ]);
  expect(deadlines[0]?.key).toBe('ops:assets:winner:nextDueOn:2026-11-01');
  expect(opsSegments['custom-source'] ?? 'custom-source').toBe('custom-source');
  expect(opsRecordHref('custom-source', 'unknown-list', 'record')).toBe('/provoz/custom-source');
});

it('operations search preserves text precedence, short search fields and the location fallback boundary', () => {
  // Keep the legacy member order and whitespace visible; search text walks this exact JSON sequence.
  const fixture = Schema.decodeSync(Schema.fromJsonString(Schema.Json))(`{
    "documents": [{ "id": "doc 1", "name": "", "title": "  ", "note": "needle", "location": {}, "related": { "label": "Unused" } }],
    "history": [{ "id": "hidden", "title": "History" }],
    "other": [{ "title": "Missing identity" }, null]
  }`);
  const rows = opsSearchRows('documents', fixture);
  const expected = Schema.decodeSync(Schema.fromJsonString(Schema.Json))(`[
    {
      "href": "/provoz/dokumenty?doc=doc%201",
      "id": "doc 1",
      "kind": "ops",
      "title": "  ",
      "terms": "documents doc 1     needle"
    }
  ]`);
  expect(rows).toEqual(expected);
});

it('S15-01 active property count and rows exclude disposed records', () => {
  const property = (
    id: string,
    lifecycleState: PropertyData['properties'][number]['lifecycleState'],
  ): PropertyData['properties'][number] => ({
    address: id,
    code: id,
    createdAt: at,
    legalEntityRef: {
      moduleId: 'core.identity',
      resourceId: 'company',
      resourceType: 'core.identity.legal-entity',
      tenantId,
    },
    lifecycleState,
    name: id,
    note: null,
    propertyRef: {
      moduleId: 'property.portfolio',
      resourceId: id,
      resourceType: 'property.portfolio.property',
      tenantId,
    },
    updatedAt: at,
  });
  const source = sources({
    property: {
      data: {
        assets: [],
        properties: [
          ...Array.from({ length: 5 }, (_, index) => property(`active-${index}`, 'ACTIVE')),
          property('disposed-1', 'DISPOSED'),
          property('disposed-2', 'DISPOSED'),
        ],
        revision: 0,
        units: [],
      },
      status: 'ready',
    },
  });
  const kpi = buildKpis({ deadlines: [], names: new Map(), sources: source, today: '2026-10-20' }).find(
    (entry) => entry.id === 'properties',
  );
  expect(kpi?.value).toBe(5);
  expect(kpi?.rows).toHaveLength(5);
  expect(kpi?.rows.every((row) => row.id.startsWith('active-'))).toBe(true);
});

it('cancelled or reassigned task alerts leave the live inbox, while stored history is retained', () => {
  const notifications = [notification('ASSIGNED', `task-assigned:t1:${actor.principalId}`, 'work')];
  const source = sources({
    ops: {
      data: agendaOverview({ events: [], notifications }),
      status: 'ready',
    },
    work: {
      data: Schema.decodeUnknownSync(WorkRecordsResponseSchema)({
        actorPrincipalRef: actor,
        assignablePrincipals: [],
        canWrite: false,
        collection: {
          properties: {
            dueDate: { locked: true, type: 'DATE' },
            ownerPrincipalRef: { locked: true, type: 'PRINCIPAL' },
            status: { groups: ['NOT_STARTED', 'IN_PROGRESS', 'DONE'], locked: true, type: 'STATUS' },
            title: { locked: true, type: 'TEXT' },
          },
          ref: { moduleId: 'work.tasks', resourceId: 'tasks', resourceType: 'work.tasks.task-collection', tenantId },
          title: 'Tasks',
        },
        indicators: { open: 0, openByAssignee: [], overdue: 0 },
        items: [
          {
            collectionRef: {
              moduleId: 'work.tasks',
              resourceId: 'tasks',
              resourceType: 'work.tasks.task-collection',
              tenantId,
            },
            contextRefs: [],
            createdAt: at,
            ownerPrincipalRef: actor,
            priority: 'NORMAL',
            ref: { moduleId: 'work.tasks', resourceId: 't1', resourceType: 'work.tasks.task', tenantId },
            state: 'CANCELLED',
            title: 'Cancelled task',
            updatedAt: at,
          },
        ],
        principalNames: [],
        referenceDate: '2026-10-20',
        revision: 0,
      }),
      status: 'ready',
    },
  });
  expect(currentAgendaState(source, [], '2026-10-20')?.notifications).toEqual([]);
  expect(notifications).toHaveLength(1);
});

it('stale source deadlines are hidden without deleting stored notification history', () => {
  const notifications = [
    notification('DEADLINE', 'invoice-due:removed:2026-10-25:DEADLINE', 'finance'),
    notification('ASSIGNED', 'assignment', 'ops'),
  ];
  const state = { events: [], notifications };
  const source = sources({
    finance: { status: 'ready' },
    ops: {
      data: agendaOverview(state),
      status: 'ready',
    },
  });
  expect(currentAgendaState(source, [], '2026-10-20')?.notifications?.map((entry) => entry.eventKey)).toEqual([
    'assignment',
  ]);
  expect(notifications).toHaveLength(2);
});

it('greets the session person, never an account role or a fixture persona', () => {
  expect(personalGreetingName(' Jana Nováková ')).toBe('Jana Nováková');
  expect(personalGreetingName('Jana')).toBe('Jana');
  expect(personalGreetingName('Vedení Siampark')).toBeUndefined();
  expect(personalGreetingName('Provoz Siampark')).toBeUndefined();
  expect(personalGreetingName('Účetní Siampark')).toBeUndefined();
  expect(personalGreetingName('Externí obchodník')).toBeUndefined();
  expect(pipe(undefined, personalGreetingName)).toBeUndefined();
  expect(personalGreetingName('')).toBeUndefined();
});

it('agenda assignee names come only from the session and visible same-tenant event labels', () => {
  const context = { displayName: 'Jana Nováková', legalEntityId: 'company', principalId: 'self', tenantId: 'tenant' };
  const state = {
    events: [
      { ...event, assignee: { principalId: 'self', tenantId: 'tenant' }, assigneeLabel: 'Old name' },
      { ...event, assignee: { principalId: 'partner', tenantId: 'tenant' }, assigneeLabel: '  Petr Novák  ' },
      { ...event, assignee: { principalId: 'other', tenantId: 'another-tenant' }, assigneeLabel: 'Hidden name' },
      { ...event, assignee: { principalId: 'unnamed', tenantId: 'tenant' } },
    ],
  } satisfies AgendaState;
  expect(agendaPeople(state, context)).toEqual([
    { displayName: 'Jana Nováková', principalId: 'self', tenantId: 'tenant' },
    { displayName: 'Petr Novák', principalId: 'partner', tenantId: 'tenant' },
  ]);
  expect(agendaPeople(state)).toEqual([]);
  expect(agendaPeople(undefined, Struct.omit(context, ['displayName']))).toEqual([]);
});

it('author labels never infer a demo identity and self labels include tenant identity', () => {
  const principal = {
    principalId: '72000000-0000-4000-8000-000000000021',
    tenantId: '70000000-0000-4000-8000-000000000020',
  };
  const otherTenant = { ...principal, tenantId: 'another-tenant' };
  expect(assetPrincipalLabel(principal, principal, 'vy')).toBe('vy');
  expect(assetPrincipalLabel(principal, undefined, 'vy')).toBe('');
  expect(assetPrincipalLabel(principal, otherTenant, 'vy')).toBe('');
  expect(meterPersonLabel(translate, principal, principal)).toBe('facility-operations.meters.people.you');
  expect(meterPersonLabel(translate, principal)).toBe('');
  expect(meterPersonLabel(translate, principal, otherTenant)).toBe('');
});
