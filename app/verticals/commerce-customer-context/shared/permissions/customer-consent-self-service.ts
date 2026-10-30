import { defineBusinessPermission } from '@app/core-runtime';
import {
  CUSTOMER_CONSENT_READ_OWN_PERMISSION,
  CUSTOMER_CONSENT_UPDATE_OWN_PERMISSION,
  customerConsentReadOwnEntrypoint,
  customerConsentUpdateOwnEntrypoint,
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
