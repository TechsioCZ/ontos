import { CommunicationRequestSchema } from '@app/communications-contracts/communication-request';
import type { CommunicationRequestEncoded } from '@app/communications-contracts/communication-request';
import { DateTime, Effect, Schema } from 'effect';

import {
  PORTAL_AUTH_COMMUNICATION_SOURCE_MODULE,
  PORTAL_AUTH_ISSUANCE_REFERENCE_KEY,
  PORTAL_AUTH_RECIPIENT_ROLE,
  PORTAL_AUTH_RESOURCE_TYPE,
  portalAuthCommunicationPurposeOf,
  portalAuthIdempotencyKey,
} from '../../../shared/portal-auth-communications.ts';
import type { PortalAuthIssuance } from './issuance.ts';

/** The trusted scope the Portal Auth realm of this deployment operates in. */
export interface PortalAuthRequestScope {
  readonly legalEntityId?: string;
  readonly tenantId: string;
}

const decodeRequest = Schema.decodeUnknownEffect(CommunicationRequestSchema, { onExcessProperty: 'error' });
const encodeRequest = Schema.encodeEffect(CommunicationRequestSchema);

/**
 * The Communication Request of one Auth issuance (#1406, D-B). It states WHAT HAPPENED and for whom, never what to send:
 * the issuance (its own occurrence identity, NOT the enrollment `ownerInvocationId`), the original subject and endpoint
 * as references, the instant Auth bound them, the trusted scope and one safe reference. There is no field that could hold
 * a token, link, one-time code, password or address, and the idempotency key derives from the issuance reference alone.
 *
 * Expiry is not a request field: Communications asks Auth for the issuance state at the decision and again at the last
 * stoppable handoff, so an expired, consumed or revoked issuance stops there with a reason and nothing is extended.
 */
export const portalAuthCommunicationRequest = (
  issuance: PortalAuthIssuance,
  scope: PortalAuthRequestScope,
): Effect.Effect<CommunicationRequestEncoded, Schema.SchemaError> => {
  const moduleId = PORTAL_AUTH_COMMUNICATION_SOURCE_MODULE;
  const requestScope =
    scope.legalEntityId === undefined
      ? { tenantId: scope.tenantId }
      : { legalEntityId: scope.legalEntityId, tenantId: scope.tenantId };
  const encoded = {
    idempotency: {
      correlationId: issuance.issuanceRef,
      key: portalAuthIdempotencyKey(issuance.flow, issuance.issuanceRef),
    },
    occurrence: { occurrenceId: issuance.issuanceRef, revision: 1 },
    originalRecipients: [
      {
        originalContact: {
          contactRef: { moduleId, resourceId: issuance.issuanceRef, resourceType: PORTAL_AUTH_RESOURCE_TYPE.endpoint },
          evidence: {
            kind: 'HISTORICAL_SNAPSHOT',
            snapshotRef: {
              moduleId,
              resourceId: issuance.issuanceRef,
              resourceType: PORTAL_AUTH_RESOURCE_TYPE.issuance,
            },
          },
        },
        recipientRef: {
          moduleId,
          resourceId: issuance.providerSubjectId,
          resourceType: PORTAL_AUTH_RESOURCE_TYPE.account,
        },
        role: PORTAL_AUTH_RECIPIENT_ROLE,
        scope: requestScope,
        validAt: DateTime.formatIso(issuance.issuedAt),
      },
    ],
    purpose: portalAuthCommunicationPurposeOf(issuance.flow),
    safeReferences: [
      {
        key: PORTAL_AUTH_ISSUANCE_REFERENCE_KEY,
        ref: { moduleId, resourceId: issuance.issuanceRef, resourceType: PORTAL_AUTH_RESOURCE_TYPE.issuance },
      },
    ],
    schemaVersion: 1,
    scope: requestScope,
    source: { moduleKey: moduleId },
  } as const;
  // the published contract is the only judge of the request: a field it does not know is an error, never silently dropped
  return decodeRequest(encoded).pipe(Effect.flatMap(encodeRequest));
};
