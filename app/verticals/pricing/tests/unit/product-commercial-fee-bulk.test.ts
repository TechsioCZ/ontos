import { getVerticalRuntimeActions } from '@app/core-runtime';
import { PricingCommercialFeeProductTargetSnapshotSchema } from '@app/pricing-contracts/domain/commercial-fee';
import { DateTime, Effect, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  ManageProductCommercialFeesBulkPayloadSchema,
  ManageProductCommercialFeesBulkResultSchema,
} from '../../shared/actions/manage-product-commercial-fees-bulk.ts';
import type {
  ManageProductCommercialFeeOperation,
  ManageProductCommercialFeesBulkTargetIntent,
} from '../../shared/actions/manage-product-commercial-fees-bulk.ts';
import {
  applyProductCommercialFeeBulkManagement,
  manageProductCommercialFeesBulkAction,
} from '../../src/actions/manage-product-commercial-fees-bulk.action.ts';
import type { ProductCommercialFeeBulkActionServices } from '../../src/actions/manage-product-commercial-fees-bulk.action.ts';
import { productCommercialFeeBulkSnapshotMatchesCurrentOwnerRead } from '../../src/integrations/product-commercial-fee-bulk-catalog-snapshot.ts';
import {
  makeProductCommercialFeeBulkCommandPort,
  makeProductCommercialFeeBulkService,
} from '../../src/services/product-commercial-fee-bulk.service.ts';
import type {
  ProductCommercialFeeBulkCommand,
  ProductCommercialFeeBulkCommandDependencies,
  ProductCommercialFeeBulkCommandPort,
  ProductCommercialFeeBulkOwnerOutcome,
} from '../../src/services/product-commercial-fee-bulk.service.ts';
import {
  CommercialFeeActionResultLookupOutcomeSchema,
  CommercialFeePersistenceUnavailable,
} from '../../src/services/commercial-fee-persistence.service.ts';
import { pricingManifest } from '../../vertical.manifest.ts';
import { pricingRegistration } from '../../vertical.registration.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const capturedAt = '2026-09-27T10:00:00.000Z';
const catalogRef = <const ResourceType extends string>(resourceId: string, resourceType: ResourceType) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});
const productRef = catalogRef('33333333-3333-4333-8333-333333333333', 'commerce.catalog.product');
const variantRefs = [
  catalogRef('44444444-4444-4444-8444-444444444444', 'commerce.catalog.variant'),
  catalogRef('55555555-5555-4555-8555-555555555555', 'commerce.catalog.variant'),
] as const;
const targetFor = (variantRef: (typeof variantRefs)[number]) => ({ productRef, variantRef });
const catalogEvidenceFor = (target: ReturnType<typeof targetFor>) => ({
  assessedAt: capturedAt,
  basis: [
    { role: 'PRODUCT' as const, source: { resourceRef: target.productRef, revision: 4 } },
    { role: 'VARIANT' as const, source: { resourceRef: target.variantRef, revision: 7 } },
    {
      provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
      role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
      source: { resourceRef: target.productRef, revision: 4 },
    },
  ],
  membership: {
    attestationId: `catalog-membership:${target.variantRef.resourceId}`,
    observedAt: capturedAt,
    productRef,
    source: 'CATALOG_OWNER_CURRENT_READ' as const,
    variant: { resourceRef: target.variantRef, revision: 7 },
  },
  purpose: 'PRICING' as const,
  selection: target,
  status: 'VALID' as const,
});
const snapshot = Schema.decodeSync(PricingCommercialFeeProductTargetSnapshotSchema)({
  capturedAt,
  catalogOwnerRevision: 'catalog-product-active-variants:797-fees',
  productRef,
  snapshotId: '1'.repeat(64),
  targets: variantRefs.map((variantRef) => {
    const target = targetFor(variantRef);
    return {
      catalogEvidence: catalogEvidenceFor(target),
      target,
      targetId: variantRef.resourceId,
    };
  }),
  targetSetCompleteness: {
    observedAt: capturedAt,
    ownerRevision: 'catalog-product-active-variants:797-fees',
    scope: { kind: 'EXACT_PREDICATE', predicateRef: 'catalog-product:active-variants' },
  },
});
const commercialScope = { channelId: 'B2B' as const, marketId: 'cz-launch', sellingLegalEntityId: legalEntityId };
const targetIntents = snapshot.targets.map(
  ({ target, targetId }, index): ManageProductCommercialFeesBulkTargetIntent => {
    const catalogTargetEvidence = {
      capturedAt,
      catalogOwnerRevision: snapshot.catalogOwnerRevision,
      productRef,
      snapshotId: snapshot.snapshotId,
      targetId,
      variantRef: target.variantRef,
    };
    return {
      catalogTargetEvidence,
      identity: { snapshotId: snapshot.snapshotId, target, targetId },
      intentId: `commercial-fee-intent:${index + 1}`,
      operation: {
        kind: 'DEFINE_COMMERCIAL_FEE',
        payload: {
          catalogTargetEvidence,
          configuredAmount: { amount: `${20 + index}`, currencyCode: 'CZK' },
          effectivePeriod: { effectiveFrom: '2026-10-01T00:00:00.000Z', effectiveTo: null },
          identityKey: {
            calculationBasis: { kind: 'FIXED_PER_LINE' },
            commercialScope,
            currencyCode: 'CZK',
            family: 'RECYCLING_FEE',
            monetaryBoundary: 'PRE_TAX',
            target: { variantRef: target.variantRef },
          },
          reason: 'Apply exact Product snapshot Commercial Fee',
        },
      },
      targetCorrelationRef: `commercial-fee-correlation:${index + 1}`,
    };
  },
);
const payload = Schema.decodeSync(ManageProductCommercialFeesBulkPayloadSchema)({ snapshot, targetIntents });
const [firstIntent, secondIntent] = targetIntents;
if (firstIntent === undefined || secondIntent === undefined) {
  throw new Error('Commercial Fee bulk fixture requires exactly two target intents');
}
const trusted = {
  actionInvocationId: '66666666-6666-4666-8666-666666666666',
  principalContext: {
    authBindingId: '77777777-7777-4777-8777-777777777777',
    authContextRef: 'session:commercial-fee-bulk',
    authMethod: 'session' as const,
    correlationId: 'commercial-fee-bulk-request',
    legalEntityId,
    principalId: '88888888-8888-4888-8888-888888888888',
    tenantId,
  },
  requestCorrelationId: 'commercial-fee-bulk-request',
  trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-27T10:05:00.000Z')),
};
const canonicalFor = (index: number) => ({
  feeRef: {
    moduleId: 'commerce.pricing' as const,
    resourceId: index === 0 ? '99999999-9999-4999-8999-999999999999' : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    resourceType: 'commerce.pricing.commercial-fee' as const,
    tenantId,
  },
  revisionId: index === 0 ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
});
const supportRootRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  resourceType: 'commerce.pricing.currency-support' as const,
  tenantId,
};
const supportRevisionRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  resourceType: 'commerce.pricing.currency-support-revision' as const,
  supportRootId: supportRootRef.resourceId,
  tenantId,
};
const currentCurrencySupport = {
  currentnessEvidence: {
    evaluatedAt: capturedAt,
    evaluationMode: 'CURRENT_WITH_REVALIDATION' as const,
    observedAt: capturedAt,
    revalidatedAt: capturedAt,
    scheduleRevision: 1,
    supportRevisionRef,
    supportRootRef,
  },
  effectivePeriod: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null },
  generation: 1,
  observedAt: capturedAt,
  pricingRevision: 'pricing-currency-support:797-fees',
  scheduleRevision: 1,
  supportedCurrencies: ['CZK'] as const,
  supportRevisionRef,
  supportRootRef,
};
const successfulActionResult = {
  outcomes: targetIntents.map((intent, index) => ({
    canonical: canonicalFor(index),
    identity: intent.identity,
    intentId: intent.intentId,
    outcome: 'CREATED' as const,
    resolvedBy: 'OWNER_COMMAND' as const,
    targetCorrelationRef: intent.targetCorrelationRef,
  })),
  snapshotId: snapshot.snapshotId,
};

const makeCommandDependencies = (
  services: Pick<
    ProductCommercialFeeBulkCommandDependencies['defineServices'],
    'define' | 'loadCurrencySupport' | 'validateCatalogTarget'
  > &
    Pick<ProductCommercialFeeBulkCommandDependencies['reviseServices'], 'revise'> & {
      readonly lookupResult?: ProductCommercialFeeBulkCommandDependencies['persistence']['lookupResult'];
    },
): ProductCommercialFeeBulkCommandDependencies => {
  const persistence = {
    define: services.define,
    lookupResult:
      services.lookupResult ??
      (({ actionInvocationId }: { readonly actionInvocationId: string }) =>
        Effect.succeed(
          Schema.decodeSync(CommercialFeeActionResultLookupOutcomeSchema)({
            actionInvocationId,
            outcome: 'COMMERCIAL_FEE_ACTION_RESULT_ABSENT',
          }),
        )),
    readCurrent: () => Effect.die('unused Commercial Fee Current read'),
    readCurrentSet: () => Effect.die('unused Commercial Fee set read'),
    readSchedule: () => Effect.die('unused Commercial Fee schedule read'),
    revise: services.revise,
    verifySetGeneration: () => Effect.die('unused Commercial Fee generation verification'),
  } satisfies ProductCommercialFeeBulkCommandDependencies['persistence'];
  return {
    defineServices: {
      define: persistence.define,
      loadCurrencySupport: services.loadCurrencySupport,
      validateCatalogTarget: services.validateCatalogTarget,
    },
    persistence,
    reviseServices: {
      loadCurrencySupport: services.loadCurrencySupport,
      revise: persistence.revise,
      validateCatalogTarget: services.validateCatalogTarget,
    },
  };
};

describe('Product Commercial Fee bulk management (#797)', () => {
  it('publishes the generated fail-closed Action and exact fixed-snapshot contract', () => {
    expect(manageProductCommercialFeesBulkAction.descriptor).toMatchObject({
      actionKey: 'commerce.pricing.manage-product-commercial-fees-bulk',
      idempotency: 'required',
      legalEntityScope: 'required',
      owningModuleKey: 'commerce.pricing',
    });
    expect(pricingManifest.publicSurface.actions).toContain(manageProductCommercialFeesBulkAction);
    expect(getVerticalRuntimeActions(pricingRegistration)).toContain(manageProductCommercialFeesBulkAction);
    expect(Schema.is(ManageProductCommercialFeesBulkPayloadSchema)(payload)).toBe(true);

    const changedEvidence = {
      ...payload,
      targetIntents: payload.targetIntents.map((intent, index) =>
        index === 0
          ? {
              ...intent,
              catalogTargetEvidence: {
                ...intent.catalogTargetEvidence,
                catalogOwnerRevision: 'catalog-revision:changed',
              },
            }
          : intent,
      ),
    };
    expect(Schema.is(ManageProductCommercialFeesBulkPayloadSchema)(changedEvidence)).toBe(false);
  });

  it.effect('preserves snapshot order and returns independent granular owner outcomes', () =>
    Effect.gen(function* partialOutcomes() {
      const executed: string[] = [];
      const port: ProductCommercialFeeBulkCommandPort<ManageProductCommercialFeeOperation> = {
        executeAuthorizedCommercialFeeAction: (command) => {
          executed.push(command.identity.targetId);
          const index = targetIntents.findIndex(({ identity }) => identity.targetId === command.identity.targetId);
          return index === 0
            ? Effect.succeed({ canonical: canonicalFor(index), outcome: 'CREATED' as const })
            : Effect.succeed({ outcome: 'CONFLICT' as const, reasonCode: 'EXPECTED_CURRENT_MISMATCH' });
        },
        reconcileAuthorizedCommercialFeeAction: () => Effect.succeed({ status: 'ABSENT' as const }),
      };
      const result = yield* makeProductCommercialFeeBulkService(port).execute({ ...payload, trusted });

      expect(Schema.is(ManageProductCommercialFeesBulkResultSchema)(result)).toBe(true);
      expect(result.outcomes.map(({ outcome }) => outcome)).toEqual(['CREATED', 'CONFLICT']);
      expect(result.outcomes.map(({ identity }) => identity.targetId)).toEqual(
        snapshot.targets.map(({ targetId }) => targetId),
      );
      expect(executed).toEqual(snapshot.targets.map(({ targetId }) => targetId));
    }),
  );

  it.effect('reconciles once before command execution and preserves acknowledgement challenges', () =>
    Effect.gen(function* reconcileFirst() {
      const executed: string[] = [];
      const acknowledgementChallenge = {
        actingPrincipalId: trusted.principalContext.principalId,
        feeRef: canonicalFor(1).feeRef,
        fingerprint: 'a'.repeat(64),
        identityKey: secondIntent.operation.payload.identityKey,
        intendedConfiguredAmount: { amount: '21', currencyCode: 'CZK' as const },
        intendedEffectivePeriod: { effectiveFrom: '2026-10-01T00:00:00.000Z', effectiveTo: null },
        intent: 'VALUE_ONLY_CURRENT' as const,
        presentedFuture: [],
        scheduleRevision: 1,
        targetEffectivePeriod: { effectiveFrom: '2026-10-01T00:00:00.000Z', effectiveTo: null },
        targetRevisionId: canonicalFor(1).revisionId,
      };
      const port: ProductCommercialFeeBulkCommandPort<ManageProductCommercialFeeOperation> = {
        executeAuthorizedCommercialFeeAction: (command) => {
          executed.push(command.intentId);
          return Effect.succeed({ canonical: canonicalFor(0), outcome: 'CREATED' as const });
        },
        reconcileAuthorizedCommercialFeeAction: (command) =>
          command.intentId === firstIntent.intentId
            ? Effect.succeed({
                outcome: { canonical: canonicalFor(0), outcome: 'UNCHANGED' as const },
                status: 'RESOLVED' as const,
              })
            : Effect.succeed({
                outcome: {
                  acknowledgementChallenge,
                  outcome: 'REJECTED' as const,
                  reasonCode: 'COMMERCIAL_FEE_SCHEDULE_ACKNOWLEDGEMENT_REQUIRED',
                },
                status: 'RESOLVED' as const,
              }),
      };
      const result = yield* makeProductCommercialFeeBulkService(port).execute({ ...payload, trusted });

      expect(executed).toEqual([]);
      expect(result.outcomes.map(({ outcome }) => outcome)).toEqual(['UNCHANGED', 'REJECTED']);
      expect(result.outcomes[1]).toMatchObject({ acknowledgementChallenge, resolvedBy: 'OWNER_RECONCILIATION' });
      expect(Schema.is(ManageProductCommercialFeesBulkResultSchema)(result)).toBe(true);
    }),
  );

  it.effect(
    'bounds recovery to one lookup and one command while failing closed on unavailable or invalid owner results',
    () =>
      Effect.gen(function* boundedRecovery() {
        const reconciled: string[] = [];
        const executed: string[] = [];
        const port: ProductCommercialFeeBulkCommandPort<ManageProductCommercialFeeOperation> = {
          executeAuthorizedCommercialFeeAction: (command) => {
            executed.push(command.intentId);
            const mismatchedOwnerOutcome: ProductCommercialFeeBulkOwnerOutcome = {
              canonical: canonicalFor(1),
              outcome: 'RETIRED',
            };
            return Effect.succeed(mismatchedOwnerOutcome);
          },
          reconcileAuthorizedCommercialFeeAction: (command) => {
            reconciled.push(command.intentId);
            return command.intentId === firstIntent.intentId
              ? Effect.fail({ _tag: 'OwnerResultLookupUnavailable' as const })
              : Effect.succeed({ status: 'RETRY_ALLOWED' as const });
          },
        };
        const result = yield* makeProductCommercialFeeBulkService(port).execute({ ...payload, trusted });

        expect(reconciled).toEqual(targetIntents.map(({ intentId }) => intentId));
        expect(executed).toEqual([secondIntent.intentId]);
        expect(result.outcomes).toMatchObject([
          { outcome: 'INDETERMINATE', reasonCode: 'OwnerResultLookupUnavailable' },
          { outcome: 'INDETERMINATE', reasonCode: 'OwnerOutcomeOperationMismatch' },
        ]);
        expect(Schema.is(ManageProductCommercialFeesBulkResultSchema)(result)).toBe(true);
      }),
  );

  it.effect('reports an authorized command outage as indeterminate without a second command attempt', () =>
    Effect.gen(function* commandUnavailable() {
      const executed: string[] = [];
      const port: ProductCommercialFeeBulkCommandPort<ManageProductCommercialFeeOperation> = {
        executeAuthorizedCommercialFeeAction: (command) => {
          executed.push(command.intentId);
          return Effect.fail({ _tag: 'AuthorizedCommercialFeeCommandUnavailable' as const });
        },
        reconcileAuthorizedCommercialFeeAction: () => Effect.succeed({ status: 'RETRY_ALLOWED' as const }),
      };
      const result = yield* makeProductCommercialFeeBulkService(port).execute({ ...payload, trusted });

      expect(executed).toEqual(targetIntents.map(({ intentId }) => intentId));
      expect(result.outcomes).toMatchObject([
        {
          outcome: 'INDETERMINATE',
          reasonCode: 'AuthorizedCommercialFeeCommandUnavailable',
          resolvedBy: 'OWNER_COMMAND',
        },
        {
          outcome: 'INDETERMINATE',
          reasonCode: 'AuthorizedCommercialFeeCommandUnavailable',
          resolvedBy: 'OWNER_COMMAND',
        },
      ]);
    }),
  );

  it.effect('does not attach a replayed Commercial Fee result from a different fixed target', () =>
    Effect.gen(function* rejectMismatchedReplayTarget() {
      const dependencies = makeCommandDependencies({
        define: () => Effect.die('unused Commercial Fee definition'),
        loadCurrencySupport: () => Effect.die('unused Currency Support read'),
        lookupResult: ({ actionInvocationId }) =>
          Effect.succeed(
            Schema.decodeSync(CommercialFeeActionResultLookupOutcomeSchema)({
              actionInvocationId,
              outcome: 'COMMERCIAL_FEE_ACTION_RESULT_FOUND',
              result: {
                identityKey: secondIntent.operation.payload.identityKey,
                outcome: 'COMMERCIAL_FEE_CONFLICT',
                reason: 'EXPECTED_CURRENT_STALE',
              },
            }),
          ),
        revise: () => Effect.die('unused Commercial Fee revision'),
        validateCatalogTarget: () => Effect.die('unused Catalog target validation'),
      });
      const reconciliation = yield* makeProductCommercialFeeBulkCommandPort(
        dependencies,
      ).reconcileAuthorizedCommercialFeeAction({ ...firstIntent, trusted });

      expect(reconciliation).toEqual({
        outcome: { outcome: 'CONFLICT', reasonCode: 'IDEMPOTENCY_CONFLICT' },
        status: 'RESOLVED',
      });
    }),
  );

  it.effect('rejects a stale Catalog snapshot before target execution', () =>
    Effect.gen(function* staleSnapshot() {
      let executions = 0;
      const services: ProductCommercialFeeBulkActionServices = {
        execute: () => {
          executions += 1;
          return Effect.succeed(successfulActionResult);
        },
        validateCurrentCatalogSnapshot: () => Effect.succeed(false),
      };
      const failure = yield* applyProductCommercialFeeBulkManagement(payload, trusted, services).pipe(Effect.flip);

      expect(failure).toMatchObject({ code: 'BULK_TARGET_IDENTITY_MISMATCH' });
      expect(executions).toBe(0);
    }),
  );

  it('accepts a later Catalog observation of the same source cut and rejects changed owner revisions', () => {
    const laterCapturedAt = '2026-09-27T10:10:00.000Z';
    const laterObservation = Schema.decodeSync(PricingCommercialFeeProductTargetSnapshotSchema)({
      ...snapshot,
      capturedAt: laterCapturedAt,
      targets: snapshot.targets.map((entry, index) => ({
        ...entry,
        catalogEvidence: {
          ...entry.catalogEvidence,
          assessedAt: laterCapturedAt,
          membership: {
            ...entry.catalogEvidence.membership,
            attestationId: `fresh-owner-attestation:${index + 1}`,
            observedAt: laterCapturedAt,
          },
        },
      })),
      targetSetCompleteness: { ...snapshot.targetSetCompleteness, observedAt: laterCapturedAt },
    });

    expect(productCommercialFeeBulkSnapshotMatchesCurrentOwnerRead(snapshot, laterObservation)).toBe(true);
    expect(
      productCommercialFeeBulkSnapshotMatchesCurrentOwnerRead(snapshot, {
        ...laterObservation,
        catalogOwnerRevision: 'catalog-product-active-variants:changed',
      }),
    ).toBe(false);
    expect(
      productCommercialFeeBulkSnapshotMatchesCurrentOwnerRead(snapshot, {
        ...laterObservation,
        targets: laterObservation.targets.slice(0, 1),
      }),
    ).toBe(false);
    const changedBasisObservation = Schema.decodeSync(PricingCommercialFeeProductTargetSnapshotSchema)({
      ...laterObservation,
      targets: laterObservation.targets.map((entry, index) =>
        index === 0
          ? {
              ...entry,
              catalogEvidence: {
                ...entry.catalogEvidence,
                basis: entry.catalogEvidence.basis.map((basis) =>
                  basis.role === 'VARIANT'
                    ? { ...basis, source: { ...basis.source, revision: basis.source.revision + 1 } }
                    : basis,
                ),
                membership: {
                  ...entry.catalogEvidence.membership,
                  variant: {
                    ...entry.catalogEvidence.membership.variant,
                    revision: entry.catalogEvidence.membership.variant.revision + 1,
                  },
                },
              },
            }
          : entry,
      ),
    });
    expect(productCommercialFeeBulkSnapshotMatchesCurrentOwnerRead(snapshot, changedBasisObservation)).toBe(false);
  });

  it.effect('rejects one unsupported currency per target and continues the remaining fixed snapshot', () =>
    Effect.gen(function* mixedCurrencyTargets() {
      const mixedPayload = yield* Schema.decodeEffect(ManageProductCommercialFeesBulkPayloadSchema)({
        ...payload,
        targetIntents: payload.targetIntents.map((intent, index) => {
          if (index !== 0 || intent.operation.kind !== 'DEFINE_COMMERCIAL_FEE') {
            return intent;
          }
          return {
            ...intent,
            operation: {
              ...intent.operation,
              payload: {
                ...intent.operation.payload,
                configuredAmount: { amount: intent.operation.payload.configuredAmount.amount, currencyCode: 'EUR' },
                identityKey: { ...intent.operation.payload.identityKey, currencyCode: 'EUR' },
              },
            },
          };
        }),
      });
      const definedTargets: string[] = [];
      const dependencies = makeCommandDependencies({
        define: (command) => {
          definedTargets.push(command.identityKey.target.variantRef.resourceId);
          const index = variantRefs.findIndex(
            ({ resourceId }) => resourceId === command.identityKey.target.variantRef.resourceId,
          );
          return Effect.succeed({
            definition: {
              catalogTargetEvidence: command.catalogTargetEvidence,
              feeRef: canonicalFor(index).feeRef,
              identityKey: command.identityKey,
              revision: {
                configuredAmount: command.configuredAmount,
                effectiveFrom: command.effectivePeriod.effectiveFrom,
                revision: 1,
                revisionId: canonicalFor(index).revisionId,
              },
            },
            outcome: 'COMMERCIAL_FEE_CREATED' as const,
          });
        },
        loadCurrencySupport: () => Effect.succeed({ _tag: 'current' as const, current: currentCurrencySupport }),
        revise: () => Effect.die('unused Commercial Fee revision'),
        validateCatalogTarget: () => Effect.succeed(true),
      });
      const result = yield* makeProductCommercialFeeBulkService(
        makeProductCommercialFeeBulkCommandPort(dependencies),
      ).execute({ ...mixedPayload, trusted });

      expect(result.outcomes).toMatchObject([
        { outcome: 'REJECTED', reasonCode: 'define_commercial_fee_currency_not_enabled' },
        { outcome: 'CREATED' },
      ]);
      expect(definedTargets).toEqual([variantRefs[1].resourceId]);
    }),
  );

  it.effect('checks VALUE_ONLY_CURRENT currency support at the requested effective boundary', () =>
    Effect.gen(function* valueOnlyBoundary() {
      const requestedEffectiveFrom = '2026-10-15T00:00:00.000Z';
      const [first] = payload.targetIntents;
      if (first === undefined || first.operation.kind !== 'DEFINE_COMMERCIAL_FEE') {
        throw new Error('VALUE_ONLY_CURRENT fixture requires a definition target');
      }
      const revisedOperation: ManageProductCommercialFeeOperation = {
        kind: 'REVISE_COMMERCIAL_FEE',
        payload: {
          catalogTargetEvidence: first.catalogTargetEvidence,
          configuredAmount: { amount: '25', currencyCode: 'CZK' },
          effectiveFrom: requestedEffectiveFrom,
          expectedCurrent: {
            effectivePeriod: { effectiveFrom: '2026-10-01T00:00:00.000Z', effectiveTo: null },
            feeRef: canonicalFor(0).feeRef,
            identityKey: first.operation.payload.identityKey,
            revision: 1,
            revisionId: canonicalFor(0).revisionId,
            scheduleRevision: 1,
          },
          identityKey: first.operation.payload.identityKey,
          intent: 'VALUE_ONLY_CURRENT',
          reason: 'Change Current value at the requested boundary',
        },
      };
      const queries: unknown[] = [];
      const dependencies = makeCommandDependencies({
        define: () => Effect.die('unused Commercial Fee definition'),
        loadCurrencySupport: (query) => {
          queries.push(query);
          return Effect.succeed({ _tag: 'current' as const, current: currentCurrencySupport });
        },
        revise: () =>
          Effect.fail(new CommercialFeePersistenceUnavailable({ reason: 'Stop after boundary verification' })),
        validateCatalogTarget: () => Effect.succeed(true),
      });
      const command: ProductCommercialFeeBulkCommand<ManageProductCommercialFeeOperation> = {
        ...first,
        operation: revisedOperation,
        trusted,
      };

      const failure = yield* makeProductCommercialFeeBulkCommandPort(dependencies)
        .executeAuthorizedCommercialFeeAction(command)
        .pipe(Effect.flip);

      expect(
        Match.value(failure).pipe(
          Match.tag('CommercialFeePersistenceUnavailable', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      expect(queries).toEqual([{ effectiveAt: requestedEffectiveFrom, tenantId }]);
    }),
  );
});
