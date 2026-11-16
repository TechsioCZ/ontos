import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Hex } from 'effect/encoding';

import {
  crmClientEvidencePreimage,
  crmClientEvidenceReferenceFromSha256,
} from '../../shared/domain/crm-client-evidence.ts';

/** Party's own computation of the published CRM client evidence reference, used to verify a CRM intake. */
export const crmClientEvidenceReference = (
  scope: { readonly tenantId: string; readonly legalEntityId: string },
  clientId: string,
) => crmClientEvidenceReferenceFromSha256(Hex.encode(sha256(utf8ToBytes(crmClientEvidencePreimage(scope, clientId)))));
