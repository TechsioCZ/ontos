import { defineBusinessPermission } from '@app/core-runtime';
import {
  CUSTOMER_NOTICE_RESOLVE_AUTHORITY_PERMISSION,
  customerConsentNoticeAuthorityEntrypoint,
  CUSTOMER_CONSENT_READ_OWN_PERMISSION,
  CUSTOMER_CONSENT_UPDATE_OWN_PERMISSION,
  CUSTOMER_CONSENT_RESOLVE_AUTHORITY_PERMISSION,
  customerConsentReadOwnEntrypoint,
  customerConsentUpdateOwnEntrypoint,
  customerConsentAuthorityEntrypoint,
} from '../portal-auth/consent-entrypoints.ts';

const declaration = {
  allowedScopeKinds: ['module'],
  auditSensitivity: 'sensitive',
  authorityGroups: [],
  customerDelegable: false,
  internalGrantable: false,
  owningCapability: 'commerce.customer-context.consent',
  schemaVersion: '1',
} as const;
export const customerConsentReadOwnPermission = defineBusinessPermission({
  ...declaration,
  key: CUSTOMER_CONSENT_READ_OWN_PERMISSION,
  meaning: 'Read declared newsletter notice and the consent of the freshly admitted Commerce account only.',
  protectedEntrypoints: [customerConsentReadOwnEntrypoint.entrypointKey],
});
export const customerConsentUpdateOwnPermission = defineBusinessPermission({
  ...declaration,
  key: CUSTOMER_CONSENT_UPDATE_OWN_PERMISSION,
  meaning: 'Submit an explicit newsletter choice for the Party of the freshly admitted Commerce account only.',
  protectedEntrypoints: [customerConsentUpdateOwnEntrypoint.entrypointKey],
});
export const customerConsentAuthorityPermission = defineBusinessPermission({
  ...declaration,
  key: CUSTOMER_CONSENT_RESOLVE_AUTHORITY_PERMISSION,
  meaning: 'Allow the Privacy owner to resolve a current Commerce session into exact Party-scoped consent authority.',
  protectedEntrypoints: [customerConsentAuthorityEntrypoint.entrypointKey],
});

export const customerConsentNoticeAuthorityPermission = defineBusinessPermission({
  ...declaration,
  key: CUSTOMER_NOTICE_RESOLVE_AUTHORITY_PERMISSION,
  meaning:
    'Allow Privacy to resolve a durable explicit notice acknowledgement for the exact admitted Commerce customer.',
  protectedEntrypoints: [customerConsentNoticeAuthorityEntrypoint.entrypointKey],
});
