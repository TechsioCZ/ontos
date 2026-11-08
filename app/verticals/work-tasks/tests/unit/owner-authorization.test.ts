import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import { TenantIntentLoader } from '@app/core-runtime/access/intent/tenant-intent-loader';
import { AgentIdSchema, PrincipalIdSchema, RecordKeySchema } from '@app/core-runtime/access/ids';
import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import type { AssignablePrincipalDirectory, AssignmentEligibility } from '@app/core-runtime/auth/assignable-principals';
import { AssignablePrincipals, AssigneeIneligible } from '@app/core-runtime/auth/assignable-principals';
import { Effect, Schema } from 'effect';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { expect, it } from 'effect-rstest';
import {
  workRecordsCarrier,
  workRecordsReadDeclaration,
  workApplyCommandDeclaration,
} from '../../shared/access-declarations.ts';
import { TaskSchema, WorkStateSchema, PartyIdSchema } from '../../shared/apis/records.ts';
import { WorkPermissionDenied, WorkReferenceUnavailable } from '../../shared/actions/apply-command.ts';
import { recordsRead } from '../../src/api/records.read.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { finishWorkRecords, visibleWorkTasks, workRecordsGrants } from '../../src/services/persistence.service.ts';
import { taskReachSql } from '../../src/services/record-reach.ts';
import { lookupCatalog } from '../support/lookup-catalog.ts';
import { scope as baseScope, ref, company } from './search-fixtures.ts';

const scope = {
  ...baseScope,
  authBindingId: '60000000-0000-4000-8000-000000000001',
  authContextRef: 'session:owner-read',
  authMethod: 'session',
} as const;
const assigned: ListAccessPredicate = {
  groups: [
    {
      clauses: [
        {
          conditions: [
            {
              _tag: 'AssignedTo',
              holder: { _tag: 'Principal', principalId: PrincipalIdSchema.make(scope.principalId) },
            },
          ],
        },
      ],
    },
  ],
};
const targets: ListAccessPredicate = {
  groups: [
    { clauses: [{ conditions: [{ _tag: 'RecordKeyIn', recordKeys: [RecordKeySchema.make(ref.resourceId)] }] }] },
  ],
};
const state = Schema.decodeUnknownSync(WorkStateSchema)({
  collection: {
    properties: {
      dueDate: { locked: true, type: 'DATE' },
      ownerPrincipalRef: { locked: true, type: 'PRINCIPAL' },
      status: { groups: ['NOT_STARTED', 'IN_PROGRESS', 'DONE'], locked: true, type: 'STATUS' },
      title: { locked: true, type: 'TEXT' },
    },
    ref: {
      moduleId: ref.moduleId,
      resourceId: 'default',
      resourceType: 'work.tasks.task-collection',
      tenantId: scope.tenantId,
    },
    title: 'Tasks',
  },
  projects: [
    {
      createdAt: '2026-11-01T10:00:00Z',
      id: 'secret-project',
      milestones: [],
      plannedEnd: '2026-11-30',
      plannedStart: '2026-11-01',
      state: 'ACTIVE',
      title: 'All-only project',
      updatedAt: '2026-11-01T10:00:00Z',
    },
  ],
  tasks: [
    {
      collectionRef: {
        moduleId: ref.moduleId,
        resourceId: 'default',
        resourceType: 'work.tasks.task-collection',
        tenantId: scope.tenantId,
      },
      contextRefs: [],
      createdAt: '2026-11-01T10:00:00Z',
      history: [
        {
          action: 'updated',
          actorPrincipalRef: { principalId: scope.principalId, tenantId: scope.tenantId },
          at: '2026-11-01T10:00:00Z',
          changes: [
            { after: 'secret-party', field: 'partyId' },
            { after: 'secret-opportunity', field: 'opportunityId' },
            { after: 'Own task', field: 'title' },
          ],
        },
      ],
      opportunityId: '70000000-0000-4000-8000-000000000002',
      ownerPrincipalRef: { principalId: scope.principalId, tenantId: scope.tenantId },
      partyId: '70000000-0000-4000-8000-000000000001',
      priority: 'NORMAL',
      ref,
      state: 'NEW',
      title: 'Own task',
      updatedAt: '2026-11-01T10:00:00Z',
    },
  ],
});
const task = Schema.decodeUnknownSync(Schema.toType(TaskSchema))(state.tasks[0]);
const lookupAccess = {
  contracts: 'denied',
  customers: 'denied',
  opportunities: 'denied',
  properties: 'denied',
} as const;
const loaded = {
  assignmentDirectory: { legalEntityId: company, members: [], tenantId: scope.tenantId },
  names: new Map([
    [scope.principalId, 'Actor'],
    ['80000000-0000-4000-8000-000000000001', 'Private colleague'],
  ]),
  revision: 3,
  state: Schema.encodeSync(WorkStateSchema)(state),
};
const assignments = {
  read: (_directory: AssignablePrincipalDirectory, eligibility: AssignmentEligibility) =>
    Effect.sync(() => {
      expect(eligibility.carrier).toEqual({ accessDeclaration: recordsRead.descriptor.accessDeclaration });
      expect(eligibility.scope).toBe(scope);
      expect(eligibility.target).toBeUndefined();
      return [];
    }),
  resolveAssignee: () => Effect.fail(new AssigneeIneligible({ reason: 'Not used' })),
};

it('the actual registered read, write and assignment carrier have one declaration source', () => {
  expect(recordsRead.descriptor.accessDeclaration).toEqual(workRecordsCarrier.accessDeclaration);
  expect(workRecordsReadDeclaration.selectors).toEqual(['all', 'assigned']);
  expect(workRecordsReadDeclaration.risk).toBe('sensitive');
  expect(applyCommandAction.descriptor.accessDeclaration?.key).toBe(workApplyCommandDeclaration.key);
  expect(workApplyCommandDeclaration.selectors).toEqual([]);
});
for (const outcome of ['DENIED', 'UNAVAILABLE'] as const) {
  it.effect(`read ${outcome} never becomes an own-task fallback`, () =>
    Effect.gen(function* test() {
      const gate = makeTestAccessDecision({ defaultAnswer: { outcome } });
      const failure = yield* workRecordsGrants(scope).pipe(
        Effect.provideService(AccessDecisionGate, gate),
        Effect.provideService(TenantIntentLoader, lookupCatalog()),
        Effect.flip,
      );
      expect(failure).toBeInstanceOf(outcome === 'DENIED' ? WorkPermissionDenied : WorkReferenceUnavailable);
    }),
  );
}
it.effect('the runtime predicate is retained exactly and does not infer write permission from read ALL', () =>
  Effect.gen(function* test() {
    const gate = makeTestAccessDecision({ defaultAnswer: { outcome: 'DENIED' } });
    const grants = yield* workRecordsGrants(scope, assigned).pipe(
      Effect.provideService(AccessDecisionGate, gate),
      Effect.provideService(TenantIntentLoader, lookupCatalog()),
    );
    expect(grants.predicate).toBe(assigned);
    expect(grants.readAll).toBe(false);
    expect(grants.writeAll).toBe(false);
    expect(
      gate.askedLists.some(({ carrier }) => carrier.accessDeclaration?.key === workRecordsReadDeclaration.key),
    ).toBe(false);
  }),
);
it.effect('assigned authority intersects explicit targets and never crosses tenant identity', () =>
  Effect.gen(function* test() {
    expect(
      yield* visibleWorkTasks(
        [
          task,
          {
            ...task,
            ownerPrincipalRef: {
              ...task.ownerPrincipalRef,
              principalId: scope.authBindingId,
              tenantId: scope.tenantId,
            },
          },
        ],
        scope,
        assigned,
      ),
    ).toEqual([task]);
    expect(
      yield* visibleWorkTasks(
        [{ ...task, ownerPrincipalRef: { principalId: scope.principalId, tenantId: scope.authBindingId } }],
        scope,
        assigned,
      ),
    ).toEqual([]);
    expect(yield* visibleWorkTasks([task], scope, { groups: [...assigned.groups, ...targets.groups] })).toEqual([task]);
    expect(
      yield* visibleWorkTasks([task], scope, {
        groups: [
          {
            clauses: [
              {
                conditions: [
                  { _tag: 'AssignedTo', holder: { _tag: 'Agent', agentId: AgentIdSchema.make(scope.authBindingId) } },
                ],
              },
            ],
          },
        ],
      }),
    ).toEqual([]);
  }),
);
it.effect('restricted records redact lookup IDs and history and reject inference through their filters', () =>
  Effect.gen(function* test() {
    const grants = { lookupAccess, predicate: assigned, readAll: false, writeAll: false };
    const records = yield* finishWorkRecords({}, loaded, grants, scope).pipe(
      Effect.provideService(AssignablePrincipals, assignments),
    );
    expect(records.items).toHaveLength(1);
    expect(records.items[0]).not.toHaveProperty('partyId');
    expect(records.items[0]).not.toHaveProperty('opportunityId');
    expect(records.items[0]?.history?.[0]?.changes).toEqual([{ after: 'Own task', field: 'title' }]);
    expect(records.projects).toEqual([]);
    expect(records.principalNames.map(({ displayName }) => displayName)).toEqual(['Actor']);
    expect(records.canWrite).toBe(false);
    const failure = yield* finishWorkRecords(
      { partyId: PartyIdSchema.make('70000000-0000-4000-8000-000000000001') },
      loaded,
      grants,
      scope,
    ).pipe(Effect.provideService(AssignablePrincipals, assignments), Effect.flip);
    expect(failure).toBeInstanceOf(WorkPermissionDenied);
  }),
);
it('native JSONB SQL keeps tenant identity and the exact AND/OR structure parameterized', () => {
  const predicate = { groups: [...assigned.groups, ...targets.groups] };
  const query = new PgDialect().sqlToQuery(taskReachSql(predicate, sql`task`, scope.tenantId));
  expect(query.sql).toContain("->'ownerPrincipalRef'->>'tenantId'");
  expect(query.sql).toContain("->'ref'->>'tenantId'");
  expect(query.sql).toContain("->'ref'->>'resourceId' in");
  expect(query.params).toContain(scope.tenantId);
  expect(query.params).toContain(scope.principalId);
  expect(query.params).toContain(ref.resourceId);
  expect(query.sql).not.toContain(scope.principalId);
  expect(query.sql).not.toContain(ref.resourceId);
});
