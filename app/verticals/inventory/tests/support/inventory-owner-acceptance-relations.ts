import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { Effect, Option, Ref, Schema } from 'effect';

import {
  CatalogToStockBindingCandidateSchema,
  CatalogToStockBindingCorrectionInputSchema,
  CatalogToStockBindingSchema,
  // oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Acceptance tests exercise the owner lifecycle at its public domain seam; expires: 2027-03-31.
  makeCatalogToStockBindingLifecycle,
} from '../../shared/domain/catalog-to-stock-binding.ts';
import type {
  CatalogToStockBinding,
  CatalogToStockBindingHistoryEntry,
  CatalogToStockBindingPersistence,
} from '../../shared/domain/catalog-to-stock-binding.ts';
import {
  ExternalStockCorrelationSchema,
  ExternalStockKeySchema,
  // oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Acceptance tests exercise exact issuer-qualified resolution at its public domain seam; expires: 2027-03-31.
  makeExternalStockCorrelationResolver,
} from '../../shared/domain/external-stock-correlation.ts';
import type { ExternalStockCorrelation, ExternalStockKey } from '../../shared/domain/external-stock-correlation.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import { InventorySourceAssertionProposalSchema } from '../../shared/domain/inventory-source-assertion.ts';
import type {
  InventorySourceAssertion,
  InventorySourceAssertionPersistence,
} from '../../shared/domain/inventory-source-assertion.ts';
import {
  EstablishStockSharingEligibilityInputSchema,
  StockSharingEligibilitySchema,
  TrustedCurrentCommercePurchasingContextSchema,
} from '../../shared/domain/stock-sharing-eligibility.ts';
import type {
  StockSharingEligibility,
  StockSharingEligibilityPersistence,
} from '../../shared/domain/stock-sharing-eligibility.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import { StockPositionSchema } from '../../shared/domain/stock-position.ts';
import { InventoryBackendConfigurationRefSchema } from '../../shared/resources/inventory-backend-configuration.ts';
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Acceptance tests exercise the source evaluator through explicit owner ports; expires: 2027-03-31.
import { makeInventorySourceAssertionEvaluator } from '../../src/domain/inventory-source-assertion-evaluator.ts';
import { evaluateStockSourceCurrentness } from '../../src/services/stock-source-currentness.service.ts';
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Acceptance tests exercise the owner service through explicit in-memory ports; expires: 2027-03-31.
import { makeStockSharingEligibilityService } from '../../src/services/stock-sharing-eligibility-service.ts';

/* oxlint-disable sonarjs/no-nested-functions -- In-memory owner ports keep acceptance composition explicit and isolated; expires: 2027-03-31. */

const tenantId = '11111111-1111-4111-8111-111111111111';
const customerConfigurationId = 'customer-configuration:acceptance';
const firstInstant = '2026-09-24T10:00:00.000Z';
const secondInstant = '2026-09-24T11:00:00.000Z';
const catalogModuleId = 'commerce.catalog' as const;
const inventoryModuleId = 'commerce.inventory' as const;
const inventoryConfigurationResourceType = 'commerce.inventory.inventory-backend-configuration' as const;
const inventoryStockItemResourceType = 'commerce.inventory.stock-item' as const;

const unitRef = {
  moduleId: catalogModuleId,
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;

const inventoryConfigurationRef = (resourceId: string) =>
  Schema.decodeUnknownSync(InventoryBackendConfigurationRefSchema)({
    moduleId: inventoryModuleId,
    resourceId,
    resourceType: inventoryConfigurationResourceType,
    tenantId,
  });

const makeSharingPersistence = Effect.gen(function* makeSharingPersistence() {
  const current = yield* Ref.make<Option.Option<StockSharingEligibility>>(Option.none());
  const revisions = yield* Ref.make<readonly StockSharingEligibility[]>([]);
  const persistence: StockSharingEligibilityPersistence = {
    findByRef: (relationRef) =>
      Ref.get(current).pipe(
        Effect.map(
          Option.filter(
            (relation) =>
              relation.ref.tenantId === relationRef.tenantId && relation.ref.resourceId === relationRef.resourceId,
          ),
        ),
      ),
    insertCurrent: (relation) =>
      Effect.gen(function* insertCurrent() {
        yield* Ref.set(current, Option.some(relation));
        yield* Ref.set(revisions, [relation]);
        return relation;
      }),
    listCurrent: (scope) =>
      Ref.get(current).pipe(
        Effect.map(
          Option.match({
            onNone: () => [],
            onSome: (relation) =>
              relation.lifecycle === 'CURRENT' &&
              relation.scope.customerConfigurationId === scope.customerConfigurationId &&
              relation.scope.ownerConfigurationRef.resourceId === scope.ownerConfigurationRef.resourceId &&
              relation.scope.positionRef.resourceId === scope.positionRef.resourceId
                ? [relation]
                : [],
          }),
        ),
      ),
    readHistory: () =>
      Ref.get(revisions).pipe(
        Effect.map((history) =>
          history.map((relation, index) => {
            const successor = history[index + 1];
            return successor === undefined || relation.effectivePeriod.to !== null
              ? relation
              : Schema.decodeSync(StockSharingEligibilitySchema)({
                  ...relation,
                  effectivePeriod: {
                    from: relation.effectivePeriod.from,
                    to: successor.effectivePeriod.to ?? successor.effectivePeriod.from,
                  },
                  lifecycle: 'ENDED',
                });
          }),
        ),
      ),
    saveRevision: ({ next }) =>
      Effect.gen(function* saveRevision() {
        yield* Ref.set(current, Option.some(next));
        yield* Ref.update(revisions, (history) => [...history, next]);
        return next;
      }),
  };
  return persistence;
});

/** Exercises the real owner lifecycle and exposes the ended decision plus immutable history. */
export const runStockSharingLifecycleAcceptance = Effect.gen(function* runStockSharingLifecycleAcceptance() {
  const positionRef = {
    moduleId: inventoryModuleId,
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'commerce.inventory.stock-position',
    tenantId,
  } as const;
  const sellingLegalEntityRef = {
    moduleId: 'core.identity',
    resourceId: '44444444-4444-4444-8444-444444444444',
    resourceType: 'core.identity.legal-entity',
    tenantId,
  } as const;
  const input = Schema.decodeUnknownSync(EstablishStockSharingEligibilityInputSchema)({
    effectiveFrom: firstInstant,
    scope: {
      customerConfigurationId,
      ownerConfigurationRef: inventoryConfigurationRef('55555555-5555-4555-8555-555555555555'),
      positionRef,
    },
    subject: {
      channel: 'B2C',
      commerceMarketRef: {
        moduleId: 'commerce.market-catalog',
        resourceId: 'market-cz',
        resourceType: 'commerce.market-catalog.market',
        tenantId,
      },
      sellingLegalEntityRef,
      storefrontRef: { appId: 'acceptance-storefront', tenantId },
    },
  });
  const context = Schema.decodeUnknownSync(TrustedCurrentCommercePurchasingContextSchema)({
    ...input.subject,
    commerceMarketRef: input.subject.commerceMarketRef,
    customerConfigurationId,
    evidenceRef: 'commerce-context:acceptance',
    observedAt: firstInstant,
    status: 'CURRENT_OWNER_VERIFIED',
    storefrontRef: input.subject.storefrontRef,
    tenantId,
  });
  const persistence = yield* makeSharingPersistence;
  const service = makeStockSharingEligibilityService({
    commerceValidator: {
      validateCurrent: () =>
        Effect.succeed({
          evidenceRef: 'commerce-validation:acceptance',
          observedAt: firstInstant,
          verification: 'OWNER_VERIFIED_CURRENT' as const,
        }),
    },
    makeEligibilityId: () => '66666666-6666-4666-8666-666666666666',
    persistence,
  });

  const established = yield* service.establish(input);
  const ended = yield* service.end({ endedAt: secondInstant, relationRef: established.ref });
  const evaluationFailure = yield* service.evaluate({ context, scope: input.scope }).pipe(Effect.flip);
  const history = yield* persistence.readHistory(established.ref);

  return { ended, established, evaluationFailure, history, originalScope: input.scope, originalSubject: input.subject };
});

const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  packageRef: {
    moduleId: catalogModuleId,
    resourceId: '77777777-7777-4777-8777-777777777777',
    resourceType: 'commerce.catalog.package',
    tenantId,
  },
  productRef: {
    moduleId: catalogModuleId,
    resourceId: '88888888-8888-4888-8888-888888888888',
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: catalogModuleId,
    resourceId: '99999999-9999-4999-8999-999999999999',
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
});
const exactSelectionMeaning = { id: 'catalog:acceptance:meaning', kind: 'PACKAGE_OPTION' as const };

const makeBindingPersistence = (initial: CatalogToStockBinding) =>
  Effect.gen(function* createBindingPersistence() {
    const current = yield* Ref.make(initial);
    const history = yield* Ref.make<readonly CatalogToStockBindingHistoryEntry[]>([]);
    const persistence: CatalogToStockBindingPersistence = {
      endCurrent: ({ historyEntry }) =>
        Ref.update(history, (entries) => [...entries, historyEntry]).pipe(Effect.as(historyEntry)),
      findCurrentByExactSelectionMeaning: (requestedTenantId, requestedMeaning) =>
        Ref.get(current).pipe(
          Effect.map((binding) =>
            binding.bindingRef.tenantId === requestedTenantId &&
            binding.exactSelectionMeaning.id === requestedMeaning.id &&
            binding.exactSelectionMeaning.kind === requestedMeaning.kind
              ? [binding]
              : [],
          ),
        ),
      findCurrentByStockItem: (stockItemRef) =>
        Ref.get(current).pipe(
          Effect.map((binding) =>
            binding.stockItemRef.tenantId === stockItemRef.tenantId &&
            binding.stockItemRef.resourceId === stockItemRef.resourceId
              ? Option.some(binding)
              : Option.none(),
          ),
        ),
      insertCurrent: (binding) => Ref.set(current, binding).pipe(Effect.as(binding)),
      readHistory: () => Ref.get(history),
      replaceCurrent: ({ historyEntry, next }) =>
        Effect.gen(function* replaceCurrent() {
          yield* Ref.update(history, (entries) => [...entries, historyEntry]);
          yield* Ref.set(current, next);
          return next;
        }),
    };
    return persistence;
  });

/** Corrects only the relation target while retaining both Stock Items' intrinsic meanings. */
export const runBindingCorrectionMeaningAcceptance = Effect.gen(function* runBindingCorrectionMeaningAcceptance() {
  const originalItem = Schema.decodeUnknownSync(StockItemSchema)({
    createdAt: firstInstant,
    exactSelectionMeaning,
    lifecycle: 'CURRENT',
    retiredAt: null,
    revision: 1,
    stockItemRef: {
      moduleId: inventoryModuleId,
      resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      resourceType: inventoryStockItemResourceType,
      tenantId,
    },
    unitRef,
  });
  const replacementItem = Schema.decodeUnknownSync(StockItemSchema)({
    ...originalItem,
    stockItemRef: { ...originalItem.stockItemRef, resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2' },
  });
  const originalBinding = Schema.decodeUnknownSync(CatalogToStockBindingSchema)({
    bindingRef: {
      moduleId: inventoryModuleId,
      resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
      resourceType: 'commerce.inventory.catalog-to-stock-binding',
      tenantId,
    },
    catalogSelection: selection,
    effectiveFrom: firstInstant,
    exactSelectionMeaning,
    revision: 1,
    stockItemRef: originalItem.stockItemRef,
    unitRef,
  });
  const persistence = yield* makeBindingPersistence(originalBinding);
  const lifecycle = makeCatalogToStockBindingLifecycle(persistence, {
    makeBindingId: () => originalBinding.bindingRef.resourceId,
    now: Effect.succeed(secondInstant),
  });
  const candidate = Schema.decodeUnknownSync(CatalogToStockBindingCandidateSchema)({
    catalogSelection: selection,
    exactSelectionMeaning,
    stockItem: replacementItem,
  });
  const originalMeaning = { ...originalItem.exactSelectionMeaning };
  const replacementMeaning = { ...replacementItem.exactSelectionMeaning };

  const correctedBinding = yield* lifecycle.correct(
    Schema.decodeUnknownSync(CatalogToStockBindingCorrectionInputSchema)({
      candidate,
      evidence: { authority: 'INVENTORY_BINDING_OWNER', ownerEvidenceRef: 'binding-correction:acceptance' },
    }),
  );
  const history = yield* persistence.readHistory(correctedBinding.bindingRef);

  return {
    correctedBinding,
    history,
    originalBinding,
    originalItem,
    originalMeaning,
    replacementItem,
    replacementMeaning,
  };
});

const sameExternalKey = (left: ExternalStockKey, right: ExternalStockKey) =>
  left.tenantId === right.tenantId &&
  left.customerConfigurationId === right.customerConfigurationId &&
  left.issuer.backendKind === right.issuer.backendKind &&
  left.issuer.backendId === right.issuer.backendId &&
  left.namespace === right.namespace &&
  left.externalScope === right.externalScope &&
  left.identifierKind === right.identifierKind &&
  left.externalValue === right.externalValue;

/** Proves delayed backend-A evidence remains historical after backend B owns Current truth. */
export const runExternalIssuerCutoverAcceptance = Effect.gen(function* runExternalIssuerCutoverAcceptance() {
  const selectedConfiguration = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
    configurationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
    customerConfigurationId,
    revision: 1,
    selectedAt: secondInstant,
    selection: {
      backend: 'external_business_system',
      backendId: 'backend-b',
      exactReservationCapability: 'SUPPORTED',
      stockCorrectionCapability: 'UNSUPPORTED',
    },
    tenantId,
  });
  const itemRef = {
    moduleId: inventoryModuleId,
    resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
    resourceType: inventoryStockItemResourceType,
    tenantId,
  } as const;
  const locationRef = {
    moduleId: inventoryModuleId,
    resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
    resourceType: 'commerce.inventory.stock-location',
    tenantId,
  } as const;
  const positionRef = {
    moduleId: inventoryModuleId,
    resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4',
    resourceType: 'commerce.inventory.stock-position',
    tenantId,
  } as const;
  const externalKey = (identifierKind: 'ITEM' | 'LOCATION') =>
    Schema.decodeUnknownSync(ExternalStockKeySchema)({
      customerConfigurationId,
      externalScope: 'warehouse:acceptance',
      externalValue: identifierKind === 'ITEM' ? 'ITEM-A' : 'LOCATION-A',
      identifierKind,
      issuer: { backendId: 'backend-a', backendKind: 'external_business_system' as const },
      namespace: 'inventory',
      tenantId,
    });
  const correlation = (identifierKind: 'ITEM' | 'LOCATION') =>
    Schema.decodeUnknownSync(ExternalStockCorrelationSchema)({
      confirmedAt: firstInstant,
      correlationRef: {
        moduleId: inventoryModuleId,
        resourceId:
          identifierKind === 'ITEM' ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5' : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6',
        resourceType: 'commerce.inventory.external-stock-correlation',
        tenantId,
      },
      effectivePeriod: { from: '2026-09-24T09:00:00.000Z', to: secondInstant },
      externalKey: externalKey(identifierKind),
      lifecycle: 'ENDED',
      ownerEvidenceRef: `backend-a:correlation:${identifierKind.toLowerCase()}`,
      revision: 2,
      target:
        identifierKind === 'ITEM' ? { _tag: 'STOCK_ITEM', ref: itemRef } : { _tag: 'STOCK_LOCATION', ref: locationRef },
    });
  const correlations: readonly ExternalStockCorrelation[] = [correlation('ITEM'), correlation('LOCATION')];
  const resolver = makeExternalStockCorrelationResolver({
    findEffective: (key, asOf) =>
      Effect.succeed(
        correlations.filter(
          (candidate) =>
            sameExternalKey(candidate.externalKey, key) &&
            candidate.effectivePeriod.from <= asOf &&
            (candidate.effectivePeriod.to === null || asOf < candidate.effectivePeriod.to),
        ),
      ),
  });
  const position = Schema.decodeUnknownSync(StockPositionSchema)({
    createdAt: firstInstant,
    endedAt: null,
    lifecycle: 'CURRENT',
    onHand: {
      _tag: 'UNKNOWN',
      meaning: 'ON_HAND',
      ownerConfigurationRef: inventoryConfigurationRef(selectedConfiguration.configurationId),
      unitRef,
    },
    ref: positionRef,
    revision: 1,
    scope: { customerConfigurationId, stockItemRef: itemRef, stockLocationRef: locationRef, unitRef },
  });
  const proposal = Schema.decodeUnknownSync(InventorySourceAssertionProposalSchema)({
    assertionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7',
    businessObservedAt: firstInstant,
    coverage: [],
    customerConfigurationId,
    factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
    issuer: { backendId: 'backend-a', backendKind: 'external_business_system' },
    itemExternalKey: externalKey('ITEM'),
    locationExternalKey: externalKey('LOCATION'),
    orderingEvidence: { _tag: 'SOURCE_REVISION', revision: '42' },
    ownerEvidenceRef: 'backend-a:snapshot:42',
    positionRef,
    quantity: { amount: '9', unitRef },
    receivedAt: '2026-09-24T12:00:00.000Z',
    sourceReference: 'backend-a:delayed-snapshot:42',
  });
  const stored = yield* Ref.make<readonly InventorySourceAssertion[]>([]);
  const persistence: InventorySourceAssertionPersistence = {
    append: (assertion) => Ref.update(stored, (history) => [...history, assertion]).pipe(Effect.as(assertion)),
    findById: (assertionId) =>
      Ref.get(stored).pipe(
        Effect.map((history) =>
          Option.fromNullishOr(history.find((assertion) => assertion.assertionId === assertionId)),
        ),
      ),
  };
  const itemResolution = yield* resolver.resolve({
    asOf: proposal.businessObservedAt,
    externalKey: proposal.itemExternalKey,
    selectedConfiguration,
  });
  const locationResolution = yield* resolver.resolve({
    asOf: proposal.businessObservedAt,
    externalKey: proposal.locationExternalKey,
    selectedConfiguration,
  });
  const evaluation = yield* makeInventorySourceAssertionEvaluator({
    correlations: {
      resolve: ({ externalKey: key }) =>
        Effect.succeed(key.identifierKind === 'ITEM' ? itemResolution : locationResolution),
    },
    effects: { listAppliedForPosition: () => Effect.succeed([]) },
    persistence,
    positions: { read: () => Effect.succeed(Option.some(position)) },
  }).evaluate({ proposal, selectedConfiguration });
  const currentness = yield* evaluateStockSourceCurrentness({
    evaluatedAt: '2026-09-24T12:01:00.000Z',
    ownerConfigurationRef: inventoryConfigurationRef(selectedConfiguration.configurationId),
    ownerCurrentThrough: '2026-09-24T13:00:00.000Z',
    position,
    sourceCondition: { _tag: 'SOURCE_ASSERTION', evaluation },
  });
  const assertionHistory = yield* Ref.get(stored);

  return {
    assertionHistory,
    correlations,
    currentness,
    evaluation,
    itemResolution,
    locationResolution,
    position,
    proposal,
    selectedConfiguration,
  };
});

/* oxlint-enable sonarjs/no-nested-functions */
