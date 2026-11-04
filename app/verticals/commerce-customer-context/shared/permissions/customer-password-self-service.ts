import { defineBusinessPermission } from '@app/core-runtime';
import {
  CUSTOMER_CREDENTIAL_CHANGE_OWN_PERMISSION,
  customerCredentialChangeOwnEntrypoint,
} from '../portal-auth/password-change-entrypoints.ts';

export const customerPasswordChangeOwnPermission = defineBusinessPermission({
  allowedScopeKinds: ['module'],
  auditSensitivity: 'sensitive',
  authorityGroups: [],
  customerDelegable: false,
  internalGrantable: false,
  key: CUSTOMER_CREDENTIAL_CHANGE_OWN_PERMISSION,
  meaning:
    'Change the login password of the freshly admitted Commerce account after its current password is verified; no other credential.',
  owningCapability: 'commerce.customer-context.password',
  protectedEntrypoints: [customerCredentialChangeOwnEntrypoint.entrypointKey],
  schemaVersion: '1',
});
