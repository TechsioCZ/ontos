import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import {
  CreateApplicabilityBindingPayloadSchema,
  CreateRulePayloadSchema,
  CreateRuleRevisionPayloadSchema,
  EndApplicabilityBindingPayloadSchema,
  ReplaceApplicabilityBindingPayloadSchema,
  RetireRulePayloadSchema,
} from '../../shared/actions/policy-administration.ts';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import {
  assortmentRelations,
  applicabilityBindingEndFacts,
  applicabilityBindings,
  ruleRetirementFacts,
  ruleRevisions,
  stableRules,
} from '../../src/database/schema.ts';
import {
  assortmentMeaningFingerprint,
  assortmentPolicyPersistenceForScope,
} from '../../src/services/policy-administration.service.ts';

const tenantId = randomUUID();
const legalEntityId = randomUUID();
const principalId = randomUUID();
const channelRef = {
  moduleId: 'commerce.channel',
  resourceId: 'channel-acceptance',
  resourceType: 'commerce.channel.channel',
  tenantId,
} as const;
const sellingLegalEntityRef = {
  moduleId: 'party.registry',
  resourceId: legalEntityId,
  resourceType: 'party.registry.legal-entity',
  tenantId,
} as const;
const scope = {
  authContextRef: `better-auth-session:${randomUUID()}`,
  authMethod: 'session',
  correlationId: randomUUID(),
  legalEntityId,
  principalId,
  tenantId,
} satisfies OperationalScope;

type CoreTestDatabase = TestDatabaseFromClient<typeof coreRelations>;

const instant = (value: string) => Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(value);
const at = instant('2030-01-01T00:00:00.000Z');
const later = instant('2030-02-01T00:00:00.000Z');

const runScoped = <Value>(
  database: CoreTestDatabase,
  operation: (transaction: ScopedTransactionExecutor) => Effect.Effect<Value, unknown>,
) =>
  database.transaction((transaction) =>
    Effect.gen(function* runOwnerScopedOperation() {
      const scopedTransaction = yield* installOperationalScope(transaction, scope);
      return yield* operation(scopedTransaction);
    }),
  );

const InitialRuleRevisionIdSchema = Schema.String.pipe(Schema.brand('AssortmentInitialRuleRevisionId'));
const StableRuleIdSchema = Schema.String.pipe(Schema.brand('AssortmentStableRuleId'));
const RuleRevisionIdSchema = Schema.String.pipe(Schema.brand('AssortmentRuleRevisionId'));
const BindingIdSchema = Schema.String.pipe(Schema.brand('AssortmentBindingId'));
const CreatedBindingIdSchema = Schema.String.pipe(Schema.brand('AssortmentCreatedBindingId'));
const EndedBindingIdSchema = Schema.String.pipe(Schema.brand('AssortmentEndedBindingId'));

const CreateRulePersistenceSuccessSchema = Schema.Struct({
  created: Schema.Boolean,
  initialRevisionNumber: Schema.Number,
  initialRuleRevisionId: InitialRuleRevisionIdSchema,
  meaningFingerprint: Schema.String,
  stableRuleId: StableRuleIdSchema,
});
const CreateRuleRevisionPersistenceSuccessSchema = Schema.Struct({
  created: Schema.Boolean,
  meaningFingerprint: Schema.String,
  revisionNumber: Schema.Number,
  ruleRevisionId: RuleRevisionIdSchema,
});
const BindingPersistenceSuccessSchema = Schema.Struct({
  bindingId: BindingIdSchema,
  created: Schema.Boolean,
});
const ReplacementPersistenceSuccessSchema = Schema.Struct({
  createdBindingId: CreatedBindingIdSchema,
  endedBindingId: EndedBindingIdSchema,
  replaced: Schema.Boolean,
});
const EndPersistenceSuccessSchema = Schema.Struct({ ended: Schema.Boolean });
const RetirementPersistenceSuccessSchema = Schema.Struct({ retired: Schema.Boolean });

const bindingBasisFingerprint = (row: typeof applicabilityBindings.$inferSelect): string =>
  assortmentMeaningFingerprint({
    bindingKind: row.bindingKind,
    channelResourceId: row.channelResourceId,
    customerGroupResourceId: row.customerGroupResourceId,
    effectiveFrom: DateTime.formatIso(DateTime.makeUnsafe(row.effectiveFrom)),
    marketResourceId: row.marketResourceId,
    ruleRevisionId: row.ruleRevisionId,
    storefrontResourceId: row.storefrontResourceId,
    subjectKind: row.subjectKind,
    subjectResourceId: row.subjectResourceId,
  });

it.live(
  'persists the complete Assortment policy lifecycle with replay, stale-basis, conflict, and atomicity proof',
  () =>
    Effect.scoped(
      Effect.gen(function* policyAdministrationPersistenceAcceptance() {
        const { admin: adminClient } = yield* testDatabaseClients;
        const admin = yield* makeTestDatabaseFromClient(adminClient, assortmentRelations);
        // The owner service is exercised through an administrative test connection because
        // this lane verifies the owner transaction's persistence semantics. Runtime-role
        // capabilities remain covered by the owner database-security verifier.
        const ownerDatabase = yield* makeTestDatabaseFromClient(adminClient, coreRelations);

        const cleanup = () =>
          admin.transaction((transaction) =>
            Effect.gen(function* cleanupOwnerRows() {
              yield* transaction.execute(sql`set local session_replication_role = 'replica'`, 'objects');
              yield* transaction
                .delete(applicabilityBindingEndFacts)
                .where(eq(applicabilityBindingEndFacts.tenantId, tenantId));
              yield* transaction.delete(applicabilityBindings).where(eq(applicabilityBindings.tenantId, tenantId));
              yield* transaction.delete(ruleRetirementFacts).where(eq(ruleRetirementFacts.tenantId, tenantId));
              yield* transaction.delete(ruleRevisions).where(eq(ruleRevisions.tenantId, tenantId));
              yield* transaction.delete(stableRules).where(eq(stableRules.tenantId, tenantId));
            }),
          );

        yield* cleanup();
        yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));

        const stableCode = `acceptance.${tenantId}`;
        const createRuleInput = Schema.decodeUnknownSync(CreateRulePayloadSchema)({
          effect: 'ALLOW',
          provenanceRef: 'acceptance:create-rule',
          purpose: 'PURCHASE',
          reason: 'Create the acceptance policy rule',
          selector: {
            kind: 'PRODUCT',
            productRef: {
              moduleId: 'commerce.catalog',
              resourceId: 'catalog-product-1',
              resourceType: 'catalog.product',
              tenantId,
            },
          },
          stableCode,
        });
        const createInvocation = randomUUID();
        const createdRule = Schema.decodeUnknownSync(CreateRulePersistenceSuccessSchema)(
          yield* runScoped(ownerDatabase, (transaction) =>
            assortmentPolicyPersistenceForScope(transaction, scope).createRule({
              ...createRuleInput,
              actionInvocationId: createInvocation,
              actorPrincipalId: principalId,
              tenantId,
            }),
          ),
        );
        expect(createdRule.created).toBe(true);
        expect(createdRule.initialRevisionNumber).toBe(1);
        const storedSelectorOwner = yield* runScoped(ownerDatabase, (transaction) =>
          transaction
            .select({ ownerModuleId: ruleRevisions.selectorTargetOwnerModuleId })
            .from(ruleRevisions)
            .where(eq(ruleRevisions.ruleRevisionId, createdRule.initialRuleRevisionId))
            .limit(1),
        );
        expect(storedSelectorOwner[0]?.ownerModuleId).toBe('commerce.catalog');

        const replayedRule = Schema.decodeUnknownSync(CreateRulePersistenceSuccessSchema)(
          yield* runScoped(ownerDatabase, (transaction) =>
            assortmentPolicyPersistenceForScope(transaction, scope).createRule({
              ...createRuleInput,
              actionInvocationId: createInvocation,
              actorPrincipalId: principalId,
              tenantId,
            }),
          ),
        );
        expect(replayedRule.created).toBe(false);
        expect(replayedRule.stableRuleId).toBe(createdRule.stableRuleId);

        const businessConflict = yield* runScoped(ownerDatabase, (transaction) =>
          assortmentPolicyPersistenceForScope(transaction, scope).createRule({
            ...createRuleInput,
            actionInvocationId: randomUUID(),
            actorPrincipalId: principalId,
            tenantId,
          }),
        );
        expect(businessConflict).toMatchObject({ conflict: 'BUSINESS_CODE', kind: 'conflict' });

        const stableRuleRef = {
          moduleId: 'commerce.assortment',
          resourceId: createdRule.stableRuleId,
          resourceType: 'commerce.assortment.stable-rule',
          tenantId,
        } as const;
        const revisionTwoInput = Schema.decodeUnknownSync(CreateRuleRevisionPayloadSchema)({
          effect: 'DENY',
          expectedLatestRevision: 1,
          provenanceRef: 'acceptance:create-revision',
          purpose: 'PURCHASE',
          reason: 'Create the second acceptance rule revision',
          selector: { kind: 'ALL' },
          stableRuleRef,
        });
        const revisionInvocation = randomUUID();
        const revisionTwo = Schema.decodeUnknownSync(CreateRuleRevisionPersistenceSuccessSchema)(
          yield* runScoped(ownerDatabase, (transaction) =>
            assortmentPolicyPersistenceForScope(transaction, scope).createRuleRevision({
              ...revisionTwoInput,
              actionInvocationId: revisionInvocation,
              actorPrincipalId: principalId,
              tenantId,
            }),
          ),
        );
        expect(revisionTwo.created).toBe(true);
        expect(revisionTwo.revisionNumber).toBe(2);

        const replayedRevision = Schema.decodeUnknownSync(CreateRuleRevisionPersistenceSuccessSchema)(
          yield* runScoped(ownerDatabase, (transaction) =>
            assortmentPolicyPersistenceForScope(transaction, scope).createRuleRevision({
              ...revisionTwoInput,
              actionInvocationId: revisionInvocation,
              actorPrincipalId: principalId,
              tenantId,
            }),
          ),
        );
        expect(replayedRevision.created).toBe(false);
        expect(replayedRevision.ruleRevisionId).toBe(revisionTwo.ruleRevisionId);

        const revisionInvocationConflict = yield* runScoped(ownerDatabase, (transaction) =>
          assortmentPolicyPersistenceForScope(transaction, scope).createRuleRevision({
            ...revisionTwoInput,
            actionInvocationId: revisionInvocation,
            actorPrincipalId: principalId,
            reason: 'Reuse the revision invocation with a different payload',
            tenantId,
          }),
        );
        expect(revisionInvocationConflict).toEqual({
          conflict: 'IDEMPOTENCY_REUSED',
          kind: 'conflict',
        });

        const staleRevision = yield* runScoped(ownerDatabase, (transaction) =>
          assortmentPolicyPersistenceForScope(transaction, scope).createRuleRevision({
            ...revisionTwoInput,
            actionInvocationId: randomUUID(),
            actorPrincipalId: principalId,
            expectedLatestRevision: 1,
            tenantId,
          }),
        );
        expect(staleRevision).toEqual({ kind: 'stale_basis' });

        const ruleRevisionRef = {
          ownerModuleId: 'commerce.assortment',
          revision: '2',
          sourceRef: {
            moduleId: 'commerce.assortment',
            resourceId: revisionTwo.ruleRevisionId,
            resourceType: 'commerce.assortment.rule-revision',
            tenantId,
          },
        } as const;
        const createBindingInput = Schema.decodeUnknownSync(CreateApplicabilityBindingPayloadSchema)({
          audience: { kind: 'SHARED' },
          commercialScope: { channelRef, sellingLegalEntityRef },
          effectiveFrom: DateTime.formatIso(at),
          provenanceRef: 'acceptance:create-binding',
          reason: 'Create the acceptance binding',
          ruleRevisionRef,
        });
        const bindingInvocation = randomUUID();
        const bindingResult = Schema.decodeUnknownSync(BindingPersistenceSuccessSchema)(
          yield* runScoped(ownerDatabase, (transaction) =>
            assortmentPolicyPersistenceForScope(transaction, scope).createBinding({
              ...createBindingInput,
              actionInvocationId: bindingInvocation,
              actorPrincipalId: principalId,
              legalEntityId,
              tenantId,
            }),
          ),
        );
        expect(bindingResult.created).toBe(true);

        const replayedBinding = Schema.decodeUnknownSync(BindingPersistenceSuccessSchema)(
          yield* runScoped(ownerDatabase, (transaction) =>
            assortmentPolicyPersistenceForScope(transaction, scope).createBinding({
              ...createBindingInput,
              actionInvocationId: bindingInvocation,
              actorPrincipalId: principalId,
              legalEntityId,
              tenantId,
            }),
          ),
        );
        expect(replayedBinding.created).toBe(false);
        expect(replayedBinding.bindingId).toBe(bindingResult.bindingId);

        const bindingInvocationConflict = yield* runScoped(ownerDatabase, (transaction) =>
          assortmentPolicyPersistenceForScope(transaction, scope).createBinding({
            ...createBindingInput,
            actionInvocationId: bindingInvocation,
            actorPrincipalId: principalId,
            legalEntityId,
            reason: 'Reuse the binding invocation with a different payload',
            tenantId,
          }),
        );
        expect(bindingInvocationConflict).toEqual({
          conflict: 'IDEMPOTENCY_REUSED',
          kind: 'conflict',
        });

        const oldBindingId = bindingResult.bindingId;
        const oldBindingRef = {
          moduleId: 'commerce.assortment',
          resourceId: oldBindingId,
          resourceType: 'commerce.assortment.applicability-binding',
          tenantId,
        } as const;
        const [oldBinding] = yield* admin
          .select()
          .from(applicabilityBindings)
          .where(
            and(
              eq(applicabilityBindings.tenantId, tenantId),
              eq(applicabilityBindings.applicabilityBindingId, oldBindingId),
            ),
          );
        if (oldBinding === undefined) {
          throw new Error('Expected the created binding row');
        }
        const oldBindingBasis = bindingBasisFingerprint(oldBinding);

        const staleEndInput = Schema.decodeUnknownSync(EndApplicabilityBindingPayloadSchema)({
          applicabilityBindingRef: oldBindingRef,
          effectiveAt: DateTime.formatIso(at),
          expectedBasisFingerprint: '0'.repeat(64),
          provenanceRef: 'acceptance:stale-end',
          reason: 'Reject a stale end basis',
        });
        const staleEnd = yield* runScoped(ownerDatabase, (transaction) =>
          assortmentPolicyPersistenceForScope(transaction, scope).endBinding({
            ...staleEndInput,
            actionInvocationId: randomUUID(),
            actorPrincipalId: principalId,
            legalEntityId,
            tenantId,
          }),
        );
        expect(staleEnd).toEqual({ kind: 'stale_basis' });

        const validReplacementForAtomicity = Schema.decodeUnknownSync(ReplaceApplicabilityBindingPayloadSchema)({
          effectiveAt: DateTime.formatIso(later),
          existingBindingRef: oldBindingRef,
          expectedExistingBasisFingerprint: oldBindingBasis,
          proposedAudience: { kind: 'SHARED' },
          proposedCommercialScope: { channelRef, sellingLegalEntityRef },
          proposedEffectiveFrom: DateTime.formatIso(later),
          proposedRuleRevisionRef: ruleRevisionRef,
          provenanceRef: 'acceptance:atomic-failure',
          reason: 'Force the replacement insert to fail after ending the old binding',
        });
        // Inject a persistence-level fault below the Action validation boundary so the
        // database channel trim constraint rejects only the replacement insert.
        const invalidChannelRef = { ...validReplacementForAtomicity.proposedCommercialScope.channelRef };
        Object.defineProperty(invalidChannelRef, 'resourceId', { value: ' channel-with-padding ' });
        const invalidWithUntrimmedChannel = {
          ...validReplacementForAtomicity,
          proposedCommercialScope: {
            ...validReplacementForAtomicity.proposedCommercialScope,
            channelRef: invalidChannelRef,
          },
        };
        const failedReplacement = yield* Effect.exit(
          runScoped(ownerDatabase, (transaction) =>
            assortmentPolicyPersistenceForScope(transaction, scope).replaceBinding({
              ...invalidWithUntrimmedChannel,
              actionInvocationId: randomUUID(),
              actorPrincipalId: principalId,
              legalEntityId,
              tenantId,
            }),
          ),
        );
        expect(Exit.isFailure(failedReplacement)).toBe(true);
        const [oldBindingEndAfterFailure] = yield* admin
          .select()
          .from(applicabilityBindingEndFacts)
          .where(
            and(
              eq(applicabilityBindingEndFacts.tenantId, tenantId),
              eq(applicabilityBindingEndFacts.applicabilityBindingId, oldBindingId),
            ),
          );
        expect(oldBindingEndAfterFailure).toBeUndefined();

        const replacementInput = Schema.decodeUnknownSync(ReplaceApplicabilityBindingPayloadSchema)({
          effectiveAt: DateTime.formatIso(later),
          existingBindingRef: oldBindingRef,
          expectedExistingBasisFingerprint: oldBindingBasis,
          proposedAudience: { kind: 'SHARED' },
          proposedCommercialScope: { channelRef, sellingLegalEntityRef },
          proposedEffectiveFrom: DateTime.formatIso(later),
          proposedRuleRevisionRef: ruleRevisionRef,
          provenanceRef: 'acceptance:replace-binding',
          reason: 'Replace the acceptance binding atomically',
        });
        const replacementInvocation = randomUUID();
        const replacement = Schema.decodeUnknownSync(ReplacementPersistenceSuccessSchema)(
          yield* runScoped(ownerDatabase, (transaction) =>
            assortmentPolicyPersistenceForScope(transaction, scope).replaceBinding({
              ...replacementInput,
              actionInvocationId: replacementInvocation,
              actorPrincipalId: principalId,
              legalEntityId,
              tenantId,
            }),
          ),
        );
        expect(replacement.replaced).toBe(true);
        expect(replacement.endedBindingId).toBe(oldBindingId);

        const replacementReplay = Schema.decodeUnknownSync(ReplacementPersistenceSuccessSchema)(
          yield* runScoped(ownerDatabase, (transaction) =>
            assortmentPolicyPersistenceForScope(transaction, scope).replaceBinding({
              ...replacementInput,
              actionInvocationId: replacementInvocation,
              actorPrincipalId: principalId,
              legalEntityId,
              tenantId,
            }),
          ),
        );
        expect(replacementReplay.replaced).toBe(false);
        expect(replacementReplay.createdBindingId).toBe(replacement.createdBindingId);

        const replacementBindingRef = {
          ...oldBindingRef,
          resourceId: replacement.createdBindingId,
        } as const;
        const replacementBindingRows = yield* admin
          .select()
          .from(applicabilityBindings)
          .where(
            and(
              eq(applicabilityBindings.tenantId, tenantId),
              eq(applicabilityBindings.applicabilityBindingId, replacement.createdBindingId),
            ),
          );
        const [replacementBinding] = replacementBindingRows;
        if (replacementBinding === undefined) {
          throw new Error('Expected the replacement binding row');
        }
        const endInput = Schema.decodeUnknownSync(EndApplicabilityBindingPayloadSchema)({
          applicabilityBindingRef: replacementBindingRef,
          effectiveAt: DateTime.formatIso(later),
          expectedBasisFingerprint: bindingBasisFingerprint(replacementBinding),
          provenanceRef: 'acceptance:end-binding',
          reason: 'End the replacement binding',
        });
        const endInvocation = randomUUID();
        const ended = Schema.decodeUnknownSync(EndPersistenceSuccessSchema)(
          yield* runScoped(ownerDatabase, (transaction) =>
            assortmentPolicyPersistenceForScope(transaction, scope).endBinding({
              ...endInput,
              actionInvocationId: endInvocation,
              actorPrincipalId: principalId,
              legalEntityId,
              tenantId,
            }),
          ),
        );
        expect(ended.ended).toBe(true);
        const endedReplay = Schema.decodeUnknownSync(EndPersistenceSuccessSchema)(
          yield* runScoped(ownerDatabase, (transaction) =>
            assortmentPolicyPersistenceForScope(transaction, scope).endBinding({
              ...endInput,
              actionInvocationId: endInvocation,
              actorPrincipalId: principalId,
              legalEntityId,
              tenantId,
            }),
          ),
        );
        expect(endedReplay.ended).toBe(false);

        const retireInput = Schema.decodeUnknownSync(RetireRulePayloadSchema)({
          effectiveAt: DateTime.formatIso(later),
          expectedBasisFingerprint: assortmentMeaningFingerprint({
            latestRevisionId: revisionTwo.ruleRevisionId,
            latestRevisionNumber: revisionTwo.revisionNumber,
            retired: false,
            stableCode,
          }),
          provenanceRef: 'acceptance:retire-rule',
          reason: 'Retire the acceptance rule',
          stableRuleRef,
        });
        const retireInvocation = randomUUID();
        const retired = Schema.decodeUnknownSync(RetirementPersistenceSuccessSchema)(
          yield* runScoped(ownerDatabase, (transaction) =>
            assortmentPolicyPersistenceForScope(transaction, scope).retireRule({
              ...retireInput,
              actionInvocationId: retireInvocation,
              actorPrincipalId: principalId,
              tenantId,
            }),
          ),
        );
        expect(retired.retired).toBe(true);
        const retiredReplay = Schema.decodeUnknownSync(RetirementPersistenceSuccessSchema)(
          yield* runScoped(ownerDatabase, (transaction) =>
            assortmentPolicyPersistenceForScope(transaction, scope).retireRule({
              ...retireInput,
              actionInvocationId: retireInvocation,
              actorPrincipalId: principalId,
              tenantId,
            }),
          ),
        );
        expect(retiredReplay.retired).toBe(false);

        const [stableCount] = yield* admin
          .select({ count: sql<number>`count(*)::integer` })
          .from(stableRules)
          .where(eq(stableRules.tenantId, tenantId));
        const [revisionCount] = yield* admin
          .select({ count: sql<number>`count(*)::integer` })
          .from(ruleRevisions)
          .where(eq(ruleRevisions.tenantId, tenantId));
        const [bindingCount] = yield* admin
          .select({ count: sql<number>`count(*)::integer` })
          .from(applicabilityBindings)
          .where(eq(applicabilityBindings.tenantId, tenantId));
        const [endCount] = yield* admin
          .select({ count: sql<number>`count(*)::integer` })
          .from(applicabilityBindingEndFacts)
          .where(eq(applicabilityBindingEndFacts.tenantId, tenantId));
        const [retirementCount] = yield* admin
          .select({ count: sql<number>`count(*)::integer` })
          .from(ruleRetirementFacts)
          .where(eq(ruleRetirementFacts.tenantId, tenantId));
        expect(stableCount?.count).toBe(1);
        expect(revisionCount?.count).toBe(2);
        expect(bindingCount?.count).toBe(2);
        expect(endCount?.count).toBe(2);
        expect(retirementCount?.count).toBe(1);
      }),
    ),
);
