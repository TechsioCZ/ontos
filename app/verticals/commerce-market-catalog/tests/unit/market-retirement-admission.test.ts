import type { MarketRetirementAdmissionService } from '../../src/services/market-retirement-admission.service.ts';
import { MarketRetirementImpactAssessmentRejected } from '../../src/actions/market-retirement-impact-assessment-rejected.ts';
import { NodeCrypto } from '@effect/platform-node';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionHandler } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { manageMarketRetirementAdmissionAction } from '../../src/actions/manage-market-retirement-admission.action.ts';
import { MarketRetirementImpactAuthorityLive } from '../../src/integrations/market-retirement-impact.ts';
import { readFileSync } from 'node:fs';
import { Effect, Exit, Layer, Option, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { marketRetirementAdmissions } from '../../src/database/schema.ts';
import {
  projectMarketRetirementAdmission,
  retirementGuardHash,
  retirementPayloadMatches,
} from '../../src/persistence/market-retirement-admission-persistence.ts';
import {
  MarketRetirementEncodedPayloadSchema,
  MarketRetirementStoredBasisSchema,
  MarketRetirementSettlementPending,
} from '../../shared/market-retirement-admission.ts';
import { MarketLifecycleResultSchema } from '../../shared/action-contracts.ts';
import { ReservedMarketRetirementImpactAssessmentSchema } from '../../shared/domain/market-retirement-impact.ts';
import { MarketRetirementImpactAssessmentUnavailable } from '../../src/actions/market-retirement-impact-assessment-unavailable.ts';
import { makePreparedMarketRetirementImpact } from '../../src/services/market-retirement-admission.service.ts';
import { mapRetireMarketActionProblem } from '../../api/retire-market-action-problems.ts';
import { RetireMarketActionSettlementPendingProblemSchema } from '../../shared/apis/retire-market-action.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const marketId = '22222222-2222-4222-8222-222222222222';
const sourceActionInvocationId = '33333333-3333-4333-8333-333333333333';
const proof = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const marketRef = {
  moduleId: 'commerce.market-catalog',
  resourceId: marketId,
  resourceType: 'commerce.market-catalog.market',
  tenantId,
} as const;
const definitionRevisionRef = {
  ...marketRef,
  resourceType: 'commerce.market-catalog.market-definition-revision',
} as const;
const retirement = Schema.decodeUnknownSync(MarketRetirementEncodedPayloadSchema)({
  effectiveAt: '2026-12-01T00:00:00.000Z',
  expectedCurrentDefinitionRevisionRef: definitionRevisionRef,
  expectedRevision: 3,
  marketRef,
  reason: 'Retire replaced Market.',
});
const result = Schema.decodeUnknownSync(MarketLifecycleResultSchema)({
  changed: true,
  definitionRevisionRef,
  lifecycle: 'RETIRED',
  marketRef,
  revision: 4,
});
const assessment = Schema.decodeUnknownSync(ReservedMarketRetirementImpactAssessmentSchema)({
  assessedMarketRef: marketRef,
  assessedMarketRevision: 3,
  assessmentDigest: 'a'.repeat(64),
  effectiveAt: retirement.effectiveAt,
  providers: [],
  requiredProviderModuleKeys: ['commerce.customer-context'],
  reservation: { token: proof, version: 1 },
});
const basis = Schema.decodeUnknownSync(MarketRetirementStoredBasisSchema)({
  assessment: {
    assessedMarketRef: marketRef,
    assessedMarketRevision: 3,
    assessmentDigest: 'a'.repeat(64),
    effectiveAt: retirement.effectiveAt,
    providers: [],
    requiredProviderModuleKeys: ['commerce.customer-context'],
  },
  reserve: {
    assessmentDigest: 'a'.repeat(64),
    evaluatedAt: retirement.effectiveAt,
    sourceEvidence: [
      {
        completenessEvidence: {
          observedAt: '2026-11-30T23:59:59.000Z',
          ownerRevision: 'owner:17',
          scope: { kind: 'EXACT_PREDICATE', predicateRef: 'exact:market' },
        },
        currentness: 'CURRENT',
        digest: 'b'.repeat(64),
        generation: 'owner:g17',
        ownerRevision: 'owner:17',
        sourceId: 'commerce.customer-context.market-bootstrap-policy',
      },
    ],
  },
});
const row = (status: 'PENDING' | 'COMMITTED' | 'ABORTED'): typeof marketRetirementAdmissions.$inferSelect => ({
  abortProof: proof,
  basis,
  committedResult: status === 'COMMITTED' ? result : null,
  compositionRevision: 'b'.repeat(64),
  createdAt: new Date('2026-11-30T23:59:59.000Z'),
  marketId,
  principalId: proof,
  releaseGuardHash: retirementGuardHash(proof),
  retirementAssessment: status === 'COMMITTED' ? assessment : null,
  retirementPayload: retirement,
  sellingLegalEntityId: proof,
  sourceActionInvocationId,
  status,
  tenantId,
});

const unexpectedManagementFixtureOperation = () => Effect.die('Unexpected management fixture operation');
const managementFixtureLayers = Layer.mergeAll(
  NodeCrypto.layer,
  MarketRetirementImpactAuthorityLive.pipe(Layer.provide(NodeCrypto.layer)),
);
describe('Market retirement admission fence contracts', () => {
  for (const scenario of ['new-basis', 'cached-basis', 'abort', 'rejected-basis'] as const) {
    it.effect(`records truthful metadata-only ${scenario} contribution without abort proof leakage`, () =>
      Effect.gen(function* managementEvidence() {
        const collector = createActionCollector(
          manageMarketRetirementAdmissionAction.descriptor.domainEvents,
          'commerce.market-catalog',
          manageMarketRetirementAdmissionAction.descriptor.accessEvidencePolicy,
        );
        const projectedResult = yield* projectMarketRetirementAdmission(
          row(scenario === 'abort' ? 'ABORTED' : 'PENDING'),
          scenario === 'abort',
        );
        const management: Effect.Success<ReturnType<MarketRetirementAdmissionService['manage']>> =
          scenario === 'rejected-basis'
            ? {
                admissionReadCount: Option.some<0 | 1>(1),
                basisRead: true,
                result: Result.fail(
                  new MarketRetirementImpactAssessmentRejected({
                    code: 'market_retirement_impact_assessment_rejected',
                    reason: 'A live reference exists',
                  }),
                ),
              }
            : {
                admissionReadCount: Option.some<0 | 1>(1),
                basisRead: scenario === 'new-basis',
                result: Result.succeed(projectedResult),
              };
        const outcome = yield* Effect.exit(
          getActionHandler(manageMarketRetirementAdmissionAction)(
            { operation: scenario === 'abort' ? 'ABORT' : 'PREPARE', retirement, sourceActionInvocationId },
            {
              actionInvocationId: sourceActionInvocationId,
              addDomainEvent: collector.addDomainEvent,
              addOutboxMessage: collector.addOutboxMessage,
              compositionRevision: 'b'.repeat(64),
              recordAuditEvidence: collector.recordAuditEvidence,
              recordDataAccess: collector.recordDataAccess,
              scope: {
                authMethod: 'system',
                correlationId: 'management-evidence-unit',
                legalEntityId: proof,
                principalId: proof,
                tenantId,
              },
              services: {
                commit: unexpectedManagementFixtureOperation,
                lockPending: unexpectedManagementFixtureOperation,
                manage: () => Effect.succeed(management),
                recover: unexpectedManagementFixtureOperation,
              },
            },
          ),
        );
        expect(Exit.isFailure(outcome)).toBe(scenario === 'rejected-basis');
        const evidence = collector.snapshot();
        expect(
          evidence.dataAccessEvents.filter((event) => event.servingModuleKey === 'commerce.market-catalog'),
        ).toHaveLength(1);
        expect(
          evidence.dataAccessEvents.filter((event) => event.servingModuleKey === 'commerce.customer-context'),
        ).toHaveLength(scenario === 'new-basis' || scenario === 'rejected-basis' ? 1 : 0);
        expect(evidence.domainEvents).toHaveLength(0);
        expect(evidence.outboxMessages).toHaveLength(0);
        expect(JSON.stringify(evidence)).not.toContain(proof);
      }).pipe(Effect.provide(managementFixtureLayers)),
    );
  }

  it.effect('consumes a prepared parent capability only once even across concurrent takers', () =>
    Effect.gen(function* singleConsumption() {
      let reads = 0;
      const capability = makePreparedMarketRetirementImpact(
        Effect.sync(() => {
          reads += 1;
          return { actionInvocationId: sourceActionInvocationId, assessment };
        }),
      );
      const outcomes = yield* Effect.all([Effect.exit(capability.take), Effect.exit(capability.take)], {
        concurrency: 'unbounded',
      });
      expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1);
      expect(outcomes.filter(Exit.isFailure)).toHaveLength(1);
      expect(reads).toBe(1);
    }),
  );

  for (const status of ['PENDING', 'COMMITTED'] as const) {
    it.effect(`never projects the private abort proof from ${status}, including recovery`, () =>
      Effect.gen(function* hiddenProof() {
        const projected = yield* projectMarketRetirementAdmission(row(status), true);
        expect(projected).not.toHaveProperty('abortProof');
        expect(projected.releaseGuardHash).toBe(retirementGuardHash(proof));
        if (projected.outcome === 'COMMITTED') {
          expect(projected.assessment.reservation).toEqual({ token: proof, version: 1 });
        }
      }),
    );
  }
  it.effect('reveals proof only for explicitly requested irrevocably ABORTED recovery', () =>
    Effect.gen(function* abortedRecovery() {
      const ordinary = yield* projectMarketRetirementAdmission(row('ABORTED'));
      expect(ordinary).not.toHaveProperty('abortProof');
      const recovered = yield* projectMarketRetirementAdmission(row('ABORTED'), true);
      expect(recovered).toMatchObject({ abortProof: proof, outcome: 'ABORTED', sourceActionInvocationId });
    }),
  );
  it.effect('rejects a COMMITTED receipt whose required original reservation evidence is missing', () =>
    Effect.gen(function* incompleteReceipt() {
      const incomplete = { ...row('COMMITTED'), retirementAssessment: null };
      const failure = yield* projectMarketRetirementAdmission(incomplete).pipe(Effect.flip);
      expect(Schema.is(MarketRetirementImpactAssessmentUnavailable)(failure)).toBe(true);
    }),
  );
  it('matches canonical payload values independently of JSON object key order and rejects an altered command', () => {
    const reordered = {
      effectiveAt: retirement.effectiveAt,
      expectedCurrentDefinitionRevisionRef: retirement.expectedCurrentDefinitionRevisionRef,
      expectedRevision: retirement.expectedRevision,
      marketRef: retirement.marketRef,
      reason: retirement.reason,
    };
    expect(retirementPayloadMatches(retirement, reordered)).toBe(true);
    expect(retirementPayloadMatches(retirement, { ...reordered, reason: 'Another command.' })).toBe(false);
    expect(retirementGuardHash(proof)).not.toBe(retirementGuardHash(proof.toUpperCase()));
  });
  it('retains original committed result and explicit pending debt through the declared HTTP error codec', () => {
    const problem = mapRetireMarketActionProblem(
      new MarketRetirementSettlementPending({
        code: 'market_retirement_settlement_unavailable',
        committedResult: result,
        reason: 'Finalization remains pending.',
        sourceActionInvocationId,
      }),
    );
    const retained = Schema.decodeUnknownSync(RetireMarketActionSettlementPendingProblemSchema)(
      Schema.encodeSync(RetireMarketActionSettlementPendingProblemSchema)(
        Schema.decodeUnknownSync(RetireMarketActionSettlementPendingProblemSchema)(problem),
      ),
    );
    expect(retained).toMatchObject({
      committedResult: result,
      pendingSettlement: true,
      resolution: 'RECOVER_ORIGINAL_EFFECT',
      retryCommand: false,
      sourceActionInvocationId,
      status: 503,
    });
    expect(JSON.stringify(retained)).not.toContain(proof);
  });
  it('declares closed admission states, committed-receipt integrity and same-Tenant Market identity', () => {
    const config = getTableConfig(marketRetirementAdmissions);
    expect(config.enableRLS).toBe(true);
    expect(config.checks.map((check) => check.name)).toContain('market_retirement_admissions_receipt_ck');
    expect(config.foreignKeys.map((key) => key.getName())).toContain('market_retirement_admissions_market_fk');
    const migration = readFileSync(
      new URL('../../drizzle/20261031152114_market_retirement_admission/migration.sql', import.meta.url),
      'utf-8',
    );
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE ON TABLE');
    expect(migration).not.toContain('GRANT SELECT, INSERT, UPDATE, DELETE');
  });
});
