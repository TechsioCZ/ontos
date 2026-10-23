import { defineBusinessPermission } from '@app/core-runtime';
import {
  CUSTOMER_PROFILE_READ_OWN_PERMISSION,
  CUSTOMER_PROFILE_UPDATE_OWN_PERMISSION,
  customerProfileReadOwnEntrypoint,
  customerProfileUpdateOwnEntrypoint,
} from '../portal-auth/profile-entrypoints.ts';

export const customerProfileReadOwnPermission = defineBusinessPermission({
  allowedScopeKinds: ['module'],
  auditSensitivity: 'sensitive',
  authorityGroups: [],
  customerDelegable: false,
  internalGrantable: false,
  key: CUSTOMER_PROFILE_READ_OWN_PERMISSION,
  meaning: 'Read only the Party profile mapped to a freshly admitted Commerce portal session.',
  owningCapability: 'commerce.customer-context.profile',
  protectedEntrypoints: [customerProfileReadOwnEntrypoint.entrypointKey],
  schemaVersion: '1',
});
export const customerProfileUpdateOwnPermission = defineBusinessPermission({
  allowedScopeKinds: ['module'],
  auditSensitivity: 'sensitive',
  authorityGroups: [],
  customerDelegable: false,
  internalGrantable: false,
  key: CUSTOMER_PROFILE_UPDATE_OWN_PERMISSION,
  meaning:
    'Update only the contact profile mapped to a freshly admitted Commerce portal session; never login credentials.',
  owningCapability: 'commerce.customer-context.profile',
  protectedEntrypoints: [customerProfileUpdateOwnEntrypoint.entrypointKey],
  schemaVersion: '1',
});
