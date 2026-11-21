import { isVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { Effect, Schema } from 'effect';

import {
  COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  CommerceSessionReferenceSchema,
} from '../../../shared/portal-auth-contracts.ts';
import type { CurrentCustomerAuthority } from './customer-authority.ts';

/** Server-only values obtained from admitCustomerAccount, never from a request payload. */
export interface CustomerOwnPortalScope {
  readonly authority: CurrentCustomerAuthority;
  readonly legalEntityId: string;
  readonly sessionRef: string;
  readonly tenantId: string;
  readonly workloadPrincipal: Readonly<TrustedPrincipalContext>;
}

/**
 * The freshly admitted customer's own verified principal: exactly the session, account binding, company and Tenant the
 * route admitted, signed in by session in the Commerce namespace. Anything else is the caller's `unavailable`.
 */
export const admittedCustomerPrincipal = Effect.fn('CustomerOwnPortal.admittedPrincipal')(function* admittedPrincipal<
  Failure,
>(scope: CustomerOwnPortalScope, unavailable: () => Failure) {
  if (
    scope.tenantId !== scope.workloadPrincipal.tenantId ||
    scope.legalEntityId !== scope.workloadPrincipal.legalEntityId
  ) {
    return yield* Effect.fail(unavailable());
  }
  const sessionRef = yield* Schema.decodeEffect(CommerceSessionReferenceSchema)(scope.sessionRef).pipe(
    Effect.mapError(unavailable),
  );
  const { principal } = scope.authority;
  if (
    !isVerifiedGatewayPrincipalContext(principal) ||
    principal.authBindingId !== scope.authority.authBindingId ||
    principal.authContextRef !== sessionRef ||
    principal.authenticationNamespaceId !== COMMERCE_AUTHENTICATION_NAMESPACE_ID ||
    principal.authMethod !== 'session' ||
    principal.legalEntityId !== scope.legalEntityId ||
    principal.principalId !== scope.authority.principalId ||
    principal.tenantId !== scope.tenantId
  ) {
    return yield* Effect.fail(unavailable());
  }
  return principal;
});
