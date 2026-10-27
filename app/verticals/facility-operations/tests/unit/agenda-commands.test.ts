import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { Array as EffectArray, DateTime, Effect, Exit, Option, Order, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { AgendaCommandSchema, agendaCommandSchemas, evolveAgenda } from '../../shared/commands/agenda.ts';
import { AgendaStateSchema, agendaStateForPrincipal } from '../../shared/domain/agenda.ts';
import type { AgendaState } from '../../shared/domain/agenda.ts';
import { seedAgendaState } from '../../scripts/seed/agenda.mts';
import {
  contractDeadlines,
  notificationCandidates,
  taskAssignmentCandidates,
  projectDeadlines,
  toCsv,
  urgencyOf,
} from '../../src/ui/ops-agenda/deadlines.ts';
import { openOpsIncidents, opsAgendaDeadlines } from '../../shared/domain/ops-overview.ts';

const [createEventSchema, updateEventSchema] = agendaCommandSchemas;

it.effect('calendar dates keep their date-only wire form and reject impossible dates', () =>
  Effect.gen(function* calendarDateWire() {
    const command = { _tag: 'AgendaEventCreate', date: '2028-02-29', kind: 'MEETING', title: 'Leap day' } as const;
    const decoded = yield* Schema.decodeUnknownEffect(AgendaCommandSchema)(command);
    expect(Schema.is(createEventSchema)(decoded)).toBe(true);
    if (Schema.is(createEventSchema)(decoded)) {
      expect(decoded.date).toBe('2028-02-29');
    }
    expect(yield* Schema.encodeEffect(AgendaCommandSchema)(decoded)).toEqual(command);
    yield* Effect.forEach(
      ['2026-02-29', '2026-02-31', '2026-13-01', '2026-10-20T00:00:00Z'],
      (date) =>
        Schema.decodeUnknownEffect(AgendaCommandSchema)({ ...command, date }).pipe(
          Effect.exit,
          Effect.tap((exit) => Effect.sync(() => expect(Exit.isFailure(exit)).toBe(true))),
        ),
      { concurrency: 1, discard: true },
    );
  }),
);

const tenantId = '70000000-0000-4000-8000-000000000020';
const management = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const operations = { principalId: '72000000-0000-4000-8000-000000000022', tenantId };
const now = DateTime.makeUnsafe('2026-10-20T08:00:00Z');
const later = DateTime.makeUnsafe('2026-10-20T09:00:00Z');
const decodeCommand = Schema.decodeUnknownSync(AgendaCommandSchema);
const empty: AgendaState = { events: [] };

type Actor = typeof management;
const apply = (
  state: AgendaState,
  command: typeof AgendaCommandSchema.Encoded,
  resourceId: string,
  actor: Actor = management,
) =>
  evolveAgenda(state, decodeCommand(command), {
    actor: Schema.decodeUnknownSync(PrincipalRefSchema)(actor),
    now: resourceId.endsWith('-late') ? later : now,
    resourceId,
  });

const deadlineItem = (eventKey: string) => ({
  category: 'DEADLINE' as const,
  dueDate: '2026-10-31',
  eventKey,
  href: '/smlouvy?resourceId=c1',
  source: 'agreements',
  title: 'Kavárna U Parku · A101',
});

const mine = (state: AgendaState, actor: Actor) =>
  (state.notifications ?? []).filter((entry) => entry.recipient.principalId === actor.principalId);

it.effect('assigning an event to a colleague notifies them once; assigning yourself does not', () =>
  Effect.gen(function* eventAssignment() {
    const created = yield* apply(
      empty,
      {
        _tag: 'AgendaEventCreate',
        assignee: operations,
        date: '2026-10-27',
        kind: 'INSPECTION',
        title: 'Revize výtahu',
      },
      'e1',
    );
    expect(created.state.events).toHaveLength(1);
    expect(created.state.events[0]?.status).toBe('PLANNED');
    expect(mine(created.state, operations).map((entry) => entry.category)).toEqual(['ASSIGNED']);
    expect(created.entityIds).toEqual(['e1', 'e1:n0']);
    const own = yield* apply(
      empty,
      { _tag: 'AgendaEventCreate', assignee: management, date: '2026-10-27', kind: 'MEETING', title: 'Porada' },
      'e2',
    );
    expect(own.state.notifications ?? []).toEqual([]);
  }),
);

it.effect('S13-03: the same source event delivered twice (and twice in one batch) is notified once', () =>
  Effect.gen(function* sourceDeliveryDeduplication() {
    const first = yield* apply(
      empty,
      {
        _tag: 'AgendaNotificationsDeliver',
        items: [
          deadlineItem('contract-end:c1:2026-10-31:DEADLINE'),
          deadlineItem('contract-end:c1:2026-10-31:DEADLINE'),
        ],
      },
      'd1',
    );
    expect(mine(first.state, management)).toHaveLength(1);
    expect(first.entityIds).toHaveLength(1);
    const again = yield* apply(
      first.state,
      { _tag: 'AgendaNotificationsDeliver', items: [deadlineItem('contract-end:c1:2026-10-31:DEADLINE')] },
      'd2',
    );
    expect(mine(again.state, management)).toHaveLength(1);
    expect(again.entityIds).toEqual([]);
    const otherPerson = yield* apply(
      again.state,
      { _tag: 'AgendaNotificationsDeliver', items: [deadlineItem('contract-end:c1:2026-10-31:DEADLINE')] },
      'd3',
      operations,
    );
    expect(mine(otherPerson.state, operations)).toHaveLength(1);
    expect(mine(otherPerson.state, management)).toHaveLength(1);
  }),
);

it.effect('only the recipient can mark a notification read; mark-all touches only own unread ones', () =>
  Effect.gen(function* notificationRecipient() {
    const delivered = yield* apply(
      empty,
      { _tag: 'AgendaNotificationsDeliver', items: [deadlineItem('k1'), deadlineItem('k2')] },
      'd1',
    );
    const [first] = mine(delivered.state, management);
    const foreign = yield* Effect.exit(
      apply(
        delivered.state,
        { _tag: 'AgendaNotificationsMarkRead', notificationIds: [first?.id ?? ''] },
        'r1',
        operations,
      ),
    );
    expect(Exit.isFailure(foreign)).toBe(true);
    const read = yield* apply(
      delivered.state,
      { _tag: 'AgendaNotificationsMarkRead', notificationIds: [first?.id ?? ''] },
      'r2',
    );
    expect(mine(read.state, management).filter((entry) => entry.readAt === undefined)).toHaveLength(1);
    const all = yield* apply(read.state, { _tag: 'AgendaNotificationsMarkAllRead' }, 'r3');
    expect(mine(all.state, management).every((entry) => entry.readAt !== undefined)).toBe(true);
    expect(all.entityIds).toHaveLength(1);
  }),
);

it.effect('rescheduling notifies the assignee once per new date; cancelled events can only be reopened', () =>
  Effect.gen(function* eventRescheduling() {
    const created = yield* apply(
      empty,
      { _tag: 'AgendaEventCreate', assignee: operations, date: '2026-10-27', kind: 'MEETING', title: 'Kontrolní den' },
      'e1',
    );
    const moved = yield* apply(
      created.state,
      { _tag: 'AgendaEventUpdate', date: '2026-10-29', eventId: 'e1' },
      'u1-late',
    );
    expect(moved.state.events[0]?.date).toBe('2026-10-29');
    expect(DateTime.formatIso(moved.state.events[0]?.updatedAt ?? now)).toBe('2026-10-20T09:00:00.000Z');
    expect(mine(moved.state, operations).map((entry) => entry.category)).toEqual(['ASSIGNED', 'CHANGE']);
    const same = yield* apply(
      moved.state,
      { _tag: 'AgendaEventUpdate', date: '2026-10-29', eventId: 'e1', title: 'Kontrolní den – změna' },
      'u2',
    );
    expect(mine(same.state, operations)).toHaveLength(2);
    const cancelled = yield* apply(same.state, { _tag: 'AgendaEventUpdate', eventId: 'e1', status: 'CANCELLED' }, 'u3');
    const blocked = yield* Effect.exit(
      apply(cancelled.state, { _tag: 'AgendaEventUpdate', date: '2026-11-01', eventId: 'e1' }, 'u4'),
    );
    expect(Exit.isFailure(blocked)).toBe(true);
    const missing = yield* Effect.exit(
      apply(empty, { _tag: 'AgendaEventUpdate', eventId: 'nope', status: 'DONE' }, 'u5'),
    );
    expect(Exit.isFailure(missing)).toBe(true);
  }),
);

it.effect('export log and preferences are stored per person', () =>
  Effect.gen(function* personalPreferences() {
    const exported = yield* apply(
      empty,
      { _tag: 'AgendaExportRecord', filter: 'zdroj=finance', list: 'calendar', rowCount: 12 },
      'x1',
    );
    expect(exported.state.exports?.[0]?.rowCount).toBe(12);
    const pref = yield* apply(exported.state, { _tag: 'AgendaPreferencesSet', emailOptIn: true, leadDays: 7 }, 'p1');
    const pref2 = yield* apply(pref.state, { _tag: 'AgendaPreferencesSet', emailOptIn: false, leadDays: 21 }, 'p2');
    expect(pref2.state.preferences).toHaveLength(1);
    expect(pref2.state.preferences?.[0]?.leadDays).toBe(21);
  }),
);

it.effect('S13 e-mail: optional categories stored, switch-on instant kept while e-mail stays on', () =>
  Effect.gen(function* emailSubscription() {
    const on = yield* apply(
      empty,
      { _tag: 'AgendaPreferencesSet', emailCategories: ['CHANGE'], emailOptIn: true, leadDays: 7 },
      'e1',
    );
    expect(on.state.preferences?.[0]?.emailCategories).toEqual(['CHANGE']);
    const [onPreference] = on.state.preferences ?? [];
    if (onPreference?.emailSince === undefined) {
      throw new Error('Missing initial email subscription instant');
    }
    expect(DateTime.formatIso(onPreference.emailSince)).toBe(DateTime.formatIso(now));
    const changed = yield* apply(on.state, { _tag: 'AgendaPreferencesSet', emailOptIn: true, leadDays: 30 }, 'e2-late');
    expect(changed.state.preferences?.[0]?.emailCategories).toEqual(['CHANGE']);
    const [changedPreference] = changed.state.preferences ?? [];
    if (changedPreference?.emailSince === undefined) {
      throw new Error('Missing retained email subscription instant');
    }
    expect(DateTime.formatIso(changedPreference.emailSince)).toBe(DateTime.formatIso(now));
    const off = yield* apply(
      changed.state,
      { _tag: 'AgendaPreferencesSet', emailOptIn: false, leadDays: 30 },
      'e3-late',
    );
    expect(off.state.preferences?.[0]?.emailSince).toBeUndefined();
    const again = yield* apply(off.state, { _tag: 'AgendaPreferencesSet', emailOptIn: true, leadDays: 30 }, 'e4-late');
    const [againPreference] = again.state.preferences ?? [];
    if (againPreference?.emailSince === undefined) {
      throw new Error('Missing restarted email subscription instant');
    }
    expect(DateTime.formatIso(againPreference.emailSince)).toBe(DateTime.formatIso(later));
    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(AgendaCommandSchema)({
          _tag: 'AgendaPreferencesSet',
          emailCategories: ['ASSIGNED'],
          emailOptIn: true,
          leadDays: 7,
        }),
      ),
    ).toBe(true);
    expect(
      Schema.decodeUnknownSync(AgendaStateSchema)(Schema.encodeSync(AgendaStateSchema)(again.state)).preferences,
    ).toHaveLength(1);
  }),
);

it('S13-02: a changed contract end date yields a new calendar key without any write in the agenda', () => {
  const contract = {
    contractRef: { resourceId: 'c1' },
    counterpartyRef: { resourceId: 'p1' },
    endDate: '2026-10-31',
    lifecycleState: 'ACTIVE',
    propertyRef: null,
    renewalNoticeDate: '2026-10-25',
    startDate: '2025-11-01',
    unitRef: { resourceId: 'u1' },
  };
  const names = new Map([
    ['p1', 'Kavárna U Parku'],
    ['u1', 'A101'],
  ]);
  const before = contractDeadlines([contract], names).find((row) => row.category === 'contractEnd');
  const after = contractDeadlines([{ ...contract, endDate: '2026-12-31' }], names).find(
    (row) => row.category === 'contractEnd',
  );
  expect(before?.date).toBe('2026-10-31');
  expect(after?.date).toBe('2026-12-31');
  expect(after?.key).not.toBe(before?.key);
  expect(after?.title).toBe('Kavárna U Parku · A101');
});

it('notification candidates: own or unowned, open, within lead time; overdue gets its own key', () => {
  const rows = [
    {
      category: 'task',
      date: '2026-10-22',
      done: false,
      href: '/a',
      key: 'task-due:t1:2026-10-22',
      ownerPrincipalId: 'me',
      source: 'work',
      title: 'Moje',
    },
    {
      category: 'task',
      date: '2026-10-22',
      done: false,
      href: '/b',
      key: 'task-due:t2:2026-10-22',
      ownerPrincipalId: 'other',
      source: 'work',
      title: 'Cizí',
    },
    {
      category: 'invoiceDue',
      date: '2026-10-10',
      done: false,
      href: '/c',
      key: 'invoice-due:i1:2026-10-10',
      source: 'finance',
      title: 'FV-1',
    },
    {
      category: 'invoiceDue',
      date: '2026-10-12',
      done: true,
      href: '/d',
      key: 'invoice-due:i2:2026-10-12',
      source: 'finance',
      title: 'FV-2',
    },
    {
      category: 'contractEnd',
      date: '2027-03-01',
      done: false,
      href: '/e',
      key: 'contract-end:c9:2027-03-01',
      source: 'agreements',
      title: 'Daleko',
    },
  ] as const;
  const candidates = notificationCandidates(rows, '2026-10-20', 14, 'me');
  expect(candidates.map((entry) => entry.eventKey)).toEqual([
    'task-due:t1:2026-10-22:DEADLINE',
    'invoice-due:i1:2026-10-10:OVERDUE',
  ]);
  expect(urgencyOf(rows[2], '2026-10-20')).toBe('overdue');
  expect(urgencyOf(rows[0], '2026-10-20')).toBe('soon');
});

it('provoz agendas: dates are found by field name, nested revisions keep the latest, closed records are done', () => {
  const state = {
    assets: [
      {
        id: 'a1',
        name: 'Výtah A',
        revisions: [
          { id: 'r1', nextDueOn: '2026-05-01', performedOn: '2025-05-01' },
          { id: 'r2', nextDueOn: '2027-05-01', performedOn: '2026-05-01' },
        ],
      },
    ],
    devices: [{ id: 'd1', name: 'Kamera 1', nextInspectionDate: '2026-11-02', state: 'decommissioned' }],
    incidents: [
      { description: 'Nefunkční čtečka', id: 'i1', state: 'reported' },
      { description: 'Vyřešeno', id: 'i2', state: 'resolved' },
    ],
  };
  const rows = opsAgendaDeadlines('assets', state);
  const revision = rows.find((row) => row.field === 'nextDueOn');
  expect(revision?.date).toBe('2027-05-01');
  expect(revision?.category).toBe('assetService');
  expect(rows.find((row) => row.field === 'nextInspectionDate')?.done).toBe(true);
  expect(rows.some((row) => row.field === 'performedOn')).toBe(false);
  expect(openOpsIncidents('security', state).map((entry) => entry.id)).toEqual(['i1']);
});

it('CSV uses semicolons, quotes special cells and starts with a BOM', () => {
  const csv = toCsv(
    ['Název', 'Částka'],
    [
      ['Nájem; říjen', 1200],
      ['"A"', undefined],
    ],
  );
  expect(csv).toBe('﻿Název;Částka\r\n"Nájem; říjen";1200\r\n"""A""";\r\n');
});

it('the agenda seed decodes', () => {
  const decoded = Schema.decodeUnknownSync(AgendaStateSchema)(seedAgendaState());
  expect(decoded.events.length).toBeGreaterThan(3);
  expect((decoded.notifications ?? []).every((entry) => entry.category === 'ASSIGNED')).toBe(true);
});

it('personal agenda data is projected server-side, including tenant identity', () => {
  const ref = Schema.decodeUnknownSync(PrincipalRefSchema)(management);
  const other = Schema.decodeUnknownSync(PrincipalRefSchema)(operations);
  const state = Schema.decodeUnknownSync(AgendaStateSchema)(seedAgendaState());
  const projected = agendaStateForPrincipal(
    {
      ...state,
      preferences: [ref, other].map((principal) => ({ emailOptIn: false, leadDays: 14, principal, updatedAt: now })),
    },
    ref,
  );
  expect(projected.events).toEqual(state.events);
  expect(projected.notifications?.every((entry) => entry.recipient.principalId === ref.principalId)).toBe(true);
  expect(projected.preferences?.map((entry) => entry.principal.principalId)).toEqual([ref.principalId]);
  // SAFETY: The principal UUID is intentionally reused as a different tenant UUID to exercise tenant filtering.
  expect(agendaStateForPrincipal(state, { ...ref, tenantId: other.principalId }).notifications).toEqual([]);
});

it('calendar keeps separate revision types, honors latest performed service and reads nested objects', () => {
  const rows = opsAgendaDeadlines('assets', {
    assets: [
      {
        id: 'a1',
        name: 'Výtah',
        services: [
          { id: 'r1', kind: 'revision', nextDueOn: '2028-10-01', performedOn: '2025-10-01', title: 'Roční revize' },
          { id: 'r2', kind: 'revision', nextDueOn: '2027-10-01', performedOn: '2026-10-01', title: 'Roční revize' },
          { id: 's1', kind: 'service', nextDueOn: '2026-11-01', title: 'Měsíční servis' },
        ],
      },
    ],
    inventories: [
      {
        id: 'i1',
        items: [
          { followUp: { dueDate: '2026-10-29', id: 'f1', status: 'open', title: 'Dohledat vybavení' }, id: 'i2' },
        ],
      },
    ],
  });
  expect(
    EffectArray.sort(
      rows.filter((row) => row.field === 'nextDueOn').map((row) => row.date),
      Order.String,
    ),
  ).toEqual(['2026-11-01', '2027-10-01']);
  expect(rows.some((row) => row.title === 'Dohledat vybavení')).toBe(true);
  const documents = opsAgendaDeadlines('documents', {
    documents: [{ contract: { status: 'active', validTo: '2026-11-30' }, id: 'd1', title: 'Nájemní smlouva' }],
  });
  expect(documents[0]?.date).toBe('2026-11-30');
  expect(openOpsIncidents('security', { incidents: [{ id: 'i', resolvedAt: null, title: 'Otevřeno' }] })).toHaveLength(
    1,
  );
});

it('project milestones follow source dates and completion flags without a copied calendar entry', () => {
  const rows = projectDeadlines([
    {
      id: 'p1',
      milestones: [
        { completed: false, dueDate: '2026-11-30', title: 'Předání' },
        { completed: true, dueDate: '2026-10-05', title: 'Zaměření' },
      ],
      plannedEnd: '2026-12-15',
      plannedStart: '2026-10-01',
      state: 'ACTIVE',
      title: 'Modernizace recepce',
    },
  ]);
  expect(rows).toHaveLength(4);
  expect(rows.filter((row) => !row.done).map((row) => row.date)).toEqual(['2026-12-15', '2026-11-30']);
});

it.effect('native task assignment without a deadline persists once in the recipient inbox', () =>
  Effect.gen(function* nativeTaskAssignment() {
    const task = {
      contextRefs: [],
      ownerPrincipalRef: operations,
      priority: 'NORMAL',
      ref: { resourceId: 'task-1' },
      state: 'NEW',
      title: 'Připravit harmonogram údržby',
    };
    const items = taskAssignmentCandidates([task], operations.principalId);
    expect(items).toHaveLength(1);
    expect(items[0]?.dueDate).toBeUndefined();
    expect(taskAssignmentCandidates([task], management.principalId)).toEqual([]);
    expect(taskAssignmentCandidates([{ ...task, state: 'CANCELLED' }], operations.principalId)).toEqual([]);
    expect(taskAssignmentCandidates([{ ...task, state: 'DONE' }], operations.principalId)).toEqual([]);
    const delivered = yield* apply(
      empty,
      { _tag: 'AgendaNotificationsDeliver', items },
      'native-assignment',
      operations,
    );
    const again = yield* apply(
      delivered.state,
      { _tag: 'AgendaNotificationsDeliver', items },
      'native-assignment-again',
      operations,
    );
    expect(mine(again.state, operations)).toHaveLength(1);
    expect(mine(again.state, operations)[0]?.category).toBe('ASSIGNED');
    expect(mine(again.state, operations)[0]?.href).toBe('/ukoly?resourceId=task-1');
    expect(again.entityIds).toEqual([]);
  }),
);

it('nested source dates link to the root document and security inspections to the exact device', () => {
  const documents = opsAgendaDeadlines('documents', {
    documents: [{ contract: { validTo: '2026-10-25' }, id: 'doc 1', title: 'Úklid' }],
  });
  expect(documents[0]?.href).toBe('/provoz/dokumenty?doc=doc%201');
  const devices = opsAgendaDeadlines('security', {
    devices: [{ id: 'cam-12', name: 'Kamera K-12', nextInspectionDate: '2026-10-31' }],
  });
  expect(devices[0]?.href).toBe('/provoz/bezpecnost?device=cam-12');
});

it('CSV neutralizes spreadsheet formulas without changing numeric amounts', () => {
  expect(
    toCsv(
      ['Název', 'Částka'],
      [
        ['=SUM(A1:A2)', -20],
        [' @HYPERLINK()', 10],
      ],
    ),
  ).toContain("'=SUM(A1:A2);-20");
});

it.effect('event update patches preserve omitted, removed and supplied references over the wire', () =>
  Effect.gen(function* agendaReferencePatches() {
    const related = { id: 'unit-1', kind: 'unit', label: 'Unit 1' } as const;
    const base = { _tag: 'AgendaEventUpdate', eventId: 'e1', title: 'Updated' } as const;
    const omitted = yield* Schema.decodeUnknownEffect(AgendaCommandSchema)(base);
    expect(Object.hasOwn(omitted, 'related')).toBe(false);
    expect(Object.hasOwn(omitted, 'assignee')).toBe(false);
    expect(yield* Schema.encodeEffect(AgendaCommandSchema)(omitted)).toEqual(base);
    const removal = { ...base, assignee: null, related: null };
    const removed = yield* Schema.decodeUnknownEffect(AgendaCommandSchema)(removal);
    expect(Schema.is(updateEventSchema)(removed)).toBe(true);
    if (Schema.is(updateEventSchema)(removed)) {
      expect(removed.related !== undefined && Option.isNone(removed.related)).toBe(true);
      expect(removed.assignee !== undefined && Option.isNone(removed.assignee)).toBe(true);
    }
    expect(yield* Schema.encodeEffect(AgendaCommandSchema)(removed)).toEqual(removal);
    const supplied = { ...base, assignee: operations, assigneeLabel: 'Operations', related };
    const present = yield* Schema.decodeUnknownEffect(AgendaCommandSchema)(supplied);
    expect(yield* Schema.encodeEffect(AgendaCommandSchema)(present)).toEqual(supplied);

    const created = yield* apply(
      empty,
      {
        _tag: 'AgendaEventCreate',
        assignee: operations,
        assigneeLabel: 'Operations',
        date: '2026-10-27',
        kind: 'MEETING',
        related,
        title: 'Original',
      },
      'e1',
    );
    const retained = yield* apply(created.state, base, 'update-omitted');
    expect(retained.state.events[0]?.related).toEqual(related);
    expect(retained.state.events[0]?.assignee).toEqual(operations);
    expect(retained.state.events[0]?.assigneeLabel).toBe('Operations');
    const cleared = yield* apply(retained.state, removal, 'update-removed');
    expect(Object.hasOwn(cleared.state.events[0] ?? {}, 'related')).toBe(false);
    expect(Object.hasOwn(cleared.state.events[0] ?? {}, 'assignee')).toBe(false);
    expect(Object.hasOwn(cleared.state.events[0] ?? {}, 'assigneeLabel')).toBe(false);
    const restored = yield* apply(cleared.state, supplied, 'update-present');
    expect(restored.state.events[0]?.related).toEqual(related);
    expect(restored.state.events[0]?.assignee).toEqual(operations);
    expect(restored.state.events[0]?.assigneeLabel).toBe('Operations');
  }),
);
