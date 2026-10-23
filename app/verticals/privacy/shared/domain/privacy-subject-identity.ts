import { createHash } from 'node:crypto';

import type { PrivacySubjectRef } from '../resources/privacy-subject.ts';
import type { PrivacyPartyRefSchema } from './party-reference.ts';

/** Privacy's tenant-scoped identity for an identified Party; the Party remains an external reference. */
export const privacySubjectRefForParty = (partyRef: typeof PrivacyPartyRefSchema.Encoded): PrivacySubjectRef => {
  // UUIDv8: SHA-256, domain separated from every other owner/resource identity.
  const hash = createHash('sha256')
    .update(`privacy.core/privacy-subject/party.registry.party/${partyRef.tenantId}/${partyRef.resourceId}`)
    .digest('hex');
  const variant = ((Number.parseInt(hash.slice(16, 18), 16) % 64) + 128).toString(16).padStart(2, '0');
  return {
    moduleId: 'privacy.core',
    resourceId: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${variant}${hash.slice(18, 20)}-${hash.slice(20, 32)}`,
    resourceType: 'privacy.core.privacy-subject',
    tenantId: partyRef.tenantId,
  };
};
