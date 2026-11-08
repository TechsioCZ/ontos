import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import { ListAccessConditionSchema } from '@app/core-runtime/access/decision/list-access';
import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { RecordKeySchema } from '@app/core-runtime/access/ids';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { recordsCarrier, applyCommandCarrier } from '../../shared/access-declarations.ts';
import { recordReachSql, recordVisible, validRecordPredicate } from '../../src/services/record-reach.ts';
import { salesInsightsRecordsGrants } from '../../src/services/persistence.service.ts';
import { recordsRead } from '../../src/api/records.read.ts';
import { salesInsightsRegistration } from '../../vertical.registration.ts';
import { MetricRefSchema } from '../../shared/resources/metric.ts';
import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';
const recordId = '50000000-0000-4000-8000-000000000001';
const scope = {
  authContextRef: 'better-auth-session:owner-test',
  authMethod: 'session' as const,
  correlationId: 'record-access',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId,
  tenantId,
};
const row = {
  ownerPrincipalRef: Schema.decodeSync(PrincipalRefSchema)({ principalId, tenantId }),
  ref: Schema.decodeSync(MetricRefSchema)({
    moduleId: 'demo.sales-insights',
    resourceId: recordId,
    resourceType: 'demo.sales-insights.metric',
    tenantId,
  }),
};
const reach: ListAccessPredicate = {
  groups: [{ clauses: [{ conditions: [{ _tag: 'RecordKeyIn', recordKeys: [RecordKeySchema.make(recordId)] }] }] }],
};
const team = Schema.decodeSync(ListAccessConditionSchema)({ _tag: 'TeamMemberOf', teamIds: [principalId] });
it('shares the exact declaration with the registered owner read', () => {
  expect(salesInsightsRegistration.moduleId).toBe(recordsRead.descriptor.owningModuleKey);
  expect(recordsCarrier.accessDeclaration).toEqual(recordsRead.descriptor.accessDeclaration);
  expect(recordsRead.descriptor.accessDeclaration?.selectors.length).toBeGreaterThan(0);
});
it.effect('selector reads use list, preserve the full predicate and never treat approval as write', () =>
  Effect.gen(function* test() {
    const gate = makeTestAccessDecision({
      answers: {
        [applyCommandCarrier.accessDeclaration.key]: { outcome: 'NEEDS_APPROVAL' },
        [recordsCarrier.accessDeclaration.key]: { outcome: 'ALLOWED', predicate: reach },
      },
    });
    const grants = yield* salesInsightsRecordsGrants(scope).pipe(Effect.provideService(AccessDecisionGate, gate));
    expect(grants.predicate).toEqual(reach);
    expect(grants.writeAll).toBe(false);
    expect(gate.askedLists).toHaveLength(1);
    expect(gate.askedDecisions.map((input) => input.carrier.accessDeclaration?.key)).toEqual([
      applyCommandCarrier.accessDeclaration.key,
    ]);
    expect(gate.askedLists[0]?.scope).toEqual(scope);
  }),
);
for (const outcome of ['DENIED', 'UNAVAILABLE', 'NEEDS_APPROVAL'] as const) {
  it.effect(`read ${outcome} never becomes an ALL predicate`, () =>
    Effect.gen(function* test() {
      const gate = makeTestAccessDecision({ defaultAnswer: { outcome } });
      expect(
        yield* salesInsightsRecordsGrants(scope).pipe(
          Effect.provideService(AccessDecisionGate, gate),
          Effect.isFailure,
        ),
      ).toBe(true);
    }),
  );
}
it.effect('an allowed list without a predicate fails closed', () =>
  Effect.gen(function* test() {
    const scripted = makeTestAccessDecision({ defaultAnswer: { outcome: 'ALLOWED' } });
    const gate = {
      ...scripted,
      list: (input: Parameters<typeof scripted.list>[0]) =>
        scripted.list(input).pipe(Effect.map((answer) => ({ decision: answer.decision }))),
    };
    expect(
      yield* salesInsightsRecordsGrants(scope).pipe(Effect.provideService(AccessDecisionGate, gate), Effect.isFailure),
    ).toBe(true);
  }),
);
it('matches AND of OR of AND, while unsupported facts and missing clauses never widen access', () => {
  expect(recordVisible(reach, row, tenantId)).toBe(true);
  const intersection: ListAccessPredicate = { groups: [...reach.groups, { clauses: [{ conditions: [team] }] }] };
  expect(recordVisible(intersection, row, tenantId)).toBe(false);
  const union: ListAccessPredicate = {
    groups: [{ clauses: [{ conditions: [team] }, ...reach.groups.flatMap((group) => group.clauses)] }],
  };
  expect(recordVisible(union, row, tenantId)).toBe(true);
  const conjunction: ListAccessPredicate = { groups: [{ clauses: [{ conditions: [{ _tag: 'AllInScope' }, team] }] }] };
  expect(recordVisible(conjunction, row, tenantId)).toBe(false);
  expect(validRecordPredicate({ groups: [{ clauses: [] }] })).toBe(false);
  expect(validRecordPredicate({ groups: [{ clauses: [{ conditions: [] }] }] })).toBe(false);
  expect(validRecordPredicate({ groups: [{ clauses: [{ conditions: [{ _tag: 'Unknown' }] }] }] })).toBe(false);
  const query = new PgDialect().sqlToQuery(recordReachSql(intersection, sql`record`, tenantId));
  expect(query.sql).toContain(' in (');
  expect(query.sql).toContain(' and ');
  expect(query.sql).toContain('false');
  expect(query.params).toContain(recordId);
});

it('keeps disjunctions inside their intersected groups in SQL', () => {
  const predicate: ListAccessPredicate = {
    groups: [{ clauses: [{ conditions: [team] }, { conditions: [{ _tag: 'AllInScope' }] }] }, ...reach.groups],
  };
  const query = new PgDialect().sqlToQuery(recordReachSql(predicate, sql`record`, tenantId));
  expect(query.sql).toContain(' or ');
  expect(query.sql).toContain(' and ');
  expect(query.params).toContain(recordId);
});

it('assigned reach is tenant-bound and still intersects explicit record restrictions', () => {
  const assigned: ListAccessPredicate = {
    groups: [
      {
        clauses: [
          {
            conditions: [
              Schema.decodeSync(ListAccessConditionSchema)({
                _tag: 'AssignedTo',
                holder: { _tag: 'Principal', principalId },
              }),
            ],
          },
        ],
      },
    ],
  };
  expect(recordVisible(assigned, row, tenantId)).toBe(true);
  expect(recordVisible(assigned, row, principalId)).toBe(false);
  const explicit: ListAccessPredicate = {
    groups: [
      ...assigned.groups,
      { clauses: [{ conditions: [{ _tag: 'RecordKeyIn', recordKeys: [RecordKeySchema.make(principalId)] }] }] },
    ],
  };
  expect(recordVisible(explicit, row, tenantId)).toBe(false);
  const query = new PgDialect().sqlToQuery(recordReachSql(assigned, sql`record`, tenantId));
  expect(query.params).toContain(tenantId);
  expect(query.params).toContain(principalId);
});
