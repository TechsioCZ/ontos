import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { SingleWorkCommandSchema } from '../../shared/actions/apply-command.ts';
import { WorkStateSchema } from '../../shared/apis/records.ts';
import { evolveWorkState } from '../../src/services/persistence.service.ts';
import { withHistory } from '../../src/services/work-history.ts';
import { filterTasks, initialTaskFilters } from '../../src/routes/[lang]/siampark/work/tasks-model.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const actor = { principalId: '20000000-0000-4000-8000-000000000002', tenantId };
const created = DateTime.makeUnsafe('2026-10-05T10:00:00Z');
const later = DateTime.makeUnsafe('2026-10-06T08:30:00Z');
const seed = {
  collection: {
    properties: {
      dueDate: { locked: true, type: 'DATE' },
      ownerPrincipalRef: { locked: true, type: 'PRINCIPAL' },
      status: { groups: ['NOT_STARTED', 'IN_PROGRESS', 'DONE'], locked: true, type: 'STATUS' },
      title: { locked: true, type: 'TEXT' },
    },
    ref: { moduleId: 'siampark.work', resourceId: 'default', resourceType: 'siampark.work.task-collection', tenantId },
    title: 'Tasks',
  },
  tasks: [],
} as const;

const command = (input: unknown) => Schema.decodeUnknownEffect(SingleWorkCommandSchema)(input);

it.effect('every governed change records who, when and each field before → after', () =>
  Effect.gen(function* history() {
    const empty = yield* Schema.decodeEffect(WorkStateSchema)(seed);
    const create = yield* evolveWorkState(
      empty,
      yield* command({ _tag: 'CreateTask', dueDate: '2026-10-20', title: 'Revize výtahu' }),
      { now: created, resourceId: 'task-1', tenantId },
    );
    const afterCreate = withHistory(empty, create.state, actor, created);
    expect(afterCreate.tasks[0]?.history?.map((entry) => entry.action)).toEqual(['created']);

    const taskRef = create.task.ref;
    const update = yield* evolveWorkState(
      afterCreate,
      yield* command({ _tag: 'UpdateTask', dueDate: '2026-10-24', priority: 'HIGH', taskRef }),
      { now: later, resourceId: 'task-1', tenantId },
    );
    const afterUpdate = withHistory(afterCreate, update.state, actor, later);
    const entry = afterUpdate.tasks[0]?.history?.at(-1);
    expect(entry?.action).toBe('updated');
    expect(entry?.actorPrincipalRef).toEqual(actor);
    expect(entry?.changes).toEqual([
      { after: 'HIGH', before: 'NORMAL', field: 'priority' },
      { after: '2026-10-24', before: '2026-10-20', field: 'dueDate' },
    ]);

    // Hiding an open task is refused; a cancelled one is hidden and the history says so.
    const refused = yield* evolveWorkState(
      afterUpdate,
      yield* command({ _tag: 'SetTaskArchived', archived: true, taskRef }),
      { now: later, resourceId: 'task-1', tenantId },
    ).pipe(Effect.flip);
    expect(refused._tag).toBe('WorkLifecycleConflict');
    const cancel = yield* evolveWorkState(
      afterUpdate,
      yield* command({ _tag: 'ChangeTaskState', state: 'CANCELLED', taskRef }),
      { now: later, resourceId: 'task-1', tenantId },
    );
    const afterCancel = withHistory(afterUpdate, cancel.state, actor, later);
    const hide = yield* evolveWorkState(
      afterCancel,
      yield* command({ _tag: 'SetTaskArchived', archived: true, taskRef }),
      { now: later, resourceId: 'task-1', tenantId },
    );
    const afterHide = withHistory(afterCancel, hide.state, actor, later);
    const [hidden] = afterHide.tasks;
    expect(hidden?.archivedAt).toBeDefined();
    expect(hidden?.history?.map((item) => item.action)).toEqual(['created', 'updated', 'updated', 'archived']);
    // The state survives the stored JSON shape.
    const roundTrip = yield* Schema.decodeUnknownEffect(WorkStateSchema)(
      yield* Schema.encodeEffect(WorkStateSchema)(afterHide),
    );
    expect(roundTrip.tasks[0]?.history?.length).toBe(4);
  }),
);

it.effect('Objekt and Termín od/do filters narrow the list', () =>
  Effect.gen(function* filters() {
    const empty = yield* Schema.decodeEffect(WorkStateSchema)(seed);
    const unitRef = {
      moduleId: 'siampark.property',
      resourceId: '30000000-0000-4000-8000-000000000101',
      resourceType: 'siampark.property.unit',
      tenantId,
    };
    const first = yield* evolveWorkState(
      empty,
      yield* command({ _tag: 'CreateTask', contextRefs: [unitRef], dueDate: '2026-11-03', title: 'Výměna baterie' }),
      { now: created, resourceId: 'a', tenantId },
    );
    const second = yield* evolveWorkState(
      first.state,
      yield* command({ _tag: 'CreateTask', dueDate: '2026-12-15', title: 'Úklid sklepa' }),
      { now: created, resourceId: 'b', tenantId },
    );
    const unitProperty = new Map([['30000000-0000-4000-8000-000000000101', '30000000-0000-4000-8000-000000000001']]);
    const titles = (overrides: Partial<typeof initialTaskFilters>) =>
      filterTasks(second.state.tasks, {
        filters: { ...initialTaskFilters, ...overrides },
        tab: 'all',
        unitProperty,
      }).map((task) => task.title);
    expect(titles({ object: '30000000-0000-4000-8000-000000000001' })).toEqual(['Výměna baterie']);
    expect(titles({ object: '30000000-0000-4000-8000-000000000101' })).toEqual(['Výměna baterie']);
    expect(titles({ dueFrom: '2026-12-01' })).toEqual(['Úklid sklepa']);
    expect(titles({ dueFrom: '2026-11-01', dueTo: '2026-11-30' })).toEqual(['Výměna baterie']);
    expect(titles({})).toHaveLength(2);
  }),
);
