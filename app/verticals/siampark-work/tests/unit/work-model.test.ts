import { TaskRefSchema } from '../../shared/resources/task.ts';
import {
  WorkLifecycleConflict,
  WorkScopeMismatch,
  WorkReferenceUnavailable,
  WorkCommandSchema,
} from '../../shared/actions/apply-command.ts';
import { Effect, DateTime, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ContextAccess } from '@app/core-runtime';
import type { ContextAccessService, OperationalScope } from '@app/core-runtime';
import { WorkStateSchema, CalendarDateSchema } from '../../shared/apis/records.ts';
import {
  evolveWorkState,
  taskIsOverdue,
  taskStatusGroup,
  visibleWorkTasks,
} from '../../src/services/persistence.service.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const now = DateTime.makeUnsafe('2026-10-05T10:00:00Z');
const scope: OperationalScope = {
  authBindingId: '20000000-0000-4000-8000-000000000003',
  authContextRef: 'session:test',
  authMethod: 'session',
  correlationId: 'test:work',
  legalEntityId: '20000000-0000-4000-8000-000000000004',
  principalId: '20000000-0000-4000-8000-000000000002',
  tenantId,
};
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
const resourceDecision = (id: string, allowed: readonly string[], unavailable: boolean) => {
  if (unavailable) {
    return 'unavailable' as const;
  }
  return allowed.includes(id) ? ('allowed' as const) : ('denied' as const);
};
const fakeAccess = (allowed: readonly string[], unavailable = false): ContextAccessService => ({
  assortmentPermissions: () => Effect.succeed([]),
  businessPermissions: () => Effect.succeed([]),
  contextPermissions: ({ targets }) =>
    Effect.succeed(
      targets.map(({ moduleId, permission }) => ({ decision: 'denied' as const, key: `${moduleId}:${permission}` })),
    ),
  identityNamespaces: () => Effect.succeed([]),
  legalEntities: () => Effect.succeed([]),
  modules: () => Effect.succeed([]),
  resources: ({ resources }) =>
    Effect.succeed(
      resources.map((ref) => ({
        decision: resourceDecision(ref.resourceId, allowed, unavailable),
        key: `${ref.moduleId}:${ref.resourceType}:${ref.resourceId}`,
      })),
    ),
  tenants: () => Effect.succeed([]),
});

it.effect('Title-only creation defaults to NEW without business context or principal', () =>
  Effect.gen(function* case1() {
    const state = yield* Schema.decodeEffect(WorkStateSchema)(seed);
    const command = yield* Schema.decodeEffect(WorkCommandSchema)({ _tag: 'CreateTask', title: 'Inspect apartment' });
    const change = yield* evolveWorkState(state, command, { now, resourceId: 'new', tenantId });
    expect(change.task.state).toBe('NEW');
    expect(change.task.priority).toBe('NORMAL');
    expect(change.task.contextRefs).toEqual([]);
    expect(change.task.ownerPrincipalRef).toBeUndefined();
    expect(change.task.collectionRef).toEqual(state.collection.ref);
    expect(
      yield* evolveWorkState(
        change.state,
        { _tag: 'ChangeTaskState', state: 'DONE', taskRef: change.task.ref },
        { now, resourceId: 'next', tenantId },
      ).pipe(Effect.flip),
    ).toBeInstanceOf(WorkLifecycleConflict);
    const started = yield* evolveWorkState(
      change.state,
      { _tag: 'ChangeTaskState', state: 'IN_PROGRESS', taskRef: change.task.ref },
      { now, resourceId: 'next', tenantId },
    );
    const done = yield* evolveWorkState(
      started.state,
      { _tag: 'ChangeTaskState', state: 'DONE', taskRef: change.task.ref },
      { now, resourceId: 'next', tenantId },
    );
    expect(
      yield* evolveWorkState(
        done.state,
        { _tag: 'UpdateTask', taskRef: change.task.ref, title: 'Edited after done' },
        { now, resourceId: 'next', tenantId },
      ).pipe(Effect.flip),
    ).toBeInstanceOf(WorkLifecycleConflict);
  }),
);
it.effect('rejects cross-tenant owner and impossible dates', () =>
  Effect.gen(function* case2() {
    const state = yield* Schema.decodeEffect(WorkStateSchema)(seed);
    expect(
      yield* evolveWorkState(
        state,
        {
          _tag: 'CreateTask',
          ownerPrincipalRef: { principalId: scope.principalId, tenantId: '30000000-0000-4000-8000-000000000001' },
          title: 'Unsafe',
        },
        { now, resourceId: 'new', tenantId },
      ).pipe(Effect.flip),
    ).toBeInstanceOf(WorkScopeMismatch);
    expect(yield* Schema.decodeEffect(CalendarDateSchema)('2026-02-30').pipe(Effect.isFailure)).toBe(true);
  }),
);
it.effect('WAITING is in progress, overdue is derived, and resource filtering fails closed', () =>
  Effect.gen(function* case3() {
    const state = yield* Schema.decodeEffect(WorkStateSchema)(seed);
    const created = yield* evolveWorkState(
      state,
      { _tag: 'CreateTask', dueDate: '2026-10-04', title: 'Due' },
      { now, resourceId: 'allowed', tenantId },
    );
    const task = { ...created.task, state: 'WAITING' as const };
    expect(taskStatusGroup(task.state)).toBe('IN_PROGRESS');
    expect(taskIsOverdue(task)).toBe(true);
    expect(taskIsOverdue({ ...task, dueDate: '2026-10-05' })).toBe(false);
    expect(taskIsOverdue({ ...task, state: 'DONE' })).toBe(false);
    const foreignRef = yield* Schema.decodeEffect(TaskRefSchema)({ ...task.ref, resourceId: 'denied' });
    const foreign = { ...task, ref: foreignRef };
    expect(
      yield* visibleWorkTasks([task, foreign], scope).pipe(
        Effect.provideService(ContextAccess, fakeAccess(['allowed'])),
      ),
    ).toEqual([task]);
    expect(
      yield* visibleWorkTasks([task, foreign], scope)
        .pipe(Effect.provideService(ContextAccess, fakeAccess(['allowed'], true)))
        .pipe(Effect.flip),
    ).toBeInstanceOf(WorkReferenceUnavailable);
  }),
);
