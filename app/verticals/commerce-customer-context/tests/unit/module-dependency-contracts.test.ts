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

  it('declares four PriceGroup mutation calls and keeps Current resolution and empty definition batches conditional', () => {
    const requirements = commerceCustomerContextManifest.requirements?.operations;
    const priceGroup = requirements?.filter(({ provider }) => provider.moduleId === 'pricing.price-group-catalog');
    expect(priceGroup).toHaveLength(5);
    const current = priceGroup?.find(
      ({ key }) => key === 'commerce.customer-context.requirement.price-group-single-assignment',
    );
    expect(current?.condition).toBe(
      'commerce.customer-context.condition.complete-current-single-price-group-assignment',
    );
    expect(current?.evidence).toContain(
      'commerce.customer-context.evidence.price-group.complete-current-assignment-set',
    );
    expect(
      requirements
        ?.filter(({ provider }) => provider.moduleId === 'payment.term-catalog')
        .every(({ condition }) => condition.endsWith('referenced-payment-term-definitions-nonempty')),
    ).toBe(true);
    for (const operation of ['assign-customer', 'assign-counterparty', 'migrate-customer', 'migrate-counterparty']) {
      const requirement = priceGroup?.find(
        ({ key }) => key === `commerce.customer-context.requirement.${operation}-price-group-catalog`,
      );
      expect(requirement?.entrypointKey).toBe(`commerce.customer-context.${operation}-price-group`);
      expect(requirement?.provider).toEqual({
        entrypointKey: 'pricing.price-group-catalog.api.validate-price-group-compatibility',
        moduleId: 'pricing.price-group-catalog',
        schemaVersion: '1',
      });
    }
    expect(priceGroup?.some(({ entrypointKey }) => entrypointKey.includes('remove-'))).toBe(false);
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
