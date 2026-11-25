import { CommunicationRequestSchema } from '@app/communications-contracts/communication-request';
import type { CommunicationRequestEncoded } from '@app/communications-contracts/communication-request';
import type { PortalAuthIssuanceRef } from '@app/portal-auth-contracts/portal-auth-issuance';
import { DateTime, Effect, Schema } from 'effect';

/**
 * LABELLED test builder of the Communication Request that Portal Auth submits for ONE verification issuance. Communications
 * takes no dependency on Auth's module package, so the suites that need a source request of Auth's shape state it here, against
 * the published Communications contract only; the strings are the ones the approved catalog and Auth's published vocabulary
 * carry (the end-to-end suites of Auth assert that they are equal). Every value is FICTIONAL.
 */
const AUTH_MODULE = 'commerce.customer-context';

export interface PortalAuthVerificationIssuance {
  readonly expiresAt: DateTime.DateTime;
  readonly issuanceRef: PortalAuthIssuanceRef;
  readonly issuedAt: DateTime.DateTime;
  readonly providerSubjectId: string;
}

const decodeRequest = Schema.decodeUnknownEffect(CommunicationRequestSchema, { onExcessProperty: 'error' });
const encodeRequest = Schema.encodeEffect(CommunicationRequestSchema);

export const portalAuthVerificationRequest = (
  issuance: PortalAuthVerificationIssuance,
  scope: { readonly tenantId: string },
): Effect.Effect<CommunicationRequestEncoded, Schema.SchemaError> => {
  const issuanceRef = {
    moduleId: AUTH_MODULE,
    resourceId: issuance.issuanceRef,
    resourceType: `${AUTH_MODULE}.portal-auth-issuance`,
  };
  return decodeRequest({
    idempotency: { correlationId: issuance.issuanceRef, key: `portal-auth.verify-email.${issuance.issuanceRef}` },
    occurrence: {
      occurrenceId: issuance.issuanceRef,
      revision: 1,
      validUntil: DateTime.formatIso(issuance.expiresAt),
    },
    originalRecipients: [
      {
        originalContact: {
          contactRef: { ...issuanceRef, resourceType: `${AUTH_MODULE}.portal-auth-endpoint` },
          evidence: { kind: 'HISTORICAL_SNAPSHOT', snapshotRef: issuanceRef },
        },
        recipientRef: {
          moduleId: AUTH_MODULE,
          resourceId: issuance.providerSubjectId,
          resourceType: `${AUTH_MODULE}.portal-auth-account`,
        },
        role: 'account-holder',
        scope,
        validAt: DateTime.formatIso(issuance.issuedAt),
      },
    ],
    purpose: `${AUTH_MODULE}.portal-auth.verify-email`,
    safeReferences: [{ key: 'portal-auth.issuance', ref: issuanceRef }],
    schemaVersion: 1,
    scope,
    source: { moduleKey: AUTH_MODULE },
  }).pipe(Effect.flatMap(encodeRequest));
};
