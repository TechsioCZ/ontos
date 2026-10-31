import { defineTenantModuleEntrypoint } from '@app/core-runtime';

export const CUSTOMER_PROFILE_READ_OWN_PERMISSION = 'customer.profile.read_own';
export const CUSTOMER_PROFILE_UPDATE_OWN_PERMISSION = 'customer.profile.update_own';

export const customerProfileReadOwnEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'context_permission', permission: CUSTOMER_PROFILE_READ_OWN_PERMISSION },
  entrypointKey: 'commerce.customer-context.api.customer-profile-read-own',
  moduleKey: 'commerce.customer-context',
  role: 'api',
});
export const customerProfileUpdateOwnEntrypoint = defineTenantModuleEntrypoint({
  access: 'write',
  authorization: { kind: 'context_permission', permission: CUSTOMER_PROFILE_UPDATE_OWN_PERMISSION },
  entrypointKey: 'commerce.customer-context.api.customer-profile-update-own',
  moduleKey: 'commerce.customer-context',
  role: 'api',
});
