import { expect, it } from 'effect-rstest';

import { getActionServiceFactory } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { getReadServiceFactory } from '../../../../packages/core-runtime/src/reads/definition.ts';

import { archiveCustomerProfileAction } from '../../src/actions/archive-customer-profile.action.ts';
import { attributeGuestRetailCustomerAction } from '../../src/actions/attribute-guest-retail-customer.action.ts';
import { bindRetailPortalProfileAction } from '../../src/actions/bind-retail-portal-profile.action.ts';
import { createCounterpartyPurchasingProfileAction } from '../../src/actions/create-counterparty-purchasing-profile.action.ts';
import { ensureRetailCustomerProfileAction } from '../../src/actions/ensure-retail-customer-profile.action.ts';
import { openProfileReconciliationAction } from '../../src/actions/open-profile-reconciliation.action.ts';
import { reactivateCustomerProfileAction } from '../../src/actions/reactivate-customer-profile.action.ts';
import { recoverRetailPortalProfileBindingAction } from '../../src/actions/recover-retail-portal-profile-binding.action.ts';
import { resolveProfileReconciliationAction } from '../../src/actions/resolve-profile-reconciliation.action.ts';
import { revokeRetailPortalProfileBindingAction } from '../../src/actions/revoke-retail-portal-profile-binding.action.ts';
import { suspendCustomerProfileAction } from '../../src/actions/suspend-customer-profile.action.ts';
import { customerProfileReadRead } from '../../src/api/customer-profile-read.read.ts';
import { customerProfileTradingGateRead } from '../../src/api/customer-profile-trading-gate.read.ts';
import { guestAttributionStatusRead } from '../../src/api/guest-attribution-status.read.ts';
import { profileReconciliationReadRead } from '../../src/api/profile-reconciliation-read.read.ts';
import { retailAccessDecisionRead } from '../../src/api/retail-access-decision.read.ts';
import { retailPortalProfileBindingReadRead } from '../../src/api/retail-portal-profile-binding-read.read.ts';
import { retailPrincipalResolutionRead } from '../../src/api/retail-principal-resolution.read.ts';

it('attaches every stable Profile registration to scoped production persistence', () => {
  expect(getActionServiceFactory(archiveCustomerProfileAction).toString()).toContain(
    'profileServicesForVerifiedScope',
  );
  expect(getActionServiceFactory(attributeGuestRetailCustomerAction).toString()).toContain(
    'profileServicesForVerifiedScope',
  );
  expect(getActionServiceFactory(bindRetailPortalProfileAction).toString()).toContain(
    'profileServicesForVerifiedScope',
  );
  expect(getActionServiceFactory(createCounterpartyPurchasingProfileAction).toString()).toContain(
    'profileServicesForVerifiedScope',
  );
  expect(getActionServiceFactory(ensureRetailCustomerProfileAction).toString()).toContain(
    'profileServicesForVerifiedScope',
  );
  expect(getActionServiceFactory(openProfileReconciliationAction).toString()).toContain(
    'profileServicesForVerifiedScope',
  );
  expect(getActionServiceFactory(reactivateCustomerProfileAction).toString()).toContain(
    'profileServicesForVerifiedScope',
  );
  expect(getActionServiceFactory(recoverRetailPortalProfileBindingAction).toString()).toContain(
    'profileServicesForVerifiedScope',
  );
  expect(getActionServiceFactory(resolveProfileReconciliationAction).toString()).toContain(
    'profileServicesForVerifiedScope',
  );
  expect(getActionServiceFactory(revokeRetailPortalProfileBindingAction).toString()).toContain(
    'profileServicesForVerifiedScope',
  );
  expect(getActionServiceFactory(suspendCustomerProfileAction).toString()).toContain(
    'profileServicesForVerifiedScope',
  );
  expect(getReadServiceFactory(customerProfileReadRead).toString()).toContain(
    'profileServicesForVerifiedScope',
  );
  expect(getReadServiceFactory(customerProfileTradingGateRead).toString()).toContain(
    'profileServicesForVerifiedScope',
  );
  expect(getReadServiceFactory(guestAttributionStatusRead).toString()).toContain(
    'profileServicesForVerifiedScope',
  );
  expect(getReadServiceFactory(profileReconciliationReadRead).toString()).toContain(
    'profileServicesForVerifiedScope',
  );
  expect(getReadServiceFactory(retailAccessDecisionRead).toString()).toContain(
    'profileServicesForVerifiedScope',
  );
  expect(getReadServiceFactory(retailPortalProfileBindingReadRead).toString()).toContain(
    'profileServicesForVerifiedScope',
  );
  expect(getReadServiceFactory(retailPrincipalResolutionRead).toString()).toContain(
    'profileServicesForVerifiedScope',
  );
  expect(getActionServiceFactory(resolveProfileReconciliationAction).toString()).toContain(
    'ProfileReconciliationOwnerVerifier',
  );
});
