import { TaskRefSchema } from '../../shared/resources/task.ts';
import {
  WorkLifecycleConflict,
  WorkScopeMismatch,
  WorkReferenceUnavailable,
  SingleWorkCommandSchema,
} from '../../shared/actions/apply-command.ts';
import { Effect, DateTime, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ContextAccess } from '@app/core-runtime';
import { withHistory } from '../../src/services/work-history.ts';
import { AssignablePrincipals, AssigneeIneligible } from '@app/core-runtime/auth/assignable-principals';
import type { ContextAccessService, OperationalScope } from '@app/core-runtime';
import {
  WorkStateSchema,
  CalendarDateSchema,
  ProjectIdSchema,
  StorefrontInquirySchema,
} from '../../shared/apis/records.ts';
import {
  evolveWorkState,
  finishWorkRecords,
  taskIsOverdue,
  taskStatusGroup,
  visibleWorkTasks,
} from '../../src/services/persistence.service.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const now = DateTime.makeUnsafe('2026-10-05T10:00:00Z');
const scope = {
  authBindingId: '20000000-0000-4000-8000-000000000003',
  authContextRef: 'session:test',
  authMethod: 'session',
  correlationId: 'test:work',
  legalEntityId: '20000000-0000-4000-8000-000000000004',
  principalId: '20000000-0000-4000-8000-000000000002',
  tenantId,
} satisfies OperationalScope;
const seed = {
  collection: {
    properties: {
      dueDate: { locked: true, type: 'DATE' },
      ownerPrincipalRef: { locked: true, type: 'PRINCIPAL' },
      status: { groups: ['NOT_STARTED', 'IN_PROGRESS', 'DONE'], locked: true, type: 'STATUS' },
      title: { locked: true, type: 'TEXT' },
    },
    ref: { moduleId: 'work.tasks', resourceId: 'default', resourceType: 'work.tasks.task-collection', tenantId },
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

it.effect('a restricted persona sees its own tasks, never another principal’s task', () =>
  Effect.gen(function* ownTasksOnly() {
    const state = yield* Schema.decodeEffect(WorkStateSchema)(seed);
    const own = yield* evolveWorkState(
      state,
      {
        _tag: 'CreateTask',
        ownerPrincipalRef: { principalId: scope.principalId, tenantId },
        title: 'Vlastní úkol',
      },
      { now, resourceId: 'own', tenantId },
    );
    const other = yield* evolveWorkState(
      own.state,
      {
        _tag: 'CreateTask',
        ownerPrincipalRef: { principalId: scope.authBindingId, tenantId },
        title: 'Cizí úkol',
      },
      { now, resourceId: 'other', tenantId },
    );
    const visible = yield* visibleWorkTasks(other.state.tasks, scope, false).pipe(
      Effect.provideService(ContextAccess, fakeAccess([])),
    );
    expect(visible.map((task) => task.title)).toEqual(['Vlastní úkol']);
  }),
);

it.effect('personal visibility compares the full tenant and principal identity', () =>
  Effect.gen(function* fullPrincipalIdentity() {
    const state = yield* Schema.decodeEffect(WorkStateSchema)(seed);
    const created = yield* evolveWorkState(
      state,
      {
        _tag: 'CreateTask',
        ownerPrincipalRef: { principalId: scope.principalId, tenantId },
        title: 'Owned work',
      },
      { now, resourceId: 'identity', tenantId },
    );
    const foreign = {
      ...created.task,
      ownerPrincipalRef: { principalId: scope.principalId, tenantId: scope.authBindingId },
    };
    expect(
      yield* visibleWorkTasks([foreign], scope, false).pipe(Effect.provideService(ContextAccess, fakeAccess([]))),
    ).toEqual([]);
  }),
);

it.effect('unrelated task edits preserve a historical assignment and its reassignment marker', () =>
  Effect.gen(function* preserveHistoricalAssignment() {
    const initial = yield* Schema.decodeEffect(WorkStateSchema)(seed);
    const created = yield* evolveWorkState(
      initial,
      {
        _tag: 'CreateTask',
        ownerPrincipalRef: { principalId: scope.principalId, tenantId },
        title: 'Departed owner work',
      },
      { now, resourceId: 'departed', tenantId },
    );
    const task = { ...created.task, assignmentNeedsReassignment: true };
    const changed = yield* evolveWorkState(
      { ...created.state, tasks: [task] },
      {
        _tag: 'UpdateTask',
        taskRef: task.ref,
        title: 'Updated title',
      },
      { now, resourceId: 'departed', tenantId },
    );
    expect(changed.task.ownerPrincipalRef).toEqual(task.ownerPrincipalRef);
    expect(changed.task).toMatchObject({ assignmentNeedsReassignment: true });
    const retainedOwner = yield* evolveWorkState(
      changed.state,
      {
        _tag: 'UpdateTask',
        ownerPrincipalRef: Option.some({ principalId: scope.principalId, tenantId }),
        taskRef: task.ref,
      },
      { now, resourceId: 'departed', tenantId },
    );
    expect(retainedOwner.task).toMatchObject({ assignmentNeedsReassignment: true });
  }),
);

it.effect('UpdateTask assigns, preserves an omitted owner, and clears through stored state, records and history', () =>
  Effect.gen(function* clearAssignment() {
    const initial = yield* Schema.decodeEffect(WorkStateSchema)(seed);
    const created = yield* evolveWorkState(
      initial,
      { _tag: 'CreateTask', title: 'Repair office lighting' },
      { now, resourceId: 'clear-owner', tenantId },
    );
    const actor = { principalId: scope.principalId, tenantId };
    const target = { principalId: scope.authBindingId, tenantId };
    const taskRef = created.task.ref;
    const assignedAt = DateTime.makeUnsafe('2026-10-05T10:01:00Z');
    const clearedAt = DateTime.makeUnsafe('2026-10-05T10:02:00Z');
    const assign = yield* Schema.decodeUnknownEffect(SingleWorkCommandSchema)({
      _tag: 'UpdateTask',
      ownerPrincipalRef: target,
      taskRef,
    });
    const assigned = yield* evolveWorkState(created.state, assign, { now: assignedAt, resourceId: 'unused', tenantId });
    const assignedState = withHistory(created.state, assigned.state, actor, assignedAt);
    expect(assignedState.tasks[0]?.ownerPrincipalRef).toEqual(target);
    expect(assignedState.tasks[0]?.history?.[0]?.changes).toEqual([
      { after: `${tenantId}:${target.principalId}`, field: 'ownerPrincipalRef' },
    ]);

    const omitted = yield* Schema.decodeUnknownEffect(SingleWorkCommandSchema)({ _tag: 'UpdateTask', taskRef });
    expect(yield* Schema.encodeEffect(SingleWorkCommandSchema)(omitted)).not.toHaveProperty('ownerPrincipalRef');
    const unchanged = yield* evolveWorkState(assignedState, omitted, {
      now: assignedAt,
      resourceId: 'unused',
      tenantId,
    });
    const unchangedState = withHistory(assignedState, unchanged.state, actor, assignedAt);
    expect(unchanged.task.ownerPrincipalRef).toEqual(target);
    expect(unchangedState.tasks[0]?.history).toEqual(assignedState.tasks[0]?.history);

    const clear = yield* Schema.decodeUnknownEffect(SingleWorkCommandSchema)({
      _tag: 'UpdateTask',
      ownerPrincipalRef: null,
      taskRef,
    });
    expect(yield* Schema.encodeEffect(SingleWorkCommandSchema)(clear)).toHaveProperty('ownerPrincipalRef', null);
    const cleared = yield* evolveWorkState(unchangedState, clear, { now: clearedAt, resourceId: 'unused', tenantId });
    const recorded = withHistory(unchangedState, cleared.state, actor, clearedAt, 'Manager');
    const stored = yield* Schema.encodeEffect(WorkStateSchema)(recorded);
    const reloaded = yield* Schema.decodeUnknownEffect(WorkStateSchema)(stored);
    expect(reloaded.tasks[0]).not.toHaveProperty('ownerPrincipalRef');
    expect(reloaded.tasks[0]?.history).toHaveLength(2);
    expect(reloaded.tasks[0]?.history?.at(-1)).toEqual({
      action: 'updated',
      actorDisplayName: 'Manager',
      actorPrincipalRef: actor,
      at: clearedAt,
      changes: [{ before: `${tenantId}:${target.principalId}`, field: 'ownerPrincipalRef' }],
    });
    const records = yield* finishWorkRecords(
      { resourceId: taskRef.resourceId },
      {
        assignmentDirectory: { legalEntityId: scope.legalEntityId, members: [], tenantId },
        names: new Map(),
        revision: 3,
        state: stored,
      },
      {
        lookupAccess: { contracts: 'denied', customers: 'denied', opportunities: 'denied', properties: 'denied' },
        readAll: true,
        writeAll: true,
      },
      scope,
    ).pipe(
      Effect.provideService(ContextAccess, fakeAccess([])),
      Effect.provideService(AssignablePrincipals, {
        read: () => Effect.succeed([]),
        resolveAssignee: () => Effect.fail(new AssigneeIneligible({ reason: 'A clear has no assignment target' })),
      }),
    );
    expect(records.items[0]).not.toHaveProperty('ownerPrincipalRef');
    expect(records.items[0]?.history).toEqual(reloaded.tasks[0]?.history);
    expect(records.indicators.openByAssignee).toEqual([]);
  }),
);

it.effect('explicit unassignment removes stale assignment markers but rejects malformed and cross-tenant targets', () =>
  Effect.gen(function* validateAssignmentPatch() {
    const initial = yield* Schema.decodeEffect(WorkStateSchema)(seed);
    const created = yield* evolveWorkState(
      initial,
      { _tag: 'CreateTask', ownerPrincipalRef: { principalId: scope.principalId, tenantId }, title: 'Historical work' },
      { now, resourceId: 'historical-clear', tenantId },
    );
    const historical = {
      ...created.state,
      tasks: [{ ...created.task, assignmentNeedsReassignment: true, assignmentWithoutLogin: true }],
    };
    const taskRef = created.task.ref;
    for (const ownerPrincipalRef of ['', {}, { principalId: scope.principalId }, undefined]) {
      expect(
        yield* Schema.decodeUnknownEffect(SingleWorkCommandSchema)({
          _tag: 'UpdateTask',
          ownerPrincipalRef,
          taskRef,
        }).pipe(Effect.isFailure),
      ).toBe(true);
    }
    const foreign = yield* Schema.decodeUnknownEffect(SingleWorkCommandSchema)({
      _tag: 'UpdateTask',
      ownerPrincipalRef: { principalId: scope.principalId, tenantId: scope.authBindingId },
      taskRef,
    });
    expect(
      yield* evolveWorkState(historical, foreign, { now, resourceId: 'unused', tenantId }).pipe(Effect.flip),
    ).toBeInstanceOf(WorkScopeMismatch);
    const clear = yield* Schema.decodeUnknownEffect(SingleWorkCommandSchema)({
      _tag: 'UpdateTask',
      ownerPrincipalRef: null,
      taskRef,
    });
    const cleared = yield* evolveWorkState(historical, clear, { now, resourceId: 'unused', tenantId });
    expect(cleared.task).not.toHaveProperty('ownerPrincipalRef');
    expect(cleared.task).not.toHaveProperty('assignmentNeedsReassignment');
    expect(cleared.task).not.toHaveProperty('assignmentWithoutLogin');
    const cancelled = yield* evolveWorkState(
      historical,
      { _tag: 'ChangeTaskState', state: 'CANCELLED', taskRef },
      { now, resourceId: 'unused', tenantId },
    );
    expect(
      yield* evolveWorkState(cancelled.state, clear, { now, resourceId: 'unused', tenantId }).pipe(Effect.flip),
    ).toBeInstanceOf(WorkLifecycleConflict);
  }),
);

it.effect('projects departed task and project owners without rewriting their stored references', () =>
  Effect.gen(function* departedProjection() {
    const initial = yield* Schema.decodeEffect(WorkStateSchema)(seed);
    const created = yield* evolveWorkState(
      initial,
      {
        _tag: 'CreateTask',
        ownerPrincipalRef: { principalId: scope.principalId, tenantId },
        title: 'Historical work',
      },
      { now, resourceId: 'historical', tenantId },
    );
    const state = yield* Schema.encodeEffect(WorkStateSchema)({
      ...created.state,
      projects: [
        {
          createdAt: now,
          id: yield* Schema.decodeEffect(ProjectIdSchema)('historical-project'),
          milestones: [],
          plannedEnd: '2026-10-31',
          plannedStart: '2026-10-01',
          responsiblePrincipalRef: created.task.ownerPrincipalRef,
          state: 'ACTIVE',
          title: 'Historical project',
          updatedAt: now,
        },
      ],
    });
    const available = { displayName: 'Available agent', principalRef: { principalId: scope.authBindingId, tenantId } };
    const records = yield* finishWorkRecords(
      {},
      {
        assignmentDirectory: {
          legalEntityId: '20000000-0000-4000-8000-000000000004',
          members: [
            { ...available, membershipStatus: 'active', principalStatus: 'active' },
            {
              displayName: 'Former colleague',
              membershipStatus: 'departed',
              principalRef: { principalId: scope.principalId, tenantId },
              principalStatus: 'active',
            },
          ],
          tenantId,
        },
        names: new Map([
          [scope.principalId, 'Former colleague'],
          [scope.authBindingId, available.displayName],
        ]),
        revision: 7,
        state,
      },
      {
        lookupAccess: { contracts: 'denied', customers: 'denied', opportunities: 'denied', properties: 'denied' },
        readAll: true,
        writeAll: true,
      },
      scope,
    ).pipe(
      Effect.provideService(ContextAccess, fakeAccess([])),
      Effect.provideService(AssignablePrincipals, {
        read: () => Effect.succeed([available]),
        resolveAssignee: () => Effect.fail(new AssigneeIneligible({ reason: 'Not used by a records read' })),
      }),
    );
    expect(records.items[0]?.ownerPrincipalRef).toEqual(created.task.ownerPrincipalRef);
    expect(records.items[0]?.assignmentNeedsReassignment).toBe(true);
    expect(records.projects[0]?.responsiblePrincipalRef).toEqual(created.task.ownerPrincipalRef);
    expect(records.projects[0]?.assignmentNeedsReassignment).toBe(true);
    expect(records.assignablePrincipals).toEqual([available]);
    expect(created.task).not.toHaveProperty('assignmentNeedsReassignment');
  }),
);

it.effect('closed unlinked records keep historical provenance but never advertise reassignment', () =>
  Effect.gen(function* closedUnlinkedProjection() {
    const initial = yield* Schema.decodeEffect(WorkStateSchema)(seed);
    const created = yield* evolveWorkState(
      initial,
      { _tag: 'CreateTask', title: 'Unlinked history' },
      { now, resourceId: 'unlinked', tenantId },
    );
    const state = yield* Schema.encodeEffect(WorkStateSchema)({
      ...created.state,
      tasks: (['DONE', 'CANCELLED', 'NEW'] as const).map((taskState) => ({
        ...created.task,
        assignmentNeedsReassignment: true,
        assignmentWithoutLogin: true,
        ref: { ...created.task.ref, resourceId: Schema.decodeUnknownSync(TaskRefSchema.fields.resourceId)(taskState) },
        state: taskState,
      })),
    });
    const records = yield* finishWorkRecords(
      {},
      {
        assignmentDirectory: { legalEntityId: scope.legalEntityId, members: [], tenantId },
        names: new Map(),
        revision: 1,
        state,
      },
      {
        lookupAccess: { contracts: 'denied', customers: 'denied', opportunities: 'denied', properties: 'denied' },
        readAll: true,
        writeAll: true,
      },
      scope,
    ).pipe(
      Effect.provideService(ContextAccess, fakeAccess([])),
      Effect.provideService(AssignablePrincipals, {
        read: () => Effect.succeed([]),
        resolveAssignee: () => Effect.fail(new AssigneeIneligible({ reason: 'Not used by a records read' })),
      }),
    );
    expect(records.items.map((task) => task.assignmentNeedsReassignment === true)).toEqual([false, false, true]);
    expect(records.items.every((task) => task.assignmentWithoutLogin === true)).toBe(true);
  }),
);

it.effect('Title-only creation defaults to NEW without business context or principal', () =>
  Effect.gen(function* case1() {
    const state = yield* Schema.decodeEffect(WorkStateSchema)(seed);
    const command = yield* Schema.decodeEffect(SingleWorkCommandSchema)({
      _tag: 'CreateTask',
      title: 'Inspect apartment',
    });
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
    expect(taskIsOverdue(task, '2026-10-05')).toBe(true);
    expect(taskIsOverdue({ ...task, dueDate: '2026-10-05' }, '2026-10-05')).toBe(false);
    expect(taskIsOverdue({ ...task, state: 'DONE' }, '2026-10-05')).toBe(false);
    const foreignRef = yield* Schema.decodeEffect(TaskRefSchema)({ ...task.ref, resourceId: 'denied' });
    const foreign = { ...task, ref: foreignRef };
    expect(
      yield* visibleWorkTasks([task, foreign], scope, false).pipe(
        Effect.provideService(ContextAccess, fakeAccess(['allowed'])),
      ),
    ).toEqual([task]);
    expect(
      yield* visibleWorkTasks([task, foreign], scope, false)
        .pipe(Effect.provideService(ContextAccess, fakeAccess(['allowed'], true)))
        .pipe(Effect.flip),
    ).toBeInstanceOf(WorkReferenceUnavailable);
  }),
);
it.effect('UpdateTask keeps an absent due date, replaces a new one and removes it on wire null', () =>
  Effect.gen(function* case4() {
    const state = yield* Schema.decodeEffect(WorkStateSchema)(seed);
    const created = yield* evolveWorkState(
      state,
      { _tag: 'CreateTask', dueDate: '2026-10-04', title: 'Due' },
      { now, resourceId: 'due', tenantId },
    );
    const update = (fields: { readonly dueDate?: string | null; readonly title?: string }) =>
      Schema.decodeUnknownEffect(SingleWorkCommandSchema)({
        _tag: 'UpdateTask',
        taskRef: created.task.ref,
        ...fields,
      }).pipe(
        Effect.flatMap((command) => evolveWorkState(created.state, command, { now, resourceId: 'due', tenantId })),
      );
    expect((yield* update({ title: 'Renamed' })).task.dueDate).toBe('2026-10-04');
    expect((yield* update({ dueDate: '2026-10-09' })).task.dueDate).toBe('2026-10-09');
    const cleared = yield* update({ dueDate: null });
    expect(cleared.task.dueDate).toBeUndefined();
    expect(Object.keys(cleared.task)).not.toContain('dueDate');
  }),
);

it.effect('task property, unit and contract context can be replaced or cleared on update', () =>
  Effect.gen(function* editableContextLinks() {
    const state = yield* Schema.decodeEffect(WorkStateSchema)(seed);
    const created = yield* evolveWorkState(
      state,
      { _tag: 'CreateTask', title: 'Kontrola nájemního prostoru' },
      { now, resourceId: 'context-task', tenantId },
    );
    const contextRefs = [
      {
        moduleId: 'property.portfolio',
        resourceId: '20000000-0000-4000-8000-000000000011',
        resourceType: 'property.portfolio.property',
        tenantId,
      },
      {
        moduleId: 'legal.agreements',
        resourceId: '20000000-0000-4000-8000-000000000012',
        resourceType: 'legal.agreements.contract',
        tenantId,
      },
    ];
    const update = yield* Schema.decodeUnknownEffect(SingleWorkCommandSchema)({
      _tag: 'UpdateTask',
      contextRefs,
      taskRef: created.task.ref,
    });
    const linked = yield* evolveWorkState(created.state, update, { now, resourceId: 'unused', tenantId });
    expect(linked.task.contextRefs).toEqual(contextRefs);
    const clear = yield* Schema.decodeUnknownEffect(SingleWorkCommandSchema)({
      _tag: 'UpdateTask',
      contextRefs: [],
      taskRef: created.task.ref,
    });
    const cleared = yield* evolveWorkState(linked.state, clear, { now, resourceId: 'unused', tenantId });
    expect(cleared.task.contextRefs).toEqual([]);
    const foreign = yield* Schema.decodeUnknownEffect(SingleWorkCommandSchema)({
      _tag: 'UpdateTask',
      contextRefs: [{ ...contextRefs[0], tenantId: '20000000-0000-4000-8000-000000000099' }],
      taskRef: created.task.ref,
    });
    expect(
      yield* Effect.flip(evolveWorkState(created.state, foreign, { now, resourceId: 'unused', tenantId })),
    ).toBeInstanceOf(WorkScopeMismatch);
    const due = { ...created.task, dueDate: CalendarDateSchema.make('2026-10-19') };
    expect(taskIsOverdue(due, '2026-10-20')).toBe(true);
    expect(taskIsOverdue(due, '2026-10-19')).toBe(false);
  }),
);

it.effect('retains a real storefront inquiry as an actionable task with its product identity', () =>
  Effect.gen(function* storefrontInquiryTask() {
    const state = yield* Schema.decodeEffect(WorkStateSchema)(seed);
    const inquiry = yield* Schema.decodeUnknownEffect(StorefrontInquirySchema)({
      email: 'pavel@example.com',
      kind: 'PRODUCT_QUESTION',
      message: 'Prosím o potvrzení jakosti.',
      name: 'Pavel Dvořák',
      productId: 'akros-product-fh-ii',
      productName: 'Šroub A4',
      productSlug: 'sroub',
      requestId: '97672670-44ed-4de3-915d-e40e2cebe99c',
      subject: 'Jakost materiálu',
    });
    const command = yield* Schema.decodeEffect(SingleWorkCommandSchema)({
      _tag: 'CreateTask',
      description: inquiry.message,
      storefrontInquiry: inquiry,
      title: 'Dotaz na produkt: Jakost materiálu',
    });
    const change = yield* evolveWorkState(state, command, { now, resourceId: 'inquiry-task', tenantId });
    const encoded = yield* Schema.encodeEffect(WorkStateSchema)(change.state);
    const restored = yield* Schema.decodeEffect(WorkStateSchema)(encoded);
    expect(restored.tasks[0]?.storefrontInquiry).toEqual(inquiry);
    expect(restored.tasks[0]?.state).toBe('NEW');
    expect(restored.tasks[0]?.description).toBe(inquiry.message);
  }),
);
