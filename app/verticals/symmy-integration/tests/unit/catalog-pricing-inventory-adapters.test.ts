import { CreateProductRecoveryForbiddenProblemSchema } from '@app/catalog/api/create-product-recovery';
import { CreateProductActionAlreadyCommittedProblemSchema } from '@app/catalog/api/create-product-action';
import { PriceGroupResultLookupResponseSchema } from '@app/price-group-catalog/apis/price-group-result-lookup';
import { DefinePriceResultSchema } from '@app/pricing/actions/define-price';
import { PriceSourceResultLookupResponseSchema } from '@app/pricing/apis/price-source-result-lookup';
import { GatewayDelegatedContextRequestSchema } from '@app/shared-contracts';
import { NodeCrypto } from '@effect/platform-node';
import { ConfigProvider, Effect, Exit, Option, Schema } from 'effect';
import type { Crypto } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { describe, expect, it } from 'effect-rstest';

import { holdTestModuleCredentials } from '../../../../packages/core-runtime/tests/support/module-credentials.ts';
import {
  SymmyCatalogPricingInventoryIntentSchema,
  SymmyCatalogPricingInventoryReceiptSchema,
} from '../../shared/domain/symmy-catalog-pricing-inventory-intents.ts';
import {
  SymmyExecutionEffectStateSchema,
  SymmyPinnedEffectSchema,
  SymmyPinnedJobPlanSchema,
} from '../../shared/domain/symmy-job-execution.ts';
import type { SymmyEffectAdapterInput } from '../../src/services/symmy-effect-adapters.service.ts';
import type { SymmyOwnerReceipt, SymmyPinnedEffect } from '../../shared/domain/symmy-job-execution.ts';
import { symmyJobWorkerUnavailable } from '../../src/services/symmy-job-worker-error.ts';
import {
  makeSymmyCatalogPricingInventoryAdapters,
  materializeSymmyCatalogPricingInventorySourceOccurrence,
  prepareSymmyCatalogPricingInventoryRequestHash,
} from '../../src/services/symmy-catalog-pricing-inventory-adapters.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const effectId = '10000000-0000-4000-8000-000000000002';
const executorId = '10000000-0000-4000-8000-000000000003';
const invocationId = '10000000-0000-4000-8000-000000000004';
const productId = '10000000-0000-4000-8000-000000000005';
const variantId = '10000000-0000-4000-8000-000000000006';
const compositionRevision = 'a'.repeat(64);
const sourceCorrelation = {
  issuerId: 'internal-ebs',
  mappingRevision: 'internal-1',
  recordId: 'product-1',
  recordNamespace: 'catalog',
  routeScope: 'route-1',
  sourceOccurrenceId: 'occurrence-1',
};
const effect = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
  effectKey: 'catalog-create',
  intent: { _tag: 'CatalogCreateProduct', payload: { name: 'Internal Product', sourceCorrelation } },
  itemId: '10000000-0000-4000-8000-000000000007',
  ref: {
    effectId,
    mappingVersion: 'internal-1',
    occurrence: {
      occurrenceId: 'occurrence-1',
      record: {
        entityKind: 'PRODUCT',
        issuerId: 'internal-ebs',
        route: { integrationRouteId: 'route-1', tenantId },
        sourceNamespace: 'catalog',
        sourceRecordId: 'product-1',
      },
    },
    operation: { entrypointKey: 'commerce.catalog.create-product', moduleId: 'commerce.catalog', schemaVersion: '2' },
    routeRevision: 'route-1',
  },
});
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
};
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: variantId,
  resourceType: 'commerce.catalog.variant',
  tenantId,
};
const bindInitialVariantEffect = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
  ...effect,
  intent: {
    _tag: 'CatalogBindInitialVariantSource',
    payload: {
      evidenceRef: 'internal-variant-source-evidence',
      expectedCreateInvocationId: invocationId,
      initialVariantRecordId: 'initial-variant-1',
      productSource: sourceCorrelation,
    },
  },
  ref: {
    ...effect.ref,
    operation: {
      entrypointKey: 'commerce.catalog.bind-initial-variant-source',
      moduleId: 'commerce.catalog',
      schemaVersion: '1',
    },
    originalTarget: productRef,
  },
});
const result = {
  businessOriginalCreateInvocationId: invocationId,
  product: {
    catalogReady: false,
    createdAt: '2026-11-07T10:00:00.000Z',
    lifecycle: 'DRAFT',
    name: 'Internal Product',
    productRef,
    revision: 1,
    updatedAt: '2026-11-07T10:00:00.000Z',
    variants: [{ lifecycle: 'WORK_IN_PROGRESS', productRef, variantId, variantRef }],
  },
  variantId,
};
const updateEffect = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
  ...effect,
  intent: {
    _tag: 'CatalogUpdateProduct',
    payload: {
      expectedRevision: 1,
      productRef,
      reason: 'Explicit internal lifecycle intent',
      targetLifecycle: 'DRAFT',
    },
  },
  ref: {
    ...effect.ref,
    operation: { entrypointKey: 'commerce.catalog.update-product', moduleId: 'commerce.catalog', schemaVersion: '1' },
    originalTarget: productRef,
  },
});

const newVariantRef = { ...variantRef, resourceId: '10000000-0000-4000-8000-000000000009' };
const dependentVariantEffect = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
  ...effect,
  dependsOn: [{ effectKey: 'catalog-create', itemKey: 'product-item' }],
  effectKey: 'additional-variant',
  intent: {
    _tag: 'CatalogCreateVariantFromProductEffect',
    parent: { effectKey: 'catalog-create', itemKey: 'product-item' },
    payload: {
      classification: {
        affectsOpenSelection: true,
        evidenceRefs: ['internal-realization-proof'],
        kind: 'NEW_REALIZATION',
        newVariantRef,
        reason: 'Explicit additional realization',
      },
      evidenceRefs: ['internal-realization-proof'],
      expectedProductRevision: 1,
      reason: 'Explicit additional realization',
      sourceCorrelation: { ...sourceCorrelation, recordId: 'variant-2' },
      variantRef: newVariantRef,
    },
    productSource: sourceCorrelation,
  },
  itemId: '10000000-0000-4000-8000-000000000010',
  ref: {
    ...effect.ref,
    effectId: '10000000-0000-4000-8000-000000000011',
    occurrence: {
      ...effect.ref.occurrence,
      record: { ...effect.ref.occurrence.record, entityKind: 'VARIANT', sourceRecordId: 'variant-2' },
    },
    operation: { entrypointKey: 'commerce.catalog.create-variant', moduleId: 'commerce.catalog', schemaVersion: '2' },
  },
});
const parentState = {
  ...Schema.decodeUnknownSync(SymmyExecutionEffectStateSchema)({
    effect,
    outcome: { effectId, owner: 'commerce.catalog', status: 'accepted_change' },
    ownerReceipt: {
      _tag: 'ProductCreated',
      actionInvocationId: invocationId,
      initialVariantRef: variantRef,
      productRef,
    },
    state: 'settled',
    version: 1,
  }),
  itemKey: 'product-item',
};
const priceGroupA = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '10000000-0000-4000-8000-000000000020',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
};
const priceGroupB = { ...priceGroupA, resourceId: '10000000-0000-4000-8000-000000000021' };
const priceRef = {
  moduleId: 'commerce.pricing',
  resourceId: '10000000-0000-4000-8000-000000000022',
  resourceType: 'commerce.pricing.price',
  tenantId,
};
const legalEntityId = '10000000-0000-4000-8000-000000000023';
const pricingSourceSystem = { ownerModuleId: 'external.internal-fixture', sourceSystemRef: 'governed-price-source' };
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '10000000-0000-4000-8000-000000000024',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
};
const priceDefinitionEffect = (group: typeof priceGroupA) =>
  Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
    ...effect,
    intent: {
      _tag: 'PriceDefine',
      payload: {
        effectiveFrom: '2026-11-07T10:00:00.000Z',
        identityKey: {
          catalogSelection: { productRef, variantRef },
          commercialScope: { channelId: 'B2C', marketId: 'internal-market', sellingLegalEntityId: legalEntityId },
          currencyCode: 'CZK',
          priceGroupSelector: { kind: 'PRICE_GROUP', priceGroupRef: group },
          unitBasis: { quantity: '1', unitRef },
        },
        monetaryAmount: { amount: '25', currencyCode: 'CZK' },
        priceRef,
        reason: 'Internal selected Price Group proof',
        sourceAssertion: {
          lineage: { kind: 'INITIAL' },
          mapping: { mappingContractRef: 'internal-contract', mappingContractVersion: 'internal-1' },
          originalAssertion: {
            monetaryAmount: { amount: '25', currencyCode: 'CZK' },
            monetaryBoundary: 'PRE_TAX',
            unitBasis: { quantity: '1', unitRef },
          },
          sourceAssertionId: '10000000-0000-4000-8000-000000000025',
          sourceAuthority: { sourceAuthorityRef: 'internal-owner-grant', sourceAuthorityVersion: '1' },
          sourceRecord: {
            sourceChangeCorrelation: 'internal-price-1',
            sourceRecordRef: 'price-1',
            sourceRecordVersion: '1',
            sourceSystem: pricingSourceSystem,
          },
          timing: {
            importedAt: '2026-11-07T10:00:00.000Z',
            ownerBusinessEffectiveAt: '2026-11-07T10:00:00.000Z',
            sourceEffectiveAt: '2026-11-07T10:00:00.000Z',
          },
        },
      },
    },
    ref: {
      ...effect.ref,
      occurrence: {
        ...effect.ref.occurrence,
        record: { ...effect.ref.occurrence.record, entityKind: 'PRICE', sourceRecordId: 'price-1' },
      },
      operation: { entrypointKey: 'commerce.pricing.define-price', moduleId: 'commerce.pricing', schemaVersion: '2' },
      originalTarget: priceRef,
    },
  });
const definePriceIntent = Schema.decodeUnknownSync(SymmyCatalogPricingInventoryIntentSchema.members[7])(
  priceDefinitionEffect(priceGroupA).intent,
);
const priceRevision = {
  effectiveFrom: definePriceIntent.payload.effectiveFrom,
  monetaryAmount: definePriceIntent.payload.monetaryAmount,
  monetaryBoundary: 'PRE_TAX',
  revision: 1,
  revisionId: '10000000-0000-4000-8000-000000000060',
};
const canonicalPriceProvenance = {
  canonicalLink: {
    ...priceRevision,
    identityKey: definePriceIntent.payload.identityKey,
    priceRef,
  },
  evidence: {
    lineage: { kind: 'INITIAL' },
    recordedAt: '2026-11-07T10:00:01.000Z',
    sourceAssertion: definePriceIntent.payload.sourceAssertion,
    sourceFactFingerprint: 'a'.repeat(64),
    tenantId,
  },
  provenanceRef: '10000000-0000-4000-8000-000000000061',
};
const canonicalPriceAssessment = Schema.encodeSync(DefinePriceResultSchema)(
  Schema.decodeUnknownSync(DefinePriceResultSchema)({
    outcome: 'PRICE_SOURCE_ASSERTION_CANONICAL_ACCEPTED',
    provenance: canonicalPriceProvenance,
  }),
);
const originalPriceReceipt = (outcome: 'CREATED' | 'REUSED') =>
  Schema.encodeSync(PriceSourceResultLookupResponseSchema)(
    Schema.decodeUnknownSync(PriceSourceResultLookupResponseSchema)({
      actionInvocationId: invocationId,
      outcome: 'PRICE_ACTION_RESULT_FOUND',
      result: {
        definition: { identityKey: definePriceIntent.payload.identityKey, priceRef, revision: priceRevision },
        outcome,
        provenance: canonicalPriceProvenance,
      },
    }),
  );
const unavailablePriceReceipt = Schema.encodeSync(PriceSourceResultLookupResponseSchema)(
  Schema.decodeUnknownSync(PriceSourceResultLookupResponseSchema)({
    actionInvocationId: invocationId,
    outcome: 'PRICE_ACTION_RESULT_UNAVAILABLE',
    retryable: true,
  }),
);
const negativePriceAssessment = Schema.encodeSync(DefinePriceResultSchema)(
  Schema.decodeUnknownSync(DefinePriceResultSchema)({
    outcome: 'PRICE_SOURCE_ASSERTION_KNOWN_INVALID',
    reason: 'CURRENCY_MISMATCH',
    sourceAssertionId: definePriceIntent.payload.sourceAssertion.sourceAssertionId,
  }),
);
const selectedPriceGroup = Schema.decodeUnknownSync(SymmyPinnedJobPlanSchema)({
  items: [{ effects: [priceDefinitionEffect(priceGroupA)], itemId: effect.itemId, itemKey: 'price-item' }],
  selector: {
    kind: 'PRICE_GROUP',
    source: {
      entityKind: 'PRICE_GROUP',
      issuerId: 'internal-ebs',
      route: { integrationRouteId: 'route-1', tenantId },
      sourceNamespace: 'price-lists',
      sourceRecordId: 'list-A',
    },
    target: priceGroupA,
  },
}).selector;
const priceGroupCreateIntent = Schema.decodeUnknownSync(SymmyCatalogPricingInventoryIntentSchema)({
  _tag: 'PriceGroupCreate',
  payload: {
    businessCode: 'INTERNAL_GROUP',
    classificationPurpose: 'Internal price classification',
    compatibilityContracts: [{ contractId: 'internal-contract', version: 1 }],
    description: 'Internal fixture definition',
    displayName: 'Internal Group',
    effectiveFrom: '2026-11-07T10:00:00.000Z',
    effectiveTo: null,
    expectedCatalogRevision: 0,
    reason: 'Explicit internal source definition',
    sourceCorrelation: {
      issuer: 'internal-ebs',
      mappingVersion: 'internal-1',
      namespace: 'price-lists',
      recordKey: 'list-A',
      routeId: 'route-1',
    },
  },
});
const groupParentInvocationId = '10000000-0000-4000-8000-000000000070';
const groupBusinessOriginalId = '10000000-0000-4000-8000-000000000071';
const groupParentEffect = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
  ...effect,
  effectKey: 'group-create',
  intent: materializeSymmyCatalogPricingInventorySourceOccurrence(priceGroupCreateIntent, 'occurrence-1'),
  itemId: '10000000-0000-4000-8000-000000000072',
  ref: {
    ...effect.ref,
    effectId: '10000000-0000-4000-8000-000000000073',
    occurrence: {
      occurrenceId: 'occurrence-1',
      record: {
        ...effect.ref.occurrence.record,
        entityKind: 'PRICE_GROUP',
        sourceNamespace: 'price-lists',
        sourceRecordId: 'list-A',
      },
    },
    operation: {
      entrypointKey: 'pricing.price-group-catalog.create-price-group',
      moduleId: 'pricing.price-group-catalog',
      schemaVersion: '1',
    },
  },
});
const groupParentState = {
  ...Schema.decodeUnknownSync(SymmyExecutionEffectStateSchema)({
    effect: groupParentEffect,
    outcome: {
      effectId: groupParentEffect.ref.effectId,
      originalStatus: 'accepted_change',
      owner: 'pricing.price-group-catalog',
      status: 'duplicate',
    },
    ownerInvocationId: groupParentInvocationId,
    ownerReceipt: {
      _tag: 'PriceGroupCreated',
      actionInvocationId: groupParentInvocationId,
      businessOriginalInvocationId: groupBusinessOriginalId,
      priceGroupRef: priceGroupA,
    },
    state: 'settled',
    version: 1,
  }),
  itemKey: 'group-item',
};
const dependentPriceEffect = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
  ...priceDefinitionEffect(priceGroupA),
  dependsOn: [{ effectKey: 'group-create', itemKey: 'group-item' }],
  intent: {
    _tag: 'PriceDefineFromGroupEffect',
    fromPriceGroupEffect: { effectKey: 'group-create', itemKey: 'group-item' },
    payload: {
      ...definePriceIntent.payload,
      identityKey: { ...definePriceIntent.payload.identityKey, priceGroupSelector: { kind: 'PRICE_GROUP' } },
    },
  },
  itemId: '10000000-0000-4000-8000-000000000074',
});
const groupOriginalReceipt = Schema.encodeSync(PriceGroupResultLookupResponseSchema)(
  Schema.decodeUnknownSync(PriceGroupResultLookupResponseSchema)({
    outcome: 'PRICE_GROUP_OPERATION_FOUND',
    receipt: {
      actionInvocationId: groupParentInvocationId,
      businessOriginalInvocationId: groupBusinessOriginalId,
      catalogRevision: 1,
      definitionRevisionId: '10000000-0000-4000-8000-000000000075',
      operationKind: 'CREATE_PRICE_GROUP',
      priceGroupRef: priceGroupA,
    },
  }),
);
const stockPositionRef = {
  moduleId: 'commerce.inventory',
  resourceId: '10000000-0000-4000-8000-000000000050',
  resourceType: 'commerce.inventory.stock-position',
  tenantId,
};
const stockEffectForBackend = (backendId: string) => {
  const issuer = { backendId, backendKind: 'external_business_system' };
  const commonKey = {
    customerConfigurationId: 'internal-customer-configuration',
    externalScope: 'internal-warehouse',
    issuer,
    namespace: 'internal-stock',
    tenantId,
  };
  return Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
    ...effect,
    intent: {
      _tag: 'InventoryImport',
      payload: {
        authorizationTargetRef: stockPositionRef,
        items: [
          {
            assertionId: '10000000-0000-4000-8000-000000000051',
            businessObservedAt: '2026-11-07T10:00:00.000Z',
            coverage: [],
            customerConfigurationId: 'internal-customer-configuration',
            factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
            issuer,
            itemExternalKey: { ...commonKey, externalValue: 'stock-item-1', identifierKind: 'ITEM' },
            locationExternalKey: { ...commonKey, externalValue: 'stock-location-1', identifierKind: 'LOCATION' },
            orderingEvidence: { _tag: 'SOURCE_REVISION', revision: '1' },
            ownerEvidenceRef: 'internal-explicit-observation',
            positionRef: stockPositionRef,
            quantity: { amount: '5', unitRef },
            receivedAt: '2026-11-07T10:00:00.000Z',
            sourceReference: 'internal-stock-observation-1',
          },
        ],
      },
    },
    ref: {
      ...effect.ref,
      occurrence: {
        ...effect.ref.occurrence,
        record: { ...effect.ref.occurrence.record, entityKind: 'STOCK', sourceRecordId: 'stock-observation-1' },
      },
      operation: {
        entrypointKey: 'commerce.inventory.import-source-assertion',
        moduleId: 'commerce.inventory',
        schemaVersion: '1',
      },
      originalTarget: stockPositionRef,
    },
  });
};
const authContextRef = `job:integration.symmy.execute-symmy-job:run:${invocationId}`;
const originalProof = Effect.fn('CpiAdapterFixture.originalProof')(function* proof(input: SymmyEffectAdapterInput) {
  const intent = yield* Schema.decodeUnknownEffect(SymmyCatalogPricingInventoryIntentSchema)(input.effect.intent);
  const requestHash = yield* prepareSymmyCatalogPricingInventoryRequestHash(
    intent,
    { principalId: executorId, tenantId },
    input.legalEntityId,
  );
  return {
    ...input,
    originalAuthContextRef: authContextRef,
    originalExecutorPrincipalId: executorId,
    originalRequestHash: requestHash,
  };
});

const configuration = ConfigProvider.fromEnvRecord({
  ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.example.test/shell-super-app-api',
});

const harness = (
  replay: boolean,
  selectedEffect = effect,
  lookupProductId = productId,
  lookupPriceGroup = priceGroupA,
  denyRecovery = false,
  priceWire?: {
    readonly assessment: typeof DefinePriceResultSchema.Encoded;
    readonly receipt: typeof PriceSourceResultLookupResponseSchema.Encoded;
  },
  groupReceipt?: typeof PriceGroupResultLookupResponseSchema.Encoded,
  variantBindingReceipt?: { readonly changed?: boolean },
) => {
  const requests: Request[] = [];
  const events: string[] = [];
  const receipts: SymmyOwnerReceipt[] = [];
  const resolvedEffects: SymmyPinnedEffect[] = [];
  let gatewayCount = 0;
  const fetch: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.url.includes('/auth/delegated/gateway-context')) {
      gatewayCount += 1;
      return Promise.resolve(
        Response.json({
          apiBaseUrl: '/catalog-api',
          compositionRevision,
          expiresAt: 1_700_000_300,
          machineContext: {
            authContextRef,
            bindingIncarnation: '10000000-0000-4000-8000-000000000008',
            principalId: executorId,
          },
          token: `assertion-${gatewayCount}`,
        }),
      );
    }
    if (request.url.includes('/reads/price-group-source-associations')) {
      events.push('owner-group-source-read');
      return Promise.resolve(
        Response.json({
          associations: [
            {
              priceGroupRef: lookupPriceGroup,
              sourceCorrelation: {
                issuer: 'internal-ebs',
                mappingVersion: 'internal-1',
                namespace: 'price-lists',
                recordKey: 'list-A',
                routeId: 'route-1',
              },
            },
          ],
          count: 1,
          limit: 2,
          offset: 0,
        }),
      );
    }
    if (groupReceipt !== undefined && request.url.includes('/reads/price-group-result-lookup')) {
      events.push('owner-group-recovery');
      return Promise.resolve(Response.json(groupReceipt));
    }
    if (priceWire !== undefined && request.url.includes('/actions/define-price')) {
      events.push('owner-price-write');
      return Promise.resolve(Response.json(priceWire.assessment));
    }
    if (priceWire !== undefined && request.url.includes('/reads/price-source-result-lookup')) {
      events.push('owner-price-recovery');
      return Promise.resolve(Response.json(priceWire.receipt));
    }
    if (request.url.includes('/reads/catalog-source-products')) {
      events.push('owner-source-read');
      return Promise.resolve(
        Response.json({
          items: [
            {
              entityKind: 'PRODUCT',
              originalActionInvocationId: invocationId,
              product: {
                ...result.product,
                productRef: { ...productRef, resourceId: lookupProductId },
                variants: result.product.variants.map((variant) => ({
                  ...variant,
                  productRef: { ...productRef, resourceId: lookupProductId },
                })),
              },
              source: sourceCorrelation,
              variantId,
              variantSources: [],
            },
          ],
          outcome: 'FOUND',
        }),
      );
    }
    events.push(request.url.includes('/reads/') ? 'owner-recovery' : 'owner-write');
    if (request.url.includes('/actions/import-source-assertion')) {
      return Promise.resolve(
        Response.json({
          items: [
            {
              assertionId: '10000000-0000-4000-8000-000000000051',
              postEffectOnHand: { amount: '5', unitRef },
              status: 'ACCEPTED',
            },
          ],
          summary: { accepted: 1, allItemsDeterminate: true, duplicates: 0, indeterminate: 0, rejected: 0, stale: 0 },
        }),
      );
    }

    if (denyRecovery && request.url.includes('/reads/create-product-recovery')) {
      const problem = CreateProductRecoveryForbiddenProblemSchema.make({
        detail: 'Internal current Read permission refusal',
        status: 403,
        title: 'Forbidden',
        type: 'https://ontos.dev/problems/forbidden',
      });
      return Promise.resolve(
        Response.json(Schema.encodeSync(CreateProductRecoveryForbiddenProblemSchema)(problem), {
          headers: { 'content-type': 'application/problem+json' },
          status: 403,
        }),
      );
    }

    if (replay && !request.url.includes('/reads/')) {
      const problem = CreateProductActionAlreadyCommittedProblemSchema.make({
        code: 'action_already_committed',
        detail: 'Internal original effect',
        invocationId,
        resolution: 'RECOVER_CREATE_PRODUCT',
        retryCommand: false,
        status: 409,
        title: 'Already committed',
        type: 'https://ontos.dev/problems/committed',
      });
      return Promise.resolve(
        Response.json(Schema.encodeSync(CreateProductActionAlreadyCommittedProblemSchema)(problem), {
          headers: { 'content-type': 'application/problem+json' },
          status: 409,
        }),
      );
    }
    if (request.url.includes('create-variant')) {
      return Promise.resolve(
        Response.json({
          businessOriginalCreateInvocationId: invocationId,
          variant: {
            lifecycle: 'WORK_IN_PROGRESS',
            productRef,
            variantId: newVariantRef.resourceId,
            variantRef: newVariantRef,
          },
        }),
      );
    }
    if (request.url.includes('bind-initial-variant-source')) {
      return Promise.resolve(
        Response.json({ ...variantBindingReceipt, originalCreateInvocationId: invocationId, productId, variantId }),
      );
    }
    return Promise.resolve(
      Response.json(request.url.includes('/actions/update-product') ? { ...result, changed: false } : result),
    );
  };
  const input: SymmyEffectAdapterInput = {
    admission: {
      actionInvocationId: invocationId,
      compositionRevision,
      sourceActionKey: 'integration.symmy.admit-symmy-sync',
      tenantId,
    },
    canExecuteNewEffects: true,
    dependencies: [],
    effect: selectedEffect,
    pricingSourceSystem,
    readOriginalActionInvocation: () =>
      Effect.succeed(Option.some({ actionInvocationId: invocationId, status: 'succeeded' })),
    recordInvocationId: (id) =>
      Effect.sync(() => {
        events.push(`invocation:${id}`);
      }),
    recordOwnerReceipt: (receipt) =>
      Effect.sync(() => {
        receipts.push(receipt);
      }),
    recordOwnerRequest: ({ executorPrincipalId }) =>
      Effect.sync(() => {
        events.push(`executor:${executorPrincipalId}`);
      }),
    recordResolvedEffect: (resolved) =>
      Effect.sync(() => {
        resolvedEffects.push(resolved);
        events.push('resolved-target');
      }),
  };
  const adapter = makeSymmyCatalogPricingInventoryAdapters.pipe(
    Effect.flatMap((adapters) => {
      const found = adapters.find(
        ({ operation }) => operation.entrypointKey === selectedEffect.ref.operation.entrypointKey,
      );
      return found === undefined ? Effect.die('Missing internal adapter') : Effect.succeed(found);
    }),
  );
  const provide = <A, E>(program: Effect.Effect<A, E, Crypto.Crypto>) =>
    // The Symmy integration holds its own module key, handed over the way the host does.
    holdTestModuleCredentials({ 'symmy-integration': 'internal-module-key' }).pipe(
      Effect.andThen(program),
      Effect.provide(NodeCrypto.layer),
      Effect.provideService(ConfigProvider.ConfigProvider, configuration),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
  return { adapter, events, input, provide, receipts, requests, resolvedEffects };
};

const gatewayRequestsFor = Effect.fn('CpiAdapterFixture.gatewayRequests')(function* gatewayRequests(
  requests: readonly Request[],
) {
  return yield* Effect.forEach(
    requests.filter((request) => request.url.includes('/auth/delegated/gateway-context')),
    Effect.fn('CpiAdapterFixture.decodeGatewayRequest')(function* decodeRequest(request) {
      const json = yield* Effect.promise(() => request.clone().text());
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(GatewayDelegatedContextRequestSchema))(json);
    }),
  );
});

describe('Symmy native public owner adapter transport', () => {
  it.effect('requires a fresh postcommit native fact for Stock instead of an admission-time absent snapshot', () => {
    const h = harness(false, stockEffectForBackend('native-backend-A'));
    return h.provide(
      Effect.gen(function* test() {
        const adapter = yield* h.adapter;
        const outcome = yield* adapter.execute({
          ...h.input,
          inventoryBackendId: 'native-backend-A',
          readOriginalActionInvocation: () =>
            Effect.succeed(
              h.events.includes('owner-write')
                ? Option.some({ actionInvocationId: invocationId, status: 'succeeded' })
                : Option.none(),
            ),
        });
        expect(outcome.status).toBe('accepted_change');
        expect(h.events.indexOf(`invocation:${invocationId}`)).toBeGreaterThan(h.events.indexOf('owner-write'));
        const stale = harness(false, stockEffectForBackend('native-backend-A'));
        const rejected = yield* stale.provide(
          Effect.gen(function* staleFact() {
            const staleAdapter = yield* stale.adapter;
            return yield* Effect.exit(
              staleAdapter.execute({
                ...stale.input,
                inventoryBackendId: 'native-backend-A',
                readOriginalActionInvocation: () => Effect.succeed(Option.none()),
              }),
            );
          }),
        );
        expect(Exit.isFailure(rejected)).toBe(true);
        expect(stale.events.filter((event) => event === 'owner-write')).toHaveLength(1);
        expect(stale.events.some((event) => event.startsWith('invocation:'))).toBe(false);
      }),
    );
  });
  it.effect(
    'names exact conditional providers independently for the Product command and protected recovery Read',
    () => {
      const h = harness(true);
      return h.provide(
        Effect.gen(function* test() {
          const adapter = yield* h.adapter;
          yield* adapter.execute(h.input);
          const exchanges = yield* gatewayRequestsFor(h.requests);
          expect(exchanges.map(({ subject }) => subject)).toMatchObject([
            {
              _tag: 'RegisteredAdmission',
              operationRequirementKey: 'integration.symmy.requirement.admission.commerce.catalog.create-product',
            },
            {
              _tag: 'RegisteredRecovery',
              operationRequirementKey:
                'integration.symmy.requirement.admission.commerce.catalog.api.create-product-recovery',
            },
          ]);
        }),
      );
    },
  );
  it.effect('uses the exact source Read provider rather than guessing a provider from its declaration', () => {
    const h = harness(false, updateEffect);
    return h.provide(
      Effect.gen(function* test() {
        const adapter = yield* h.adapter;
        yield* adapter.execute(h.input);
        const exchanges = yield* gatewayRequestsFor(h.requests);
        expect(exchanges.map(({ subject }) => subject)).toMatchObject([
          {
            operationRequirementKey:
              'integration.symmy.requirement.admission.commerce.catalog.api.catalog-source-products',
          },
          { operationRequirementKey: 'integration.symmy.requirement.admission.commerce.catalog.update-product' },
        ]);
      }),
    );
  });
  it.effect('keeps PG source lookup, Price write and immutable Price receipt conditional providers distinct', () => {
    const h = harness(false, dependentPriceEffect, productId, priceGroupA, false, {
      assessment: canonicalPriceAssessment,
      receipt: originalPriceReceipt('CREATED'),
    });
    return h.provide(
      Effect.gen(function* test() {
        const adapter = yield* h.adapter;
        yield* adapter.execute({ ...h.input, dependencies: [groupParentState], legalEntityId });
        const exchanges = yield* gatewayRequestsFor(h.requests);
        expect(exchanges.map(({ subject }) => subject)).toMatchObject([
          {
            operationRequirementKey:
              'integration.symmy.requirement.admission.pricing.price-group-catalog.api.price-group-source-associations',
          },
          { operationRequirementKey: 'integration.symmy.requirement.admission.commerce.pricing.define-price' },
          {
            operationRequirementKey:
              'integration.symmy.requirement.admission.commerce.pricing.api.price-source-result-lookup',
          },
        ]);
      }),
    );
  });
  it.effect('captures the exact immutable PG receipt with distinct current and business original IDs', () => {
    const h = harness(false, groupParentEffect, productId, priceGroupA, false, undefined, groupOriginalReceipt);
    return h.provide(
      Effect.gen(function* test() {
        const adapter = yield* h.adapter;
        const original = yield* originalProof(h.input);
        const recovered = yield* adapter.recover({
          ...original,
          canExecuteNewEffects: false,
          originalInvocationId: groupParentInvocationId,
          readOriginalActionInvocation: () =>
            Effect.succeed(Option.some({ actionInvocationId: groupParentInvocationId, status: 'succeeded' })),
        });
        expect(recovered).toMatchObject({ outcome: { status: 'duplicate' }, status: 'settled' });
        expect(h.receipts).toEqual([
          {
            _tag: 'PriceGroupCreated',
            actionInvocationId: groupParentInvocationId,
            businessOriginalInvocationId: groupBusinessOriginalId,
            priceGroupRef: priceGroupA,
          },
        ]);
        expect(h.events).toEqual(['owner-group-recovery']);
      }),
    );
  });
  it.effect('pins only the named parent native PG reference before hashing or dispatching a dependent Price', () => {
    const h = harness(false, dependentPriceEffect, productId, priceGroupA, false, {
      assessment: canonicalPriceAssessment,
      receipt: originalPriceReceipt('CREATED'),
    });
    return h.provide(
      Effect.gen(function* test() {
        const adapter = yield* h.adapter;
        const outcome = yield* adapter.execute({
          ...h.input,
          dependencies: [{ ...groupParentState, itemKey: 'decoy-group-item' }, groupParentState],
          legalEntityId,
          routeKey: 'priceListsBatchUpsert',
        });
        expect(outcome.status).toBe('accepted_change');
        const pinned = yield* Schema.decodeUnknownEffect(SymmyPinnedEffectSchema)(h.resolvedEffects[0]);
        const intent = yield* Schema.decodeUnknownEffect(SymmyCatalogPricingInventoryIntentSchema.members[7])(
          pinned.intent,
        );
        expect(intent.payload.identityKey.priceGroupSelector).toEqual({
          kind: 'PRICE_GROUP',
          priceGroupRef: priceGroupA,
        });
        expect(pinned.ref.originalTarget).toEqual(priceRef);
        expect(h.events.indexOf('resolved-target')).toBeLessThan(h.events.indexOf(`executor:${executorId}`));
        expect(h.events.indexOf('resolved-target')).toBeLessThan(h.events.indexOf('owner-price-write'));
        const original = yield* originalProof({ ...h.input, effect: pinned, legalEntityId });
        const recovered = yield* adapter.recover({
          ...original,
          canExecuteNewEffects: false,
          dependencies: [],
          originalInvocationId: invocationId,
        });
        expect(recovered).toMatchObject({ outcome: { status: 'accepted_change' }, status: 'settled' });
        expect(h.events.filter((event) => event === 'owner-group-source-read')).toHaveLength(1);
        expect(h.events.filter((event) => event === 'owner-price-write')).toHaveLength(1);
      }),
    );
  });
  it.effect('makes no owner call when a deferred Price has no exact named committed PG receipt', () => {
    const h = harness(false, dependentPriceEffect);
    return h.provide(
      Effect.gen(function* test() {
        const adapter = yield* h.adapter;
        const outcome = yield* Effect.exit(
          adapter.execute({
            ...h.input,
            dependencies: [{ ...groupParentState, itemKey: 'another-group' }],
            legalEntityId,
          }),
        );
        expect(Exit.isFailure(outcome)).toBe(true);
        expect(h.requests).toHaveLength(0);
      }),
    );
  });
  it.effect(
    'rejects a deferred Price when the live qualified PG source binding differs from its parent receipt',
    () => {
      const h = harness(false, dependentPriceEffect, productId, priceGroupB);
      return h.provide(
        Effect.gen(function* test() {
          const adapter = yield* h.adapter;
          const outcome = yield* Effect.exit(
            adapter.execute({ ...h.input, dependencies: [groupParentState], legalEntityId }),
          );
          expect(Exit.isFailure(outcome)).toBe(true);
          expect(h.events).toEqual(['owner-group-source-read']);
          expect(h.resolvedEffects).toHaveLength(0);
        }),
      );
    },
  );
  it.effect('does not dispatch dependent Price when immutable resolved-plan persistence fails', () => {
    const h = harness(false, dependentPriceEffect);
    return h.provide(
      Effect.gen(function* test() {
        const adapter = yield* h.adapter;
        const outcome = yield* Effect.exit(
          adapter.execute({
            ...h.input,
            dependencies: [groupParentState],
            legalEntityId,
            recordResolvedEffect: () => Effect.fail(symmyJobWorkerUnavailable()),
          }),
        );
        expect(Exit.isFailure(outcome)).toBe(true);
        expect(h.events).toEqual(['owner-group-source-read']);
        expect(h.requests.some((request) => request.url.includes('/actions/'))).toBe(false);
      }),
    );
  });
  it.effect('settles the actual native known-invalid currency assessment as invalid', () => {
    const h = harness(false, priceDefinitionEffect(priceGroupA), productId, priceGroupA, false, {
      assessment: negativePriceAssessment,
      receipt: unavailablePriceReceipt,
    });
    return h.provide(
      Effect.gen(function* test() {
        const adapter = yield* h.adapter;
        const outcome = yield* adapter.execute({ ...h.input, legalEntityId });
        expect(outcome.status).toBe('invalid');
        expect(h.events).toContain('owner-price-write');
        expect(h.events).not.toContain('owner-price-recovery');
      }),
    );
  });
  it.effect(
    'resolves a canonical native ACK through the exact immutable receipt instead of guessing whether it changed Price',
    () => {
      const h = harness(false, priceDefinitionEffect(priceGroupA), productId, priceGroupA, false, {
        assessment: canonicalPriceAssessment,
        receipt: originalPriceReceipt('CREATED'),
      });
      return h.provide(
        Effect.gen(function* test() {
          const adapter = yield* h.adapter;
          const outcome = yield* adapter.execute({ ...h.input, legalEntityId });
          expect(outcome.status).toBe('accepted_change');
          expect(h.events).toContain('owner-price-recovery');
          expect(h.requests.filter((request) => request.url.includes('/actions/define-price'))).toHaveLength(1);
        }),
      );
    },
  );
  it.effect('recovers the original reused Price receipt after write revocation without issuing any command', () => {
    const h = harness(false, priceDefinitionEffect(priceGroupA), productId, priceGroupA, false, {
      assessment: canonicalPriceAssessment,
      receipt: originalPriceReceipt('REUSED'),
    });
    return h.provide(
      Effect.gen(function* test() {
        const adapter = yield* h.adapter;
        const original = yield* originalProof({ ...h.input, legalEntityId });
        const assessmentResult = yield* adapter.recover({
          ...original,
          canExecuteNewEffects: false,
          originalInvocationId: invocationId,
        });
        expect(assessmentResult).toMatchObject({ outcome: { status: 'accepted_no_change' }, status: 'settled' });
        expect(h.events).toEqual(['owner-price-recovery']);
        expect(h.requests.some((request) => request.url.includes('/actions/'))).toBe(false);
      }),
    );
  });
  it.effect('keeps a lost negative ACK indeterminate when Core succeeded but no immutable owner receipt exists', () => {
    const h = harness(false, priceDefinitionEffect(priceGroupA), productId, priceGroupA, false, {
      assessment: negativePriceAssessment,
      receipt: unavailablePriceReceipt,
    });
    return h.provide(
      Effect.gen(function* test() {
        const adapter = yield* h.adapter;
        const original = yield* originalProof({ ...h.input, legalEntityId });
        const assessmentResult = yield* Effect.exit(
          adapter.recover({ ...original, canExecuteNewEffects: false, originalInvocationId: invocationId }),
        );
        expect(Exit.isFailure(assessmentResult)).toBe(true);
        expect(h.events).toEqual(['owner-price-recovery']);
        expect(h.requests.some((request) => request.url.includes('/actions/'))).toBe(false);
      }),
    );
  });
  it.effect('distinguishes invalid, held and unavailable native assessments from uncertain commits', () =>
    Effect.gen(function* test() {
      const inputs = [
        {
          expected: 'unresolved',
          wire: {
            outcome: 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD',
            reason: 'MAPPING_UNRESOLVED',
            sourceAssertionId: definePriceIntent.payload.sourceAssertion.sourceAssertionId,
          },
        },
        {
          expected: 'unavailable',
          wire: {
            dependency: 'MAPPING_REGISTRY',
            outcome: 'PRICE_SOURCE_ASSERTION_DEPENDENCY_UNAVAILABLE',
            retryable: true,
            sourceAssertionId: definePriceIntent.payload.sourceAssertion.sourceAssertionId,
          },
        },
        {
          expected: 'invalid',
          wire: negativePriceAssessment,
        },
      ];
      for (const input of inputs) {
        const assessment = yield* Schema.decodeUnknownEffect(DefinePriceResultSchema)(input.wire);
        const encoded = yield* Schema.encodeEffect(DefinePriceResultSchema)(assessment);
        const h = harness(false, priceDefinitionEffect(priceGroupA), productId, priceGroupA, false, {
          assessment: encoded,
          receipt: unavailablePriceReceipt,
        });
        const outcome = yield* h.provide(
          Effect.gen(function* attempt() {
            const adapter = yield* h.adapter;
            return yield* adapter.execute({ ...h.input, legalEntityId });
          }),
        );
        expect(outcome.status).toBe(input.expected);
        expect(h.events).not.toContain('owner-price-recovery');
      }
    }),
  );
  it.effect('rejects an unconfigured native Price source-system pair before any owner request', () => {
    const h = harness(false, priceDefinitionEffect(priceGroupA), productId, priceGroupA, false, {
      assessment: canonicalPriceAssessment,
      receipt: originalPriceReceipt('CREATED'),
    });
    return h.provide(
      Effect.gen(function* test() {
        const adapter = yield* h.adapter;
        const assessmentResult = yield* Effect.exit(
          adapter.execute({
            ...h.input,
            legalEntityId,
            pricingSourceSystem: { ...pricingSourceSystem, sourceSystemRef: 'another-semantic-source' },
          }),
        );
        expect(Exit.isFailure(assessmentResult)).toBe(true);
        const { pricingSourceSystem: configuredSource, ...withoutSource } = h.input;
        expect(configuredSource).toEqual(pricingSourceSystem);
        const absentSource = yield* Effect.exit(adapter.execute({ ...withoutSource, legalEntityId }));
        expect(Exit.isFailure(absentSource)).toBe(true);
        expect(h.requests).toHaveLength(0);
      }),
    );
  });
  it.effect(
    'pins the actual fresh machine executor before the native write and preserves the effect idempotency key',
    () => {
      const h = harness(false);
      return h.provide(
        Effect.gen(function* test() {
          const adapter = yield* h.adapter;
          const outcome = yield* adapter.execute(h.input);
          expect(outcome.status).toBe('accepted_change');
          expect(h.events).toEqual([`executor:${executorId}`, 'owner-write', `invocation:${invocationId}`]);
          expect(h.receipts).toHaveLength(1);
          expect(h.requests[1]?.headers.get('idempotency-key')).toBe(effectId);
          expect(h.requests[1]?.headers.get('authorization')).toBe('Bearer assertion-1');
        }),
      );
    },
  );

  it.effect(
    'persists an original committed invocation and acquires a second assertion for its protected recovery read',
    () => {
      const h = harness(true);
      return h.provide(
        Effect.gen(function* test() {
          const adapter = yield* h.adapter;
          const outcome = yield* adapter.execute(h.input);
          expect(outcome.status).toBe('accepted_change');
          expect(h.events).toEqual([
            `executor:${executorId}`,
            'owner-write',
            `invocation:${invocationId}`,
            'owner-recovery',
          ]);
          expect(h.requests[3]?.headers.get('authorization')).toBe('Bearer assertion-2');
        }),
      );
    },
  );

  it.effect(
    'does not replay an uncertain command when the original executor or current source authority is missing',
    () => {
      const h = harness(false);
      return h.provide(
        Effect.gen(function* test() {
          const adapter = yield* h.adapter;
          const recovery = yield* adapter.recover({
            ...h.input,
            canExecuteNewEffects: false,
            originalExecutorPrincipalId: executorId,
          });
          expect(recovery.status).toBe('unavailable');
          expect(h.requests).toHaveLength(0);
          const rejected = yield* Effect.exit(adapter.execute({ ...h.input, canExecuteNewEffects: false }));
          expect(Exit.isFailure(rejected)).toBe(true);
          expect(h.requests).toHaveLength(0);
        }),
      );
    },
  );
  it.effect(
    'looks up the original invocation and recovers it without reissuing a command after source writes are revoked',
    () => {
      const h = harness(true);
      return h.provide(
        Effect.gen(function* test() {
          const adapter = yield* h.adapter;
          const original = yield* originalProof(h.input);
          const recovery = yield* adapter.recover({ ...original, canExecuteNewEffects: false });
          expect(recovery.status).toBe('settled');
          expect(h.requests[1]?.url).toContain('/reads/create-product-recovery');
          expect(h.events).toEqual([`invocation:${invocationId}`, 'owner-recovery']);
        }),
      );
    },
  );
  it.effect(
    'verifies the exact qualified source binding before an existing Product write with separate fresh assertions',
    () => {
      const h = harness(false, updateEffect);
      return h.provide(
        Effect.gen(function* test() {
          const adapter = yield* h.adapter;
          const outcome = yield* adapter.execute(h.input);
          expect(outcome.status).toBe('accepted_no_change');
          expect(h.events).toEqual([
            'owner-source-read',
            `executor:${executorId}`,
            'owner-write',
            `invocation:${invocationId}`,
          ]);
          expect(h.requests[1]?.headers.get('authorization')).toBe('Bearer assertion-1');
          expect(h.requests[3]?.headers.get('authorization')).toBe('Bearer assertion-2');
        }),
      );
    },
  );
  it.effect(
    'does not write to an existing native target when the owner source binding resolves to another Product',
    () => {
      const h = harness(false, updateEffect, '10000000-0000-4000-8000-000000000099');
      return h.provide(
        Effect.gen(function* test() {
          const adapter = yield* h.adapter;
          const outcome = yield* adapter.execute(h.input);
          expect(outcome.status).toBe('unresolved');
          expect(h.events).toEqual(['owner-source-read']);
          expect(h.requests).toHaveLength(2);
        }),
      );
    },
  );
  it.effect('pins a dependent Variant to the exact named parent receipt before its first native command', () => {
    const h = harness(false, dependentVariantEffect);
    return h.provide(
      Effect.gen(function* test() {
        const adapter = yield* h.adapter;
        const outcome = yield* adapter.execute({
          ...h.input,
          dependencies: [{ ...parentState, itemKey: 'decoy-item' }, parentState],
        });
        expect(outcome.status).toBe('accepted_change');
        expect(h.resolvedEffects).toHaveLength(1);
        const [resolved] = h.resolvedEffects;
        expect(resolved?.ref.originalTarget).toEqual(productRef);
        expect(h.events).toEqual([
          'owner-source-read',
          'resolved-target',
          'owner-source-read',
          `executor:${executorId}`,
          'owner-write',
          `invocation:${invocationId}`,
        ]);
        expect(h.receipts).toHaveLength(1);
      }),
    );
  });
  it.effect('does not invent a parent Product reference when the canonical parent receipt is absent', () => {
    const h = harness(false, dependentVariantEffect);
    return h.provide(
      Effect.gen(function* test() {
        const adapter = yield* h.adapter;
        const outcome = yield* Effect.exit(adapter.execute({ ...h.input, dependencies: [] }));
        expect(Exit.isFailure(outcome)).toBe(true);
        expect(h.resolvedEffects).toHaveLength(0);
        expect(h.requests).toHaveLength(0);
      }),
    );
  });
  it.effect(
    'rejects a parent receipt whose original Create invocation does not match the immutable source binding',
    () => {
      const h = harness(false, dependentVariantEffect);
      const wrongParent = {
        ...parentState,
        ownerReceipt: Option.some(
          Schema.decodeUnknownSync(SymmyCatalogPricingInventoryReceiptSchema.members[0])({
            _tag: 'ProductCreated',
            actionInvocationId: '10000000-0000-4000-8000-000000000099',
            initialVariantRef: variantRef,
            productRef,
          }),
        ),
      };
      return h.provide(
        Effect.gen(function* test() {
          const adapter = yield* h.adapter;
          const outcome = yield* Effect.exit(adapter.execute({ ...h.input, dependencies: [wrongParent] }));
          expect(Exit.isFailure(outcome)).toBe(true);
          expect(h.resolvedEffects).toHaveLength(0);
          expect(h.events).toEqual(['owner-source-read']);
        }),
      );
    },
  );
  it.effect('does not call a native command when durable resolved-target persistence fails', () => {
    const h = harness(false, dependentVariantEffect);
    return h.provide(
      Effect.gen(function* test() {
        const adapter = yield* h.adapter;
        const outcome = yield* Effect.exit(
          adapter.execute({
            ...h.input,
            dependencies: [parentState],
            recordResolvedEffect: () => Effect.fail(symmyJobWorkerUnavailable()),
          }),
        );
        expect(Exit.isFailure(outcome)).toBe(true);
        expect(h.events).toEqual(['owner-source-read']);
      }),
    );
  });
  it.effect.each([effect, updateEffect])(
    'rejects a Price source occurrence for a Catalog Product write even when the qualified correlation matches',
    (productEffect) => {
      const priceSource = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
        ...productEffect,
        ref: {
          ...productEffect.ref,
          occurrence: {
            ...productEffect.ref.occurrence,
            record: { ...productEffect.ref.occurrence.record, entityKind: 'PRICE' },
          },
        },
      });
      const h = harness(false, priceSource);
      return h.provide(
        Effect.gen(function* test() {
          const adapter = yield* h.adapter;
          expect(Exit.isFailure(yield* Effect.exit(adapter.execute(h.input)))).toBe(true);
          expect(h.requests).toHaveLength(0);
        }),
      );
    },
  );
  it.effect.each([
    { receipt: { changed: true }, status: 'accepted_change' },
    { receipt: { changed: false }, status: 'accepted_no_change' },
    { receipt: {}, status: 'unresolved' },
  ])('preserves the initial Variant binding result in native dispatch and original recovery', ({ receipt, status }) => {
    const h = harness(false, bindInitialVariantEffect, productId, priceGroupA, false, undefined, undefined, receipt);
    return h.provide(
      Effect.gen(function* test() {
        const adapter = yield* h.adapter;
        const outcome = yield* adapter.execute(h.input);
        const original = yield* originalProof(h.input);
        const recovered = yield* adapter.recover({
          ...original,
          canExecuteNewEffects: false,
          originalInvocationId: invocationId,
        });
        expect(outcome.status).toBe(status);
        expect(recovered).toMatchObject({ outcome: { status }, status: 'settled' });
        expect(h.events.filter((event) => event === 'owner-write')).toHaveLength(1);
        expect(h.events.filter((event) => event === 'owner-recovery')).toHaveLength(1);
      }),
    );
  });
  it.effect(
    'recovers the frozen dependent Variant directly from its original owner receipt after new writes are blocked',
    () => {
      const frozen = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
        ...dependentVariantEffect,
        intent: {
          _tag: 'CatalogCreateVariant',
          payload: {
            classification: {
              affectsOpenSelection: true,
              evidenceRefs: ['internal-realization-proof'],
              kind: 'NEW_REALIZATION',
              newVariantRef,
              productRef,
              reason: 'Explicit additional realization',
            },
            evidenceRefs: ['internal-realization-proof'],
            expectedProductRevision: 1,
            productRef,
            reason: 'Explicit additional realization',
            sourceCorrelation: { ...sourceCorrelation, recordId: 'variant-2' },
            variantRef: newVariantRef,
          },
          productSource: sourceCorrelation,
        },
        ref: { ...dependentVariantEffect.ref, originalTarget: productRef },
      });
      const h = harness(false, frozen);
      return h.provide(
        Effect.gen(function* test() {
          const adapter = yield* h.adapter;
          const original = yield* originalProof(h.input);
          const recovery = yield* adapter.recover({
            ...original,
            canExecuteNewEffects: false,
            dependencies: [],
            originalExecutorPrincipalId: executorId,
            originalInvocationId: invocationId,
          });
          expect(recovery.status).toBe('settled');
          expect(h.events).toEqual(['owner-recovery']);
          expect(h.resolvedEffects).toHaveLength(0);
          expect(h.receipts).toHaveLength(1);
        }),
      );
    },
  );
  it.effect(
    'rejects a body Price Group that differs from the trusted code-selected native target before any owner request',
    () => {
      const h = harness(false, priceDefinitionEffect(priceGroupB));
      return h.provide(
        Effect.gen(function* test() {
          if (selectedPriceGroup === undefined) {
            return yield* Effect.die('Missing configured Price Group fixture');
          }
          const adapter = yield* h.adapter;
          const outcome = yield* adapter.execute({ ...h.input, legalEntityId, selector: selectedPriceGroup });
          expect(outcome.status).toBe('unresolved');
          expect(h.requests).toHaveLength(0);
          return yield* Effect.void;
        }),
      );
    },
  );
  it.effect('rejects a configured code whose exact source association resolves to another native Price Group', () => {
    const h = harness(false, priceDefinitionEffect(priceGroupA), productId, priceGroupB);
    return h.provide(
      Effect.gen(function* test() {
        if (selectedPriceGroup === undefined) {
          return yield* Effect.die('Missing configured Price Group fixture');
        }
        const adapter = yield* h.adapter;
        const outcome = yield* adapter.execute({ ...h.input, legalEntityId, selector: selectedPriceGroup });
        expect(outcome.status).toBe('unresolved');
        expect(h.events).toEqual(['owner-group-source-read']);
        expect(h.requests).toHaveLength(2);
        return yield* Effect.void;
      }),
    );
  });
  it.effect.each(['priceListsBatchUpsert', 'priceListPricesBatch'] as const)(
    'rejects a persisted direct Price command without a qualified list binding before owner dispatch',
    (routeKey) => {
      const h = harness(false, priceDefinitionEffect(priceGroupB), productId, priceGroupA, false, {
        assessment: canonicalPriceAssessment,
        receipt: originalPriceReceipt('CREATED'),
      });
      return h.provide(
        Effect.gen(function* test() {
          const adapter = yield* h.adapter;
          const outcome = yield* adapter.execute({ ...h.input, legalEntityId, routeKey });
          expect(outcome.status).toBe('unresolved');
          expect(h.requests).toHaveLength(0);
        }),
      );
    },
  );
  it.effect.each([
    { group: priceGroupA, status: 'accepted_change', writes: 1 },
    { group: priceGroupB, status: 'unresolved', writes: 0 },
  ])(
    'rechecks a resumed Price command against the admitted parent and owner association',
    ({ group, status, writes }) => {
      const materialized = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
        ...dependentPriceEffect,
        intent: priceDefinitionEffect(group).intent,
      });
      const acceptedPlan = Schema.decodeUnknownSync(SymmyPinnedJobPlanSchema)({
        items: [
          { effects: [groupParentEffect], itemId: groupParentEffect.itemId, itemKey: 'group-item' },
          { effects: [dependentPriceEffect], itemId: dependentPriceEffect.itemId, itemKey: 'price-item' },
        ],
      });
      const h = harness(false, materialized, productId, priceGroupA, false, {
        assessment: canonicalPriceAssessment,
        receipt: originalPriceReceipt('CREATED'),
      });
      return h.provide(
        Effect.gen(function* test() {
          const adapter = yield* h.adapter;
          const outcome = yield* adapter.execute({
            ...h.input,
            acceptedPlan,
            dependencies: [groupParentState],
            legalEntityId,
            routeKey: 'priceListsBatchUpsert',
          });
          expect(outcome.status).toBe(status);
          expect(h.events.filter((event) => event === 'owner-group-source-read')).toHaveLength(1);
          expect(h.events.filter((event) => event === 'owner-price-write')).toHaveLength(writes);
          expect(h.resolvedEffects).toHaveLength(0);
        }),
      );
    },
  );
  it.effect('keeps a known committed effect indeterminate when its current protected receipt Read is forbidden', () => {
    const h = harness(false, effect, productId, priceGroupA, true);
    return h.provide(
      Effect.gen(function* test() {
        const adapter = yield* h.adapter;
        const original = yield* originalProof(h.input);
        const error = yield* adapter
          .recover({ ...original, canExecuteNewEffects: false, originalInvocationId: invocationId })
          .pipe(Effect.flip);
        expect(error.code).toBe('symmy_job_worker_unavailable');
        expect(h.events).toEqual(['owner-recovery']);
        expect(h.receipts).toHaveLength(0);
      }),
    );
  });
  it.effect(
    'treats invisible original invocation facts as same-key retry eligibility rather than proof of no commit',
    () => {
      const h = harness(false);
      return h.provide(
        Effect.gen(function* test() {
          const adapter = yield* h.adapter;
          const original = yield* originalProof(h.input);
          const active = yield* adapter.recover({
            ...original,
            readOriginalActionInvocation: () => Effect.succeed(Option.none()),
          });
          expect(active.status).toBe('retry_original_key');
          const revoked = yield* adapter.recover({
            ...original,
            canExecuteNewEffects: false,
            readOriginalActionInvocation: () => Effect.succeed(Option.none()),
          });
          expect(revoked.status).toBe('unavailable');
          expect(h.requests).toHaveLength(0);
        }),
      );
    },
  );
  it.effect(
    'keeps a new Core call ID separate from the business original when another job replays the same source occurrence',
    () => {
      const newCoreId = '10000000-0000-4000-8000-000000000040';
      const nextEffect = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
        ...effect,
        ref: { ...effect.ref, effectId: '10000000-0000-4000-8000-000000000041' },
      });
      const h = harness(false, nextEffect);
      return h.provide(
        Effect.gen(function* test() {
          const adapter = yield* h.adapter;
          const outcome = yield* adapter.execute({
            ...h.input,
            readOriginalActionInvocation: () =>
              Effect.succeed(Option.some({ actionInvocationId: newCoreId, status: 'succeeded' })),
          });
          expect(outcome.status).toBe('duplicate');
          expect(h.events).toContain(`invocation:${newCoreId}`);
          expect(h.events).not.toContain(`invocation:${invocationId}`);
          const [receipt] = h.receipts;
          if (Schema.is(SymmyCatalogPricingInventoryReceiptSchema.members[0])(receipt)) {
            expect(receipt.actionInvocationId).toBe(invocationId);
          }
          expect(h.receipts).toHaveLength(1);
        }),
      );
    },
  );
  it.effect(
    'classifies replayed Variant creation from its business receipt while retaining the current Core invocation',
    () => {
      const currentInvocationId = '10000000-0000-4000-8000-000000000042';
      const h = harness(false, dependentVariantEffect);
      return h.provide(
        Effect.gen(function* test() {
          const adapter = yield* h.adapter;
          const outcome = yield* adapter.execute({
            ...h.input,
            dependencies: [parentState],
            readOriginalActionInvocation: () =>
              Effect.succeed(Option.some({ actionInvocationId: currentInvocationId, status: 'succeeded' })),
          });
          expect(outcome.status).toBe('duplicate');
          expect(h.events).toContain(`invocation:${currentInvocationId}`);
          expect(h.events).not.toContain(`invocation:${invocationId}`);
          const resolved = yield* Schema.decodeUnknownEffect(SymmyPinnedEffectSchema)(h.resolvedEffects[0]);
          const original = yield* originalProof({ ...h.input, effect: resolved });
          const recovered = yield* adapter.recover({
            ...original,
            canExecuteNewEffects: false,
            originalInvocationId: currentInvocationId,
            readOriginalActionInvocation: () =>
              Effect.succeed(Option.some({ actionInvocationId: currentInvocationId, status: 'succeeded' })),
          });
          expect(recovered.status).toBe('settled');
          if (recovered.status === 'settled') {
            expect(recovered.outcome.status).toBe('duplicate');
          }
          expect(h.receipts).toHaveLength(2);
        }),
      );
    },
  );
  it.effect('pins Catalog command occurrence without replacing the distinct parent Product source evidence', () =>
    Effect.gen(function* test() {
      const product = yield* Schema.decodeUnknownEffect(SymmyCatalogPricingInventoryIntentSchema.members[0])({
        _tag: 'CatalogCreateProduct',
        payload: {
          name: 'Internal Product',
          sourceCorrelation: {
            issuerId: 'internal-ebs',
            mappingRevision: 'internal-1',
            recordId: 'product-1',
            recordNamespace: 'catalog',
            routeScope: 'route-1',
          },
        },
      });
      const materialized = materializeSymmyCatalogPricingInventorySourceOccurrence(product, 'occurrence-1');
      const parsed = yield* Schema.decodeUnknownEffect(SymmyCatalogPricingInventoryIntentSchema.members[0])(
        materialized,
      );
      expect(parsed.payload.sourceCorrelation?.sourceOccurrenceId).toBe('occurrence-1');
      const variant = yield* Schema.decodeUnknownEffect(SymmyCatalogPricingInventoryIntentSchema.members[10])(
        dependentVariantEffect.intent,
      );
      const pinned = materializeSymmyCatalogPricingInventorySourceOccurrence(
        {
          ...variant,
          payload: {
            ...variant.payload,
            sourceCorrelation: {
              issuerId: 'internal-ebs',
              mappingRevision: 'internal-1',
              recordId: 'variant-2',
              recordNamespace: 'catalog',
              routeScope: 'route-1',
            },
          },
          productSource: { ...sourceCorrelation, sourceOccurrenceId: 'parent-original-occurrence' },
        },
        'occurrence-1',
      );
      const dependent = yield* Schema.decodeUnknownEffect(SymmyCatalogPricingInventoryIntentSchema.members[10])(pinned);
      expect(dependent.payload.sourceCorrelation?.sourceOccurrenceId).toBe('occurrence-1');
      expect(dependent.productSource.sourceOccurrenceId).toBe('parent-original-occurrence');
    }),
  );
  it.effect('preserves a mismatched Catalog occurrence and rejects it before any owner request', () =>
    Effect.gen(function* test() {
      const native = yield* Schema.decodeUnknownEffect(SymmyCatalogPricingInventoryIntentSchema.members[0])(
        effect.intent,
      );
      const materialized = materializeSymmyCatalogPricingInventorySourceOccurrence(
        {
          ...native,
          payload: {
            ...native.payload,
            sourceCorrelation: { ...sourceCorrelation, sourceOccurrenceId: 'wrong-occurrence' },
          },
        },
        'occurrence-1',
      );
      const scoped = yield* Schema.decodeUnknownEffect(SymmyPinnedEffectSchema)({ ...effect, intent: materialized });
      const h = harness(false, scoped);
      yield* h.provide(
        Effect.gen(function* attempt() {
          const adapter = yield* h.adapter;
          const outcome = yield* Effect.exit(adapter.execute(h.input));
          expect(Exit.isFailure(outcome)).toBe(true);
          expect(h.requests).toHaveLength(0);
        }),
      );
    }),
  );
  it.effect('materializes only the missing native PG occurrence from the explicit source occurrence fact', () =>
    Effect.gen(function* test() {
      const materialized = materializeSymmyCatalogPricingInventorySourceOccurrence(
        priceGroupCreateIntent,
        'occurrence-1',
      );
      const parsed = yield* Schema.decodeUnknownEffect(SymmyCatalogPricingInventoryIntentSchema.members[5])(
        materialized,
      );
      expect(parsed.payload.sourceCorrelation?.sourceOccurrenceId).toBe('occurrence-1');
      expect(parsed.payload.sourceCorrelation?.recordKey).toBe('list-A');
      expect(parsed.payload.sourceCorrelation?.mappingVersion).toBe('internal-1');
    }),
  );
  it.effect('preserves a caller-declared wrong PG occurrence and refuses it before any owner request', () =>
    Effect.gen(function* test() {
      const native = yield* Schema.decodeUnknownEffect(SymmyCatalogPricingInventoryIntentSchema.members[5])(
        priceGroupCreateIntent,
      );
      const mismatched = materializeSymmyCatalogPricingInventorySourceOccurrence(
        {
          ...native,
          payload: {
            ...native.payload,
            sourceCorrelation: {
              ...native.payload.sourceCorrelation,
              issuer: 'internal-ebs',
              mappingVersion: 'internal-1',
              namespace: 'price-lists',
              recordKey: 'list-A',
              routeId: 'route-1',
              sourceOccurrenceId: 'different-source-event',
            },
          },
        },
        'occurrence-1',
      );
      const scoped = yield* Schema.decodeUnknownEffect(SymmyPinnedEffectSchema)({
        ...effect,
        intent: mismatched,
        ref: {
          ...effect.ref,
          occurrence: {
            ...effect.ref.occurrence,
            record: {
              ...effect.ref.occurrence.record,
              entityKind: 'PRICE_GROUP',
              sourceNamespace: 'price-lists',
              sourceRecordId: 'list-A',
            },
          },
          operation: {
            entrypointKey: 'pricing.price-group-catalog.create-price-group',
            moduleId: 'pricing.price-group-catalog',
            schemaVersion: '1',
          },
        },
      });
      const h = harness(false, scoped);
      yield* h.provide(
        Effect.gen(function* refuse() {
          const adapter = yield* h.adapter;
          const rejected = yield* Effect.exit(adapter.execute(h.input));
          expect(Exit.isFailure(rejected)).toBe(true);
          expect(h.requests).toHaveLength(0);
        }),
      );
    }),
  );
  it.effect('rejects an Inventory backend that differs from the trusted route backend before any HTTP request', () => {
    const h = harness(false, stockEffectForBackend('native-backend-B'));
    return h.provide(
      Effect.gen(function* test() {
        const adapter = yield* h.adapter;
        const rejected = yield* Effect.exit(adapter.execute({ ...h.input, inventoryBackendId: 'native-backend-A' }));
        expect(Exit.isFailure(rejected)).toBe(true);
        expect(h.requests).toHaveLength(0);
      }),
    );
  });
  it.effect('keeps external source issuer and the independently configured native Inventory backend distinct', () => {
    const h = harness(false, stockEffectForBackend('native-backend-A'));
    return h.provide(
      Effect.gen(function* test() {
        const adapter = yield* h.adapter;
        const outcome = yield* adapter.execute({ ...h.input, inventoryBackendId: 'native-backend-A' });
        expect(outcome.status).toBe('accepted_change');
        expect(h.events).toContain('owner-write');
        expect(h.input.effect.ref.occurrence.record.issuerId).toBe('internal-ebs');
      }),
    );
  });
});
