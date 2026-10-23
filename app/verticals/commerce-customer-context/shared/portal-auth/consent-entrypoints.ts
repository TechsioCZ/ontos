import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const moduleKey = 'commerce.customer-context';

export const CUSTOMER_CONSENT_READ_OWN_PERMISSION = 'customer.consent.read_own';
export const CUSTOMER_CONSENT_UPDATE_OWN_PERMISSION = 'customer.consent.update_own';
export const CUSTOMER_CONSENT_RESOLVE_AUTHORITY_PERMISSION = 'customer.consent.resolve_authority';

export const customerConsentReadOwnEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'context_permission', permission: CUSTOMER_CONSENT_READ_OWN_PERMISSION },
  entrypointKey: 'commerce.customer-context.api.customer-consent-read-own',
  moduleKey,
  role: 'api',
});
export const customerConsentUpdateOwnEntrypoint = defineTenantModuleEntrypoint({
  access: 'write',
  authorization: { kind: 'context_permission', permission: CUSTOMER_CONSENT_UPDATE_OWN_PERMISSION },
  entrypointKey: 'commerce.customer-context.api.customer-consent-update-own',
  moduleKey,
  role: 'api',
});
export const customerConsentAuthorityEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'context_permission', permission: CUSTOMER_CONSENT_RESOLVE_AUTHORITY_PERMISSION },
  entrypointKey: 'commerce.customer-context.api.consent-authority',
  moduleKey,
  role: 'api',
});

export const CUSTOMER_NOTICE_RESOLVE_AUTHORITY_PERMISSION = 'customer.notice.resolve_authority';
export const customerConsentNoticeAuthorityEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'context_permission', permission: CUSTOMER_NOTICE_RESOLVE_AUTHORITY_PERMISSION },
  entrypointKey: 'commerce.customer-context.api.consent-notice-authority',
  moduleKey,
  role: 'api',
});
