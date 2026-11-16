import { SymmyInternalExecutionPlanSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { Schema } from 'effect';

const catalogModule = 'commerce.catalog';
const productEffectKey = 'catalog-product';
const productItemKey = 'product';

export const internalProductSource = {
  additionalVariantRecordId: 'INTERNAL_C14_ADDITIONAL_VARIANT_A',
  initialVariantRecordId: 'INTERNAL_C14_INITIAL_VARIANT_A',
  issuerId: 'INTERNAL_C14_NATIVE_ISSUER',
  mappingVersion: 'INTERNAL_C14_MAPPING_V1',
  namespace: 'INTERNAL_C14_PRODUCTS',
  productRecordId: 'INTERNAL_C14_PRODUCT_A',
  routeRevision: 'INTERNAL_C14_ROUTE_V1',
} as const;

/** Explicit internal owner facts, never a claim about the external Symmy wire format. */
export const makeSymmyC14ProductPlan = (input: {
  readonly additionalVariantId: string;
  readonly productOccurrenceId: string;
  readonly sourceRouteId: string;
  readonly tenantId: string;
  readonly variantOccurrenceId: string;
}) => {
  const source = {
    issuerId: internalProductSource.issuerId,
    mappingRevision: internalProductSource.mappingVersion,
    recordId: internalProductSource.productRecordId,
    recordNamespace: internalProductSource.namespace,
    routeScope: input.sourceRouteId,
  };
  const additionalVariantRef = {
    moduleId: catalogModule,
    resourceId: input.additionalVariantId,
    resourceType: 'commerce.catalog.variant',
    tenantId: input.tenantId,
  };
  return Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
    items: [
      {
        effects: [
          {
            effectKey: productEffectKey,
            intent: {
              _tag: 'CatalogCreateProduct',
              payload: {
                name: 'INTERNAL_C14 native Product',
                sourceCorrelation: { ...source, initialVariantRecordId: internalProductSource.initialVariantRecordId },
              },
            },
            operation: {
              entrypointKey: 'commerce.catalog.create-product',
              moduleId: catalogModule,
              schemaVersion: '2',
            },
          },
        ],
        itemKey: productItemKey,
        source: {
          entityKind: 'PRODUCT',
          issuerId: source.issuerId,
          sourceNamespace: source.recordNamespace,
          sourceRecordId: source.recordId,
        },
        sourceOccurrenceId: input.productOccurrenceId,
        unsupportedBranches: [
          { branchKey: 'catalog-category', kind: 'CategoryHint' },
          { branchKey: 'catalog-attribute', kind: 'AttributeHint' },
          { branchKey: 'catalog-media', kind: 'MediaHint' },
          { branchKey: 'catalog-variant-update', kind: 'VariantUpdateHint' },
          { branchKey: 'source-vat-hint', kind: 'TaxHint' },
          { branchKey: 'source-category-hint', kind: 'AssortmentHint' },
        ],
      },
      {
        effects: [
          {
            dependsOn: [{ effectKey: productEffectKey, itemKey: productItemKey }],
            effectKey: 'catalog-additional-variant',
            intent: {
              _tag: 'CatalogCreateVariantFromProductEffect',
              parent: { effectKey: productEffectKey, itemKey: productItemKey },
              payload: {
                classification: {
                  affectsOpenSelection: true,
                  evidenceRefs: ['INTERNAL_C14_SOURCE_REALIZATION_ASSERTION'],
                  kind: 'NEW_REALIZATION',
                  newVariantRef: additionalVariantRef,
                  reason: 'Explicit internal fixture additional realization',
                },
                evidenceRefs: ['INTERNAL_C14_SOURCE_REALIZATION_ASSERTION'],
                expectedProductRevision: 1,
                reason: 'Explicit internal fixture additional realization',
                sourceCorrelation: { ...source, recordId: internalProductSource.additionalVariantRecordId },
                variantRef: additionalVariantRef,
              },
              productSource: source,
            },
            operation: {
              entrypointKey: 'commerce.catalog.create-variant',
              moduleId: catalogModule,
              schemaVersion: '2',
            },
          },
        ],
        itemKey: 'additional-variant',
        source: {
          entityKind: 'VARIANT',
          issuerId: source.issuerId,
          sourceNamespace: source.recordNamespace,
          sourceRecordId: internalProductSource.additionalVariantRecordId,
        },
        sourceOccurrenceId: input.variantOccurrenceId,
      },
    ],
  });
};
