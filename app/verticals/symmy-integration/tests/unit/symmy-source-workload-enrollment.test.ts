import { expect, it } from 'effect-rstest';

import { symmySourceWorkloadEnrollmentFor } from '../../src/persistence/symmy-job-store.ts';

it('permits canonical company SERVICE enrollment for exactly the two customer source receivers', () => {
  for (const moduleId of ['party.registry', 'commerce.customer-context']) {
    expect(symmySourceWorkloadEnrollmentFor(moduleId)).toEqual({
      enrollmentMode: 'system-or-canonical-company-service',
      workloadKey: `${moduleId}.source-write`,
    });
  }
});

it('retains SYSTEM-only enrollment for every other supported source receiver', () => {
  for (const [moduleId, workloadKey] of [
    ['commerce.catalog', 'commerce.catalog.symmy-product-import'],
    ['commerce.pricing', 'commerce.pricing.source-write'],
    ['pricing.price-group-catalog', 'pricing.price-group-catalog.source-write'],
    ['commerce.inventory', 'commerce.inventory.source-write'],
  ] as const) {
    expect(symmySourceWorkloadEnrollmentFor(moduleId)).toEqual({ enrollmentMode: 'system', workloadKey });
  }
});

it('provides no enrollment mode for unknown receivers or a workload supplied instead of a receiver', () => {
  for (const moduleId of ['unknown.receiver', 'party.registry.source-write', 'commerce.customer-context.source-read']) {
    expect(symmySourceWorkloadEnrollmentFor(moduleId)).toBeUndefined();
  }
});
