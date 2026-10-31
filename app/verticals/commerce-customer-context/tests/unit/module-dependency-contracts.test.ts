import { extractVerticalRuntimeSafeDescriptors } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';
import { commerceCustomerContextManifest } from '../../vertical.manifest.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';
import { commerceCustomerContextApi } from '../../shared/api.ts';

describe('Customer Context owner-authored dependency contracts', () => {
  it('does not turn local saved-address reads, omitted updates or Commerce-only addresses into Party dependencies', () => {
    const { requirements } = commerceCustomerContextManifest;
    expect(requirements?.intrinsic).toEqual([]);
    const party = requirements?.operations.filter(({ provider }) => provider.moduleId === 'party.registry');
    expect(party).toHaveLength(6);
    expect(party?.some(({ entrypointKey }) => /saved-address-(?:list|detail|defaults)$/u.test(entrypointKey))).toBe(
      false,
    );
    const update = party?.find(({ entrypointKey }) => entrypointKey.endsWith('.update-saved-address'));
    expect(update?.condition).toBe('commerce.customer-context.condition.saved-address-explicit-party-origin');
    expect(party?.some(({ condition }) => condition.includes('commerce-only') || condition.includes('omitted'))).toBe(
      false,
    );
  });

  it('requires the PriceGroup owner only for one complete Current assignment and keeps empty definition batches local', () => {
    const requirements = commerceCustomerContextManifest.requirements?.operations;
    const priceGroup = requirements?.filter(({ provider }) => provider.moduleId === 'pricing.price-group-catalog');
    expect(priceGroup).toHaveLength(1);
    expect(priceGroup?.at(0)?.condition).toBe(
      'commerce.customer-context.condition.complete-current-single-price-group-assignment',
    );
    expect(priceGroup?.at(0)?.evidence).toContain(
      'commerce.customer-context.evidence.price-group.complete-current-assignment-set',
    );
    expect(
      requirements
        ?.filter(({ provider }) => provider.moduleId === 'payment.term-catalog')
        .every(({ condition }) => condition.endsWith('referenced-payment-term-definitions-nonempty')),
    ).toBe(true);
    expect(requirements?.some(({ provider }) => provider.moduleId === 'commerce.inventory')).toBe(false);
  });

  it('binds the two actual mounted reservation Actions and original reservation recovery without fabricating a provider', () => {
    const safe = extractVerticalRuntimeSafeDescriptors(commerceCustomerContextRegistration);
    expect(safe.requirements).toEqual(commerceCustomerContextManifest.requirements);
    for (const operationKey of [
      'reserveMarketRetirementAction.execute',
      'reservePaymentTermRetirementAction.execute',
    ]) {
      const claim = safe.operationContracts.find((contract) => contract.operationKey === operationKey);
      expect(claim?.entrypoint.moduleKey).toBe('commerce.customer-context');
      expect(Object.keys(commerceCustomerContextApi.groups)).toContain(operationKey.split('.')[0]);
    }
    expect(
      safe.operationContracts.some(
        ({ operationKey }) => operationKey === 'marketRetirementReservationRecovery.execute',
      ),
    ).toBe(true);
  });
});
