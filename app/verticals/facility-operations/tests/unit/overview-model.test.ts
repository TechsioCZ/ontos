import { expect, it, rstest } from '@rstest/core';
import type { RentalOverviewSources } from '../../src/ui/ops-agenda/sources.ts';

rstest.mock('../../src/ui/ops-agenda/sources.ts', () => ({
  sourceKeys: ['property', 'occupancy', 'agreements', 'work', 'finance', 'ops', 'parties'],
}));
rstest.mock('@app/admin-ui', () => ({ foldSearchText: (value: string) => value.toLowerCase() }));

import { opsSearchRows } from '../../shared/domain/ops-overview.ts';
import {
  agendaPeople,
  buildKpis,
  buildSearchIndex,
  currentAgendaState,
  personalGreetingName,
} from '../../src/ui/ops-agenda/model.ts';

const absent = { status: 'unavailable' } as const;
const sources = (extra: Partial<RentalOverviewSources> = {}): RentalOverviewSources => ({
  property: absent,
  occupancy: absent,
  agreements: absent,
  work: absent,
  finance: absent,
  ops: absent,
  parties: absent,
  sales: absent,
  ...extra,
});

it('active lease KPI and drill-down use exactly the same current active records', () => {
  const occupancy = (id: string, state: string, startDate: string, endDate: string | null) => ({
    occupancyRef: { resourceId: id },
    unitRef: { resourceId: id },
    state,
    startDate,
    endDate,
    customerCounterpartyRef: null,
  });
  const source = sources({
    occupancy: {
      status: 'ready',
      data: {
        occupancies: [
          occupancy('current', 'ACTIVE', '2026-01-01', null),
          occupancy('expired', 'ACTIVE', '2026-01-01', '2026-10-19'),
          occupancy('future', 'CONFIRMED', '2026-11-01', null),
          occupancy('ended', 'ENDED', '2026-01-01', '2026-10-01'),
        ],
      } as unknown as NonNullable<RentalOverviewSources['occupancy']['data']>,
    },
  });
  const kpi = buildKpis(source, new Map(), [], '2026-10-20').find((entry) => entry.id === 'leases');
  expect(kpi?.value).toBe(1);
  expect(kpi?.rows.map((entry) => entry.id)).toEqual(['current']);
  expect(kpi?.secondary?.['confirmed']).toBe(1);
});

it('missing sources never produce a numeric zero and forbidden sources contribute no search rows', () => {
  const source = sources({ finance: { status: 'forbidden' } });
  const kpis = buildKpis(source, new Map(), [], '2026-10-20');
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
    ops: { status: 'ready', data: { searchRows } as unknown as NonNullable<RentalOverviewSources['ops']['data']> },
  });
  const index = buildSearchIndex(source, new Map());
  expect(index.find((row) => row.id === 'cam-12')?.href).toBe('/provoz/bezpecnost?device=cam-12');
  expect(index.find((row) => row.id === 'doc-1')?.href).toBe('/provoz/dokumenty?doc=doc-1');
});

it('S15-01 active property count and rows exclude disposed records', () => {
  const property = (id: string, lifecycleState: string) => ({
    propertyRef: { resourceId: id },
    lifecycleState,
    name: id,
    code: id,
  });
  const source = sources({
    property: {
      status: 'ready',
      data: {
        properties: [
          ...Array.from({ length: 5 }, (_, index) => property(`active-${index}`, 'ACTIVE')),
          property('disposed-1', 'DISPOSED'),
          property('disposed-2', 'DISPOSED'),
        ],
        units: [],
        assets: [],
      } as unknown as NonNullable<RentalOverviewSources['property']['data']>,
    },
  });
  const kpi = buildKpis(source, new Map(), [], '2026-10-20').find((entry) => entry.id === 'properties');
  expect(kpi?.value).toBe(5);
  expect(kpi?.rows).toHaveLength(5);
  expect(kpi?.rows.every((row) => row.id.startsWith('active-'))).toBe(true);
});

it('cancelled or reassigned task alerts leave the live inbox, while stored history is retained', () => {
  const notifications = [{ category: 'ASSIGNED', eventKey: 'task-assigned:t1:me', source: 'work' }];
  const source = sources({
    work: {
      status: 'ready',
      data: {
        items: [{ ref: { resourceId: 't1' }, state: 'CANCELLED', ownerPrincipalRef: { principalId: 'me' } }],
      } as unknown as NonNullable<RentalOverviewSources['work']['data']>,
    },
    ops: {
      status: 'ready',
      data: { agenda: { state: { events: [], notifications } } } as unknown as NonNullable<
        RentalOverviewSources['ops']['data']
      >,
    },
  });
  expect(currentAgendaState(source, [], '2026-10-20')?.notifications).toEqual([]);
  expect(notifications).toHaveLength(1);
});

it('stale source deadlines are hidden without deleting stored notification history', () => {
  const notifications = [
    { category: 'DEADLINE', eventKey: 'invoice-due:removed:2026-10-25:DEADLINE', source: 'finance' },
    { category: 'ASSIGNED', eventKey: 'assignment', source: 'ops' },
  ];
  const state = { events: [], notifications };
  const source = sources({
    finance: { status: 'ready' },
    ops: {
      status: 'ready',
      data: { agenda: { state } } as unknown as NonNullable<RentalOverviewSources['ops']['data']>,
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
  expect(personalGreetingName(undefined)).toBeUndefined();
  expect(personalGreetingName('')).toBeUndefined();
});

it('agenda assignee names come only from the session and visible same-tenant event labels', () => {
  const context = { displayName: 'Jana Nováková', legalEntityId: 'company', principalId: 'self', tenantId: 'tenant' };
  const state = {
    events: [
      { assignee: { principalId: 'self', tenantId: 'tenant' }, assigneeLabel: 'Old name' },
      { assignee: { principalId: 'partner', tenantId: 'tenant' }, assigneeLabel: '  Petr Novák  ' },
      { assignee: { principalId: 'other', tenantId: 'another-tenant' }, assigneeLabel: 'Hidden name' },
      { assignee: { principalId: 'unnamed', tenantId: 'tenant' } },
    ],
  } as unknown as import('../../shared/domain/agenda.ts').AgendaState;
  expect(agendaPeople(state, context)).toEqual([
    { displayName: 'Jana Nováková', principalId: 'self', tenantId: 'tenant' },
    { displayName: 'Petr Novák', principalId: 'partner', tenantId: 'tenant' },
  ]);
  expect(agendaPeople(state, undefined)).toEqual([]);
  expect(agendaPeople(undefined, { ...context, displayName: undefined })).toEqual([]);
});
