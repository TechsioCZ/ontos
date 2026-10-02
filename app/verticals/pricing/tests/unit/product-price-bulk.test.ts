import { PriceProductTargetSnapshotSchema } from '@app/pricing-contracts/domain/catalog-price-target';
import type { PriceProductTargetOutcomeIdentity } from '@app/pricing-contracts/domain/catalog-price-target';
import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  makeProductPriceBulkService,
  ProductPriceBulkRejected,
} from '../../src/services/product-price-bulk.service.ts';
import type {
  ProductPriceBulkCommand,
  ProductPriceBulkCommandPort,
  ProductPriceBulkTargetIntent,
} from '../../src/services/product-price-bulk.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const capturedAt = '2026-09-27T10:00:00.000Z';

const catalogRef = <const ResourceType extends string>(resourceId: string, resourceType: ResourceType) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});

const productRef = catalogRef('22222222-2222-4222-8222-222222222222', 'commerce.catalog.product');
const firstVariantRef = catalogRef('33333333-3333-4333-8333-333333333333', 'commerce.catalog.variant');
const secondVariantRef = catalogRef('44444444-4444-4444-8444-444444444444', 'commerce.catalog.variant');

const targetFor = (variantRef: typeof firstVariantRef) => ({ productRef, variantRef });
const evidenceFor = (target: ReturnType<typeof targetFor>) => ({
  assessedAt: capturedAt,
  basis: [
    { role: 'PRODUCT' as const, source: { resourceRef: target.productRef, revision: 1 } },
    { role: 'VARIANT' as const, source: { resourceRef: target.variantRef, revision: 2 } },
    {
      provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
      role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
      source: { resourceRef: target.productRef, revision: 1 },
    },
  ],
  membership: {
    attestationId: `catalog-membership:${target.variantRef.resourceId}`,
    observedAt: capturedAt,
    productRef,
    source: 'CATALOG_OWNER_CURRENT_READ' as const,
    variant: { resourceRef: target.variantRef, revision: 2 },
  },
  purpose: 'PRICING' as const,
  selection: target,
  status: 'VALID' as const,
});

const firstTarget = targetFor(firstVariantRef);
const secondTarget = targetFor(secondVariantRef);
const snapshot = Schema.decodeSync(PriceProductTargetSnapshotSchema)({
  capturedAt,
  catalogOwnerRevision: 'catalog-product-active-variants:17',
  productRef,
  snapshotId: 'catalog-product-snapshot:17',
  targets: [firstTarget, secondTarget].map((target) => ({
    catalogEvidence: evidenceFor(target),
    target,
    targetId: `catalog-target:${target.variantRef.resourceId}`,
  })),
  targetSetCompleteness: {
    observedAt: capturedAt,
    ownerRevision: 'catalog-product-active-variants:17',
    scope: { kind: 'EXACT_PREDICATE', predicateRef: 'catalog-product:active-variants' },
  },
});

interface Operation {
  readonly amount: string;
}

const intents = snapshot.targets.map(({ target, targetId }, index): ProductPriceBulkTargetIntent<Operation> => ({
  identity: { snapshotId: snapshot.snapshotId, target, targetId },
  intentId: `bulk-intent:${index + 1}`,
  operation: { amount: index === 0 ? '100' : '200' },
  targetCorrelationRef: `bulk-correlation:${index + 1}`,
}));

const trusted = {
  actionInvocationId: '77777777-7777-4777-8777-777777777777',
  compositionRevision: 'b'.repeat(64),
  principalContext: {
    authBindingId: '88888888-8888-4888-8888-888888888888',
    authContextRef: 'session:product-price-bulk',
    authMethod: 'session' as const,
    legalEntityId: '66666666-6666-4666-8666-666666666666',
    principalId: '55555555-5555-4555-8555-555555555555',
    tenantId,
  },
  requestCorrelationId: 'bulk-request-correlation',
  trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-27T10:05:00.000Z')),
};

const canonical = (identity: PriceProductTargetOutcomeIdentity) => ({
  priceRef: {
    moduleId: 'commerce.pricing' as const,
    resourceId: identity.target.variantRef.resourceId,
    resourceType: 'commerce.pricing.price' as const,
    tenantId,
  },
  revisionId: identity.target.variantRef.resourceId,
});

describe('Product Price bulk service (#797)', () => {
  it.effect('preserves snapshot order and reports independent atomic owner outcomes', () =>
    Effect.gen(function* partialOutcomes() {
      const commands: ProductPriceBulkCommand<Operation>[] = [];
      const port: ProductPriceBulkCommandPort<Operation> = {
        executeAuthorizedExactPriceAction: (command) => {
          commands.push(command);
          return command.identity.targetId === snapshot.targets[0]?.targetId
            ? Effect.succeed({ canonical: canonical(command.identity), outcome: 'APPLIED' as const })
            : Effect.succeed({ outcome: 'CONFLICT' as const, reasonCode: 'EXPECTED_CURRENT_MISMATCH' });
        },
        reconcileAuthorizedExactPriceAction: () => Effect.succeed({ status: 'ABSENT' as const }),
      };
      const service = makeProductPriceBulkService(port);
      const result = yield* service.execute({ snapshot, targetIntents: intents, trusted });

      expect(result.snapshotId).toBe(snapshot.snapshotId);
      expect(result.outcomes.map(({ outcome }) => outcome)).toEqual(['APPLIED', 'CONFLICT']);
      expect(result.outcomes.map(({ identity }) => identity.targetId)).toEqual(
        snapshot.targets.map(({ targetId }) => targetId),
      );
      expect(commands).toHaveLength(2);
      expect(commands.every(({ trusted: commandTrusted }) => commandTrusted === trusted)).toBe(true);
    }),
  );

  it.effect('reconciles every original intent and never reruns a resolved success or conflict', () =>
    Effect.gen(function* reconcileBeforeRetry() {
      const executed: string[] = [];
      const reconciled: string[] = [];
      const port: ProductPriceBulkCommandPort<Operation> = {
        executeAuthorizedExactPriceAction: (command) => {
          executed.push(command.intentId);
          return Effect.succeed({ canonical: canonical(command.identity), outcome: 'UNCHANGED' as const });
        },
        reconcileAuthorizedExactPriceAction: (command) => {
          reconciled.push(command.intentId);
          if (command.intentId === intents[0]?.intentId) {
            return Effect.succeed({
              outcome: { canonical: canonical(command.identity), outcome: 'APPLIED' as const },
              status: 'RESOLVED' as const,
            });
          }
          return Effect.succeed({
            outcome: { outcome: 'CONFLICT' as const, reasonCode: 'SCHEDULE_ACKNOWLEDGEMENT_STALE' },
            status: 'RESOLVED' as const,
          });
        },
      };
      const result = yield* makeProductPriceBulkService(port).execute({ snapshot, targetIntents: intents, trusted });

      expect(reconciled).toEqual(intents.map(({ intentId }) => intentId));
      expect(executed).toEqual([]);
      expect(result.outcomes.map(({ outcome }) => outcome)).toEqual(['APPLIED', 'CONFLICT']);
      expect(result.outcomes.every(({ resolvedBy }) => resolvedBy === 'OWNER_RECONCILIATION')).toBe(true);
    }),
  );

  it.effect('retries only an owner-confirmed open intent and keeps unavailable lookup indeterminate', () =>
    Effect.gen(function* retryOpenOnly() {
      const executed: string[] = [];
      const port: ProductPriceBulkCommandPort<Operation> = {
        executeAuthorizedExactPriceAction: (command) => {
          executed.push(command.intentId);
          return Effect.succeed({ canonical: canonical(command.identity), outcome: 'APPLIED' as const });
        },
        reconcileAuthorizedExactPriceAction: (command) =>
          command.intentId === intents[0]?.intentId
            ? Effect.succeed({ status: 'RETRY_ALLOWED' as const })
            : Effect.fail({
                _tag: 'ProductPriceBulkPortFailure' as const,
                code: 'OwnerResultLookupUnavailable',
              }),
      };
      const result = yield* makeProductPriceBulkService(port).execute({ snapshot, targetIntents: intents, trusted });

      expect(executed).toEqual([intents[0]?.intentId]);
      expect(result.outcomes.map(({ outcome }) => outcome)).toEqual(['APPLIED', 'INDETERMINATE']);
      expect(result.outcomes[1]).toMatchObject({
        reasonCode: 'OwnerResultLookupUnavailable',
        resolvedBy: 'OWNER_RECONCILIATION',
      });
    }),
  );

  it.effect('rejects an intent set that is not the exact fixed snapshot target set', () =>
    Effect.gen(function* exactTargetSet() {
      let portCalls = 0;
      const port: ProductPriceBulkCommandPort<Operation> = {
        executeAuthorizedExactPriceAction: () => {
          portCalls += 1;
          return Effect.succeed({ outcome: 'REJECTED' as const, reasonCode: 'unused' });
        },
        reconcileAuthorizedExactPriceAction: () => {
          portCalls += 1;
          return Effect.succeed({ status: 'ABSENT' as const });
        },
      };
      const error = yield* Effect.flip(
        makeProductPriceBulkService(port).execute({ snapshot, targetIntents: intents.slice(0, 1), trusted }),
      );

      expect(error).toBeInstanceOf(ProductPriceBulkRejected);
      expect(error.code).toBe('BULK_TARGET_SET_MISMATCH');
      expect(portCalls).toBe(0);
    }),
  );
});
