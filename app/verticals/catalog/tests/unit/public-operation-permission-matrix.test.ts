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
import { variantHistoryRead } from '../../src/api/variant-history.read.ts';
import { packageDefinitionHistoryRead } from '../../src/api/package-definition-history.read.ts';
import { packageOptionHistoryRead } from '../../src/api/package-option-history.read.ts';
import { productBrandCurrentRead } from '../../src/api/product-brand-current.read.ts';
import { productBrandHistoryRead } from '../../src/api/product-brand-history.read.ts';
import { productSizeCurrentRead } from '../../src/api/product-size-current.read.ts';
import { productRelationshipCurrentRead } from '../../src/api/product-relationship-current.read.ts';
import { productRelationshipHistoryRead } from '../../src/api/product-relationship-history.read.ts';
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
  variantHistoryRead,
  packageDefinitionHistoryRead,
  packageOptionHistoryRead,
  productBrandCurrentRead,
  productBrandHistoryRead,
  productSizeCurrentRead,
  productRelationshipCurrentRead,
  productRelationshipHistoryRead,
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
