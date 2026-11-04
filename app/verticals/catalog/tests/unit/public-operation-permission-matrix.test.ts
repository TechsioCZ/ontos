import { catalogRegistration } from '../../vertical.registration.ts';
import { NodeCrypto } from '@effect/platform-node';
import {
  ContextAccess,
  OperationContextDenied,
  ReadHandlerExecutionError,
  ReadHandlerNotFound,
  ReadInputValidationError,
  ReadPermissionDenied,
  ReadPermissionUnavailable,
  TrustedPrincipalContextSchema,
  defineRead,
  toContextPermissionAccessKey,
} from '@app/core-runtime';
import type { ContextPermissionAccessTarget, ReadRuntimeService, TrustedPrincipalContext } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { Context, DateTime, Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { catalogAuthorityBundles, catalogPublicOperationContracts } from '../../shared/api.ts';
import { catalogManifest } from '../../vertical.manifest.ts';
import { activatePackageDefinitionRecoveryRead } from '../../src/api/activate-package-definition-recovery.read.ts';
import { activatePackageOptionRecoveryRead } from '../../src/api/activate-package-option-recovery.read.ts';
import { activateLocalOverrideRecoveryRead } from '../../src/api/activate-local-override-recovery.read.ts';
import { addProductCategoryAssignmentRecoveryRead } from '../../src/api/add-product-category-assignment-recovery.read.ts';
import { assertSizeEquivalenceRecoveryRead } from '../../src/api/assert-size-equivalence-recovery.read.ts';
import { assignCatalogMediaRecoveryRead } from '../../src/api/assign-catalog-media-recovery.read.ts';
import { assignSkuRecoveryRead } from '../../src/api/assign-sku-recovery.read.ts';
import { changeProductManufacturerRecoveryRead } from '../../src/api/change-product-manufacturer-recovery.read.ts';
import { changeProductRelationshipRecoveryRead } from '../../src/api/change-product-relationship-recovery.read.ts';
import { changeVariantRecoveryRead } from '../../src/api/change-variant-recovery.read.ts';
import { changeLocalOverrideRecoveryRead } from '../../src/api/change-local-override-recovery.read.ts';
import { confirmGtinRecoveryRead } from '../../src/api/confirm-gtin-recovery.read.ts';
import { confirmVariantCombinationRecoveryRead } from '../../src/api/confirm-variant-combination-recovery.read.ts';
import { correctGtinRecoveryRead } from '../../src/api/correct-gtin-recovery.read.ts';
import { correctProductRecoveryRead } from '../../src/api/correct-product-recovery.read.ts';
import { correctSkuRecoveryRead } from '../../src/api/correct-sku-recovery.read.ts';
import { decideProductTypeUnnecessaryRecoveryRead } from '../../src/api/decide-product-type-unnecessary-recovery.read.ts';
import { createVariantRecoveryRead } from '../../src/api/create-variant-recovery.read.ts';
import { updateProductRecoveryRead } from '../../src/api/update-product-recovery.read.ts';
import { createAttributeDefinitionRecoveryRead } from '../../src/api/create-attribute-definition-recovery.read.ts';
import { createBrandRecoveryRead } from '../../src/api/create-brand-recovery.read.ts';
import { createConfigurationUnitRecoveryRead } from '../../src/api/create-configuration-unit-recovery.read.ts';
import { createControlledAttributeValueRecoveryRead } from '../../src/api/create-controlled-attribute-value-recovery.read.ts';
import { createPackageDefinitionRecoveryRead } from '../../src/api/create-package-definition-recovery.read.ts';
import { createProductCategoryRecoveryRead } from '../../src/api/create-product-category-recovery.read.ts';
import { createProductRelationshipRecoveryRead } from '../../src/api/create-product-relationship-recovery.read.ts';
import { createProductTypeRecoveryRead } from '../../src/api/create-product-type-recovery.read.ts';
import { createProductUnitRecoveryRead } from '../../src/api/create-product-unit-recovery.read.ts';
import { createSetCompositionRecoveryRead } from '../../src/api/create-set-composition-recovery.read.ts';
import { reviseAttributeDefinitionRecoveryRead } from '../../src/api/revise-attribute-definition-recovery.read.ts';
import { reviseConfigurationUnitRecoveryRead } from '../../src/api/revise-configuration-unit-recovery.read.ts';
import { revisePackageDefinitionRecoveryRead } from '../../src/api/revise-package-definition-recovery.read.ts';
import { reviseProductTypeRecoveryRead } from '../../src/api/revise-product-type-recovery.read.ts';
import { reviseProductUnitRecoveryRead } from '../../src/api/revise-product-unit-recovery.read.ts';
import { reviseSetCompositionRecoveryRead } from '../../src/api/revise-set-composition-recovery.read.ts';
import { retireBrandRecoveryRead } from '../../src/api/retire-brand-recovery.read.ts';
import { governProductAttributeApplicabilityRecoveryRead } from '../../src/api/govern-product-attribute-applicability-recovery.read.ts';
import { governVariantAllowedValuesRecoveryRead } from '../../src/api/govern-variant-allowed-values-recovery.read.ts';
import { governVariantAxesRecoveryRead } from '../../src/api/govern-variant-axes-recovery.read.ts';
import { markGtinUnresolvedRecoveryRead } from '../../src/api/mark-gtin-unresolved-recovery.read.ts';
import { importSourceAssertionRecoveryRead } from '../../src/api/import-source-assertion-recovery.read.ts';
import { moveProductCategoryRecoveryRead } from '../../src/api/move-product-category-recovery.read.ts';
import { promotePackageDefinitionRecoveryRead } from '../../src/api/promote-package-definition-recovery.read.ts';
import { publishProductConfigurationRecoveryRead } from '../../src/api/publish-product-configuration-recovery.read.ts';
import { reactivateBrandRecoveryRead } from '../../src/api/reactivate-brand-recovery.read.ts';
import { reactivateControlledAttributeValueRecoveryRead } from '../../src/api/reactivate-controlled-attribute-value-recovery.read.ts';
import { reactivateProductRecoveryRead } from '../../src/api/reactivate-product-recovery.read.ts';
import { reactivateVariantRecoveryRead } from '../../src/api/reactivate-variant-recovery.read.ts';
import { removeCatalogMediaRecoveryRead } from '../../src/api/remove-catalog-media-recovery.read.ts';
import { removeProductAttributeValuesRecoveryRead } from '../../src/api/remove-product-attribute-values-recovery.read.ts';
import { removeProductCategoryAssignmentRecoveryRead } from '../../src/api/remove-product-category-assignment-recovery.read.ts';
import { removeProductLocalizedFactsRecoveryRead } from '../../src/api/remove-product-localized-facts-recovery.read.ts';
import { retireConfigurationUnitRecoveryRead } from '../../src/api/retire-configuration-unit-recovery.read.ts';
import { retireControlledAttributeValueRecoveryRead } from '../../src/api/retire-controlled-attribute-value-recovery.read.ts';
import { retireGtinRecoveryRead } from '../../src/api/retire-gtin-recovery.read.ts';
import { retirePackageDefinitionRecoveryRead } from '../../src/api/retire-package-definition-recovery.read.ts';
import { retirePackageOptionRecoveryRead } from '../../src/api/retire-package-option-recovery.read.ts';
import { retireProductRecoveryRead } from '../../src/api/retire-product-recovery.read.ts';
import { retireProductCategoryRecoveryRead } from '../../src/api/retire-product-category-recovery.read.ts';
import { retireProductUnitRecoveryRead } from '../../src/api/retire-product-unit-recovery.read.ts';
import { retireVariantRecoveryRead } from '../../src/api/retire-variant-recovery.read.ts';
import { releaseLocalOverrideRecoveryRead } from '../../src/api/release-local-override-recovery.read.ts';
import { brandCurrentRead } from '../../src/api/brand-current.read.ts';
import { brandHistoryRead } from '../../src/api/brand-history.read.ts';
import { colorCurrentRead } from '../../src/api/color-current.read.ts';
import { colorHistoryRead } from '../../src/api/color-history.read.ts';
import { catalogMediaCurrentRead } from '../../src/api/catalog-media-current.read.ts';
import { catalogDocumentCurrentRead } from '../../src/api/catalog-document-current.read.ts';
import { catalogSourceResolutionRead } from '../../src/api/catalog-source-resolution.read.ts';
import { externalTargetResolutionRead } from '../../src/api/external-target-resolution.read.ts';
import { selectionEvidenceRead } from '../../src/api/selection-evidence.read.ts';
import { assortmentSelectionAssessmentV1Read } from '../../src/api/assortment-selection-assessment-v1.read.ts';
import { assortmentSetCompositionV1Read } from '../../src/api/assortment-set-composition-v1.read.ts';
import { assortmentProductClassificationV1Read } from '../../src/api/assortment-product-classification-v1.read.ts';
import { createProductRecoveryRead } from '../../src/api/create-product-recovery.read.ts';
import { effectiveAttributeValuesCurrentRead } from '../../src/api/effective-attribute-values-current.read.ts';
import { gtinCurrentRead } from '../../src/api/gtin-current.read.ts';
import { gtinHistoryRead } from '../../src/api/gtin-history.read.ts';
import { listRecordedVariantsRead } from '../../src/api/list-recorded-variants.read.ts';
import { manufacturerRelationCurrentRead } from '../../src/api/manufacturer-relation-current.read.ts';
import { manufacturerRelationHistoryRead } from '../../src/api/manufacturer-relation-history.read.ts';
import { productCategoryClassificationRead } from '../../src/api/product-category-classification.read.ts';
import { productCategoryHistoryRead } from '../../src/api/product-category-history.read.ts';
import { productDetailRead } from '../../src/api/product-detail.read.ts';
import { productHistoryRead } from '../../src/api/product-history.read.ts';
import { productVariantSnapshotRead } from '../../src/api/product-variant-snapshot.read.ts';
import { variantHistoryRead } from '../../src/api/variant-history.read.ts';
import { packageDefinitionHistoryRead } from '../../src/api/package-definition-history.read.ts';
import { packageOptionHistoryRead } from '../../src/api/package-option-history.read.ts';
import { productBrandCurrentRead } from '../../src/api/product-brand-current.read.ts';
import { productBrandHistoryRead } from '../../src/api/product-brand-history.read.ts';
import { productSizeCurrentRead } from '../../src/api/product-size-current.read.ts';
import { productRelationshipCurrentRead } from '../../src/api/product-relationship-current.read.ts';
import { productRelationshipHistoryRead } from '../../src/api/product-relationship-history.read.ts';
import { pricingPurposeEquivalenceRead } from '../../src/api/pricing-purpose-equivalence.read.ts';
import { quantityBasisCompatibilityRead } from '../../src/api/quantity-basis-compatibility.read.ts';
import { quantityPreparationRead } from '../../src/api/quantity-preparation.read.ts';
import { skuLookupRead } from '../../src/api/sku-lookup.read.ts';
import { removeProductManufacturerRecoveryRead } from '../../src/api/remove-product-manufacturer-recovery.read.ts';
import { removeProductRelationshipRecoveryRead } from '../../src/api/remove-product-relationship-recovery.read.ts';
import { removeVariantAttributeOverrideRecoveryRead } from '../../src/api/remove-variant-attribute-override-recovery.read.ts';
import { removeVariantLocalizedFactsRecoveryRead } from '../../src/api/remove-variant-localized-facts-recovery.read.ts';
import { renameAttributeDefinitionRecoveryRead } from '../../src/api/rename-attribute-definition-recovery.read.ts';
import { renameBrandRecoveryRead } from '../../src/api/rename-brand-recovery.read.ts';
import { renameControlledAttributeValueRecoveryRead } from '../../src/api/rename-controlled-attribute-value-recovery.read.ts';
import { renameProductCategoryRecoveryRead } from '../../src/api/rename-product-category-recovery.read.ts';
import { renameSkuRecoveryRead } from '../../src/api/rename-sku-recovery.read.ts';
import { reorderCatalogMediaRecoveryRead } from '../../src/api/reorder-catalog-media-recovery.read.ts';
import { replaceProductSizesRecoveryRead } from '../../src/api/replace-product-sizes-recovery.read.ts';
import { setProductAttributeValuesRecoveryRead } from '../../src/api/set-product-attribute-values-recovery.read.ts';
import { setProductBrandRecoveryRead } from '../../src/api/set-product-brand-recovery.read.ts';
import { setProductLocalizedFactsRecoveryRead } from '../../src/api/set-product-localized-facts-recovery.read.ts';
import { setProductManufacturerRecoveryRead } from '../../src/api/set-product-manufacturer-recovery.read.ts';
import { setProductTypeRecoveryRead } from '../../src/api/set-product-type-recovery.read.ts';
import { setProductUnitTargetDivisibilityRecoveryRead } from '../../src/api/set-product-unit-target-divisibility-recovery.read.ts';
import { setVariantAttributeOverrideRecoveryRead } from '../../src/api/set-variant-attribute-override-recovery.read.ts';
import { setVariantLocalizedFactsRecoveryRead } from '../../src/api/set-variant-localized-facts-recovery.read.ts';
import { setCompositionCurrentRead } from '../../src/api/set-composition-current.read.ts';
import { setCompositionHistoryRead } from '../../src/api/set-composition-history.read.ts';

const reads = [
  activateLocalOverrideRecoveryRead,
  activatePackageDefinitionRecoveryRead,
  activatePackageOptionRecoveryRead,
  addProductCategoryAssignmentRecoveryRead,
  assertSizeEquivalenceRecoveryRead,
  assignCatalogMediaRecoveryRead,
  assignSkuRecoveryRead,
  changeProductManufacturerRecoveryRead,
  changeProductRelationshipRecoveryRead,
  changeVariantRecoveryRead,
  changeLocalOverrideRecoveryRead,
  confirmGtinRecoveryRead,
  confirmVariantCombinationRecoveryRead,
  correctGtinRecoveryRead,
  correctProductRecoveryRead,
  correctSkuRecoveryRead,
  decideProductTypeUnnecessaryRecoveryRead,
  createVariantRecoveryRead,
  updateProductRecoveryRead,
  createAttributeDefinitionRecoveryRead,
  createBrandRecoveryRead,
  createConfigurationUnitRecoveryRead,
  createControlledAttributeValueRecoveryRead,
  createPackageDefinitionRecoveryRead,
  createProductCategoryRecoveryRead,
  createProductRelationshipRecoveryRead,
  createProductTypeRecoveryRead,
  createProductUnitRecoveryRead,
  createSetCompositionRecoveryRead,
  reviseAttributeDefinitionRecoveryRead,
  reviseConfigurationUnitRecoveryRead,
  revisePackageDefinitionRecoveryRead,
  reviseProductTypeRecoveryRead,
  reviseProductUnitRecoveryRead,
  reviseSetCompositionRecoveryRead,
  retireBrandRecoveryRead,
  governProductAttributeApplicabilityRecoveryRead,
  governVariantAllowedValuesRecoveryRead,
  governVariantAxesRecoveryRead,
  markGtinUnresolvedRecoveryRead,
  importSourceAssertionRecoveryRead,
  moveProductCategoryRecoveryRead,
  promotePackageDefinitionRecoveryRead,
  publishProductConfigurationRecoveryRead,
  reactivateBrandRecoveryRead,
  reactivateControlledAttributeValueRecoveryRead,
  reactivateProductRecoveryRead,
  reactivateVariantRecoveryRead,
  removeCatalogMediaRecoveryRead,
  removeProductAttributeValuesRecoveryRead,
  removeProductCategoryAssignmentRecoveryRead,
  removeProductLocalizedFactsRecoveryRead,
  retireConfigurationUnitRecoveryRead,
  retireControlledAttributeValueRecoveryRead,
  retireGtinRecoveryRead,
  retirePackageDefinitionRecoveryRead,
  retirePackageOptionRecoveryRead,
  retireProductRecoveryRead,
  retireProductCategoryRecoveryRead,
  retireProductUnitRecoveryRead,
  retireVariantRecoveryRead,
  releaseLocalOverrideRecoveryRead,
  brandCurrentRead,
  brandHistoryRead,
  colorCurrentRead,
  colorHistoryRead,
  catalogMediaCurrentRead,
  catalogDocumentCurrentRead,
  catalogSourceResolutionRead,
  externalTargetResolutionRead,
  selectionEvidenceRead,
  assortmentSelectionAssessmentV1Read,
  assortmentSetCompositionV1Read,
  assortmentProductClassificationV1Read,
  createProductRecoveryRead,
  effectiveAttributeValuesCurrentRead,
  gtinCurrentRead,
  gtinHistoryRead,
  listRecordedVariantsRead,
  manufacturerRelationCurrentRead,
  manufacturerRelationHistoryRead,
  productCategoryClassificationRead,
  productCategoryHistoryRead,
  productDetailRead,
  productHistoryRead,
  productVariantSnapshotRead,
  variantHistoryRead,
  packageDefinitionHistoryRead,
  packageOptionHistoryRead,
  productBrandCurrentRead,
  productBrandHistoryRead,
  productSizeCurrentRead,
  productRelationshipCurrentRead,
  productRelationshipHistoryRead,
  pricingPurposeEquivalenceRead,
  quantityBasisCompatibilityRead,
  quantityPreparationRead,
  skuLookupRead,
  removeProductManufacturerRecoveryRead,
  removeProductRelationshipRecoveryRead,
  removeVariantAttributeOverrideRecoveryRead,
  removeVariantLocalizedFactsRecoveryRead,
  renameAttributeDefinitionRecoveryRead,
  renameBrandRecoveryRead,
  renameControlledAttributeValueRecoveryRead,
  renameProductCategoryRecoveryRead,
  renameSkuRecoveryRead,
  reorderCatalogMediaRecoveryRead,
  replaceProductSizesRecoveryRead,
  setProductAttributeValuesRecoveryRead,
  setProductBrandRecoveryRead,
  setProductLocalizedFactsRecoveryRead,
  setProductManufacturerRecoveryRead,
  setProductTypeRecoveryRead,
  setProductUnitTargetDivisibilityRecoveryRead,
  setVariantAttributeOverrideRecoveryRead,
  setVariantLocalizedFactsRecoveryRead,
  setCompositionCurrentRead,
  setCompositionHistoryRead,
] as const;

const expectedPermissionTarget = (readKey: string) => {
  if (
    readKey === 'commerce.catalog.api.catalog-media-current' ||
    readKey === 'commerce.catalog.api.pricing-purpose-equivalence' ||
    readKey === 'commerce.catalog.api.quantity-basis-compatibility' ||
    readKey === 'commerce.catalog.api.quantity-preparation'
  ) {
    return 'resource';
  }
  if (readKey.endsWith('-recovery')) {
    return 'tenant';
  }
  if (
    readKey.includes('brand') ||
    readKey.includes('manufacturer-relation') ||
    readKey.includes('product-relationship') ||
    readKey === 'commerce.catalog.api.assortment-selection-assessment-v1' ||
    readKey === 'commerce.catalog.api.product-size-current' ||
    readKey === 'commerce.catalog.api.color-current' ||
    readKey === 'commerce.catalog.api.color-history' ||
    readKey === 'commerce.catalog.api.effective-attribute-values-current' ||
    readKey === 'commerce.catalog.api.gtin-current' ||
    readKey === 'commerce.catalog.api.gtin-history' ||
    readKey === 'commerce.catalog.api.list-recorded-variants' ||
    readKey === 'commerce.catalog.api.sku-lookup'
  ) {
    return 'module';
  }
  return 'tenant';
};

it('maps every published Action and governed read to one explicit atomic permission and bundle', () => {
  const actionKeys = catalogManifest.publicSurface.actions.map((action) => action.descriptor.actionKey);
  const readKeys = reads.map((read) => read.descriptor.readKey);
  expect(new Set(readKeys)).toEqual(
    new Set(Object.keys(catalogManifest.publicSurface.api).map((name) => `commerce.catalog.api.${name}`)),
  );
  const published = [...actionKeys, ...readKeys];
  expect(new Set(published).size).toBe(published.length);
  expect(new Set(Object.keys(catalogPublicOperationContracts))).toEqual(new Set(published));

  for (const actionKey of actionKeys) {
    const contract = Object.entries(catalogPublicOperationContracts).find(([key]) => key === actionKey)?.[1];
    expect(contract).toMatchObject({ permission: actionKey, permissionKind: 'action_execution', scope: 'tenant' });
  }
  for (const read of reads) {
    const { entrypoint, readKey } = read.descriptor;
    const contract = Object.entries(catalogPublicOperationContracts).find(([key]) => key === readKey)?.[1];
    expect(entrypoint.authorization.kind).toBe('context_permission');
    if (entrypoint.authorization.kind !== 'context_permission') {
      continue;
    }
    expect(contract).toMatchObject({
      authorityBundle: 'CATALOG_READER',
      permission: entrypoint.authorization.permission,
      permissionKind: 'context_permission',
      scope: 'tenant',
    });
    expect(entrypoint.scope).toBe('tenant');
    const expectedTarget = expectedPermissionTarget(readKey);
    expect(read.descriptor.permissionTarget).toBe(expectedTarget);
    if ('resourcePermission' in read.descriptor && read.descriptor.resourcePermission !== undefined) {
      expect(contract).toMatchObject({ permissionTarget: expectedTarget, resourcePermission: 'read' });
    }
  }

  expect(catalogPublicOperationContracts['commerce.catalog.api.product-relationship-current']).toMatchObject({
    permissionTarget: 'module',
    resourcePermission: 'read',
  });

  const bundlePermissions = Object.values(catalogAuthorityBundles).flat();
  const contractPermissions = Object.values(catalogPublicOperationContracts).map(({ permission }) => permission);
  expect(new Set(bundlePermissions).size).toBe(bundlePermissions.length);
  expect(new Set(contractPermissions).size).toBe(contractPermissions.length);
  expect(new Set(bundlePermissions)).toEqual(new Set(contractPermissions));
  for (const contract of Object.values(catalogPublicOperationContracts)) {
    expect(catalogAuthorityBundles[contract.authorityBundle]).toContain(contract.permission);
  }
});

it('keeps read, ordinary edit, shared-definition, and high-impact lifecycle authority disjoint', () => {
  const bundles = catalogAuthorityBundles;
  expect(bundles.PRODUCT_EDITOR).toContain('commerce.catalog.update-product');
  expect(bundles.PRODUCT_EDITOR).toContain('commerce.catalog.govern-variant-axes');
  expect(bundles.CATALOG_DEFINITION_MANAGER).not.toContain('commerce.catalog.govern-variant-axes');
  expect(catalogPublicOperationContracts['commerce.catalog.govern-variant-axes']).toMatchObject({
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'product',
    permissionKind: 'action_execution',
  });
  expect(bundles.PRODUCT_EDITOR).toContain('commerce.catalog.set-product-brand');
  expect(bundles.PRODUCT_EDITOR).toContain('commerce.catalog.set-product-manufacturer');
  expect(bundles.PRODUCT_EDITOR).toContain('commerce.catalog.assign-catalog-media');
  expect(bundles.PRODUCT_EDITOR).toContain('commerce.catalog.replace-product-sizes');
  expect(bundles.CATALOG_DEFINITION_MANAGER).toContain('commerce.catalog.create-brand');
  expect(bundles.CATALOG_DEFINITION_MANAGER).toContain('commerce.catalog.assert-size-equivalence');
  expect(bundles.CATALOG_DEFINITION_MANAGER).toContain('commerce.catalog.activate-package-definition');
  expect(bundles.CATALOG_DEFINITION_MANAGER).toContain('commerce.catalog.create-package-definition');
  expect(bundles.CATALOG_DEFINITION_MANAGER).toContain('commerce.catalog.create-product-unit');
  expect(bundles.CATALOG_DEFINITION_MANAGER).toContain('commerce.catalog.revise-attribute-definition');
  expect(bundles.PRODUCT_EDITOR).not.toContain('commerce.catalog.revise-attribute-definition');
  expect(catalogPublicOperationContracts['commerce.catalog.revise-attribute-definition']).toMatchObject({
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: 'attribute-definition',
    permission: 'commerce.catalog.revise-attribute-definition',
    permissionKind: 'action_execution',
    scope: 'tenant',
  });
  for (const operation of [
    'commerce.catalog.create-configuration-unit',
    'commerce.catalog.revise-configuration-unit',
    'commerce.catalog.retire-configuration-unit',
  ] as const) {
    expect(bundles.CATALOG_DEFINITION_MANAGER).toContain(operation);
    expect(bundles.PRODUCT_EDITOR).not.toContain(operation);
    expect(bundles.CATALOG_LIFECYCLE_MANAGER).not.toContain(operation);
    expect(catalogPublicOperationContracts[operation]).toMatchObject({
      authorityBundle: 'CATALOG_DEFINITION_MANAGER',
      businessTarget: 'configuration-unit',
      permission: operation,
      permissionKind: 'action_execution',
      scope: 'tenant',
    });
  }
  expect(bundles.CATALOG_DEFINITION_MANAGER).toContain('commerce.catalog.activate-package-option');
  expect(bundles.CATALOG_DEFINITION_MANAGER).toContain('commerce.catalog.retire-package-option');
  for (const productAction of [
    'commerce.catalog.assign-sku',
    'commerce.catalog.rename-sku',
    'commerce.catalog.correct-sku',
    'commerce.catalog.confirm-gtin',
    'commerce.catalog.correct-gtin',
    'commerce.catalog.publish-product-configuration',
    'commerce.catalog.create-set-composition',
    'commerce.catalog.revise-set-composition',
  ]) {
    expect(bundles.PRODUCT_EDITOR).toContain(productAction);
    expect(bundles.CATALOG_DEFINITION_MANAGER).not.toContain(productAction);
    expect(bundles.CATALOG_LIFECYCLE_MANAGER).not.toContain(productAction);
  }
  expect(bundles.CATALOG_LIFECYCLE_MANAGER).toContain('commerce.catalog.retire-product');
  expect(bundles.CATALOG_LIFECYCLE_MANAGER).toContain('commerce.catalog.retire-variant');
  expect(bundles.PRODUCT_EDITOR).not.toContain('commerce.catalog.retire-product');
  expect(bundles.PRODUCT_EDITOR).not.toContain('commerce.catalog.create-brand');
  expect(bundles.PRODUCT_EDITOR).not.toContain('commerce.catalog.activate-package-option');
  expect(bundles.PRODUCT_EDITOR).not.toContain('commerce.catalog.retire-package-option');
  expect(bundles.CATALOG_DEFINITION_MANAGER).not.toContain('commerce.catalog.retire-product');
  expect(bundles.CATALOG_READER).not.toContain('commerce.catalog.create-product');
});

const targetTenantId = '11111111-1111-4111-8111-111111111111';
const targetProductId = '22222222-2222-4222-8222-222222222222';
const targetVariantId = '33333333-3333-4333-8333-333333333333';
const targetUnitId = '44444444-4444-4444-8444-444444444444';
const targetEffectiveAt = '2026-09-27T12:00:00.000Z';
const targetScope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '55555555-5555-4555-8555-555555555555',
    authContextRef: 'better-auth-session:catalog-resource-targets',
    authMethod: 'session',
    legalEntityId: '66666666-6666-4666-8666-666666666666',
    principalId: '77777777-7777-4777-8777-777777777777',
    tenantId: targetTenantId,
  }),
  correlationId: 'catalog-resource-targets',
};

// Encoded inputs are decoded by the actual registrations, including the malformed-kind controls.
const resourceTargetInputs = (tenantId = targetTenantId, productType = 'commerce.catalog.product') => {
  const productRef = { moduleId: 'commerce.catalog', resourceId: targetProductId, resourceType: productType, tenantId };
  const variantRef = {
    moduleId: 'commerce.catalog',
    resourceId: targetVariantId,
    resourceType: 'commerce.catalog.variant',
    tenantId,
  };
  const unitRef = {
    moduleId: 'commerce.catalog',
    resourceId: targetUnitId,
    resourceType: 'commerce.catalog.product-unit',
    tenantId,
  };
  const selection = { productRef, variantRef };
  const quantityBasis = { targetDivisibilityRevision: 3, targetRef: variantRef, unitRef, unitRuleRevision: 7 };
  const handoff = {
    completeness: {
      observedAt: targetEffectiveAt,
      ownerRevision: 'commerce.catalog.quantity:owner-1',
      scope: { kind: 'EXACT_PREDICATE', predicateRef: 'commerce.catalog.quantity:resource-targets' },
    },
    divisible: false,
    equivalentSelectionKey: 'commerce.catalog.selection:exact-1',
    evidence: {
      assessedAt: targetEffectiveAt,
      basis: [
        { role: 'PRODUCT', source: { resourceRef: productRef, revision: 2 } },
        { role: 'VARIANT', source: { resourceRef: variantRef, revision: 4 } },
        {
          provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
          role: 'PRODUCT_TYPE_UNTYPED_DECISION',
          source: { resourceRef: productRef, revision: 2 },
        },
      ],
      membership: {
        attestationId: 'catalog-resource-targets',
        observedAt: targetEffectiveAt,
        productRef,
        source: 'CATALOG_OWNER_CURRENT_READ',
        variant: { resourceRef: variantRef, revision: 4 },
      },
      purpose: 'PRICING',
      selection,
      status: 'VALID',
    },
    hierarchyRevision: 'commerce.catalog.hierarchy:hierarchy-1',
    ownerRevision: 'commerce.catalog.quantity:owner-1',
    quantity: {
      changed: false,
      notice: null,
      requested: '2',
      resulting: '2',
      rounding: 'UP',
      status: 'VALID',
      step: '1',
      targetId: targetVariantId,
      tenantId,
      unitId: targetUnitId,
      unitRuleRevision: 7,
    },
    quantityBasis,
    selection,
    status: 'READY',
    unitRef,
  };
  return {
    compatibility: { effectiveAt: targetEffectiveAt, handoff, price: { quantity: '1', quantityBasis } },
    equivalence: {
      anchorSelection: selection,
      effectiveAt: targetEffectiveAt,
      members: [{ handoff, occurrenceId: 'single-member' }],
    },
    media: { target: productRef },
    preparation: { amount: '2', purpose: 'PRICING', selection },
  };
};

const targetReadCases = [
  {
    name: 'quantity preparation',
    run: (
      runtime: ReadRuntimeService,
      principal: TrustedPrincipalContext,
      inputs: ReturnType<typeof resourceTargetInputs>,
    ) =>
      runtime
        .runRead({
          input: inputs.preparation,
          principal,
          registration: quantityPreparationRead,
          transport: { correlationId: targetScope.correlationId },
        })
        .pipe(Effect.asVoid),
  },
  {
    name: 'basis compatibility',
    run: (
      runtime: ReadRuntimeService,
      principal: TrustedPrincipalContext,
      inputs: ReturnType<typeof resourceTargetInputs>,
    ) =>
      runtime
        .runRead({
          input: inputs.compatibility,
          principal,
          registration: quantityBasisCompatibilityRead,
          transport: { correlationId: targetScope.correlationId },
        })
        .pipe(Effect.asVoid),
  },
  {
    name: 'pricing equivalence N=1',
    run: (
      runtime: ReadRuntimeService,
      principal: TrustedPrincipalContext,
      inputs: ReturnType<typeof resourceTargetInputs>,
    ) =>
      runtime
        .runRead({
          input: inputs.equivalence,
          principal,
          registration: pricingPurposeEquivalenceRead,
          transport: { correlationId: targetScope.correlationId },
        })
        .pipe(Effect.asVoid),
  },
  {
    name: 'current media',
    run: (
      runtime: ReadRuntimeService,
      principal: TrustedPrincipalContext,
      inputs: ReturnType<typeof resourceTargetInputs>,
    ) =>
      runtime
        .runRead({
          input: inputs.media,
          principal,
          registration: catalogMediaCurrentRead,
          transport: { correlationId: targetScope.correlationId },
        })
        .pipe(Effect.asVoid),
  },
];

const allowTargetReadContextPermissions = ({
  targets,
}: {
  readonly targets: readonly ContextPermissionAccessTarget[];
}) =>
  Effect.succeed(
    targets.map((target) => ({ decision: 'allowed' as const, key: toContextPermissionAccessKey(target) })),
  );

it.layer(NodeCrypto.layer)('Catalog registered resource target agreement', (suite) => {
  for (const read of targetReadCases) {
    suite.effect(`${read.name} reaches its original owner handler and commits governed evidence`, () =>
      Effect.gen(function* registeredResourceRead() {
        const harness = yield* makeReadTestHarness({
          executeOwnerQuery: (query) => {
            expect(query.scope).toEqual({ legalEntityId: targetScope.legalEntityId, tenantId: targetTenantId });
            if (query.sql.includes('"catalog"."catalog_media_assignment_sets"')) {
              return Effect.succeed([]);
            }
            expect(query.sql).toContain('"catalog"."products"');
            expect(query.params).toContain(targetTenantId);
            expect(query.params).toContain(targetProductId);
            // The real media owner sees an existing Product with no assignments. Quantity owners
            // see no Current revision and must retain their business-negative result.
            return Effect.succeed(query.sql.startsWith('select "product_id"') ? [{ productId: targetProductId }] : []);
          },
          operationTime: DateTime.toDateUtc(DateTime.makeUnsafe(targetEffectiveAt)),
          ownerAuthorizationDecision: 'allowed',
          ownerRegistration: catalogRegistration,
          permissionDecision: 'allowed',
          scope: targetScope,
        });
        Object.assign(Context.get(yield* Layer.build(harness.layer), ContextAccess), {
          contextPermissions: allowTargetReadContextPermissions,
        });
        yield* read.run(harness.runtime, targetScope, resourceTargetInputs());
        expect(harness.snapshot().stages).toContain('handler_executed');
        expect(harness.snapshot().evidenceWrites).toBe(1);
        expect(harness.snapshot().statements.at(-1)).toBe('COMMIT');
      }),
    );

    for (const decision of ['denied', 'unavailable'] as const) {
      suite.effect(`${read.name} keeps resource ${decision} fail-closed despite module access`, () =>
        Effect.gen(function* resourcePermissionFailure() {
          const harness = yield* makeReadTestHarness({
            executeOwnerQuery: () => Effect.die('No owner SQL is authorized'),
            operationTime: DateTime.toDateUtc(DateTime.makeUnsafe(targetEffectiveAt)),
            ownerAuthorizationDecision: 'allowed',
            ownerRegistration: catalogRegistration,
            permissionDecision: 'allowed',
            scope: targetScope,
          });
          const access = Context.get(yield* Layer.build(harness.layer), ContextAccess);
          const requested: object[] = [];
          // Override only the test permission transport; real Core resolution and gates remain.
          Object.assign(access, {
            contextPermissions: allowTargetReadContextPermissions,
            resources: ({ resources }: Parameters<typeof access.resources>[0]) => {
              requested.push(...resources);
              return Effect.succeed(
                resources.map((resource) => ({
                  decision,
                  key: `${resource.moduleId}:${resource.resourceType}:${resource.resourceId}`,
                })),
              );
            },
          });
          const failure = yield* read.run(harness.runtime, targetScope, resourceTargetInputs()).pipe(Effect.flip);
          expect(Schema.is(decision === 'denied' ? ReadPermissionDenied : ReadPermissionUnavailable)(failure)).toBe(
            true,
          );
          expect(requested).toEqual([resourceTargetInputs().media.target, resourceTargetInputs().media.target]);
          expect(harness.snapshot().ownerQueries).toEqual([]);
          expect(harness.snapshot().stages).not.toContain('handler_executed');
        }),
      );
    }

    suite.effect(`${read.name} rejects a malformed resource kind before owner SQL`, () =>
      Effect.gen(function* wrongResourceKind() {
        const harness = yield* makeReadTestHarness({
          executeOwnerQuery: () => Effect.die('No owner SQL is authorized'),
          operationTime: DateTime.toDateUtc(DateTime.makeUnsafe(targetEffectiveAt)),
          ownerAuthorizationDecision: 'allowed',
          ownerRegistration: catalogRegistration,
          permissionDecision: 'allowed',
          scope: targetScope,
        });
        const failure = yield* read
          .run(harness.runtime, targetScope, resourceTargetInputs(targetTenantId, 'commerce.catalog.product-unit'))
          .pipe(Effect.flip);
        expect(Schema.is(ReadInputValidationError)(failure)).toBe(true);
        expect(harness.snapshot().ownerQueries).toEqual([]);
      }),
    );

    suite.effect(`${read.name} rejects a foreign Tenant before owner SQL`, () =>
      Effect.gen(function* foreignResourceTenant() {
        const harness = yield* makeReadTestHarness({
          executeOwnerQuery: () => Effect.die('No owner SQL is authorized'),
          operationTime: DateTime.toDateUtc(DateTime.makeUnsafe(targetEffectiveAt)),
          ownerAuthorizationDecision: 'allowed',
          ownerRegistration: catalogRegistration,
          permissionDecision: 'allowed',
          scope: targetScope,
        });
        Object.assign(Context.get(yield* Layer.build(harness.layer), ContextAccess), {
          contextPermissions: allowTargetReadContextPermissions,
        });
        const failure = yield* read
          .run(harness.runtime, targetScope, resourceTargetInputs('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))
          .pipe(Effect.flip);
        expect(Schema.is(ReadHandlerNotFound)(failure)).toBe(true);
        expect(harness.snapshot().ownerQueries).toEqual([]);
        expect(harness.snapshot().stages).toContain('scope_installed');
        expect(harness.snapshot().stages).not.toContain('handler_executed');
      }),
    );

    suite.effect(`${read.name} requires a selected Legal Entity before permission or owner resolution`, () =>
      Effect.gen(function* missingLegalEntity() {
        const harness = yield* makeReadTestHarness({
          executeOwnerQuery: () => Effect.die('No owner SQL is authorized'),
          operationTime: DateTime.toDateUtc(DateTime.makeUnsafe(targetEffectiveAt)),
          ownerAuthorizationDecision: 'allowed',
          ownerRegistration: catalogRegistration,
          permissionDecision: 'allowed',
          scope: targetScope,
        });
        const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
          authBindingId: targetScope.authBindingId,
          authContextRef: targetScope.authContextRef,
          authMethod: targetScope.authMethod,
          principalId: targetScope.principalId,
          tenantId: targetScope.tenantId,
        });
        const failure = yield* read.run(harness.runtime, principal, resourceTargetInputs()).pipe(Effect.flip);
        expect(Schema.is(OperationContextDenied)(failure)).toBe(true);
        expect(harness.snapshot().ownerQueries).toEqual([]);
        expect(harness.snapshot().stages).not.toContain('permission_checked');
      }),
    );
  }

  suite.effect('current media authorizes the exact Variant target through both resource checks', () =>
    Effect.gen(function* exactMediaVariant() {
      const target = {
        moduleId: 'commerce.catalog',
        resourceId: targetVariantId,
        resourceType: 'commerce.catalog.variant',
        tenantId: targetTenantId,
      };
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: (query) => {
          expect(query.scope).toEqual({ legalEntityId: targetScope.legalEntityId, tenantId: targetTenantId });
          if (query.sql.includes('"catalog"."product_variants"')) {
            expect(query.params).toContain(targetVariantId);
            return Effect.succeed([{ productId: targetProductId }]);
          }
          expect(query.sql).toContain('"catalog"."catalog_media_assignment_sets"');
          return Effect.succeed([]);
        },
        operationTime: DateTime.toDateUtc(DateTime.makeUnsafe(targetEffectiveAt)),
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: catalogRegistration,
        permissionDecision: 'allowed',
        scope: targetScope,
      });
      const access = Context.get(yield* Layer.build(harness.layer), ContextAccess);
      const requested: object[] = [];
      Object.assign(access, {
        contextPermissions: allowTargetReadContextPermissions,
        resources: ({ resources }: Parameters<typeof access.resources>[0]) => {
          requested.push(...resources);
          return Effect.succeed(
            resources.map((resource) => ({
              decision: 'allowed' as const,
              key: `${resource.moduleId}:${resource.resourceType}:${resource.resourceId}`,
            })),
          );
        },
      });
      const result = yield* harness.runtime.runRead({
        input: { target },
        principal: targetScope,
        registration: catalogMediaCurrentRead,
        transport: { correlationId: targetScope.correlationId },
      });
      expect(result.target).toEqual(target);
      expect(requested).toEqual([target, target]);
      expect(harness.snapshot().stages).toContain('handler_executed');
      expect(harness.snapshot().evidenceWrites).toBe(1);
    }),
  );

  suite.effect('preserves the Core descriptor/resolver mismatch guard', () =>
    Effect.gen(function* mismatchControl() {
      const mismatched = defineRead(
        quantityPreparationRead.descriptor,
        () => Effect.die('Mismatch must fail before handler'),
        () => Effect.succeed({}),
        () => ({ kind: 'module', moduleId: 'commerce.catalog' }),
      );
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: () => Effect.die('No owner SQL is authorized'),
        operationTime: DateTime.toDateUtc(DateTime.makeUnsafe(targetEffectiveAt)),
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: catalogRegistration,
        permissionDecision: 'allowed',
        scope: targetScope,
      });
      const failure = yield* harness.runtime
        .runRead({
          input: resourceTargetInputs().preparation,
          principal: targetScope,
          registration: mismatched,
          transport: { correlationId: targetScope.correlationId },
        })
        .pipe(Effect.flip);
      expect(Schema.is(ReadHandlerExecutionError)(failure)).toBe(true);
      expect(failure).toMatchObject({ reason: 'The declared read permission target is invalid' });
      expect(harness.snapshot().ownerQueries).toEqual([]);
    }),
  );
});
