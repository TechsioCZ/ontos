import { ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY, extractVerticalRuntimeSafeDescriptors } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';
import { catalogManifest } from '../../vertical.manifest.ts';
import { catalogRegistration } from '../../vertical.registration.ts';
import { removeProductManufacturerAction } from '../../src/actions/remove-product-manufacturer.action.ts';

describe('Catalog owner-authored dependency contracts', () => {
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
    expect(safe.operationContracts).toHaveLength(5);
    for (const contract of safe.operationContracts) {
      expect(contract.entrypoint.moduleKey).toBe('commerce.catalog');
      expect(contract.schemaVersion).toBe('1');
      expect(Object.keys(contract)).toHaveLength(4);
      expect(Object.keys(contract)).toEqual(
        expect.arrayContaining(['apiKey', 'entrypoint', 'operationKey', 'schemaVersion']),
      );
    }
  });
});
