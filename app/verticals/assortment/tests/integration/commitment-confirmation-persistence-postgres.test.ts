import { randomUUID } from 'node:crypto';

import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { and, eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Exit, Predicate, Result, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import type { CoreTransaction } from '../../../../packages/core-runtime/src/db/types.ts';
import {
  AssortmentCommitmentConfirmationInvalid,
  AssortmentCommitmentConfirmationPayloadSchema,
  AssortmentCommitmentConfirmationResultSchema,
} from '../../shared/domain/commitment-confirmation.ts';
import {
  AssortmentCandidateSchema,
  AssortmentDependencyFailureError,
  AssortmentGovernedDecisionSchema,
  AssortmentOwnerResourceRefSchema,
  AssortmentPurchaseRequestSchema,
  AssortmentPurchaseConstituentSchema,
  AssortmentSetCompletenessEvidenceSchema,
} from '../../shared/domain/decision-contracts.ts';
import { assortmentRelations, commitmentConfirmations, decisionEvidence } from '../../src/database/schema.ts';
import {
  makeAssortmentDecisionEvaluation,
  assortmentPurchaseConstituentRequest,
} from '../../shared/domain/ports/decision-evaluation.ts';
import { assortmentDecisionExplanationReadService } from '../../src/services/decision-explanation-read.service.ts';
import { AssortmentPolicyPersistenceUnavailable } from '../../shared/domain/policy-errors.ts';
import { AssortmentSuccessfulAttemptDecisionEvidenceSchema } from '../../shared/domain/decision-evidence.ts';
import {
  AssortmentOrdinaryResolutionInputSchema,
  resolveAssortmentOrdinary,
} from '../../shared/domain/ordinary-resolution.ts';
import { makeAssortmentCommitmentConfirmationService } from '../../src/services/assortment-commitment-confirmation.service.ts';
import { assortmentCommitmentConfirmationRepositoryForScope } from '../../src/services/assortment-commitment-confirmation.repository.ts';
import { assortmentDecisionEvidenceRepositoryForScope } from '../../src/services/decision-evidence.repository.ts';

const tenantId = randomUUID();
const legalEntityId = randomUUID();
const foreignTenantId = randomUUID();
const foreignLegalEntityId = randomUUID();
const principalId = randomUUID();
const actionInvocationId = randomUUID();

type AssortmentTestDatabase = TestDatabaseFromClient<typeof assortmentRelations>;
type AssortmentTransaction = Parameters<Parameters<AssortmentTestDatabase['transaction']>[0]>[0];

const scope = {
  authContextRef: 'commitment-confirmation-postgres-test',
  authMethod: 'session',
  correlationId: 'commitment-confirmation-postgres-test',
  legalEntityId,
  principalId,
  tenantId,
} satisfies OperationalScope;

const ref = (moduleId: string, resourceType: string, resourceId: string, refTenantId = tenantId) =>
  Schema.decodeUnknownSync(AssortmentOwnerResourceRefSchema)({
    moduleId,
    resourceId,
    resourceType,
    tenantId: refTenantId,
  });

// Future consumer owners define these types; Assortment persists both references opaquely.
const attemptRef = ref('example.consumer', 'example.consumer.attempt', 'attempt-1');
const meaningRef = ref('example.consumer', 'example.consumer.prospective-purchase-meaning', 'meaning-1');
const productRef = ref('catalog.owner', 'catalog.product', 'product-1');
const variantRef = ref('catalog.owner', 'catalog.variant', 'variant-1');
const candidate = Schema.decodeUnknownSync(AssortmentCandidateSchema)({
  audience: { kind: 'SHARED' },
  bindingRef: ref('commerce.assortment', 'commerce.assortment.applicability-binding', 'binding-1'),
  commercialScope: {
    channelRef: ref('commerce.channel', 'commerce.channel.channel', 'web'),
    sellingLegalEntityRef: ref('commerce.legal-entity', 'commerce.legal-entity.selling-legal-entity', legalEntityId),
  },
  decisionPurpose: 'PURCHASE',
  effect: 'ALLOW',
  ruleRevision: {
    ownerModuleId: 'commerce.assortment',
    revision: 'r1',
    sourceRef: ref('commerce.assortment', 'commerce.assortment.rule-revision', 'revision-1'),
  },
  selector: { kind: 'VARIANT', variantRef },
  stableRuleRef: ref('commerce.assortment', 'commerce.assortment.stable-rule', 'rule-1'),
});
const constituent = Schema.decodeUnknownSync(AssortmentPurchaseConstituentSchema)({
  catalogSelection: { configuration: { kind: 'NONE' }, productRef, variantKind: 'ATOMIC', variantRef },
  role: 'TOP_LEVEL',
});
const decisionEvidenceRef = {
  evidenceRef: ref('commerce.assortment', 'commerce.assortment.decision-evidence', 'evidence-1'),
  ownerModuleId: 'commerce.assortment',
};
const payload = Schema.decodeUnknownSync(AssortmentCommitmentConfirmationPayloadSchema)({
  attemptRef,
  candidate,
  constituent,
  decisionEvidenceRef,
  prospectivePurchaseMeaningRef: meaningRef,
});
const confirmation = Schema.decodeUnknownSync(AssortmentCommitmentConfirmationResultSchema)({
  ...payload,
  confirmationRef: ref('commerce.assortment', 'commerce.assortment.commitment-confirmation', randomUUID()),
  expiresAt: '2026-09-24T10:00:30.000Z',
  issuedAt: '2026-09-24T10:00:00.000Z',
});
const metadata = { actionInvocationId, actorPrincipalId: principalId };
const evidenceRequest = Schema.decodeUnknownSync(AssortmentPurchaseRequestSchema)({
  constituent: {
    catalogSelection: { configuration: { kind: 'NONE' }, productRef, variantKind: 'ATOMIC', variantRef },
    role: 'TOP_LEVEL',
  },
  decisionPurpose: 'PURCHASE',
  subject: {
    kind: 'IDENTIFIED',
    subject: {
      kind: 'RETAIL_CUSTOMER_PROFILE',
      profileRef: ref('commerce.customer-context', 'commerce.customer-context.retail-customer-profile', 'profile-1'),
    },
  },
  trustedContext: {
    channelRef: ref('commerce.channel', 'commerce.channel.channel', 'web'),
    operationTime: '2026-09-24T10:00:00.000Z',
    sellingLegalEntityRef: ref('commerce.legal-entity', 'commerce.legal-entity.selling-legal-entity', legalEntityId),
    tenantId,
  },
});
const evidenceDecision = Schema.decodeUnknownSync(AssortmentGovernedDecisionSchema)({
  evidence: {
    factCurrentness: [],
    operationTime: '2026-09-24T10:00:00.000Z',
    setCompleteness: [],
    subject: evidenceRequest.subject,
    target: { kind: 'CATALOG_SELECTION', selection: evidenceRequest.constituent.catalogSelection },
    trustedContext: { ...evidenceRequest.trustedContext, operationTime: '2026-09-24T10:00:00.000Z' },
  },
  outcome: 'ELIGIBLE',
});

const freeze = <Value extends object>(value: Value): Value => {
  if (Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    if (Predicate.isObjectOrArray(nested)) {
      freeze(nested);
    }
  }
  return Object.freeze(value);
};

const known = (request: typeof evidenceRequest, outcome: 'ELIGIBLE' | 'INELIGIBLE') =>
  freeze(
    Schema.decodeUnknownSync(Schema.toType(AssortmentGovernedDecisionSchema))({
      ...evidenceDecision,
      evidence: {
        ...evidenceDecision.evidence,
        target: { kind: 'CATALOG_SELECTION', selection: request.constituent.catalogSelection },
      },
      outcome,
    }),
  );

const componentCandidateCompleteness = Schema.decodeUnknownSync(AssortmentSetCompletenessEvidenceSchema)({
  predicate: 'all current Candidate-producing bindings and immutable revisions for this exact decision',
  proof: {
    evidenceRef: ref('commerce.assortment', 'commerce.assortment.evidence', 'component-candidate-set-proof'),
    ownerModuleId: 'commerce.assortment',
  },
  scope: 'commerce.assortment.ordinary-candidates',
  state: 'COMPLETE',
});

const positiveComponentAttemptAt = (component: typeof constituent, now: DateTime.Utc) => {
  const request = Schema.decodeUnknownSync(Schema.toType(AssortmentPurchaseRequestSchema))({
    ...evidenceRequest,
    constituent: component,
    trustedContext: { ...evidenceRequest.trustedContext, operationTime: now },
  });
  const decoded = Schema.decodeUnknownSync(Schema.toType(AssortmentSuccessfulAttemptDecisionEvidenceSchema))({
    decision: {
      evidence: {
        candidates: [candidate],
        factCurrentness: [candidate.bindingRef, candidate.ruleRevision.sourceRef].map((factRef, index) => ({
          factRef,
          proof: {
            evidenceRef: ref('commerce.assortment', 'commerce.assortment.evidence', `component-current-proof-${index}`),
            ownerModuleId: 'commerce.assortment',
          },
          state: 'CURRENT',
        })),
        operationTime: now,
        setCompleteness: [componentCandidateCompleteness],
        subject: request.subject,
        target: { kind: 'CATALOG_SELECTION', selection: component.catalogSelection },
        trustedContext: request.trustedContext,
      },
      outcome: 'ELIGIBLE',
    },
    request,
  });
  return { ...decoded, request };
};

const runScoped = <Value>(
  database: AssortmentTestDatabase,
  operationScope: OperationalScope,
  operation: (transaction: AssortmentTransaction) => Effect.Effect<Value, unknown>,
) =>
  database.transaction((transaction) =>
    Effect.gen(function* runOwnerScopedOperation() {
      yield* transaction.execute(
        sql`select set_config('ontos.tenant_id', ${operationScope.tenantId}, true), set_config('ontos.legal_entity_id', ${operationScope.legalEntityId}, true)`,
        'objects',
      );
      return yield* operation(transaction);
    }),
  );

const runRepositoryScoped = <Value>(
  database: AssortmentTestDatabase,
  operationScope: OperationalScope,
  operation: (transaction: ScopedTransactionExecutor) => Effect.Effect<Value, unknown>,
) =>
  database.transaction((transaction) =>
    Effect.gen(function* runRepositoryOperation() {
      // SAFETY: The assortment and Core transactions expose the same Drizzle transaction
      // protocol; the shared scope installer only consumes that structural database boundary.
      const scopedTransaction = yield* installOperationalScope(
        transaction,
        operationScope,
      );
      return yield* operation(scopedTransaction);
    }),
  );

const cleanupRows = (admin: AssortmentTestDatabase) =>
  admin.transaction((transaction) =>
    Effect.gen(function* cleanupCommitmentConfirmations() {
      yield* transaction.execute(sql`set local session_replication_role = 'replica'`, 'objects');
      yield* transaction
        .delete(decisionEvidence)
        .where(and(eq(decisionEvidence.tenantId, tenantId), eq(decisionEvidence.legalEntityId, legalEntityId)));
      yield* transaction
        .delete(commitmentConfirmations)
        .where(
          and(eq(commitmentConfirmations.tenantId, tenantId), eq(commitmentConfirmations.legalEntityId, legalEntityId)),
        );
    }),
  );

const grantRuntimeAccess = (admin: AssortmentTestDatabase) =>
  admin.transaction((transaction) =>
    Effect.gen(function* grantCommitmentConfirmationAccess() {
      yield* transaction.execute(sql`grant usage on schema assortment to ontos_runtime`, 'objects');
      yield* transaction.execute(
        sql`grant select, insert, update, delete on table assortment.assortment_commitment_confirmations to ontos_runtime`,
        'objects',
      );
    }),
  );

const revokeRuntimeAccess = (admin: AssortmentTestDatabase) =>
  admin.transaction((transaction) =>
    Effect.gen(function* revokeCommitmentConfirmationAccess() {
      yield* transaction.execute(
        sql`revoke select, insert, update, delete on table assortment.assortment_commitment_confirmations from ontos_runtime`,
        'objects',
      );
      yield* transaction.execute(sql`revoke usage on schema assortment from ontos_runtime`, 'objects');
    }),
  );

it.live('persists immutable confirmations with replay, RLS isolation, and append-only enforcement', () =>
  Effect.scoped(
    Effect.gen(function* commitmentConfirmationPersistenceAcceptance() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, assortmentRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, assortmentRelations);
      yield* cleanupRows(admin);
      yield* grantRuntimeAccess(admin);
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* cleanupCommitmentConfirmationAcceptance() {
          yield* cleanupRows(admin).pipe(Effect.orDie);
          yield* revokeRuntimeAccess(admin).pipe(Effect.orDie);
        }),
      );

      const persisted = yield* runRepositoryScoped(runtime, scope, (transaction) =>
        assortmentCommitmentConfirmationRepositoryForScope(transaction, scope).persist(
          payload,
          confirmation,
          scope,
          metadata,
        ),
      );
      expect(persisted).toEqual(confirmation);

      yield* admin.transaction((transaction) =>
        transaction.execute(
          sql`grant select, insert, update, delete on table assortment.assortment_decision_evidence to ontos_runtime`,
          'objects',
        ),
      );
      yield* Effect.addFinalizer(() =>
        admin
          .transaction((transaction) =>
            transaction.execute(
              sql`revoke select, insert, update, delete on table assortment.assortment_decision_evidence from ontos_runtime`,
              'objects',
            ),
          )
          .pipe(Effect.orDie),
      );
      const evidenceReference = yield* runRepositoryScoped(runtime, scope, (transaction) =>
        assortmentDecisionEvidenceRepositoryForScope(transaction, scope).persist({
          constituent: evidenceRequest.constituent,
          decision: evidenceDecision,
          request: evidenceRequest,
        }),
      );
      const persistedEvidence = yield* runRepositoryScoped(runtime, scope, (transaction) =>
        assortmentDecisionEvidenceRepositoryForScope(transaction, scope).resolve(evidenceReference.evidenceRef),
      );
      expect(persistedEvidence.request).toEqual(evidenceRequest);
      expect(persistedEvidence.evidence).toEqual(evidenceDecision.evidence);
      // Trusted source fixtures prove the owner contract through real storage;
      // they do not claim deployed owner provenance or Attempt/Bundle authority.
      const component = Schema.decodeUnknownSync(AssortmentPurchaseConstituentSchema)({
        ...evidenceRequest.constituent,
        role: 'REQUIRED_COMPONENT',
      });
      const setRevision = {
        ownerModuleId: 'catalog.owner',
        revision: 'set-r1',
        sourceRef: ref('catalog.owner', 'catalog.set-composition-revision', 'set-r1'),
      };
      const setRequest = Schema.decodeUnknownSync(Schema.toType(AssortmentPurchaseRequestSchema))({
        ...evidenceRequest,
        constituent: {
          catalogSelection: {
            configuration: { kind: 'NONE' },
            productRef: ref('catalog.owner', 'catalog.product', 'set-product'),
            setCompositionRevision: setRevision,
            variantKind: 'SET',
            variantRef: ref('catalog.owner', 'catalog.variant', 'set-variant'),
          },
          role: 'TOP_LEVEL',
        },
        setComposition: { requiredComponents: [component], setCompositionRevision: setRevision },
      });
      const componentRequest = assortmentPurchaseConstituentRequest(setRequest, component);
      const { setComposition } = setRequest;
      if (setComposition === undefined) {
        throw new Error('expected pinned Set composition');
      }
      for (const composedOutcome of ['ELIGIBLE', 'INELIGIBLE'] as const) {
        const persistenceAttempts: string[] = [];
        let persistenceFailed = false;
        const recordPersistenceFailure = Effect.sync(() => {
          persistenceFailed = true;
        });
        const unknown = freeze(
          Schema.decodeUnknownSync(AssortmentGovernedDecisionSchema)({
            failure: {
              _tag: 'AssortmentDependencyFailureError',
              code: 'DEPENDENCY_FAILURE',
              ownerModuleId: 'commerce.assortment',
              retryable: true,
              safeReasonCode: 'DEPENDENCY_UNAVAILABLE',
            },
            outcome: 'INDETERMINATE',
          }),
        );
        const result = yield* runRepositoryScoped(runtime, scope, (transaction) =>
          makeAssortmentDecisionEvaluation({
            evidenceStore: {
              persist: (input) =>
                Effect.sync(() =>
                  persistenceAttempts.push(
                    input.request.decisionPurpose === 'PURCHASE'
                      ? input.request.constituent.role
                      : input.request.decisionPurpose,
                  ),
                ).pipe(
                  Effect.andThen(assortmentDecisionEvidenceRepositoryForScope(transaction, scope).persist(input)),
                  Effect.tapError(() => recordPersistenceFailure),
                ),
            },
            source: {
              resolvePurchase: () =>
                Effect.succeed({
                  constituents: [
                    {
                      constituent: setRequest.constituent,
                      decision: composedOutcome === 'INELIGIBLE' ? unknown : known(setRequest, 'ELIGIBLE'),
                      request: setRequest,
                    },
                    {
                      constituent: component,
                      decision: known(componentRequest, composedOutcome),
                      request: componentRequest,
                    },
                  ],
                  decision: known(setRequest, composedOutcome),
                  request: setRequest,
                }),
              resolveVisibility: () =>
                Effect.fail(
                  new AssortmentDependencyFailureError({
                    code: 'DEPENDENCY_FAILURE',
                    ownerModuleId: setRequest.constituent.catalogSelection.productRef.moduleId,
                    retryable: true,
                    safeReasonCode: 'DEPENDENCY_UNAVAILABLE',
                  }),
                ),
            },
          }).evaluatePurchase(
            {
              constituent: setRequest.constituent,
              decisionPurpose: 'PURCHASE',
              setComposition,
              subject: setRequest.subject,
              trustedContextRef: ref('commerce.gateway', 'commerce.gateway.context', 'trusted-fixture-context'),
            },
            scope,
          ),
        );
        // These assertions distinguish pre-store source rejection from a real
        // typed persistence failure, without manufacturing durable references.
        expect(persistenceFailed).toBe(false);
        expect(persistenceAttempts).toEqual(
          composedOutcome === 'ELIGIBLE' ? ['TOP_LEVEL', 'REQUIRED_COMPONENT'] : ['REQUIRED_COMPONENT'],
        );
        expect(result.decision.outcome).toBe(composedOutcome);
        const componentEvidence = result.consumerEvidence?.evaluatedConstituents.find(
          (item) => item.constituent.role === 'REQUIRED_COMPONENT',
        );
        if (componentEvidence === undefined || componentEvidence.outcome === 'INDETERMINATE') {
          throw new Error('expected durable component evidence');
        }
        const explained = yield* runRepositoryScoped(runtime, scope, (transaction) =>
          assortmentDecisionExplanationReadService(scope, (reference) =>
            assortmentDecisionEvidenceRepositoryForScope(transaction, scope)
              .resolve(reference)
              .pipe(
                Effect.mapError(
                  () =>
                    new AssortmentPolicyPersistenceUnavailable({
                      code: 'assortment_policy_persistence_unavailable',
                      reason: 'test evidence unavailable',
                    }),
                ),
              ),
          ).explain({ evidenceRef: componentEvidence.decisionEvidence, request: componentRequest }),
        );
        expect(explained.outcome).toBe(composedOutcome);
        expect(explained.evidence.target).toEqual({ kind: 'CATALOG_SELECTION', selection: component.catalogSelection });
        if (composedOutcome === 'INELIGIBLE') {
          expect(result.consumerEvidence?.evaluatedConstituents[0]?.outcome).toBe('INDETERMINATE');
          expect(result.consumerEvidence?.evaluatedConstituents[0]).not.toHaveProperty('decisionEvidence');
        }
      }
      // Trusted complete Current and Attempt/Bundle fixtures prove Assortment's
      // service-to-real-repository chain; the production factory remains unavailable.
      // A scoped fixed clock binds freshly stored evidence to the issuer's exact now.
      yield* Effect.gen(function* issuesPersistedComponentConfirmation() {
        const now = yield* DateTime.now;
        const attemptEvidence = positiveComponentAttemptAt(component, now);
        const freshComponentRef = yield* runRepositoryScoped(runtime, scope, (transaction) =>
          assortmentDecisionEvidenceRepositoryForScope(transaction, scope).persist({
            constituent: component,
            decision: attemptEvidence.decision,
            request: attemptEvidence.request,
          }),
        );
        const componentPayload = Schema.decodeUnknownSync(AssortmentCommitmentConfirmationPayloadSchema)({
          ...payload,
          constituent: component,
          decisionEvidenceRef: freshComponentRef,
        });
        const issued = yield* runRepositoryScoped(runtime, scope, (transaction) =>
          makeAssortmentCommitmentConfirmationService(
            scope,
            {
              evaluate: (requested, _evaluationScope, issuedNow) => {
                const currentAttempt = positiveComponentAttemptAt(component, issuedNow);
                const { request: currentRequest } = currentAttempt;
                const ordinaryInput = Schema.decodeUnknownSync(Schema.toType(AssortmentOrdinaryResolutionInputSchema))({
                  candidates: [candidate],
                  completeness: {
                    evidence: componentCandidateCompleteness,
                    scope: {
                      commercialScope: candidate.commercialScope,
                      decisionPurpose: 'PURCHASE',
                      kind: 'ORDINARY_CANDIDATES',
                      operationTime: issuedNow,
                      subject: currentRequest.subject,
                      target: currentAttempt.decision.evidence.target,
                      tenantId,
                    },
                  },
                  decisionPurpose: 'PURCHASE',
                  factCurrentness: currentAttempt.decision.evidence.factCurrentness,
                  subject: currentRequest.subject,
                  target: currentAttempt.decision.evidence.target,
                  tenantId,
                  trustedContext: currentRequest.trustedContext,
                });
                expect(resolveAssortmentOrdinary(ordinaryInput)).toMatchObject({
                  kind: 'RESOLVED',
                  outcome: 'ELIGIBLE',
                });
                const wrongPredicate = {
                  ...ordinaryInput,
                  completeness: {
                    ...ordinaryInput.completeness,
                    evidence: { ...ordinaryInput.completeness.evidence, predicate: 'an unproven subset of candidates' },
                  },
                };
                expect(resolveAssortmentOrdinary(wrongPredicate)).toEqual({
                  kind: 'INDETERMINATE',
                  reason: 'CANDIDATE_SET_INCOMPLETE',
                });
                return Effect.succeed({
                  attemptEvidence: currentAttempt,
                  attemptRef: requested.attemptRef,
                  candidate,
                  constituent: component,
                  decisionEvidenceRef: freshComponentRef,
                  ordinaryInput,
                  prospectivePurchaseMeaningRef: requested.prospectivePurchaseMeaningRef,
                });
              },
            },
            assortmentCommitmentConfirmationRepositoryForScope(transaction, scope),
          ).issue(componentPayload, {
            actionInvocationId: randomUUID(),
            actorPrincipalId: principalId,
          }),
        );
        expect(issued.constituent).toEqual(component);
        expect(issued.constituent.role).toBe('REQUIRED_COMPONENT');
        expect(issued.candidate).toEqual(componentPayload.candidate);
        expect(issued.decisionEvidenceRef).toEqual(freshComponentRef);
        expect(DateTime.toEpochMillis(issued.issuedAt)).toBe(DateTime.toEpochMillis(now));
        const savedComponentEvidence = yield* runRepositoryScoped(runtime, scope, (transaction) =>
          assortmentDecisionEvidenceRepositoryForScope(transaction, scope).resolve(
            issued.decisionEvidenceRef.evidenceRef,
          ),
        );
        expect(savedComponentEvidence.request).toEqual(attemptEvidence.request);
        expect(savedComponentEvidence.evidence).toEqual(attemptEvidence.decision.evidence);
        const savedRows = yield* runScoped(runtime, scope, (transaction) =>
          transaction
            .select()
            .from(commitmentConfirmations)
            .where(eq(commitmentConfirmations.commitmentConfirmationId, issued.confirmationRef.resourceId)),
        );
        expect(savedRows).toHaveLength(1);
        expect(savedRows[0]?.constituentJson).toEqual(component);
        expect(savedRows[0]?.decisionEvidenceJson).toEqual(freshComponentRef);
      }).pipe(Effect.provide(TestClock.layer()));

      const wrongScope = { ...scope, tenantId: foreignTenantId };
      const wrongScopeEvidence = yield* runRepositoryScoped(runtime, wrongScope, (transaction) =>
        Effect.result(
          assortmentDecisionEvidenceRepositoryForScope(transaction, wrongScope).resolve(evidenceReference.evidenceRef),
        ),
      );
      expect(Result.isFailure(wrongScopeEvidence)).toBe(true);

      const replayed = yield* runRepositoryScoped(runtime, scope, (transaction) =>
        assortmentCommitmentConfirmationRepositoryForScope(transaction, scope).persist(
          payload,
          Schema.decodeUnknownSync(AssortmentCommitmentConfirmationResultSchema)({
            ...confirmation,
            confirmationRef: ref('commerce.assortment', 'commerce.assortment.commitment-confirmation', randomUUID()),
            expiresAt: '2026-09-24T10:00:20.000Z',
            issuedAt: '2026-09-24T10:00:00.000Z',
          }),
          scope,
          metadata,
        ),
      );
      expect(replayed).toEqual(confirmation);

      const changedActor = yield* Effect.flip(
        runRepositoryScoped(runtime, scope, (transaction) =>
          assortmentCommitmentConfirmationRepositoryForScope(transaction, scope).persist(payload, confirmation, scope, {
            ...metadata,
            actorPrincipalId: randomUUID(),
          }),
        ),
      );
      expect(Schema.is(AssortmentCommitmentConfirmationInvalid)(changedActor)).toBe(true);

      const changedPayload = Schema.decodeUnknownSync(AssortmentCommitmentConfirmationPayloadSchema)({
        ...payload,
        prospectivePurchaseMeaningRef: ref(
          'example.consumer',
          'example.consumer.prospective-purchase-meaning',
          'meaning-2',
        ),
      });
      const changedPayloadResult = Schema.decodeUnknownSync(AssortmentCommitmentConfirmationResultSchema)({
        ...changedPayload,
        confirmationRef: ref('commerce.assortment', 'commerce.assortment.commitment-confirmation', randomUUID()),
        expiresAt: '2026-09-24T10:00:30.000Z',
        issuedAt: '2026-09-24T10:00:00.000Z',
      });
      const changedPayloadError = yield* Effect.flip(
        runRepositoryScoped(runtime, scope, (transaction) =>
          assortmentCommitmentConfirmationRepositoryForScope(transaction, scope).persist(
            changedPayload,
            changedPayloadResult,
            scope,
            metadata,
          ),
        ),
      );
      expect(Schema.is(AssortmentCommitmentConfirmationInvalid)(changedPayloadError)).toBe(true);

      const visibleRows = yield* runScoped(runtime, scope, (transaction) =>
        transaction
          .select()
          .from(commitmentConfirmations)
          .where(eq(commitmentConfirmations.commitmentConfirmationId, confirmation.confirmationRef.resourceId)),
      );
      expect(visibleRows).toHaveLength(1);

      const wrongTenantScope = { ...scope, tenantId: foreignTenantId };
      const wrongTenantRows = yield* runScoped(runtime, wrongTenantScope, (transaction) =>
        transaction
          .select()
          .from(commitmentConfirmations)
          .where(eq(commitmentConfirmations.commitmentConfirmationId, confirmation.confirmationRef.resourceId)),
      );
      expect(wrongTenantRows).toEqual([]);

      const wrongLegalEntityScope = { ...scope, legalEntityId: foreignLegalEntityId };
      const wrongLegalEntityRows = yield* runScoped(runtime, wrongLegalEntityScope, (transaction) =>
        transaction
          .select()
          .from(commitmentConfirmations)
          .where(eq(commitmentConfirmations.commitmentConfirmationId, confirmation.confirmationRef.resourceId)),
      );
      expect(wrongLegalEntityRows).toEqual([]);

      const updateExit = yield* Effect.exit(
        runScoped(runtime, scope, (transaction) =>
          transaction.execute(
            sql`update assortment.assortment_commitment_confirmations set recorded_at = recorded_at where commitment_confirmation_id = ${confirmation.confirmationRef.resourceId}::uuid`,
            'objects',
          ),
        ),
      );
      expect(Exit.isFailure(updateExit)).toBe(true);

      const deleteExit = yield* Effect.exit(
        runScoped(runtime, scope, (transaction) =>
          transaction.execute(
            sql`delete from assortment.assortment_commitment_confirmations where commitment_confirmation_id = ${confirmation.confirmationRef.resourceId}::uuid`,
            'objects',
          ),
        ),
      );
      expect(Exit.isFailure(deleteExit)).toBe(true);

      const immutableRows = yield* runScoped(runtime, scope, (transaction) =>
        transaction
          .select()
          .from(commitmentConfirmations)
          .where(eq(commitmentConfirmations.commitmentConfirmationId, confirmation.confirmationRef.resourceId)),
      );
      expect(immutableRows).toEqual(visibleRows);
    }),
  ),
);
