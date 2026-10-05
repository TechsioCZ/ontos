import { randomUUID } from 'node:crypto';

import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { DateTime, Effect, Match, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import {
  CreateApplicabilityBindingPayloadSchema,
  CreateRuleRevisionPayloadSchema,
  CreateRulePayloadSchema,
  EndApplicabilityBindingPayloadSchema,
  RetireRulePayloadSchema,
} from '../../shared/actions/policy-administration.ts';
import { CreateClosedAssortmentBoundaryPayloadSchema } from '../../shared/actions/boundary-administration.ts';
import {
  AssortmentApplicableBoundaryQueryV1Schema,
  AssortmentOrdinaryCandidateQueryV1Schema,
} from '../../shared/domain/decision-set-query.ts';
import { readAssortmentDecisionSetV1, verifyAssortmentDecisionSetV1 } from '../../src/services/decision-set-reader.ts';
import { boundaryAdministrationPersistenceForScope } from '../../src/services/boundary-administration.service.ts';
import {
  assortmentMeaningFingerprint,
  assortmentPolicyPersistenceForScope,
  bindingRef,
  ruleRevisionRef,
  stableRuleRef,
} from '../../src/services/policy-administration.service.ts';
import {
  AssortmentOrdinaryResolutionInputSchema,
  resolveAssortmentOrdinary,
} from '../../shared/domain/ordinary-resolution.ts';
import { AssortmentCustomerGroupMembershipSetSchema } from '../../shared/domain/ports/owner-evidence.ts';
import {
  AssortmentGovernedDecisionSchema,
  AssortmentVisibilityRequestSchema,
} from '../../shared/domain/decision-contracts.ts';
import { AssortmentPolicyPersistenceUnavailable } from '../../shared/domain/policy-errors.ts';
import { assortmentDecisionEvidenceRepositoryForScope } from '../../src/services/decision-evidence.repository.ts';
import { assortmentDecisionExplanationReadService } from '../../src/services/decision-explanation-read.service.ts';

const historicalEvidenceUnavailable = () =>
  new AssortmentPolicyPersistenceUnavailable({
    code: 'assortment_policy_persistence_unavailable',
    reason: 'Historical fixture evidence unavailable',
  });

const tenantId = randomUUID();
const legalEntityId = randomUUID();
const principalId = randomUUID();
const operationTime = '2030-02-01T00:00:00.000Z';
const scope = {
  authContextRef: `job:assortment-decision-set:${randomUUID()}`,
  authMethod: 'system',
  correlationId: randomUUID(),
  legalEntityId,
  principalId,
  tenantId,
} satisfies OperationalScope;
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: randomUUID(),
  resourceType: 'catalog.product',
  tenantId,
} as const;
const profileRef = {
  moduleId: 'commerce.customer-context',
  resourceId: randomUUID(),
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
} as const;
const channelRef = {
  moduleId: 'commerce.channel',
  resourceId: 'decision-set-channel',
  resourceType: 'commerce.channel.channel',
  tenantId,
} as const;
const sellingLegalEntityRef = {
  moduleId: 'party.registry',
  resourceId: legalEntityId,
  resourceType: 'party.registry.legal-entity',
  tenantId,
} as const;
const query = Schema.decodeUnknownSync(AssortmentOrdinaryCandidateQueryV1Schema)({
  decisionPurpose: 'VISIBILITY',
  kind: 'ORDINARY_CANDIDATES',
  legalEntityId,
  operationTime,
  subject: {
    kind: 'IDENTIFIED',
    subject: { kind: 'RETAIL_CUSTOMER_PROFILE', profileRef },
  },
  target: { kind: 'PRODUCT', productRef },
  tenantId,
  trustedContext: {
    channelRef,
    operationTime,
    sellingLegalEntityRef,
    tenantId,
  },
  version: 1,
});

it.live('invalidates empty Assortment Candidate and Boundary sets when matching facts are added', () =>
  Effect.scoped(
    Effect.gen(function* decisionSetCurrentnessPostgres() {
      const { admin: adminClient } = yield* testDatabaseClients;
      const ownerDatabase = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runScoped = <Value, Failure>(
        operation: (transaction: ScopedTransactionExecutor) => Effect.Effect<Value, Failure>,
      ) =>
        ownerDatabase.transaction((transaction) =>
          Effect.gen(function* scopedAssortmentOperation() {
            const scoped = yield* installOperationalScope(transaction, scope);
            return yield* operation(scoped);
          }),
        );

      const foreignTenantId = randomUUID();
      const foreignQuery = Schema.decodeUnknownSync(AssortmentOrdinaryCandidateQueryV1Schema)({
        decisionPurpose: 'VISIBILITY',
        kind: 'ORDINARY_CANDIDATES',
        legalEntityId,
        operationTime,
        subject: {
          kind: 'IDENTIFIED',
          subject: {
            kind: 'RETAIL_CUSTOMER_PROFILE',
            profileRef: { ...profileRef, tenantId: foreignTenantId },
          },
        },
        target: { kind: 'PRODUCT', productRef: { ...productRef, tenantId: foreignTenantId } },
        tenantId: foreignTenantId,
        trustedContext: {
          channelRef: { ...channelRef, tenantId: foreignTenantId },
          operationTime,
          sellingLegalEntityRef: { ...sellingLegalEntityRef, tenantId: foreignTenantId },
          tenantId: foreignTenantId,
        },
        version: 1,
      });
      const foreignRead = yield* runScoped((transaction) =>
        Effect.result(readAssortmentDecisionSetV1(transaction, foreignQuery)),
      );
      expect(Result.isFailure(foreignRead)).toBe(true);

      const otherLegalEntityId = randomUUID();
      const otherEntityQuery = Schema.decodeUnknownSync(AssortmentOrdinaryCandidateQueryV1Schema)({
        decisionPurpose: 'VISIBILITY',
        kind: 'ORDINARY_CANDIDATES',
        legalEntityId: otherLegalEntityId,
        operationTime,
        subject: { kind: 'IDENTIFIED', subject: { kind: 'RETAIL_CUSTOMER_PROFILE', profileRef } },
        target: { kind: 'PRODUCT', productRef },
        tenantId,
        trustedContext: {
          channelRef,
          operationTime,
          sellingLegalEntityRef: { ...sellingLegalEntityRef, resourceId: otherLegalEntityId },
          tenantId,
        },
        version: 1,
      });
      const otherEntityRead = yield* runScoped((transaction) =>
        Effect.result(readAssortmentDecisionSetV1(transaction, otherEntityQuery)),
      );
      expect(Result.isFailure(otherEntityRead)).toBe(true);

      const createRuleInput = Schema.decodeUnknownSync(CreateRulePayloadSchema)({
        effect: 'ALLOW',
        provenanceRef: 'decision-set-currentness:create-rule',
        purpose: 'VISIBILITY',
        reason: 'Seed the owner fence without creating a binding',
        selector: { kind: 'ALL' },
        stableCode: `decision-set.${tenantId}`,
      });
      const created = yield* runScoped((transaction) =>
        assortmentPolicyPersistenceForScope(transaction, scope).createRule({
          ...createRuleInput,
          actionInvocationId: randomUUID(),
          actorPrincipalId: principalId,
          tenantId,
        }),
      );
      if (!('initialRuleRevisionId' in created)) {
        throw new Error('Expected a new Assortment Rule Revision');
      }

      const empty = yield* runScoped((transaction) => readAssortmentDecisionSetV1(transaction, query));
      expect(empty.kind).toBe('COMPLETE_ORDINARY_CANDIDATE_SET');
      if (empty.kind !== 'COMPLETE_ORDINARY_CANDIDATE_SET') {
        throw new Error('Expected the ordinary Candidate set');
      }
      expect(empty.candidates).toEqual([]);
      const expectedProofRef = empty.completeness.evidence.proof.evidenceRef;
      const verify = () =>
        runScoped((transaction) => verifyAssortmentDecisionSetV1(transaction, { expectedProofRef, query, version: 1 }));
      expect(yield* verify()).toEqual({ state: 'CURRENT', version: 1 });

      const createBindingInput = Schema.decodeUnknownSync(CreateApplicabilityBindingPayloadSchema)({
        audience: { kind: 'SHARED' },
        commercialScope: { channelRef, sellingLegalEntityRef },
        effectiveFrom: DateTime.formatIso(DateTime.makeUnsafe(new Date('2030-01-01T00:00:00.000Z'))),
        provenanceRef: 'decision-set-currentness:create-binding',
        reason: 'Make the Rule Revision applicable',
        ruleRevisionRef: {
          ownerModuleId: 'commerce.assortment',
          revision: '1',
          sourceRef: {
            moduleId: 'commerce.assortment',
            resourceId: created.initialRuleRevisionId,
            resourceType: 'commerce.assortment.rule-revision',
            tenantId,
          },
        },
      });
      const binding = yield* runScoped((transaction) =>
        assortmentPolicyPersistenceForScope(transaction, scope).createBinding({
          ...createBindingInput,
          actionInvocationId: randomUUID(),
          actorPrincipalId: principalId,
          legalEntityId,
          tenantId,
        }),
      );
      expect(binding).toMatchObject({ created: true });
      expect(yield* verify()).toEqual({ state: 'STALE', version: 1 });
      const current = yield* runScoped((transaction) => readAssortmentDecisionSetV1(transaction, query));
      expect(current.kind).toBe('COMPLETE_ORDINARY_CANDIDATE_SET');
      if (current.kind !== 'COMPLETE_ORDINARY_CANDIDATE_SET') {
        throw new Error('Expected the ordinary Candidate set');
      }
      expect(current.candidates).toHaveLength(1);
      expect(current.candidates[0]).toMatchObject({ effect: 'ALLOW', selector: { kind: 'ALL' } });
      expect(
        yield* runScoped((transaction) =>
          verifyAssortmentDecisionSetV1(transaction, {
            expectedProofRef: current.completeness.evidence.proof.evidenceRef,
            query,
            version: 1,
          }),
        ),
      ).toEqual({ state: 'CURRENT', version: 1 });

      const boundaryQuery = Schema.decodeUnknownSync(AssortmentApplicableBoundaryQueryV1Schema)({
        decisionPurpose: 'VISIBILITY',
        kind: 'APPLICABLE_BOUNDARIES',
        legalEntityId,
        operationTime,
        subject: query.subject.kind === 'IDENTIFIED' ? query.subject.subject : undefined,
        target: { kind: 'PRODUCT', productRef },
        tenantId,
        trustedContext: { channelRef, operationTime, sellingLegalEntityRef, tenantId },
        version: 1,
      });
      const emptyBoundaries = yield* runScoped((transaction) =>
        readAssortmentDecisionSetV1(transaction, boundaryQuery),
      );
      expect(emptyBoundaries.kind).toBe('COMPLETE_BOUNDARY_SET');
      if (emptyBoundaries.kind !== 'COMPLETE_BOUNDARY_SET') {
        throw new Error('Expected the Boundary set');
      }
      expect(emptyBoundaries.boundaries).toEqual([]);
      const emptyBoundaryProofRef = emptyBoundaries.completeness.evidence.proof.evidenceRef;
      const createBoundaryInput = Schema.decodeUnknownSync(CreateClosedAssortmentBoundaryPayloadSchema)({
        admissionSet: { entries: [{ kind: 'PRODUCT', productRef }] },
        commercialScope: { channelRef, sellingLegalEntityRef },
        decisionPurpose: 'VISIBILITY',
        effectiveFrom: '2030-01-01T00:00:00.000Z',
        provenanceRef: 'decision-set-currentness:create-boundary',
        reason: 'Make a previously empty Boundary predicate nonempty',
        subject: boundaryQuery.subject,
      });
      const createdBoundary = yield* runScoped((transaction) =>
        boundaryAdministrationPersistenceForScope(transaction, scope).create({
          ...createBoundaryInput,
          actionInvocationId: randomUUID(),
          actorPrincipalId: principalId,
          legalEntityId,
          tenantId,
        }),
      );
      expect(createdBoundary).toMatchObject({ created: true });
      expect(
        yield* runScoped((transaction) =>
          verifyAssortmentDecisionSetV1(transaction, {
            expectedProofRef: emptyBoundaryProofRef,
            query: boundaryQuery,
            version: 1,
          }),
        ),
      ).toEqual({ state: 'STALE', version: 1 });
      const currentBoundaries = yield* runScoped((transaction) =>
        readAssortmentDecisionSetV1(transaction, boundaryQuery),
      );
      expect(currentBoundaries.kind).toBe('COMPLETE_BOUNDARY_SET');
      if (currentBoundaries.kind !== 'COMPLETE_BOUNDARY_SET') {
        throw new Error('Expected the Boundary set');
      }
      expect(currentBoundaries.boundaries).toHaveLength(1);
      expect(currentBoundaries.boundaries[0]?.admissionSet).toEqual([{ kind: 'PRODUCT', productRef }]);
      expect(
        yield* runScoped((transaction) =>
          verifyAssortmentDecisionSetV1(transaction, {
            expectedProofRef: currentBoundaries.completeness.evidence.proof.evidenceRef,
            query: boundaryQuery,
            version: 1,
          }),
        ),
      ).toEqual({ state: 'CURRENT', version: 1 });
    }),
  ),
);

for (const audienceKind of ['SHARED', 'COMMERCE_CUSTOMER_GROUP', 'SUBJECT'] as const) {
  it.live(`preserves ${audienceKind} Product DENY after Rule retirement until explicit Binding End`, () =>
    Effect.scoped(
      Effect.gen(function* retirementPreservesApplicability() {
        const { admin } = yield* testDatabaseClients;
        const database = yield* makeTestDatabaseFromClient(admin, coreRelations);
        const scenarioTenantId = randomUUID();
        const scenarioLegalEntityId = randomUUID();
        const scenarioPrincipalId = randomUUID();
        const scenarioScope = {
          authContextRef: `job:retirement:${randomUUID()}`,
          authMethod: 'system',
          correlationId: randomUUID(),
          legalEntityId: scenarioLegalEntityId,
          principalId: scenarioPrincipalId,
          tenantId: scenarioTenantId,
        } satisfies OperationalScope;
        const scenarioRef = (moduleId: string, resourceType: string, resourceId: string) => ({
          moduleId,
          resourceId,
          resourceType,
          tenantId: scenarioTenantId,
        });
        const scenarioProduct = scenarioRef('commerce.catalog', 'catalog.product', randomUUID());
        const scenarioProfile = scenarioRef(
          'commerce.customer-context',
          'commerce.customer-context.retail-customer-profile',
          randomUUID(),
        );
        const scenarioGroup = scenarioRef(
          'commerce.customer-context',
          'commerce.customer-context.customer-group',
          randomUUID(),
        );
        const scenarioChannel = scenarioRef('commerce.channel', 'commerce.channel.channel', randomUUID());
        const scenarioSeller = scenarioRef('party.registry', 'party.registry.legal-entity', scenarioLegalEntityId);
        const scenarioCommercialScope = { channelRef: scenarioChannel, sellingLegalEntityRef: scenarioSeller };
        const scenarioSubject = {
          kind: 'IDENTIFIED',
          subject: { kind: 'RETAIL_CUSTOMER_PROFILE', profileRef: scenarioProfile },
        } as const;
        const startedAt = '2030-01-01T00:00:00.000Z';
        const beforeRetirementAt = '2030-02-01T00:00:00.000Z';
        const retiredAt = '2030-03-01T00:00:00.000Z';
        const afterRetirementAt = '2030-03-01T00:00:01.000Z';
        const beforeEndAt = '2030-03-31T23:59:59.999Z';
        const endedAt = '2030-04-01T00:00:00.000Z';
        const runScoped = <Value, Failure>(
          operation: (transaction: ScopedTransactionExecutor) => Effect.Effect<Value, Failure>,
        ) =>
          database.transaction((transaction) =>
            Effect.gen(function* retirementScopedOperation() {
              const scoped = yield* installOperationalScope(transaction, scenarioScope);
              return yield* operation(scoped);
            }),
          );
        const queryAt = (instant: string) =>
          Schema.decodeUnknownSync(AssortmentOrdinaryCandidateQueryV1Schema)({
            decisionPurpose: 'VISIBILITY',
            kind: 'ORDINARY_CANDIDATES',
            legalEntityId: scenarioLegalEntityId,
            operationTime: instant,
            subject: scenarioSubject,
            target: { kind: 'PRODUCT', productRef: scenarioProduct },
            tenantId: scenarioTenantId,
            trustedContext: { ...scenarioCommercialScope, operationTime: instant, tenantId: scenarioTenantId },
            version: 1,
          });
        const readAt = (instant: string) =>
          runScoped((transaction) => readAssortmentDecisionSetV1(transaction, queryAt(instant))).pipe(
            Effect.map((set) => {
              if (set.kind !== 'COMPLETE_ORDINARY_CANDIDATE_SET') {
                throw new Error('Expected the complete persisted ordinary Candidate set');
              }
              return set;
            }),
          );
        const broadInput = Schema.decodeUnknownSync(CreateRulePayloadSchema)({
          effect: 'ALLOW',
          provenanceRef: 'retirement:baseline',
          purpose: 'VISIBILITY',
          reason: 'Broad baseline for the retirement regression',
          selector: { kind: 'ALL' },
          stableCode: `retirement.allow.${scenarioTenantId}`,
        });
        const specificCode = `retirement.deny.${scenarioTenantId}`;
        const specificInput = Schema.decodeUnknownSync(CreateRulePayloadSchema)({
          effect: 'DENY',
          provenanceRef: 'retirement:specific-deny',
          purpose: 'VISIBILITY',
          reason: 'Retirement must preserve existing exact Product exclusion',
          selector: { kind: 'PRODUCT', productRef: scenarioProduct },
          stableCode: specificCode,
        });
        const broad = yield* runScoped((transaction) =>
          assortmentPolicyPersistenceForScope(transaction, scenarioScope).createRule({
            ...broadInput,
            actionInvocationId: randomUUID(),
            actorPrincipalId: scenarioPrincipalId,
            tenantId: scenarioTenantId,
          }),
        ).pipe(
          Effect.map((created) => {
            if (!('initialRuleRevisionId' in created)) {
              throw new Error('Expected broad Rule');
            }
            return created;
          }),
        );
        const specific = yield* runScoped((transaction) =>
          assortmentPolicyPersistenceForScope(transaction, scenarioScope).createRule({
            ...specificInput,
            actionInvocationId: randomUUID(),
            actorPrincipalId: scenarioPrincipalId,
            tenantId: scenarioTenantId,
          }),
        ).pipe(
          Effect.map((created) => {
            if (!('initialRuleRevisionId' in created)) {
              throw new Error('Expected specific Rule');
            }
            return created;
          }),
        );
        const specificAudience = Match.value(audienceKind).pipe(
          Match.when('SHARED', () => ({ kind: 'SHARED' as const })),
          Match.when('COMMERCE_CUSTOMER_GROUP', () => ({
            groupRef: scenarioGroup,
            kind: 'COMMERCE_CUSTOMER_GROUP' as const,
          })),
          Match.when('SUBJECT', () => ({ kind: 'SUBJECT' as const, subject: scenarioSubject.subject })),
          Match.exhaustive,
        );
        const broadBindingInput = Schema.decodeUnknownSync(CreateApplicabilityBindingPayloadSchema)({
          audience: { kind: 'SHARED' },
          commercialScope: scenarioCommercialScope,
          effectiveFrom: startedAt,
          provenanceRef: 'retirement:baseline-binding',
          reason: 'Make the broad baseline applicable',
          ruleRevisionRef: ruleRevisionRef(scenarioTenantId, broad.initialRuleRevisionId, 1),
        });
        yield* runScoped((transaction) =>
          assortmentPolicyPersistenceForScope(transaction, scenarioScope).createBinding({
            ...broadBindingInput,
            actionInvocationId: randomUUID(),
            actorPrincipalId: scenarioPrincipalId,
            legalEntityId: scenarioLegalEntityId,
            tenantId: scenarioTenantId,
          }),
        );
        const specificBindingInput = Schema.decodeUnknownSync(CreateApplicabilityBindingPayloadSchema)({
          ...broadBindingInput,
          audience: specificAudience,
          effectiveFrom: startedAt,
          provenanceRef: 'retirement:specific-binding',
          reason: 'Persist a live specific DENY Binding',
          ruleRevisionRef: ruleRevisionRef(scenarioTenantId, specific.initialRuleRevisionId, 1),
        });
        const specificBinding = yield* runScoped((transaction) =>
          assortmentPolicyPersistenceForScope(transaction, scenarioScope).createBinding({
            ...specificBindingInput,
            actionInvocationId: randomUUID(),
            actorPrincipalId: scenarioPrincipalId,
            legalEntityId: scenarioLegalEntityId,
            tenantId: scenarioTenantId,
          }),
        ).pipe(
          Effect.map((created) => {
            if (!('bindingId' in created)) {
              throw new Error('Expected specific Binding');
            }
            return created;
          }),
        );
        const resolve = (set: Effect.Success<ReturnType<typeof readAt>>) => {
          const setQuery = set.query;
          // This test translates only the Assortment owner's equivalent v1 predicate vocabulary.
          // Candidates, fact proofs, exact query scope and the actual PostgreSQL set proof are retained.
          const completeness = {
            ...set.completeness,
            evidence: {
              ...set.completeness.evidence,
              predicate: 'all current Candidate-producing bindings and immutable revisions for this exact decision',
              scope: 'commerce.assortment.ordinary-candidates',
            },
          };
          const membershipProof = {
            evidenceRef: scenarioRef(
              'commerce.customer-context',
              'commerce.customer-context.membership-set-proof',
              'fixture-proof',
            ),
            ownerModuleId: 'commerce.customer-context',
          };
          // Injected GROUP proof is a resolver fixture, not evidence of a production Membership source.
          const memberships = Schema.decodeUnknownSync(Schema.toType(AssortmentCustomerGroupMembershipSetSchema))({
            asOf: setQuery.operationTime,
            completeness: {
              predicate: 'all current customer-group memberships',
              proof: membershipProof,
              scope: 'customer-context.memberships',
              state: 'COMPLETE',
            },
            items: [
              {
                effectiveFrom: DateTime.makeUnsafe(startedAt),
                effectiveTo: null,
                groupRef: scenarioGroup,
                membershipRef: scenarioRef(
                  'commerce.customer-context',
                  'commerce.customer-context.customer-group-membership',
                  'fixture-membership',
                ),
                profileRef: scenarioProfile,
                revision: '1',
                state: 'VALID',
              },
            ],
            profileRef: scenarioProfile,
          });
          return resolveAssortmentOrdinary(
            Schema.decodeUnknownSync(Schema.toType(AssortmentOrdinaryResolutionInputSchema))({
              candidates: set.candidates,
              completeness,
              decisionPurpose: setQuery.decisionPurpose,
              factCurrentness: set.factCurrentness,
              memberships,
              subject: setQuery.subject,
              target: setQuery.target,
              tenantId: setQuery.tenantId,
              trustedContext: setQuery.trustedContext,
            }),
          );
        };
        const verify = (set: Effect.Success<ReturnType<typeof readAt>>) =>
          runScoped((transaction) =>
            verifyAssortmentDecisionSetV1(transaction, {
              expectedProofRef: set.completeness.evidence.proof.evidenceRef,
              query: set.query,
              version: 1,
            }),
          );
        const before = yield* readAt(beforeRetirementAt);
        expect(before.candidates).toHaveLength(2);
        expect(resolve(before)).toMatchObject({
          evidence: {
            maximalCandidates: [
              {
                bindingRef: bindingRef(scenarioTenantId, specificBinding.bindingId),
                effect: 'DENY',
                ruleRevision: { revision: '1', sourceRef: { resourceId: specific.initialRuleRevisionId } },
                stableRuleRef: stableRuleRef(scenarioTenantId, specific.stableRuleId),
              },
            ],
          },
          kind: 'RESOLVED',
          outcome: 'INELIGIBLE',
        });
        const preservedCandidates = JSON.stringify(before.candidates);
        const historicalRequest = Schema.decodeUnknownSync(Schema.toType(AssortmentVisibilityRequestSchema))({
          decisionPurpose: 'VISIBILITY',
          productRef: scenarioProduct,
          subject: before.query.subject,
          trustedContext: before.query.trustedContext,
        });
        const historicalDecision = Schema.decodeUnknownSync(Schema.toType(AssortmentGovernedDecisionSchema))({
          evidence: {
            candidates: before.candidates,
            factCurrentness: before.factCurrentness,
            operationTime: before.query.operationTime,
            setCompleteness: [before.completeness.evidence],
            subject: before.query.subject,
            target: before.query.target,
            trustedContext: before.query.trustedContext,
          },
          outcome: 'INELIGIBLE',
        });
        const historicalReference = yield* runScoped((transaction) =>
          assortmentDecisionEvidenceRepositoryForScope(transaction, scenarioScope).persist({
            decision: historicalDecision,
            request: historicalRequest,
          }),
        );
        const explainHistory = () =>
          runScoped((transaction) =>
            assortmentDecisionExplanationReadService(scenarioScope, (reference) =>
              assortmentDecisionEvidenceRepositoryForScope(transaction, scenarioScope)
                .resolve(reference)
                .pipe(Effect.mapError(historicalEvidenceUnavailable)),
            ).explain({ evidenceRef: historicalReference, request: historicalRequest }),
          );
        const explanationBeforeRetirement = yield* explainHistory();
        expect(explanationBeforeRetirement.outcome).toBe('INELIGIBLE');
        expect(explanationBeforeRetirement.evidence.candidates).toEqual(before.candidates);
        const fixedBeforeRetirementProof = yield* readAt(afterRetirementAt);
        expect(yield* verify(fixedBeforeRetirementProof)).toEqual({ state: 'CURRENT', version: 1 });
        const retirement = {
          ...Schema.decodeUnknownSync(RetireRulePayloadSchema)({
            effectiveAt: retiredAt,
            expectedBasisFingerprint: assortmentMeaningFingerprint({
              latestRevisionId: specific.initialRuleRevisionId,
              latestRevisionNumber: 1,
              retired: false,
              stableCode: specificCode,
            }),
            provenanceRef: 'retirement:retire-lineage',
            reason: 'Prevent new applicability without ending existing Bindings',
            stableRuleRef: stableRuleRef(scenarioTenantId, specific.stableRuleId),
          }),
          actionInvocationId: randomUUID(),
          actorPrincipalId: scenarioPrincipalId,
          tenantId: scenarioTenantId,
        };
        expect(
          yield* runScoped((transaction) =>
            assortmentPolicyPersistenceForScope(transaction, scenarioScope).retireRule(retirement),
          ),
        ).toEqual({ retired: true });
        expect(yield* verify(fixedBeforeRetirementProof)).toEqual({ state: 'STALE', version: 1 });
        const atRetirement = yield* readAt(retiredAt);
        const afterRetirement = yield* readAt(afterRetirementAt);
        expect(atRetirement.candidates).toEqual(before.candidates);
        expect(afterRetirement.candidates).toEqual(before.candidates);
        expect(resolve(atRetirement)).toMatchObject({ kind: 'RESOLVED', outcome: 'INELIGIBLE' });
        expect(resolve(afterRetirement)).toMatchObject({ kind: 'RESOLVED', outcome: 'INELIGIBLE' });
        expect(yield* explainHistory()).toEqual(explanationBeforeRetirement);
        expect(yield* verify(afterRetirement)).toEqual({ state: 'CURRENT', version: 1 });
        expect(
          yield* runScoped((transaction) =>
            assortmentPolicyPersistenceForScope(transaction, scenarioScope).retireRule(retirement),
          ),
        ).toEqual({ retired: false });
        expect(yield* verify(afterRetirement)).toEqual({ state: 'CURRENT', version: 1 });
        expect((yield* readAt(afterRetirementAt)).completeness.evidence.proof).toEqual(
          afterRetirement.completeness.evidence.proof,
        );
        expect(
          yield* runScoped((transaction) =>
            assortmentPolicyPersistenceForScope(transaction, scenarioScope).retireRule({
              ...retirement,
              reason: 'Changed intent under the same invocation',
            }),
          ),
        ).toEqual({ conflict: 'IDEMPOTENCY_REUSED', kind: 'conflict' });
        const revisionInput = Schema.decodeUnknownSync(CreateRuleRevisionPayloadSchema)({
          effect: 'ALLOW',
          expectedLatestRevision: 1,
          provenanceRef: 'retirement:forbidden-revision',
          purpose: 'VISIBILITY',
          reason: 'A retired lineage must reject fresh Revision creation',
          selector: { kind: 'ALL' },
          stableRuleRef: retirement.stableRuleRef,
        });
        expect(
          yield* runScoped((transaction) =>
            assortmentPolicyPersistenceForScope(transaction, scenarioScope).createRuleRevision({
              ...revisionInput,
              actionInvocationId: randomUUID(),
              actorPrincipalId: scenarioPrincipalId,
              tenantId: scenarioTenantId,
            }),
          ),
        ).toEqual({ conflict: 'LIFECYCLE', kind: 'conflict' });
        expect(
          yield* runScoped((transaction) =>
            assortmentPolicyPersistenceForScope(transaction, scenarioScope).createBinding({
              ...specificBindingInput,
              actionInvocationId: randomUUID(),
              actorPrincipalId: scenarioPrincipalId,
              legalEntityId: scenarioLegalEntityId,
              tenantId: scenarioTenantId,
            }),
          ),
        ).toEqual({ conflict: 'LIFECYCLE', kind: 'conflict' });
        expect(yield* verify(afterRetirement)).toEqual({ state: 'CURRENT', version: 1 });
        const specificBindingBasis = assortmentMeaningFingerprint({
          bindingKind: audienceKind,
          channelResourceId: scenarioChannel.resourceId,
          customerGroupResourceId: audienceKind === 'COMMERCE_CUSTOMER_GROUP' ? scenarioGroup.resourceId : null,
          effectiveFrom: startedAt,
          marketResourceId: null,
          ruleRevisionId: specific.initialRuleRevisionId,
          storefrontResourceId: null,
          subjectKind: audienceKind === 'SUBJECT' ? 'RETAIL_CUSTOMER_PROFILE' : null,
          subjectResourceId: audienceKind === 'SUBJECT' ? scenarioProfile.resourceId : null,
        });
        const endInput = Schema.decodeUnknownSync(EndApplicabilityBindingPayloadSchema)({
          applicabilityBindingRef: bindingRef(scenarioTenantId, specificBinding.bindingId),
          effectiveAt: endedAt,
          expectedBasisFingerprint: specificBindingBasis,
          provenanceRef: 'retirement:explicit-end',
          reason: 'Only explicit Binding End stops existing applicability',
        });
        expect(
          yield* runScoped((transaction) =>
            assortmentPolicyPersistenceForScope(transaction, scenarioScope).endBinding({
              ...endInput,
              actionInvocationId: randomUUID(),
              actorPrincipalId: scenarioPrincipalId,
              legalEntityId: scenarioLegalEntityId,
              tenantId: scenarioTenantId,
            }),
          ),
        ).toEqual({ ended: true });
        expect(yield* verify(afterRetirement)).toEqual({ state: 'STALE', version: 1 });
        const justBeforeEnd = yield* readAt(beforeEndAt);
        expect(justBeforeEnd.candidates).toEqual(before.candidates);
        expect(resolve(justBeforeEnd)).toMatchObject({ kind: 'RESOLVED', outcome: 'INELIGIBLE' });
        const atEnd = yield* readAt(endedAt);
        expect(atEnd.candidates).toHaveLength(1);
        expect(atEnd.candidates[0]).toMatchObject({ effect: 'ALLOW', selector: { kind: 'ALL' } });
        expect(resolve(atEnd)).toMatchObject({ kind: 'RESOLVED', outcome: 'ELIGIBLE' });
        expect(yield* verify(atEnd)).toEqual({ state: 'CURRENT', version: 1 });
        expect(JSON.stringify(before.candidates)).toBe(preservedCandidates);
        expect(yield* explainHistory()).toEqual(explanationBeforeRetirement);
      }),
    ),
  );
}
