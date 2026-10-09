import {
  AuthenticationAdmissionObservationSchema,
  ExternalAuthenticationSubjectSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import type { AuthenticationAdmissionObservation } from '@app/core-runtime/auth/external-identity-contracts';
import type { ExternalOperationAuthenticationRequest } from '@app/core-runtime/operations/external-authentication';
import { DateTime, Effect, Schema } from 'effect';

/** Provider-owned state observed by the Core receiver without importing owner tables. */
export interface TenantBindingIsolationProviderState {
  readonly accountStatus: 'active' | 'disabled';
  readonly businessGrants: readonly {
    readonly status: 'active' | 'revoked';
    readonly tenantId: string;
  }[];
  readonly providerSubjectId: string;
  readonly sessionRef: string;
  readonly sessionStatus: 'active' | 'revoked';
}

/**
 * Public owner HTTP seam for the lane16 composition proof. The Commerce owner can implement
 * this with its generated verification client; the Shell test never imports Commerce storage or
 * handlers. `snapshot` is test evidence that Core binding revoke does not invoke owner cleanup.
 */
export interface TenantBindingIsolationOwnerHttp {
  readonly observeAuthentication: (
    request: ExternalOperationAuthenticationRequest,
  ) => Effect.Effect<AuthenticationAdmissionObservation>;
  readonly snapshot: () => Effect.Effect<TenantBindingIsolationProviderState>;
}

export interface InMemoryTenantBindingIsolationOwnerInput {
  readonly authenticationNamespaceId: string;
  readonly businessGrantTenantIds: readonly string[];
  readonly now: DateTime.Utc;
  readonly providerSubjectId: string;
  readonly sessionRef: string;
}

/**
 * Small public-contract fixture used by the separable Core PostgreSQL proof. Root17 can replace
 * this constructor with the composed owner HTTP port while retaining the exact observations and
 * state assertions. It deliberately has no mutation method: binding revoke cannot clean up a
 * provider account, session or business grant through this seam.
 */
export const makeInMemoryTenantBindingIsolationOwner = (
  input: InMemoryTenantBindingIsolationOwnerInput,
): TenantBindingIsolationOwnerHttp => {
  const subject = Schema.decodeUnknownSync(ExternalAuthenticationSubjectSchema)({
    authenticationNamespaceId: input.authenticationNamespaceId,
    providerSubjectId: input.providerSubjectId,
    subjectType: 'user',
  });
  const state: TenantBindingIsolationProviderState = Object.freeze({
    accountStatus: 'active',
    businessGrants: Object.freeze(
      input.businessGrantTenantIds.map((tenantId) => Object.freeze({ status: 'active' as const, tenantId })),
    ),
    providerSubjectId: subject.providerSubjectId,
    sessionRef: input.sessionRef,
    sessionStatus: 'active',
  });
  return {
    observeAuthentication: (request) =>
      Effect.succeed(
        Schema.decodeUnknownSync(AuthenticationAdmissionObservationSchema)({
          audience: request.audience,
          authBindingId: request.authBindingId,
          authContextRef: request.authContextRef,
          authenticationNamespaceId: request.authenticationNamespaceId,
          bindingRevision: 1,
          expiresAt: DateTime.add(input.now, { milliseconds: 4000 }),
          nonce: request.nonce,
          observedAt: input.now,
          operationRef: request.operationRef,
          principalId: request.principalId,
          tenantId: request.tenantId,
        }),
      ),
    snapshot: () => Effect.succeed(state),
  };
};
