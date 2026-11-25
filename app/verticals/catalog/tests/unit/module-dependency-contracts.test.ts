import { ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY, extractVerticalRuntimeSafeDescriptors } from '@app/core-runtime';
import { Array as EffectArray, Order } from 'effect';
import { HttpApi } from 'effect/http-api';
import { describe, expect, it } from 'effect-rstest';
import { catalogManifest } from '../../vertical.manifest.ts';
import { catalogRegistration } from '../../vertical.registration.ts';
import { removeProductManufacturerAction } from '../../src/actions/remove-product-manufacturer.action.ts';
import { assignSkuAction } from '../../src/actions/assign-sku.action.ts';
import { assignSkuRecoveryRead } from '../../src/api/assign-sku-recovery.read.ts';
import { setProductLocalizedFactsAction } from '../../src/actions/set-product-localized-facts.action.ts';
import { setVariantLocalizedFactsAction } from '../../src/actions/set-variant-localized-facts.action.ts';
import { assortmentProductClassificationV1Read } from '../../src/api/assortment-product-classification-v1.read.ts';
import { createProductRecoveryRead } from '../../src/api/create-product-recovery.read.ts';
import { createVariantRecoveryRead } from '../../src/api/create-variant-recovery.read.ts';
import { setProductLocalizedFactsRecoveryRead } from '../../src/api/set-product-localized-facts-recovery.read.ts';
import { setVariantLocalizedFactsRecoveryRead } from '../../src/api/set-variant-localized-facts-recovery.read.ts';
import { updateProductRecoveryRead } from '../../src/api/update-product-recovery.read.ts';
import { correctProductRecoveryRead } from '../../src/api/correct-product-recovery.read.ts';
import { addProductCategoryAssignmentRecoveryRead } from '../../src/api/add-product-category-assignment-recovery.read.ts';
import { addProductCategoryAssignmentAction } from '../../src/actions/add-product-category-assignment.action.ts';
import { governVariantAxesAction } from '../../src/actions/govern-variant-axes.action.ts';
import { confirmVariantCombinationAction } from '../../src/actions/confirm-variant-combination.action.ts';
import { setProductUnitTargetDivisibilityAction } from '../../src/actions/set-product-unit-target-divisibility.action.ts';
import { decideProductTypeUnnecessaryAction } from '../../src/actions/decide-product-type-unnecessary.action.ts';
import { bindInitialVariantSourceAction } from '../../src/actions/bind-initial-variant-source.action.ts';
import { correctProductAction } from '../../src/actions/correct-product.action.ts';
import { updateProductAction } from '../../src/actions/update-product.action.ts';
import { createVariantAction } from '../../src/actions/create-variant.action.ts';
import { createProductAction } from '../../src/actions/create-product.action.ts';
import { selectionEvidenceRead } from '../../src/api/selection-evidence.read.ts';
import { quantityPreparationRead } from '../../src/api/quantity-preparation.read.ts';
import { quantityBasisCompatibilityRead } from '../../src/api/quantity-basis-compatibility.read.ts';
import { pricingPurposeEquivalenceRead } from '../../src/api/pricing-purpose-equivalence.read.ts';
import { productVariantSnapshotRead } from '../../src/api/product-variant-snapshot.read.ts';
import { bindInitialVariantSourceRecoveryRead } from '../../src/api/bind-initial-variant-source-recovery.read.ts';
import { governVariantAxesRecoveryRead } from '../../src/api/govern-variant-axes-recovery.read.ts';
import { confirmVariantCombinationRecoveryRead } from '../../src/api/confirm-variant-combination-recovery.read.ts';
import { setProductUnitTargetDivisibilityRecoveryRead } from '../../src/api/set-product-unit-target-divisibility-recovery.read.ts';
import { decideProductTypeUnnecessaryRecoveryRead } from '../../src/api/decide-product-type-unnecessary-recovery.read.ts';
import { catalogSourceProductPageRead } from '../../src/api/catalog-source-product-page.read.ts';
import { catalogSourceProductsRead } from '../../src/api/catalog-source-products.read.ts';
import { productPageRead } from '../../src/api/product-page.read.ts';

/** The published API aliases and operation names must bind these original native registrations. */
const providerBindings = [
  [
    'add-product-category-assignment-action',
    'addProductCategoryAssignmentAction.execute',
    addProductCategoryAssignmentAction,
  ],
  [
    'add-product-category-assignment-recovery',
    'addProductCategoryAssignmentRecovery.execute',
    addProductCategoryAssignmentRecoveryRead,
  ],
  ['govern-variant-axes-action', 'governVariantAxesAction.execute', governVariantAxesAction],
  ['confirm-variant-combination-action', 'confirmVariantCombinationAction.execute', confirmVariantCombinationAction],
  ['set-product-localized-facts-action', 'setProductLocalizedFactsAction.execute', setProductLocalizedFactsAction],
  [
    'set-product-unit-target-divisibility-action',
    'setProductUnitTargetDivisibilityAction.execute',
    setProductUnitTargetDivisibilityAction,
  ],
  [
    'decide-product-type-unnecessary-action',
    'decideProductTypeUnnecessaryAction.execute',
    decideProductTypeUnnecessaryAction,
  ],
  ['selection-evidence', 'selectionEvidence.execute', selectionEvidenceRead],
  ['quantity-preparation', 'quantityPreparation.execute', quantityPreparationRead],
  ['quantity-basis-compatibility', 'quantityBasisCompatibility.execute', quantityBasisCompatibilityRead],
  ['pricing-purpose-equivalence', 'pricingPurposeEquivalence.execute', pricingPurposeEquivalenceRead],
  ['product-variant-snapshot', 'productVariantSnapshot.execute', productVariantSnapshotRead],
  [
    'assortment-product-classification-v1',
    'assortmentProductClassificationV1.execute',
    assortmentProductClassificationV1Read,
  ],
  ['bind-initial-variant-source-action', 'bindInitialVariantSourceAction.execute', bindInitialVariantSourceAction],
  ['correct-product-action', 'correctProductAction.execute', correctProductAction],
  ['update-product-action', 'updateProductAction.execute', updateProductAction],
  ['assign-sku-action', 'assignSkuAction.execute', assignSkuAction],
  ['set-variant-localized-facts-action', 'setVariantLocalizedFactsAction.execute', setVariantLocalizedFactsAction],
  ['create-variant-action', 'createVariantAction.execute', createVariantAction],
  ['create-product-action', 'createProductAction.execute', createProductAction],
  ['correct-product-recovery', 'correctProductRecovery.execute', correctProductRecoveryRead],
  ['update-product-recovery', 'updateProductRecovery.execute', updateProductRecoveryRead],
  ['assign-sku-recovery', 'assignSkuRecovery.execute', assignSkuRecoveryRead],
  [
    'set-variant-localized-facts-recovery',
    'setVariantLocalizedFactsRecovery.execute',
    setVariantLocalizedFactsRecoveryRead,
  ],
  [
    'set-product-localized-facts-recovery',
    'setProductLocalizedFactsRecovery.execute',
    setProductLocalizedFactsRecoveryRead,
  ],
  ['create-variant-recovery', 'createVariantRecovery.execute', createVariantRecoveryRead],
  ['create-product-recovery', 'createProductRecovery.execute', createProductRecoveryRead],
  [
    'bind-initial-variant-source-recovery',
    'bindInitialVariantSourceRecovery.execute',
    bindInitialVariantSourceRecoveryRead,
  ],
  ['govern-variant-axes-recovery', 'governVariantAxesRecovery.execute', governVariantAxesRecoveryRead],
  [
    'confirm-variant-combination-recovery',
    'confirmVariantCombinationRecovery.execute',
    confirmVariantCombinationRecoveryRead,
  ],
  [
    'set-product-unit-target-divisibility-recovery',
    'setProductUnitTargetDivisibilityRecovery.execute',
    setProductUnitTargetDivisibilityRecoveryRead,
  ],
  [
    'decide-product-type-unnecessary-recovery',
    'decideProductTypeUnnecessaryRecovery.execute',
    decideProductTypeUnnecessaryRecoveryRead,
  ],
  ['catalog-source-product-page', 'catalogSourceProductPage.execute', catalogSourceProductPageRead],
  ['catalog-source-products', 'catalogSourceProducts.execute', catalogSourceProductsRead],
  ['product-page', 'productPage.execute', productPageRead],
] as const;

/**
 * The workload carrier the manifest publishes for an operation that admits workloads: its access declaration and
 * the workloads it admits, directly or as subject workloads.
 */
const expectedWorkloadCarrier = (descriptor: {
  readonly accessActor?: { readonly subjectWorkloads?: readonly string[] | undefined } | undefined;
  readonly accessDeclaration?: { readonly key: string } | undefined;
  readonly accessWorkload?: { readonly workloads: readonly string[] } | undefined;
}) => {
  const workloads = [
    ...(descriptor.accessWorkload?.workloads ?? []),
    ...(descriptor.accessActor?.subjectWorkloads ?? []),
  ];
  return descriptor.accessDeclaration === undefined || workloads.length === 0
    ? {}
    : { workloadCarrier: { declarationKey: descriptor.accessDeclaration.key, workloads: [...new Set(workloads)] } };
};

describe('Catalog owner-authored dependency contracts', () => {
  it('binds every published operation to its original native owner registration and actual HttpApi endpoint', () => {
    for (const [apiKey, operationKey, registration] of providerBindings) {
      const binding = catalogManifest.publicSurface.operationContracts?.find((entry) => entry.apiKey === apiKey);
      expect(binding?.registration, apiKey).toBe(registration);
      expect(binding?.operationKey, apiKey).toBe(operationKey);
      const api = catalogManifest.publicSurface.api[apiKey];
      if (!HttpApi.isHttpApi(api)) {
        expect.fail(`${apiKey} must publish a native HttpApi`);
      }
      const operations = Object.values(api.groups).flatMap((group) =>
        Object.values(group.endpoints).map((endpoint) =>
          group.topLevel ? endpoint.identifier : `${group.identifier}.${endpoint.identifier}`,
        ),
      );
      expect(operations, apiKey).toContain(operationKey);
    }
  });
  it('keeps Party validation conditional without making Party an installation dependency', () => {
    expect(catalogManifest.requirements?.intrinsic).toEqual([]);
    expect(catalogManifest.requirements?.coreCapabilities).toContainEqual(ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY);
    const operations = catalogManifest.requirements?.operations ?? [];
    expect(operations).toHaveLength(5);
    // Core's own Legal Entity detail is satisfied by Core itself, never by the composition: the one Core
    // requirement is the call the current-relation read makes for a managed Legal Entity target.
    const coreRequirements = operations.filter(({ provider }) => provider.moduleId === 'core.identity');
    expect(coreRequirements).toEqual([
      {
        condition: 'commerce.catalog.condition.retained-manufacturer-target-legal-entity',
        entrypointKey: 'commerce.catalog.api.manufacturer-relation-current',
        evidence: [
          'commerce.catalog.evidence.manufacturer-target.legal-entity-current',
          'commerce.catalog.evidence.manufacturer-target.exact-revision',
        ],
        key: 'commerce.catalog.requirement.manufacturer-current-legal-entity',
        provider: {
          entrypointKey: 'core.identity.api.legal-entity-detail',
          moduleId: 'core.identity',
          schemaVersion: '1',
        },
      },
    ]);
    // Core Media's Current V1 is the other Core requirement: served by the Shell host for the relayed requester, so it
    // declares the requester (person) as its only caller and Catalog needs no provider credential or Core table. The
    // requester is relayed as the `subject`, with the company they selected, so Core narrows Current to that company.
    expect(operations.filter(({ provider }) => provider.moduleId === 'core.media')).toEqual([
      {
        callers: [{ kind: 'person', legalEntityScope: 'subject' }],
        condition: 'commerce.catalog.condition.core-media-current',
        entrypointKey: 'commerce.catalog.api.catalog-document-current',
        evidence: ['commerce.catalog.evidence.core-media.asset-current'],
        key: 'commerce.catalog.requirement.core-media-current',
        provider: { entrypointKey: 'core.media.api.asset-current', moduleId: 'core.media', schemaVersion: '1' },
      },
    ]);
    const requirements = operations.filter(({ provider }) => provider.moduleId === 'party.registry');
    expect(requirements).toHaveLength(3);
    expect(
      requirements.every(
        ({ condition, provider }) =>
          provider.moduleId === 'party.registry' && condition.endsWith('manufacturer-target-party'),
      ),
    ).toBe(true);
    expect(
      operations.some(
        ({ entrypointKey }) => entrypointKey === removeProductManufacturerAction.descriptor.entrypoint.entrypointKey,
      ),
    ).toBe(false);
    expect(requirements.some(({ condition }) => condition.includes('legal-entity'))).toBe(false);
  });

  it('validates all actual consumer registrations and publishes only safe own provider claims', () => {
    const safe = extractVerticalRuntimeSafeDescriptors(catalogRegistration);
    expect(safe.requirements).toEqual(catalogManifest.requirements);
    const byApiKey = Order.mapInput(Order.String, (contract: { readonly apiKey: string }) => contract.apiKey);
    expect(EffectArray.sort(safe.operationContracts, byApiKey)).toEqual(
      EffectArray.sort(
        providerBindings.map(([apiKey, operationKey, registration]) => ({
          apiKey: `commerce.catalog.${apiKey}`,
          entrypoint: registration.descriptor.entrypoint,
          operationKey,
          schemaVersion: registration.descriptor.schemaVersion,
          ...expectedWorkloadCarrier(registration.descriptor),
        })),
        byApiKey,
      ),
    );
    for (const contract of safe.operationContracts) {
      expect(contract.entrypoint.moduleKey).toBe('commerce.catalog');
      expect(['1', '2']).toContain(contract.schemaVersion);
      const base = ['apiKey', 'entrypoint', 'operationKey', 'schemaVersion'];
      const keys = Object.keys(contract);
      expect(keys).toHaveLength('workloadCarrier' in contract ? 5 : 4);
      expect(keys).toEqual(expect.arrayContaining('workloadCarrier' in contract ? [...base, 'workloadCarrier'] : base));
    }
  });
});
