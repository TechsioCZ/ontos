import { Effect, DateTime, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { BulkWorkCommandSchema, SingleWorkCommandSchema } from '../../shared/actions/apply-command.ts';
import { WorkStateSchema } from '../../shared/apis/records.ts';
import { evolveBulkWorkState, evolveWorkState, openByAssignee } from '../../src/services/persistence.service.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const now = DateTime.makeUnsafe('2026-10-05T10:00:00Z');
const principalA = { principalId: '40000000-0000-4000-8000-000000000001', tenantId };
const principalB = { principalId: '40000000-0000-4000-8000-000000000002', tenantId };
const partyId = '50000000-0000-4000-8000-000000000001';
const opportunityId = '60000000-0000-4000-8000-000000000001';
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

const single = Schema.decodeUnknownEffect(SingleWorkCommandSchema);
const bulk = Schema.decodeUnknownEffect(BulkWorkCommandSchema);

it.effect('BulkChangeTaskState skips an invalid transition and reports every id', () =>
  Effect.gen(function* case1() {
    const state = yield* Schema.decodeEffect(WorkStateSchema)(seed);
    const withA = yield* evolveWorkState(state, yield* single({ _tag: 'CreateTask', title: 'Call customer' }), {
      now,
      resourceId: 'task-a',
      tenantId,
    });
    const withB = yield* evolveWorkState(withA.state, yield* single({ _tag: 'CreateTask', title: 'Prepare offer' }), {
      now,
      resourceId: 'task-b',
      tenantId,
    });
    const started = yield* evolveWorkState(
      withB.state,
      yield* single({ _tag: 'ChangeTaskState', state: 'IN_PROGRESS', taskRef: withB.task.ref }),
      { now, resourceId: 'unused', tenantId },
    );
    // NEW -> DONE is not a legal transition (NEW allows only IN_PROGRESS and CANCELLED); IN_PROGRESS -> DONE is.
    const result = yield* evolveBulkWorkState(
      started.state,
      yield* bulk({ _tag: 'BulkChangeTaskState', ids: ['task-a', 'task-b', 'missing'], toState: 'DONE' }),
      { now, tenantId },
    );
    expect(result.changed).toBe(true);
    expect(result.results).toEqual([
      { outcome: 'skipped', reason: 'invalid_transition', resourceId: 'task-a' },
      { outcome: 'changed', resourceId: 'task-b' },
      { outcome: 'skipped', reason: 'not_found', resourceId: 'missing' },
    ]);
    expect(result.state.tasks.find((task) => task.ref.resourceId === 'task-a')?.state).toBe('NEW');
    expect(result.state.tasks.find((task) => task.ref.resourceId === 'task-b')?.state).toBe('DONE');

    const nothingChanges = yield* evolveBulkWorkState(
      withA.state,
      yield* bulk({ _tag: 'BulkChangeTaskState', ids: ['task-a'], toState: 'DONE' }),
      { now, tenantId },
    );
    expect(nothingChanges.changed).toBe(false);
    expect(nothingChanges.results).toEqual([
      { outcome: 'skipped', reason: 'invalid_transition', resourceId: 'task-a' },
    ]);
  }),
);

it.effect(
  'CreateTask keeps assignee, customer and opportunity links; BulkAssignTasks sets, clears and skips closed',
  () =>
    Effect.gen(function* case2() {
      const state = yield* Schema.decodeEffect(WorkStateSchema)(seed);
      const withA = yield* evolveWorkState(
        state,
        yield* single({
          _tag: 'CreateTask',
          opportunityId,
          ownerPrincipalRef: principalB,
          partyId,
          title: 'Send contract',
        }),
        { now, resourceId: 'task-a', tenantId },
      );
      expect(withA.task.ownerPrincipalRef).toEqual(principalB);
      expect(withA.task.partyId).toBe(partyId);
      expect(withA.task.opportunityId).toBe(opportunityId);

      const withB = yield* evolveWorkState(withA.state, yield* single({ _tag: 'CreateTask', title: 'Old follow-up' }), {
        now,
        resourceId: 'task-b',
        tenantId,
      });
      const started = yield* evolveWorkState(
        withB.state,
        yield* single({ _tag: 'ChangeTaskState', state: 'IN_PROGRESS', taskRef: withB.task.ref }),
        { now, resourceId: 'unused', tenantId },
      );
      const closed = yield* evolveWorkState(
        started.state,
        yield* single({ _tag: 'ChangeTaskState', state: 'DONE', taskRef: withB.task.ref }),
        { now, resourceId: 'unused', tenantId },
      );

      const assigned = yield* evolveBulkWorkState(
        closed.state,
        yield* bulk({ _tag: 'BulkAssignTasks', ids: ['task-a', 'task-b'], ownerPrincipalRef: principalA }),
        { now, tenantId },
      );
      expect(assigned.results).toEqual([
        { outcome: 'changed', resourceId: 'task-a' },
        { outcome: 'skipped', reason: 'closed', resourceId: 'task-b' },
      ]);
      const reassigned = assigned.state.tasks.find((task) => task.ref.resourceId === 'task-a');
      expect(reassigned?.ownerPrincipalRef).toEqual(principalA);
      expect(reassigned?.partyId).toBe(partyId);
      expect(openByAssignee(assigned.state.tasks)).toEqual([{ open: 1, ownerPrincipalRef: principalA }]);

      const cleared = yield* evolveBulkWorkState(
        assigned.state,
        yield* bulk({ _tag: 'BulkAssignTasks', ids: ['task-a'], ownerPrincipalRef: null }),
        { now, tenantId },
      );
      const unassigned = cleared.state.tasks.find((task) => task.ref.resourceId === 'task-a');
      expect(unassigned).toBeDefined();
      expect(unassigned?.ownerPrincipalRef).toBeUndefined();
      expect(Object.keys(unassigned ?? {})).not.toContain('ownerPrincipalRef');
      expect(openByAssignee(cleared.state.tasks)).toEqual([]);
    }),
);

it.effect('assignment requires a complete principal reference and bulk commands need at least one id', () =>
  Effect.gen(function* case3() {
    expect(
      yield* bulk({ _tag: 'BulkAssignTasks', ids: ['task-a'], ownerPrincipalRef: 'not-a-principal-ref' }).pipe(
        Effect.isFailure,
      ),
    ).toBe(true);
    expect(yield* bulk({ _tag: 'BulkAssignTasks', ids: [], ownerPrincipalRef: null }).pipe(Effect.isFailure)).toBe(
      true,
    );
  }),
);
