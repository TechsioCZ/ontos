import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const moduleKey = 'commerce.customer-context';

export const CUSTOMER_CREDENTIAL_CHANGE_OWN_PERMISSION = 'customer.password.change_own';

export const customerCredentialChangeOwnEntrypoint = defineTenantModuleEntrypoint({
  access: 'write',
  authorization: { kind: 'context_permission', permission: CUSTOMER_CREDENTIAL_CHANGE_OWN_PERMISSION },
  entrypointKey: 'commerce.customer-context.api.customer-password-change-own',
  moduleKey,
  role: 'api',
});
