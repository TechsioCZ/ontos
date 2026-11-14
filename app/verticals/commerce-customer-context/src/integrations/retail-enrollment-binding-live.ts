import { ReadPrincipalBindingPayloadSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { ExternalIdentityClient } from '@app/shared-contracts/server/external-identity-client';
import { Effect, Layer, Schema } from 'effect';

import { CommercePortalAuthAccountLookupService } from '../../api/portal-auth/provider/account-lookup-service.ts';
import {
  CommerceCoreIdentityClientConfig,
  commerceCoreIdentityClientOptions,
} from '../../api/portal-auth/provider/core-identity-client-config.ts';
import { RetailPortalBindingActionRejected } from '../../shared/actions/bind-retail-portal-profile.ts';
import { RetailEnrollmentTargetIdentity } from './retail-enrollment-binding.ts';

const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new RetailPortalBindingActionRejected({
      code: 'DEPENDENCY_UNAVAILABLE',
      reason: 'Current enrollment target identity is unavailable',
      retryable: true,
    }),
    'cause',
    { value: cause },
  );
const denied = () =>
  new RetailPortalBindingActionRejected({
    code: 'ENROLLMENT_EVIDENCE_INSUFFICIENT',
    reason: 'The enrollment provider account or identity is not current',
    retryable: false,
  });

/** Uses the server's reviewed identity transport only to read evidence, never to execute a binding Action. */
export const retailEnrollmentTargetIdentityLive = Layer.effect(
  RetailEnrollmentTargetIdentity,
  Effect.gen(function* targetIdentity() {
    const client = yield* ExternalIdentityClient;
    const configuration = yield* CommerceCoreIdentityClientConfig;
    const accounts = yield* CommercePortalAuthAccountLookupService;
    return {
      resolve: Effect.fn('RetailEnrollmentTargetIdentity.resolve')(function* resolve({
        accountSubject,
        providerInvocationId,
        scope,
      }) {
        if (
          !(yield* accounts
            .verifiedEmailForOwnerInvocation({
              ownerInvocationId: providerInvocationId,
              providerSubjectId: accountSubject.providerSubjectId,
            })
            .pipe(Effect.mapError(unavailable)))
        ) {
          return yield* denied();
        }
        const request = yield* Schema.decodeUnknownEffect(ReadPrincipalBindingPayloadSchema)({
          ...accountSubject,
          lookup: 'subject',
        }).pipe(Effect.mapError(unavailable));
        const options = yield* commerceCoreIdentityClientOptions(
          configuration,
          scope.tenantId,
          scope.correlationId,
        ).pipe(Effect.mapError(unavailable));
        const current = yield* client.readPrincipalBinding(request, options).pipe(Effect.mapError(unavailable));
        if (current.outcome !== 'FOUND') {
          return yield* denied();
        }
        return current;
      }),
    } satisfies typeof RetailEnrollmentTargetIdentity.Service;
  }),
);
