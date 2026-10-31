import { extractVerticalRuntimeSafeDescriptors } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';
import { commerceMarketCatalogManifest } from '../../vertical.manifest.ts';
import { commerceMarketCatalogRegistration } from '../../vertical.registration.ts';
import { commerceMarketCatalogApi } from '../../shared/api.ts';
import { manageMarketRetirementAdmissionAction } from '../../src/actions/manage-market-retirement-admission.action.ts';

describe('Market owner-authored dependency contracts', () => {
  it('advertises all eight mounted Actions while keeping owner-local admission management private', () => {
    const safe = extractVerticalRuntimeSafeDescriptors(commerceMarketCatalogRegistration);
    const claims = safe.operationContracts.filter(({ operationKey }) => operationKey.split('.')[0]?.endsWith('Action'));
    const mountedActionGroups = Object.keys(commerceMarketCatalogApi.groups).filter((key) => key.endsWith('Action'));
    expect(claims.map(({ operationKey }) => operationKey.split('.')[0])).toEqual(
      expect.arrayContaining(mountedActionGroups),
    );
    expect(claims).toHaveLength(mountedActionGroups.length);
    expect(claims).toHaveLength(8);
    expect(
      safe.operationContracts.some(
        ({ entrypoint }) =>
          entrypoint.entrypointKey === manageMarketRetirementAdmissionAction.descriptor.entrypoint.entrypointKey,
      ),
    ).toBe(false);
    expect(new Set(safe.operationContracts.map(({ apiKey }) => apiKey)).size).toBe(safe.operationContracts.length);
  });

  it('keeps reciprocal owner calls conditional and original recovery separate from terminal local replay', () => {
    const { requirements } = commerceMarketCatalogManifest;
    expect(requirements?.intrinsic).toEqual([]);
    const recovery = requirements?.operations.filter(({ provider }) =>
      provider.entrypointKey.endsWith('.api.market-retirement-reservation-recovery'),
    );
    expect(recovery).toHaveLength(1);
    expect(recovery?.at(0)?.condition).toBe(
      'commerce.market-catalog.condition.retirement-ambiguous-original-reservation',
    );
    expect(
      requirements?.operations.some(({ entrypointKey }) =>
        entrypointKey.endsWith('.api.market-retirement-effect-recovery'),
      ),
    ).toBe(false);
    const subject = requirements?.operations.filter(({ provider }) =>
      provider.entrypointKey.endsWith('.api.market-subject-restrictions-current'),
    );
    expect(subject).toHaveLength(3);
    expect(subject?.every(({ condition }) => condition.endsWith('subject-qualified-market-eligibility'))).toBe(true);
    expect(extractVerticalRuntimeSafeDescriptors(commerceMarketCatalogRegistration).requirements).toEqual(requirements);
  });
});
