import { expect, it } from 'effect-rstest';

import { bindableWorkloadOwner } from '../../src/access/workloads/integration-workload-registration.ts';

const catalog = {
  manifest: {
    module: { id: 'commerce.catalog' },
    publicSurface: {
      actions: [{ accessWorkload: { workloads: ['commerce.symmy-product-import'] } }, {}],
      operationContracts: [{ workloadCarrier: { workloads: ['commerce.symmy-product-read'] } }, {}],
    },
  },
};
const symmy = {
  manifest: {
    module: { id: 'integration.symmy' },
    publicSurface: {
      actions: [{ accessWorkload: { workloads: ['integration.symmy.admit-symmy-sync'] } }],
    },
    systemWorkloads: ['integration.symmy.execute-symmy-job'],
  },
};

it('binds an integration only to a receiver workload an installed module publishes, and names that module', () => {
  expect(bindableWorkloadOwner([catalog, symmy], 'commerce.symmy-product-import')).toBe('commerce.catalog');
  expect(bindableWorkloadOwner([catalog, symmy], 'commerce.symmy-product-read')).toBe('commerce.catalog');
  expect(bindableWorkloadOwner([catalog, symmy], 'integration.symmy.admit-symmy-sync')).toBe('integration.symmy');
});

it('never binds a system workload, an unpublished key or a key outside the publishing module namespace', () => {
  expect(bindableWorkloadOwner([catalog, symmy], 'integration.symmy.execute-symmy-job')).toBeUndefined();
  expect(bindableWorkloadOwner([catalog, symmy], 'commerce.symmy-price-import')).toBeUndefined();
  expect(bindableWorkloadOwner([catalog], 'integration.symmy.admit-symmy-sync')).toBeUndefined();
});
