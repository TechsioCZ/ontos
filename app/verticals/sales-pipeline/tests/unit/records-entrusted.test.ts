import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { NodeCrypto } from '@effect/platform-node';
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import { PrincipalIdSchema, RecordKeySchema } from '@app/core-runtime/access/ids';
import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { SalesPipelineStateSchema } from '../../shared/apis/records.ts';
import { salesPipelineRecordsGrants, finishSalesPipelineRecords } from '../../src/services/persistence.service.ts';
import { opportunityVisible } from '../../src/services/record-reach.ts';
import { recordsRead } from '../../src/api/records.read.ts';
import { salesPipelineRegistration } from '../../vertical.registration.ts';
import { scope } from './search-fixtures.ts';
import { OpportunityIdSchema } from '../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';

const principal = {
  ...scope,
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'session:pipeline-external',
  authMethod: 'session' as const,
};
const ownRef = { principalId: scope.principalId, tenantId: scope.tenantId };
const base = {
  amountMinor: 500,
  createdAt: '2026-11-01T00:00:00Z',
  currency: 'CZK',
  expectedCloseDate: '2026-12-31',
  lines: [],
  partyId: '50000000-0000-4000-8000-000000000001',
  probability: 10,
  stage: 'LEAD',
  stageHistory: [],
  updatedAt: '2026-11-01T00:00:00Z',
};
const encoded = {
  opportunities: [
    { ...base, entrustedPrincipalRef: ownRef, id: '60000000-0000-4000-8000-000000000001', title: 'Own entrusted' },
    {
      ...base,
      entrustedPrincipalRef: { ...ownRef, principalId: '30000000-0000-4000-8000-000000000099' },
      id: '60000000-0000-4000-8000-000000000002',
      title: 'Other partner',
    },
    { ...base, id: '60000000-0000-4000-8000-000000000003', title: 'Unbound' },
    {
      ...base,
      entrustedPrincipalRef: { ...ownRef, tenantId: '10000000-0000-4000-8000-000000000099' },
      id: '60000000-0000-4000-8000-000000000004',
      title: 'Foreign tenant',
    },
  ],
};
const predicate: ListAccessPredicate = {
  groups: [
    {
      clauses: [
        {
          conditions: [
            {
              _tag: 'EntrustedTo',
              holder: { _tag: 'Principal', principalId: PrincipalIdSchema.make(scope.principalId) },
            },
          ],
        },
      ],
    },
  ],
};
const gateFor = (p = predicate) =>
  makeTestAccessDecision({ answers: { 'demo.sales-pipeline.api-records.read': { outcome: 'ALLOWED', predicate: p } } });

it.effect(
  'uses LIST, preserves entrusted predicate, narrows actual owner SQL and output without ALL or a write grant',
  () =>
    Effect.gen(function* entrustedRecords() {
      const gate = gateFor();
      let queries = 0;
      const harness = yield* makeReadTestHarness({
        access: 'allowed',
        executeOwnerQuery: ({ params, scope: sqlScope, sql }) => {
          queries += 1;
          expect(sqlScope).toEqual({ legalEntityId: principal.legalEntityId, tenantId: principal.tenantId });
          expect(sql).toContain('jsonb_array_elements');
          expect(sql).toContain('entrustedPrincipalRef');
          expect(params).toContain(principal.tenantId);
          expect(params).toContain(principal.principalId);
          expect(params).toContain(principal.legalEntityId);
          // Deliberately supply extra rows to prove the final owner projection fails closed too.
          return Effect.succeed([{ revision: 3, state: encoded }]);
        },
        operationTime: new Date('2026-11-07T00:00:00Z'),
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: salesPipelineRegistration,
        scope: principal,
      });
      const result = yield* harness.runtime
        .runRead({
          input: {},
          principal,
          registration: recordsRead,
          transport: { correlationId: principal.correlationId },
        })
        .pipe(Effect.provideService(AccessDecisionGate, gate));
      expect(result.items.map((item) => item.title)).toEqual(['Own entrusted']);
      expect(result.indicators.openCount).toBe(1);
      expect(result.canWrite).toBe(false);
      expect(result.aiChanges).toBeUndefined();
      expect(gate.askedDecisions.map((q) => q.carrier.accessDeclaration?.key)).not.toContain(
        'demo.sales-pipeline.api-records.read',
      );
      expect(gate.askedLists).toHaveLength(1);
      expect(queries).toBe(1);
    }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect('explicit targets intersect entrusted reach rather than widening it, including direct lookup', () =>
  Effect.gen(function* intersection() {
    const narrow: ListAccessPredicate = {
      groups: [
        ...predicate.groups,
        {
          clauses: [
            {
              conditions: [
                { _tag: 'RecordKeyIn', recordKeys: [RecordKeySchema.make('60000000-0000-4000-8000-000000000002')] },
              ],
            },
          ],
        },
      ],
    };
    const grants = yield* salesPipelineRecordsGrants(principal).pipe(
      Effect.provideService(AccessDecisionGate, gateFor(narrow)),
    );
    const result = yield* finishSalesPipelineRecords(
      { ids: [OpportunityIdSchema.make('60000000-0000-4000-8000-000000000002')] },
      Option.some({ revision: 3, state: encoded }),
      grants,
      principal,
    );
    expect(result.items).toEqual([]);
    expect(result.indicators.openCount).toBe(0);
  }),
);

it('never substitutes the current reader for an unbound or foreign entrusted holder', () => {
  const state = Schema.decodeUnknownSync(SalesPipelineStateSchema)(encoded);
  expect(state.opportunities.map((row) => opportunityVisible(predicate, row, principal.tenantId))).toEqual([
    true,
    false,
    false,
    false,
  ]);
});
