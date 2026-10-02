import { PriceProductTargetSnapshotSchema } from '@app/pricing-contracts/domain/catalog-price-target';
import { getVerticalRuntimeActions } from '@app/core-runtime';
import { PriceSourceProvenanceSchema } from '@app/pricing-contracts/domain/price-source-provenance';
import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/unstable/http';

import {
  ManageProductPriceOperationSchema,
  ManageProductPricesBulkPayloadSchema,
  ManageProductPricesBulkResultSchema,
} from '../../shared/actions/manage-product-prices-bulk.ts';
import type { ManageProductPricesBulkTargetIntent } from '../../shared/actions/manage-product-prices-bulk.ts';
import {
  handleManageProductPricesBulk,
  manageProductPricesBulkAction,
} from '../../src/actions/manage-product-prices-bulk.action.ts';
import {
  makeProductPriceBulkCommandPort,
  ProductPriceBulkRejected,
  makeProductPriceBulkService,
} from '../../src/services/product-price-bulk.service.ts';
import type {
  ProductPriceBulkCommandOptions,
  ProductPriceBulkCommandPort,
} from '../../src/services/product-price-bulk.service.ts';
import { PriceActionResultLookupOutcomeSchema } from '../../src/services/price-persistence.service.ts';
import { priceSourceFactFingerprint } from '../../src/services/price-source-provenance.service.ts';
import { executeManageProductPricesBulkWithAuthorization } from '../../src/api/manage-product-prices-bulk-action-client.ts';
import { pricingManifest } from '../../vertical.manifest.ts';
import { pricingRegistration } from '../../vertical.registration.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const capturedAt = '2026-09-27T10:00:00.000Z';
const productRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product' as const,
  tenantId,
};
const catalogRef = <const ResourceType extends string>(resourceId: string, resourceType: ResourceType) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});
const variantRefs = [
  catalogRef('44444444-4444-4444-8444-444444444444', 'commerce.catalog.variant'),
  catalogRef('55555555-5555-4555-8555-555555555555', 'commerce.catalog.variant'),
] as const;
const laterVariantRef = catalogRef('66666666-6666-4666-8666-666666666666', 'commerce.catalog.variant');
const unitRef = catalogRef('77777777-7777-4777-8777-777777777777', 'commerce.catalog.product-unit');
const targetFor = (variantRef: typeof laterVariantRef) => ({ productRef, variantRef });
const evidenceFor = (target: ReturnType<typeof targetFor>) => ({
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
const snapshotFor = (variants: readonly (typeof laterVariantRef)[], snapshotId: string) =>
  Schema.decodeSync(PriceProductTargetSnapshotSchema)({
    capturedAt,
    catalogOwnerRevision: `catalog-product-active-variants:${snapshotId}`,
    productRef,
    snapshotId,
    targets: variants.map((variantRef) => {
      const target = targetFor(variantRef);
      return {
        catalogEvidence: evidenceFor(target),
        target,
        targetId: `catalog-target:${variantRef.resourceId}`,
      };
    }),
    targetSetCompleteness: {
      observedAt: capturedAt,
      ownerRevision: `catalog-product-active-variants:${snapshotId}`,
      scope: { kind: 'EXACT_PREDICATE', predicateRef: 'catalog-product:active-variants' },
    },
  });
const snapshot = snapshotFor(variantRefs, 'snapshot-797-v1');
const laterSnapshot = snapshotFor([...variantRefs, laterVariantRef], 'snapshot-797-v2');
const sourceAssertionFor = (index: number) => ({
  lineage: { kind: 'INITIAL' as const },
  mapping: { mappingContractRef: 'erp-price-v2', mappingContractVersion: '2' },
  originalAssertion: {
    monetaryAmount: { amount: `${100 + index * 10}`, currencyCode: 'CZK' },
    monetaryBoundary: 'PRE_TAX' as const,
    unitBasis: { quantity: '1', unitRef },
  },
  sourceAssertionId: index === 0 ? '88888888-8888-4888-8888-888888888888' : '99999999-9999-4999-8999-999999999999',
  sourceAuthority: { sourceAuthorityRef: 'pricing-owner', sourceAuthorityVersion: '7' },
  sourceRecord: {
    sourceChangeCorrelation: `bulk-change-${index + 1}`,
    sourceRecordRef: `bulk-price-${index + 1}`,
    sourceRecordVersion: '1',
    sourceSystem: { ownerModuleId: 'commerce.pricing', sourceSystemRef: 'erp-eu' },
  },
  timing: {
    importedAt: '2026-09-27T10:00:00.500Z',
    ownerBusinessEffectiveAt: capturedAt,
    sourceEffectiveAt: '2026-09-27T09:59:00.000Z',
  },
});
const intents = snapshot.targets.map(({ target, targetId }, index): ManageProductPricesBulkTargetIntent => ({
  identity: { snapshotId: snapshot.snapshotId, target, targetId },
  intentId: `bulk-intent:${index + 1}`,
  operation: {
    kind: 'DEFINE_PRICE',
    payload: {
      effectiveFrom: capturedAt,
      identityKey: {
        catalogSelection: target,
        commercialScope: { channelId: 'B2C', marketId: 'cz-launch', sellingLegalEntityId: legalEntityId },
        currencyCode: 'CZK',
        priceGroupSelector: { kind: 'NO_GROUP' },
        unitBasis: { quantity: '1', unitRef },
      },
      monetaryAmount: { amount: `${100 + index * 10}`, currencyCode: 'CZK' },
      priceRef: {
        moduleId: 'commerce.pricing',
        resourceId: index === 0 ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        resourceType: 'commerce.pricing.price',
        tenantId,
      },
      reason: 'Apply one exact fixed Product snapshot target',
      sourceAssertion: sourceAssertionFor(index),
    },
  },
  targetCorrelationRef: `bulk-correlation:${index + 1}`,
}));
const payload = Schema.decodeSync(ManageProductPricesBulkPayloadSchema)({ snapshot, targetIntents: intents });
const [firstIntent] = intents;
const laterTarget = laterSnapshot.targets.at(2);
if (firstIntent === undefined || laterTarget === undefined) {
  throw new Error('The Product Price bulk acceptance fixture requires fixed and later targets');
}
const trusted = {
  actionInvocationId: 'ffffffff-ffff-4fff-8fff-fffffffffff1',
  principalContext: {
    authBindingId: 'ffffffff-ffff-4fff-8fff-fffffffffff2',
    authContextRef: 'session:bulk-management-acceptance',
    authMethod: 'session' as const,
    correlationId: 'bulk-request-correlation',
    legalEntityId,
    principalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    tenantId,
  },
  requestCorrelationId: 'bulk-request-correlation',
  trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-27T10:05:00.000Z')),
};
const canonicalFor = (intent: ManageProductPricesBulkTargetIntent, index: number) => ({
  priceRef: intent.operation.payload.priceRef,
  revisionId: index === 0 ? 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' : 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
});

describe('Product Price bulk management acceptance', () => {
  it('publishes the generated bulk Action through the manifest and runtime registration', () => {
    expect(manageProductPricesBulkAction.descriptor).toMatchObject({
      actionKey: 'commerce.pricing.manage-product-prices-bulk',
      idempotency: 'required',
      legalEntityScope: 'required',
      owningModuleKey: 'commerce.pricing',
      schemaVersion: '1',
    });
    expect(manageProductPricesBulkAction.descriptor.entrypoint).toMatchObject({
      entrypointKey: 'commerce.pricing.manage-product-prices-bulk',
      scope: 'tenant',
    });
    expect(pricingManifest.publicSurface.actions).toContain(manageProductPricesBulkAction);
    expect(getVerticalRuntimeActions(pricingRegistration)).toContain(manageProductPricesBulkAction);
  });

  it.effect('keeps the original Product snapshot fixed and reports per-Variant partial outcomes', () =>
    Effect.gen(function* fixedSnapshotPartial() {
      const executed: string[] = [];
      const trustedCommands: unknown[] = [];
      const port: ProductPriceBulkCommandPort<ManageProductPricesBulkTargetIntent['operation']> = {
        executeAuthorizedExactPriceAction: (command) => {
          executed.push(command.identity.targetId);
          trustedCommands.push(command.trusted);
          const index = intents.findIndex(({ identity }) => identity.targetId === command.identity.targetId);
          return index === 0
            ? Effect.succeed({ canonical: canonicalFor(firstIntent, index), outcome: 'APPLIED' as const })
            : Effect.succeed({ outcome: 'CONFLICT' as const, reasonCode: 'EXPECTED_CURRENT_MISMATCH' });
        },
        reconcileAuthorizedExactPriceAction: () => Effect.succeed({ status: 'ABSENT' as const }),
      };
      const result = yield* makeProductPriceBulkService(port).execute({
        ...payload,
        trusted,
      });

      expect(Schema.is(ManageProductPricesBulkResultSchema)(result)).toBe(true);
      expect(result.outcomes.map(({ outcome }) => outcome)).toEqual(['APPLIED', 'CONFLICT']);
      expect(result.outcomes.map(({ identity }) => identity.target.variantRef)).toEqual(variantRefs);
      expect(executed).toEqual(snapshot.targets.map(({ targetId }) => targetId));
      expect(executed).not.toContain(laterSnapshot.targets[2]?.targetId);
      expect(trustedCommands).toEqual(snapshot.targets.map(() => trusted));

      const requests: Request[] = [];
      const fakeFetch: typeof globalThis.fetch = (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(Response.json(result, { status: 200 }));
      };
      const transported = yield* executeManageProductPricesBulkWithAuthorization(
        payload,
        'Bearer owner-assertion',
        'bulk-request-correlation',
        {
          baseUrl: 'https://pricing.example/pricing-api',
          idempotencyKey: 'bulk-fixed-snapshot-797',
        },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));

      expect(transported).toEqual(result);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe('https://pricing.example/pricing-api/pricing/actions/manage-product-prices-bulk');
      expect(requests[0]?.headers.get('idempotency-key')).toBe('bulk-fixed-snapshot-797');
      expect(requests[0]?.headers.get('x-correlation-id')).toBe('bulk-request-correlation');
    }),
  );

  it.effect('reconciles original target intents before retry and never repeats a known success', () =>
    Effect.gen(function* reconcileOriginalIntent() {
      const reconciled: string[] = [];
      const executed: string[] = [];
      const port: ProductPriceBulkCommandPort<ManageProductPricesBulkTargetIntent['operation']> = {
        executeAuthorizedExactPriceAction: (command) => {
          executed.push(command.intentId);
          return Effect.succeed({ outcome: 'REJECTED' as const, reasonCode: 'EXACT_TARGET_INELIGIBLE' });
        },
        reconcileAuthorizedExactPriceAction: (command) => {
          reconciled.push(command.intentId);
          if (command.intentId === intents[0]?.intentId) {
            return Effect.succeed({
              outcome: { canonical: canonicalFor(firstIntent, 0), outcome: 'APPLIED' as const },
              status: 'RESOLVED' as const,
            });
          }
          return Effect.succeed({ status: 'RETRY_ALLOWED' as const });
        },
      };
      const result = yield* makeProductPriceBulkService(port).execute({ ...payload, trusted });

      expect(reconciled).toEqual(intents.map(({ intentId }) => intentId));
      expect(executed).toEqual([intents[1]?.intentId]);
      expect(result.outcomes.map(({ outcome }) => outcome)).toEqual(['APPLIED', 'REJECTED']);
      expect(result.outcomes[0]).toMatchObject({ resolvedBy: 'OWNER_RECONCILIATION' });
      expect(result.outcomes[1]).toMatchObject({ resolvedBy: 'OWNER_COMMAND' });
    }),
  );

  it.effect('does not attach a replayed Price result from a different fixed snapshot target', () =>
    Effect.gen(function* rejectMismatchedReplayTarget() {
      const firstOperation = firstIntent.operation;
      if (firstOperation.kind !== 'DEFINE_PRICE') {
        throw new Error('The replay fixture requires a defined Price target');
      }
      const [, secondIntent] = intents;
      if (secondIntent === undefined) {
        throw new Error('The replay fixture requires a mismatched fixed snapshot target');
      }
      const operation = yield* Schema.decodeEffect(ManageProductPriceOperationSchema)({
        kind: 'REVISE_PRICE',
        payload: {
          expectedCurrent: {
            effectivePeriod: { effectiveFrom: capturedAt, effectiveTo: null },
            priceRef: firstOperation.payload.priceRef,
            revision: 1,
            revisionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            scheduleRevision: 1,
          },
          intent: 'VALUE_ONLY_CURRENT',
          monetaryAmount: firstOperation.payload.monetaryAmount,
          priceRef: firstOperation.payload.priceRef,
          reason: 'Retry the exact original target only',
          sourceAssertion: firstOperation.payload.sourceAssertion,
        },
      });
      const mismatchedIdentity = {
        ...firstOperation.payload.identityKey,
        catalogSelection: secondIntent.identity.target,
      };
      const mismatchedRevision = {
        definition: {
          identityKey: mismatchedIdentity,
          priceRef: firstOperation.payload.priceRef,
          revision: {
            effectiveFrom: capturedAt,
            monetaryAmount: firstOperation.payload.monetaryAmount,
            monetaryBoundary: 'PRE_TAX' as const,
            revision: 2,
            revisionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          },
        },
        effectivePeriod: { effectiveFrom: capturedAt, effectiveTo: null },
        lineage: {
          correctedRevisionId: null,
          kind: 'VALUE_ONLY_CURRENT' as const,
          previousRevisionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        },
      };
      const mismatchedProvenance = yield* Schema.decodeUnknownEffect(PriceSourceProvenanceSchema)({
        canonicalLink: {
          effectiveFrom: capturedAt,
          identityKey: mismatchedIdentity,
          monetaryAmount: firstOperation.payload.monetaryAmount,
          monetaryBoundary: 'PRE_TAX',
          priceRef: firstOperation.payload.priceRef,
          revision: 2,
          revisionId: mismatchedRevision.definition.revision.revisionId,
        },
        evidence: {
          lineage: firstOperation.payload.sourceAssertion.lineage,
          recordedAt: capturedAt,
          sourceAssertion: firstOperation.payload.sourceAssertion,
          sourceFactFingerprint: priceSourceFactFingerprint(firstOperation.payload.sourceAssertion),
          tenantId,
        },
        provenanceRef: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      });
      const mismatchedResult = yield* Schema.decodeEffect(PriceActionResultLookupOutcomeSchema)({
        actionInvocationId: 'dddddddd-dddd-5ddd-8ddd-dddddddddddd',
        outcome: 'PRICE_ACTION_RESULT_FOUND',
        result: {
          outcome: 'REVISED',
          provenance: mismatchedProvenance,
          revision: mismatchedRevision,
        },
      });
      const dependencies = {
        defineServices: {
          assessCatalogSelection: () => Effect.die('unused Catalog assessment'),
          assessCommercialContext: () => Effect.die('unused commercial-context assessment'),
          assessExternalPriceInput: () => Effect.die('unused external Price input assessment'),
          define: () => Effect.die('unused Price definition'),
          loadCurrencySupport: () => Effect.die('unused Currency Support read'),
        },
        persistence: {
          define: () => Effect.die('unused Price definition'),
          lookupResult: () => Effect.succeed(mismatchedResult),
          readCurrent: () => Effect.die('unused Current Price read'),
          readSchedule: () => Effect.die('unused Price schedule read'),
          revise: () => Effect.die('unused Price revision'),
        },
        reviseServices: {
          assessExternalPriceInput: () => Effect.die('unused external Price input assessment'),
          readSchedule: () => Effect.die('unused Price schedule read'),
          revise: () => Effect.die('unused Price revision'),
        },
      } satisfies ProductPriceBulkCommandOptions;
      const reconciliation = yield* makeProductPriceBulkCommandPort(dependencies).reconcileAuthorizedExactPriceAction({
        ...firstIntent,
        operation,
        trusted,
      });

      expect(reconciliation).toEqual({
        outcome: { outcome: 'CONFLICT', reasonCode: 'IDEMPOTENCY_CONFLICT' },
        status: 'RESOLVED',
      });
    }),
  );

  it.effect('returns an indeterminate per-target outcome when owner result lookup is unavailable', () =>
    Effect.gen(function* unavailableLookup() {
      let executions = 0;
      const port: ProductPriceBulkCommandPort<ManageProductPricesBulkTargetIntent['operation']> = {
        executeAuthorizedExactPriceAction: () => {
          executions += 1;
          return Effect.succeed({ outcome: 'REJECTED' as const, reasonCode: 'must-not-run' });
        },
        reconcileAuthorizedExactPriceAction: () =>
          Effect.fail({
            _tag: 'ProductPriceBulkPortFailure' as const,
            code: 'OwnerResultLookupUnavailable',
          }),
      };
      const result = yield* makeProductPriceBulkService(port).execute({ ...payload, trusted });

      expect(executions).toBe(0);
      expect(result.outcomes).toHaveLength(snapshot.targets.length);
      expect(result.outcomes.every(({ outcome }) => outcome === 'INDETERMINATE')).toBe(true);
      expect(result.outcomes.every(({ resolvedBy }) => resolvedBy === 'OWNER_RECONCILIATION')).toBe(true);
    }),
  );

  it.effect('rejects a Selling Legal Entity substitution before owner reconciliation or execution', () =>
    Effect.gen(function* trustedSellerScope() {
      let portCalls = 0;
      const service = makeProductPriceBulkService<ManageProductPricesBulkTargetIntent['operation']>({
        executeAuthorizedExactPriceAction: () => {
          portCalls += 1;
          return Effect.succeed({ outcome: 'REJECTED', reasonCode: 'must-not-run' });
        },
        reconcileAuthorizedExactPriceAction: () => {
          portCalls += 1;
          return Effect.succeed({ status: 'ABSENT' });
        },
      });
      const failure = yield* handleManageProductPricesBulk(payload, {
        actionInvocationId: 'ffffffff-ffff-4fff-8fff-fffffffffff1',
        addDomainEvent: () => Effect.die('must not add an event'),
        addOutboxMessage: () => Effect.die('must not add an outbox message'),
        recordAuditEvidence: () => Effect.die('must not record successful evidence'),
        recordDataAccess: () => Effect.die('must not record data access'),
        scope: {
          authBindingId: 'ffffffff-ffff-4fff-8fff-fffffffffff2',
          authContextRef: 'session:bulk-scope-mismatch',
          authMethod: 'session',
          correlationId: 'bulk-scope-mismatch',
          legalEntityId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          principalId: trusted.principalContext.principalId,
          tenantId,
        },
        services: service,
      }).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(ProductPriceBulkRejected);
      expect(failure).toMatchObject({ code: 'BULK_SCOPE_MISMATCH' });
      expect(portCalls).toBe(0);
    }),
  );

  it.effect('rejects omitted, substituted, or newly discovered Variant targets before owner execution', () =>
    Effect.gen(function* exactTargetSetOnly() {
      let portCalls = 0;
      const port: ProductPriceBulkCommandPort<ManageProductPricesBulkTargetIntent['operation']> = {
        executeAuthorizedExactPriceAction: () => {
          portCalls += 1;
          return Effect.succeed({ outcome: 'REJECTED' as const, reasonCode: 'must-not-run' });
        },
        reconcileAuthorizedExactPriceAction: () => {
          portCalls += 1;
          return Effect.succeed({ status: 'ABSENT' as const });
        },
      };
      const service = makeProductPriceBulkService(port);
      const omitted = yield* service
        .execute({ snapshot, targetIntents: intents.slice(0, 1), trusted })
        .pipe(Effect.flip);
      const expandedIntent = {
        ...firstIntent,
        identity: {
          snapshotId: laterSnapshot.snapshotId,
          target: laterTarget.target,
          targetId: laterTarget.targetId,
        },
        intentId: 'bulk-intent:later-variant',
      };
      const addedLater = yield* service
        .execute({ snapshot, targetIntents: [...intents, expandedIntent], trusted })
        .pipe(Effect.flip);

      expect(omitted).toBeInstanceOf(ProductPriceBulkRejected);
      expect(addedLater).toBeInstanceOf(ProductPriceBulkRejected);
      expect(omitted).toMatchObject({ code: 'BULK_TARGET_SET_MISMATCH' });
      expect(addedLater).toMatchObject({ code: 'BULK_TARGET_SET_MISMATCH' });
      expect(portCalls).toBe(0);
    }),
  );

  it('keeps Product-level administration as explicit exact-Variant intents, not inheritance', () => {
    const decode = Schema.decodeUnknownSync(ManageProductPricesBulkPayloadSchema, { onExcessProperty: 'error' });
    expect(() => decode({ snapshot, targetIntents: intents.slice(0, 1) })).toThrow();
    expect(() =>
      decode({
        snapshot,
        targetIntents: intents.map((intent) => ({
          ...intent,
          identity: { ...intent.identity, target: { productRef } },
        })),
      }),
    ).toThrow();
    expect(JSON.stringify(payload)).not.toMatch(/inherit|futureVariant|productPrice/iu);
  });
});
