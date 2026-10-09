import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  catalogMediaAssignmentRevisions,
  catalogMediaAssignments,
  catalogMediaAssignmentSetRevisions,
  catalogMediaAssignmentSets,
  products,
} from '../../src/database/schema.ts';
import { catalogMediaPersistenceForScope } from '../../src/persistence/catalog-media-persistence.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const productId = '00000000-0000-4000-8000-000000000002';
const principalId = '00000000-0000-4000-8000-000000000003';
const setId = '00000000-0000-4000-8000-000000000004';
const firstId = '00000000-0000-4000-8000-000000000005';
const secondId = '00000000-0000-4000-8000-000000000006';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:media-flow-test:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'media-flow-test',
};
const subjectRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const resourceRef = {
  moduleId: 'commerce.documents',
  resourceId: '00000000-0000-4000-8000-000000000007',
  resourceType: 'commerce.documents.document',
  tenantId,
} as const;
const invalidChange = Schema.TaggedStruct('invalid_change', {});
const revisionConflict = Schema.TaggedStruct('revision_conflict', { actualRevision: Schema.Int });
const assignmentIdentifier = Schema.String.pipe(Schema.brand('AssignmentId'));
const assigned = Schema.TaggedStruct('assigned', { assignmentId: assignmentIdentifier, setRevision: Schema.Int });
const reorderedOutcome = Schema.TaggedStruct('reordered', {
  assignmentId: assignmentIdentifier,
  setRevision: Schema.Int,
});
const removedOutcome = Schema.TaggedStruct('removed', { assignmentId: assignmentIdentifier, setRevision: Schema.Int });
const mutation = (assignmentId: string, actionInvocationId: string, expectedSetRevision: number) => ({
  actionInvocationId,
  assignmentId,
  evidenceRefs: ['catalog:media-flow'],
  expectedSetRevision,
  principalId,
  reason: 'Verified media change',
  subjectRef,
});

type MediaTable =
  | typeof products
  | typeof catalogMediaAssignmentSets
  | typeof catalogMediaAssignments
  | typeof catalogMediaAssignmentSetRevisions
  | typeof catalogMediaAssignmentRevisions;
interface MockRow {
  actionInvocationId?: string;
  assignmentId?: string;
  assignmentSetId?: string;
  currentRevision?: number;
  position?: number;
  productId?: string;
  revision?: number;
  state?: string;
}
interface FixtureState {
  assignmentRevisions: MockRow[];
  assignments: MockRow[];
  assignmentUpdateIds: string[];
  invocation: { id: string };
  setRevisions: MockRow[];
  sets: MockRow[];
  writes: string[];
}

const insertValues = (state: FixtureState, table: MediaTable, values: MockRow) => {
  if (table === catalogMediaAssignmentSets) {
    const row = { ...values, assignmentSetId: setId };
    return {
      returning: () =>
        Effect.sync(() => {
          state.sets.push(row);
          state.writes.push('set');
          return [row];
        }),
    };
  }
  if (table === catalogMediaAssignments) {
    return {
      returning: () =>
        Effect.sync(() => {
          state.assignments.push({ ...values });
          state.writes.push('assignment');
          return [{ ...values }];
        }),
    };
  }
  if (table === catalogMediaAssignmentSetRevisions) {
    return Effect.sync(() => {
      state.setRevisions.push(values);
      state.writes.push('set-revision');
      return [];
    });
  }
  if (table === catalogMediaAssignmentRevisions) {
    return Effect.sync(() => {
      state.assignmentRevisions.push(values);
      state.writes.push('assignment-revision');
      return [];
    });
  }
  throw new Error('Unexpected insert');
};
const selectedRows = (state: FixtureState, table: MediaTable): MockRow[] => {
  if (table === products) {
    return [{ productId }];
  }
  if (table === catalogMediaAssignmentSets) {
    return state.sets;
  }
  if (table === catalogMediaAssignments) {
    return state.assignments;
  }
  if (table === catalogMediaAssignmentSetRevisions) {
    return state.setRevisions.filter((row) => row.actionInvocationId === state.invocation.id);
  }
  throw new Error('Unexpected select');
};
const updateRows = (state: FixtureState, table: MediaTable, values: MockRow) => {
  const targetId = table === catalogMediaAssignmentSets ? undefined : state.assignmentUpdateIds.shift();
  const row =
    table === catalogMediaAssignmentSets
      ? state.sets[0]
      : state.assignments.find((candidate) => candidate.assignmentId === targetId);
  if (row === undefined) {
    throw new Error(
      `Unexpected update target: ${table === catalogMediaAssignmentSets ? 'set' : 'assignment'}, remaining=${state.assignmentUpdateIds.join(',')}, rows=${state.assignments.map((candidate) => candidate.assignmentId).join(',')}`,
    );
  }
  Object.assign(row, values);
  state.writes.push(table === catalogMediaAssignmentSets ? 'set-update' : 'assignment-update');
  return [row];
};
const selectTable = (state: FixtureState, table: MediaTable) => {
  const selected = () => selectedRows(state, table);
  const limited = () => selected().slice(0, 1);
  const selection = {
    limit: () => Effect.sync(limited),
    pipe: () => Effect.sync(selected),
  };
  return { where: () => ({ ...selection, for: () => selection }) };
};
const updateTable = (state: FixtureState, table: MediaTable, values: MockRow) => {
  const run = () => updateRows(state, table, values);
  return { where: () => ({ pipe: () => Effect.sync(run), returning: () => Effect.sync(run) }) };
};

// Models the exercised Drizzle chains while retaining rows across independent operations.
const fixture = () => {
  const sets: MockRow[] = [];
  const assignments: MockRow[] = [];
  const setRevisions: MockRow[] = [];
  const assignmentRevisions: MockRow[] = [];
  const assignmentUpdateIds: string[] = [];
  const writes: string[] = [];
  const invocation = { id: '' };
  const state: FixtureState = {
    assignmentRevisions,
    assignments,
    assignmentUpdateIds,
    invocation,
    setRevisions,
    sets,
    writes,
  };
  const transaction = {
    insert: (table: MediaTable) => ({ values: (values: MockRow) => insertValues(state, table, values) }),
    select: () => ({ from: (table: MediaTable) => selectTable(state, table) }),
    update: (table: MediaTable) => ({ set: (values: MockRow) => updateTable(state, table, values) }),
  };
  // @ts-expect-error Stateful fixture implements only the Drizzle chains exercised here.
  const service = catalogMediaPersistenceForScope(transaction, scope);
  return { assignmentRevisions, assignments, assignmentUpdateIds, invocation, service, setRevisions, sets, writes };
};

describe('Catalog media persistence flow', () => {
  it.effect('rejects a foreign-Tenant subject before any persistence query', () =>
    Effect.gen(function* foreignTenant() {
      const transaction = new Proxy(
        {},
        {
          get: () => {
            throw new Error('foreign Tenant reached storage');
          },
        },
      );
      // @ts-expect-error No Drizzle method may be invoked for an invalid target.
      const service = catalogMediaPersistenceForScope(transaction, scope);
      const result = yield* service.assign({
        ...mutation(firstId, 'foreign-action', 0),
        order: 1,
        purpose: 'photo',
        resourceKind: 'MEDIA',
        resourceRef,
        subjectRef: { ...subjectRef, tenantId: '00000000-0000-4000-8000-000000000099' },
      });
      expect(Schema.is(invalidChange)(result)).toBe(true);
    }),
  );

  it.effect(
    'assigns, reorders, rejects stale whole-set edits, replays, and removes without deleting the Resource',
    () =>
      Effect.gen(function* mediaFlow() {
        const state = fixture();
        const first = mutation(firstId, 'action-1', 0);
        const second = mutation(secondId, 'action-2', 1);
        state.invocation.id = first.actionInvocationId;
        const firstResult = yield* state.service.assign({
          ...first,
          order: 1,
          purpose: 'photo',
          resourceKind: 'MEDIA',
          resourceRef,
        });
        expect(Schema.is(assigned)(firstResult)).toBe(true);
        expect(firstResult).toMatchObject({ assignmentId: firstId, setRevision: 1 });
        state.invocation.id = second.actionInvocationId;
        const secondResult = yield* state.service.assign({
          ...second,
          order: 2,
          purpose: 'detail',
          resourceKind: 'MEDIA',
          resourceRef,
        });
        expect(Schema.is(assigned)(secondResult)).toBe(true);
        expect(secondResult).toMatchObject({ assignmentId: secondId, setRevision: 2 });
        state.invocation.id = 'action-stale';
        const staleResult = yield* state.service.reorder({ ...first, actionInvocationId: 'action-stale', order: 2 });
        expect(Schema.is(revisionConflict)(staleResult)).toBe(true);
        expect(staleResult).toMatchObject({ actualRevision: 2 });
        state.assignmentUpdateIds.push(secondId, firstId, secondId, firstId);
        const reordered = mutation(secondId, 'action-3', 2);
        state.invocation.id = reordered.actionInvocationId;
        const reorderResult = yield* state.service.reorder({ ...reordered, order: 1 });
        expect(Schema.is(reorderedOutcome)(reorderResult)).toBe(true);
        expect(reorderResult).toMatchObject({ assignmentId: secondId, setRevision: 3 });
        expect(state.assignments.filter((row) => row.state === 'ACTIVE').map((row) => row.position)).toEqual([2, 1]);
        const writeCount = state.writes.length;
        const replayResult = yield* state.service.reorder({ ...reordered, order: 1 });
        expect(Schema.is(reorderedOutcome)(replayResult)).toBe(true);
        expect(replayResult).toMatchObject({ assignmentId: secondId, setRevision: 3 });
        expect(state.writes).toHaveLength(writeCount);
        state.assignmentUpdateIds.push(secondId, firstId, firstId);
        const removed = mutation(secondId, 'action-4', 3);
        state.invocation.id = removed.actionInvocationId;
        const removeResult = yield* state.service.remove(removed);
        expect(Schema.is(removedOutcome)(removeResult)).toBe(true);
        expect(removeResult).toMatchObject({ assignmentId: secondId, setRevision: 4 });
        expect(state.sets[0]?.currentRevision).toBe(4);
        expect(state.assignments.filter((row) => row.state === 'ACTIVE').map((row) => row.assignmentId)).toEqual([
          firstId,
        ]);
        expect(state.assignments.find((row) => row.assignmentId === secondId)?.state).toBe('REMOVED');
        expect(state.setRevisions.map((row) => row.revision)).toEqual([1, 2, 3, 4]);
        expect(state.assignmentRevisions.some((row) => row.assignmentId === secondId && row.state === 'REMOVED')).toBe(
          true,
        );
      }),
  );
});
