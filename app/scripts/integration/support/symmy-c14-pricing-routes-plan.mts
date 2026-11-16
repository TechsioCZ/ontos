import type { CreatePriceGroupDefinitionRevisionPayloadSchema } from '@app/price-group-catalog/actions/create-price-group-definition-revision';
import { SymmyInternalExecutionPlanSchema } from '@app/symmy-integration/symmy-internal-contracts';
import type { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import type { ProductUnitRefSchema } from '@app/catalog/resources/product-unit';
import type { PriceGroupRefSchema } from '@app/price-group-catalog/resources/price-group';
import { DefinePricePayloadSchema } from '@app/pricing/actions/define-price';
import { ExternalPriceSourceAuthorityGrantSchema } from '@app/pricing/testing/c14-source-authority';
import { Effect, Schema } from 'effect';

const groupModule = 'pricing.price-group-catalog';
const internalGroupContract = 'internal.c14-price-group';
const internalGroupPurpose = 'Explicit INTERNAL_C14 source group pricing';

export const internalPricingRouteSource = {
  issuerId: 'INTERNAL_C14_PRICING_ISSUER',
  mappingVersion: 'INTERNAL_C14_PRICING_MAPPING_V1',
  namespace: 'INTERNAL_C14_PRICE_LISTS',
  routeRevision: 'INTERNAL_C14_PRICING_ROUTE_V1',
} as const;

/** Two explicit source group definitions, with native catalog revisions ordered by a named dependency. */
export const decodeInternalC14PriceGroupPlan = (input: {
  readonly at: string;
  readonly firstOccurrenceId: string;
  readonly firstRecordId: string;
  readonly secondOccurrenceId: string;
  readonly secondRecordId: string;
  readonly sourceRouteId: string;
}) => {
  const definition = (
    recordId: string,
    businessCode: string,
    classificationPurpose: string,
    expectedCatalogRevision: number,
  ) => ({
    _tag: 'PriceGroupCreate',
    payload: {
      businessCode,
      classificationPurpose,
      compatibilityContracts: [{ contractId: internalGroupContract, version: 1 }],
      description: 'INTERNAL_C14 actual native Price Group receiving proof',
      displayName: `Internal ${businessCode}`,
      effectiveFrom: input.at,
      effectiveTo: null,
      expectedCatalogRevision,
      reason: 'INTERNAL_C14 explicit source group-pricing definition',
      sourceCorrelation: {
        issuer: internalPricingRouteSource.issuerId,
        mappingVersion: internalPricingRouteSource.mappingVersion,
        namespace: internalPricingRouteSource.namespace,
        recordKey: recordId,
        routeId: input.sourceRouteId,
      },
    },
  });
  const item = (
    itemKey: string,
    sourceRecordId: string,
    sourceOccurrenceId: string,
    businessCode: string,
    classificationPurpose: string,
    expectedCatalogRevision: number,
    dependsOn: readonly { readonly effectKey: string; readonly itemKey: string }[],
  ) => ({
    effects: [
      {
        dependsOn,
        effectKey: 'group-create',
        intent: definition(sourceRecordId, businessCode, classificationPurpose, expectedCatalogRevision),
        operation: {
          entrypointKey: 'pricing.price-group-catalog.create-price-group',
          moduleId: groupModule,
          schemaVersion: '1',
        },
      },
    ],
    itemKey,
    source: {
      entityKind: 'PRICE_GROUP',
      issuerId: internalPricingRouteSource.issuerId,
      sourceNamespace: internalPricingRouteSource.namespace,
      sourceRecordId,
    },
    sourceOccurrenceId,
  });
  return Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
    items: [
      item(
        'group-a',
        input.firstRecordId,
        input.firstOccurrenceId,
        'INTERNAL_C14_PRICE_GROUP_A',
        internalGroupPurpose,
        0,
        [],
      ),
      item(
        'group-b',
        input.secondRecordId,
        input.secondOccurrenceId,
        'INTERNAL_C14_PRICE_GROUP_B',
        'Explicit INTERNAL_C14 contractor source group pricing',
        1,
        [{ effectKey: 'group-create', itemKey: 'group-a' }],
      ),
    ],
  });
};

export const decodeInternalC14PriceGroupRevisionPlan = (input: {
  readonly at: string;
  readonly current: typeof CreatePriceGroupDefinitionRevisionPayloadSchema.fields.expectedCurrent.Type;
  readonly occurrenceId: string;
  readonly recordId: string;
  readonly sourceRouteId: string;
}) =>
  Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
    items: [
      {
        effects: [
          {
            effectKey: 'group-revise',
            intent: {
              _tag: 'PriceGroupRevise',
              payload: {
                classificationPurpose: internalGroupPurpose,
                compatibilityContracts: [{ contractId: internalGroupContract, version: 1 }],
                description: 'INTERNAL_C14 actual native cosmetic definition revision',
                displayName: 'Internal revised group A',
                effectiveFrom: input.at,
                effectiveTo: null,
                expectedCurrent: input.current,
                reason: 'INTERNAL_C14 explicit cosmetic source revision',
                semanticDecision: {
                  comparedDefinitionRevisionId: input.current.definitionRevisionId,
                  decision: 'SAME_MEANING',
                },
                sourceCorrelation: {
                  issuer: internalPricingRouteSource.issuerId,
                  mappingVersion: internalPricingRouteSource.mappingVersion,
                  namespace: internalPricingRouteSource.namespace,
                  recordKey: input.recordId,
                  routeId: input.sourceRouteId,
                },
              },
            },
            operation: {
              entrypointKey: 'pricing.price-group-catalog.create-price-group-definition-revision',
              moduleId: groupModule,
              schemaVersion: '1',
            },
            originalTarget: input.current.priceGroupRef,
          },
        ],
        itemKey: 'group-a',
        source: {
          entityKind: 'PRICE_GROUP',
          issuerId: internalPricingRouteSource.issuerId,
          sourceNamespace: internalPricingRouteSource.namespace,
          sourceRecordId: input.recordId,
        },
        sourceOccurrenceId: input.occurrenceId,
      },
    ],
  });

export const internalPricingNativeSourceSystem = {
  ownerModuleId: 'external.internal-c14',
  sourceSystemRef: 'INTERNAL_C14_PRICE_SOURCE_SYSTEM',
} as const;

interface InternalC14PriceFacts {
  readonly at: string;
  readonly importedAt: (typeof DefinePricePayloadSchema.fields.sourceAssertion.fields.timing.Type)['importedAt'];
  readonly marketId: string;
  readonly occurrenceId: string;
  readonly priceId: string;
  readonly recordId: string;
  readonly selection: typeof CatalogSelectionSchema.Type;
  readonly sellingLegalEntityId: string;
  readonly unitRef: typeof ProductUnitRefSchema.Type;
}
const pricingModule = 'commerce.pricing';
const nativePriceOperation = {
  entrypointKey: 'commerce.pricing.define-price',
  moduleId: pricingModule,
  schemaVersion: '2',
};
const priceFields = (input: InternalC14PriceFacts) => ({
  effectiveFrom: input.at,
  identityKey: {
    catalogSelection: input.selection,
    commercialScope: { channelId: 'B2C', marketId: input.marketId, sellingLegalEntityId: input.sellingLegalEntityId },
    currencyCode: 'CZK',
    unitBasis: { quantity: '1', unitRef: input.unitRef },
  },
  monetaryAmount: { amount: '25', currencyCode: 'CZK' },
  priceRef: {
    moduleId: pricingModule,
    resourceId: input.priceId,
    resourceType: 'commerce.pricing.price',
    tenantId: input.selection.productRef.tenantId,
  },
  reason: 'INTERNAL_C14 explicit source-backed pre-Tax Price',
  sourceAssertion: {
    lineage: { kind: 'INITIAL' },
    mapping: {
      mappingContractRef: 'INTERNAL_C14_PRICE_ROUTE_MAPPING',
      mappingContractVersion: internalPricingRouteSource.mappingVersion,
    },
    originalAssertion: {
      monetaryAmount: { amount: '25', currencyCode: 'CZK' },
      monetaryBoundary: 'PRE_TAX',
      unitBasis: { quantity: '1', unitRef: input.unitRef },
    },
    sourceAssertionId: input.occurrenceId,
    sourceAuthority: { sourceAuthorityRef: 'INTERNAL_C14_PRICE_ROUTE_AUTHORITY', sourceAuthorityVersion: '1' },
    sourceRecord: {
      sourceChangeCorrelation: input.occurrenceId,
      sourceRecordRef: input.recordId,
      sourceRecordVersion: '1',
      sourceSystem: internalPricingNativeSourceSystem,
    },
    timing: { importedAt: input.importedAt, ownerBusinessEffectiveAt: input.at, sourceEffectiveAt: input.at },
  },
});
const priceSource = (input: InternalC14PriceFacts) => ({
  entityKind: 'PRICE',
  issuerId: internalPricingRouteSource.issuerId,
  sourceNamespace: internalPricingRouteSource.namespace,
  sourceRecordId: input.recordId,
});

export const decodeInternalC14CapturedPriceGrant = (
  payload: typeof DefinePricePayloadSchema.Type,
  verifiedAt: string,
) =>
  Schema.decodeUnknownEffect(ExternalPriceSourceAuthorityGrantSchema)({
    authority: payload.sourceAssertion.sourceAuthority,
    effectivePeriod: { effectiveFrom: payload.effectiveFrom },
    exactIdentityKey: payload.identityKey,
    family: 'PRICE',
    mapping: payload.sourceAssertion.mapping,
    ownerModuleId: pricingModule,
    schemaVersion: '1',
    verificationRef: 'INTERNAL_C14_EXPLICIT_NATIVE_PRICE_ROUTE_SOURCE_GRANT',
    verifiedAt,
  });

export const decodeInternalC14SourcePricePlan = Effect.fn('InternalC14PricingRoutes.pricePlan')(
  function* decodePricePlan(input: InternalC14PriceFacts & { readonly groupRef: typeof PriceGroupRefSchema.Type }) {
    const facts = priceFields(input);
    const payload = yield* Schema.decodeUnknownEffect(DefinePricePayloadSchema)({
      ...facts,
      identityKey: { ...facts.identityKey, priceGroupSelector: { kind: 'PRICE_GROUP', priceGroupRef: input.groupRef } },
    });
    const grant = yield* decodeInternalC14CapturedPriceGrant(payload, input.importedAt);
    const plan = yield* Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
      items: [
        {
          effects: [
            {
              effectKey: 'price-define',
              intent: { _tag: 'PriceDefine', payload: yield* Schema.encodeEffect(DefinePricePayloadSchema)(payload) },
              operation: nativePriceOperation,
              originalTarget: payload.priceRef,
            },
          ],
          itemKey: 'source-price',
          source: priceSource(input),
          sourceOccurrenceId: input.occurrenceId,
        },
      ],
    });
    return { grant, payload, plan };
  },
);

/** Native Group identity is deliberately absent until the exact named parent receipt supplies it. */
export const decodeInternalC14DeferredPriceListPlan = (
  input: InternalC14PriceFacts & {
    readonly expectedCatalogRevision: number;
    readonly groupBusinessCode: string;
    readonly groupOccurrenceId: string;
    readonly groupPurpose: string;
    readonly groupRecordId: string;
    readonly sourceRouteId: string;
  },
) => {
  const facts = priceFields(input);
  const parent = { effectKey: 'new-group', itemKey: 'new-list' };
  return Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
    items: [
      {
        effects: [
          {
            effectKey: parent.effectKey,
            intent: {
              _tag: 'PriceGroupCreate',
              payload: {
                businessCode: input.groupBusinessCode,
                classificationPurpose: input.groupPurpose,
                compatibilityContracts: [{ contractId: internalGroupContract, version: 1 }],
                description: 'INTERNAL_C14 native first-import Group then Price proof',
                displayName: 'Internal new Group C',
                effectiveFrom: input.at,
                effectiveTo: null,
                expectedCatalogRevision: input.expectedCatalogRevision,
                reason: 'Explicit INTERNAL_C14 new source Group',
                sourceCorrelation: {
                  issuer: internalPricingRouteSource.issuerId,
                  mappingVersion: internalPricingRouteSource.mappingVersion,
                  namespace: internalPricingRouteSource.namespace,
                  recordKey: input.groupRecordId,
                  routeId: input.sourceRouteId,
                },
              },
            },
            operation: {
              entrypointKey: 'pricing.price-group-catalog.create-price-group',
              moduleId: groupModule,
              schemaVersion: '1',
            },
          },
        ],
        itemKey: parent.itemKey,
        source: {
          entityKind: 'PRICE_GROUP',
          issuerId: internalPricingRouteSource.issuerId,
          sourceNamespace: internalPricingRouteSource.namespace,
          sourceRecordId: input.groupRecordId,
        },
        sourceOccurrenceId: input.groupOccurrenceId,
      },
      {
        effects: [
          {
            dependsOn: [parent],
            effectKey: 'new-price',
            intent: {
              _tag: 'PriceDefineFromGroupEffect',
              fromPriceGroupEffect: parent,
              payload: { ...facts, identityKey: { ...facts.identityKey, priceGroupSelector: { kind: 'PRICE_GROUP' } } },
            },
            operation: nativePriceOperation,
            originalTarget: facts.priceRef,
          },
        ],
        itemKey: 'new-price',
        source: priceSource(input),
        sourceOccurrenceId: input.occurrenceId,
      },
    ],
  });
};
