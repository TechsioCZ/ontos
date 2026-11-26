import { expect, it } from 'effect-rstest';

import { bindableWorkloadOwner } from '../../src/access/workloads/integration-workload-registration.ts';
import {
  DORMANT_MODULE,
  DORMANT_WORKLOAD,
  PARTNER_ADMISSION_WORKLOAD,
  PARTNER_INTERNAL_WORKLOAD,
  PARTNER_MODULE,
  PARTNER_READ_WORKLOAD,
  PARTNER_SYSTEM_WORKLOAD,
  integrationWorkloadCatalog,
} from '../support/integration-workload-catalog.ts';

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
    internalWorkloads: ['integration.symmy.source-organization-facts.read'],
    module: { id: 'integration.symmy' },
    publicSurface: {
      actions: [
        { accessWorkload: { workloads: ['integration.symmy.admit-symmy-sync'] } },
        // Symmy's own server reads source organization facts as this internal workload, which it declares.
        { accessWorkload: { workloads: ['integration.symmy.source-organization-facts.read'] } },
      ],
    },
    systemWorkloads: ['integration.symmy.execute-symmy-job'],
  },
};

it('binds an integration only to a receiver workload an installed module publishes, and names that module', () => {
  expect(bindableWorkloadOwner([catalog, symmy], 'commerce.symmy-product-import')).toBe('commerce.catalog');
  expect(bindableWorkloadOwner([catalog, symmy], 'commerce.symmy-product-read')).toBe('commerce.catalog');
  expect(bindableWorkloadOwner([catalog, symmy], 'integration.symmy.admit-symmy-sync')).toBe('integration.symmy');
});

it('never binds an internal workload its module declares, even where no Tenant holds it', () => {
  expect(bindableWorkloadOwner([catalog, symmy], 'integration.symmy.source-organization-facts.read')).toBeUndefined();
});

it('never binds a system workload, an unpublished key or a key outside the publishing module namespace', () => {
  expect(bindableWorkloadOwner([catalog, symmy], 'integration.symmy.execute-symmy-job')).toBeUndefined();
  expect(bindableWorkloadOwner([catalog, symmy], 'commerce.symmy-price-import')).toBeUndefined();
  expect(bindableWorkloadOwner([catalog], 'integration.symmy.admit-symmy-sync')).toBeUndefined();
});

it('reads the bindable workloads from installed, decoded module contracts', () => {
  const { contracts } = integrationWorkloadCatalog();
  expect(bindableWorkloadOwner(contracts, PARTNER_ADMISSION_WORKLOAD)).toBe(PARTNER_MODULE);
  expect(bindableWorkloadOwner(contracts, PARTNER_READ_WORKLOAD)).toBe(PARTNER_MODULE);
  expect(bindableWorkloadOwner(contracts, DORMANT_WORKLOAD)).toBe(DORMANT_MODULE);
  expect(bindableWorkloadOwner(contracts, PARTNER_SYSTEM_WORKLOAD)).toBeUndefined();
  expect(bindableWorkloadOwner(contracts, PARTNER_INTERNAL_WORKLOAD)).toBeUndefined();
});
