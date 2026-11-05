import { GatewayContextV3ClaimsSchema } from '@app/shared-contracts';
import {
  acquireDelegatedGatewayContext,
  GatewayDelegationSourceError,
} from '@app/shared-contracts/gateway-context-server';
import { Effect, Redacted, Schema } from 'effect';
import type { Crypto } from 'effect';
import { Base64Url } from 'effect/encoding';

/**
 * The Action invocation an Enrollment Attempt was created under. Every owner call made later by
 * the continuation acts for the subject that invocation ran under (DESIGN D7).
 */
export interface RetailEnrollmentOriginator {
  readonly actionInvocationId: string;
  readonly compositionRevision: string;
  readonly tenantId: string;
}

export interface RetailOwnerCredentialRequest {
  readonly audience: 'commerce-customer-context' | 'party-registry';
  readonly crypto: Crypto.Crypto;
  readonly legalEntityId: string;
  readonly originator: RetailEnrollmentOriginator;
  readonly requestCorrelation: string;
}

export interface RetailOwnerCredential {
  readonly baseUrl: URL;
  readonly credential: Redacted.Redacted;
}

/** The calling module of every Retail enrollment owner call is Commerce Customer Context itself. */
const CALLING_MODULE_APP_ID = 'commerce-customer-context';

/**
 * Acquires an owner credential that acts for the Attempt's originator in the Attempt's Selling Legal
 * Entity, then checks the verified claims of the issued assertion: the audience, the admitted release,
 * the Tenant and Legal Entity of the Attempt, and the calling module (`act`). The originator — the
 * Storefront workload — started the Attempt in the tenant context, so the company is named here, and the
 * Shell admits it only for a workload requester that holds an active binding in the tenant. Nothing here reads a module secret or a subject claim the Shell did not sign.
 */
export const acquireRetailOwnerCredential = Effect.fn('RetailEnrollment.acquireOwnerCredential')(function* acquire(
  request: RetailOwnerCredentialRequest,
) {
  const issued = yield* acquireDelegatedGatewayContext(
    {
      audience: request.audience,
      legalEntityScope: 'subject',
      requestCorrelation: request.requestCorrelation,
      subject: {
        _tag: 'Originator',
        actionInvocationId: request.originator.actionInvocationId,
        compositionRevision: request.originator.compositionRevision,
        legalEntityId: request.legalEntityId,
        tenantId: request.originator.tenantId,
      },
    },
    request.crypto,
  );
  const [, encodedClaims] = issued.authorization.split('.');
  if (encodedClaims === undefined) {
    return yield* new GatewayDelegationSourceError({ reason: 'The issued owner credential is not a signed assertion' });
  }
  const claims = yield* Effect.fromResult(Base64Url.decodeString(encodedClaims)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(GatewayContextV3ClaimsSchema))),
    Effect.mapError(
      (cause) =>
        new GatewayDelegationSourceError({
          cause,
          reason: 'The issued owner credential carries no delegated actor claims',
        }),
    ),
  );
  if (
    claims.aud !== request.audience ||
    claims.compositionRevision !== request.originator.compositionRevision ||
    claims.principal.tenantId !== request.originator.tenantId ||
    claims.principal.legalEntityId !== request.legalEntityId ||
    claims.act.appId !== CALLING_MODULE_APP_ID
  ) {
    return yield* new GatewayDelegationSourceError({
      reason: 'The issued owner credential does not match the Attempt scope and calling module',
    });
  }
  return {
    baseUrl: new URL(issued.apiBaseUrl),
    credential: Redacted.make(issued.authorization),
  } satisfies RetailOwnerCredential;
});
