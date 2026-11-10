import { ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY, extractVerticalRuntimeSafeDescriptors } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';
import { catalogManifest } from '../../vertical.manifest.ts';
import { catalogRegistration } from '../../vertical.registration.ts';
import { removeProductManufacturerAction } from '../../src/actions/remove-product-manufacturer.action.ts';
import { setVariantLocalizedFactsAction } from '../../src/actions/set-variant-localized-facts.action.ts';
import { assortmentProductClassificationV1Read } from '../../src/api/assortment-product-classification-v1.read.ts';
import { createProductRecoveryRead } from '../../src/api/create-product-recovery.read.ts';
import { createVariantRecoveryRead } from '../../src/api/create-variant-recovery.read.ts';
import { setVariantLocalizedFactsRecoveryRead } from '../../src/api/set-variant-localized-facts-recovery.read.ts';
import { updateProductRecoveryRead } from '../../src/api/update-product-recovery.read.ts';
import { correctProductRecoveryRead } from '../../src/api/correct-product-recovery.read.ts';

describe('Catalog owner-authored dependency contracts', () => {
  it('publishes the native owner operations required by Product integration and Assortment', () => {
    const safe = extractVerticalRuntimeSafeDescriptors(catalogRegistration);
    for (const [apiKey, operationKey, registration] of [
      ['create-product-recovery', 'createProductRecovery.execute', createProductRecoveryRead],
      ['create-variant-recovery', 'createVariantRecovery.execute', createVariantRecoveryRead],
      ['update-product-recovery', 'updateProductRecovery.execute', updateProductRecoveryRead],
      ['correct-product-recovery', 'correctProductRecovery.execute', correctProductRecoveryRead],
      ['set-variant-localized-facts-action', 'setVariantLocalizedFactsAction.execute', setVariantLocalizedFactsAction],
      [
        'set-variant-localized-facts-recovery',
        'setVariantLocalizedFactsRecovery.execute',
        setVariantLocalizedFactsRecoveryRead,
      ],
      [
        'assortment-product-classification-v1',
        'assortmentProductClassificationV1.execute',
        assortmentProductClassificationV1Read,
      ],
    ] as const) {
      expect(safe.operationContracts).toContainEqual({
        apiKey: `commerce.catalog.${apiKey}`,
        entrypoint: registration.descriptor.entrypoint,
        operationKey,
        schemaVersion: registration.descriptor.schemaVersion,
      });
    }
  });
  it('keeps Party validation conditional without making Party an installation dependency', () => {
    expect(catalogManifest.requirements?.intrinsic).toEqual([]);
    expect(catalogManifest.requirements?.coreCapabilities).toContainEqual(ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY);
    const requirements = catalogManifest.requirements?.operations;
    expect(requirements).toHaveLength(3);
    expect(
      requirements?.every(
        ({ condition, provider }) =>
          provider.moduleId === 'party.registry' && condition.endsWith('manufacturer-target-party'),
      ),
    ).toBe(true);
    expect(
      requirements?.some(
        ({ entrypointKey }) => entrypointKey === removeProductManufacturerAction.descriptor.entrypoint.entrypointKey,
      ),
    ).toBe(false);
    expect(requirements?.some(({ condition }) => condition.includes('legal-entity'))).toBe(false);
  });

  it('validates all actual consumer registrations and publishes only safe own provider claims', () => {
    const safe = extractVerticalRuntimeSafeDescriptors(catalogRegistration);
    expect(safe.requirements).toEqual(catalogManifest.requirements);
    expect(safe.operationContracts).toHaveLength(19);
    for (const contract of safe.operationContracts) {
      expect(contract.entrypoint.moduleKey).toBe('commerce.catalog');
      expect(['1', '2']).toContain(contract.schemaVersion);
      expect(Object.keys(contract)).toHaveLength(4);
      expect(Object.keys(contract)).toEqual(
        expect.arrayContaining(['apiKey', 'entrypoint', 'operationKey', 'schemaVersion']),
      );
    }
  });
});
