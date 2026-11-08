import type { ReadCoreError, TrustedPrincipalContext } from '@app/core-runtime';
import { ReadRuntime, readVerifiedGatewayCompositionRevision } from '@app/core-runtime';
import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime/modules/active-application-composition';
import {
  ExternalGatewayContextRequestSchema,
  ResolveExternalSubjectRequestSchema,
} from '@app/shared-contracts/external-identity';
import { ExternalIdentityClient } from '@app/shared-contracts/server/external-identity-client';
import { Context, Crypto, Effect, Layer, Match, Option, Redacted, Schema } from 'effect';

import { verifyOperationPrincipal } from '../../auth/action-principal.ts';
import { retailAccessDecisionRead } from '../../../src/api/retail-access-decision.read.ts';
import type { EnrollmentResourceIdSchema } from '../../../shared/enrollment-contracts.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../../shared/portal-auth-contracts.ts';
import type { RetailPortalPermissionCode } from '../../../shared/domain/profile-contracts.ts';
import { readRetailEnrollmentAccountAuthority } from '../../../src/enrollment/attempts/registration-persistence.ts';
import { CommerceEnrollmentOwnerTransactionRunner } from '../../../src/enrollment/orchestration/owner-transition-production.ts';
import {
  CommerceCoreIdentityClientConfig,
  commerceCoreIdentityClientOptions,
} from '../provider/core-identity-client-config.ts';

const CustomerAuthorityRejectedValue = Schema.TaggedError<{ readonly _tag: 'CustomerAuthorityRejected' }>()(
  'CustomerAuthorityRejected',
  {},
);
export type CustomerAuthorityRejected = InstanceType<typeof CustomerAuthorityRejectedValue>;
const CustomerAuthorityUnavailableValue = Schema.TaggedError<{ readonly _tag: 'CustomerAuthorityUnavailable' }>()(
  'CustomerAuthorityUnavailable',
  {},
);
export type CustomerAuthorityUnavailable = InstanceType<typeof CustomerAuthorityUnavailableValue>;

export interface CustomerAuthorityInput {
  readonly legalEntityId: string;
  readonly permission: RetailPortalPermissionCode;
  readonly providerSubjectId: string;
  readonly sessionRef: string;
  readonly tenantId: string;
}

export interface CurrentCustomerAuthority {
  readonly authBindingId: string;
  readonly partyId: typeof EnrollmentResourceIdSchema.Type;
  /** The exact verified customer context, retained server-side for subsequent governed Reads. */
  readonly principal: TrustedPrincipalContext;
  readonly principalId: string;
  readonly profileId: string;
}

export class CommerceCustomerAuthority extends Context.Service<
  CommerceCustomerAuthority,
  {
    readonly admit: (
      input: CustomerAuthorityInput,
    ) => Effect.Effect<
      CurrentCustomerAuthority,
      CustomerAuthorityRejected | CustomerAuthorityUnavailable,
      Effect.Services<ReturnType<typeof verifyCustomerPrincipal>>
    >;
  }
>()('@app/commerce-customer-context/api/portal-auth/session/customer-authority/CommerceCustomerAuthority') {}

const profileReadPermission = 'retail.profile.read';
const unavailable = (cause: unknown) => Object.assign(new CustomerAuthorityUnavailableValue(), { cause });
const verifyCustomerPrincipal = (token: string) =>
  verifyOperationPrincipal(Redacted.make(`Bearer ${token}`)).pipe(
    Effect.mapError((cause) =>
      Match.value(cause).pipe(
        Match.tags({ ActionPrincipalConfigurationError: unavailable, ActionPrincipalUnavailableError: unavailable }),
        Match.orElse(() => new CustomerAuthorityRejectedValue()),
      ),
    ),
  );

const readAdmissionFailure = (cause: ReadCoreError) =>
  Match.value(cause).pipe(
    Match.tags({
      ReadHandlerNotFound: () => new CustomerAuthorityRejectedValue(),
      ReadPermissionDenied: () => new CustomerAuthorityRejectedValue(),
    }),
    Match.orElse(unavailable),
  );

/** Every call re-admits the real provider session and reads current customer permissions. No service identity is substituted. */
export const commerceCustomerAuthorityLive = Layer.effect(
  CommerceCustomerAuthority,
  Effect.gen(function* customerAuthority() {
    const client = yield* ExternalIdentityClient;
    const configuration = yield* CommerceCoreIdentityClientConfig;
    const compositions = yield* ActiveApplicationCompositionService;
    const runner = yield* CommerceEnrollmentOwnerTransactionRunner;
    const runtime = yield* ReadRuntime;
    const crypto = yield* Crypto.Crypto;
    return {
      admit: Effect.fn('CommerceCustomerAuthority.admit')(function* admit(input: CustomerAuthorityInput) {
        const active = yield* compositions.load.pipe(
          Effect.flatMap(validateActiveApplicationCompositionSnapshot),
          Effect.mapError(unavailable),
        );
        const request = yield* Schema.decodeEffect(ResolveExternalSubjectRequestSchema)({
          authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
          authenticationRef: input.sessionRef,
          compositionRevision: active.composition.revision,
          providerSubjectId: input.providerSubjectId,
          subjectType: 'user',
        }).pipe(Effect.mapError(unavailable));
        const clientOptions = yield* commerceCoreIdentityClientOptions(
          configuration,
          input.tenantId,
          yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable)),
        ).pipe(Effect.mapError(unavailable));
        const identity = yield* client
          .resolveExternalSubject(request, clientOptions)
          .pipe(
            Effect.mapError((cause) =>
              'status' in cause &&
              (cause.status === 401 || cause.status === 403 || cause.status === 404 || cause.status === 422)
                ? new CustomerAuthorityRejectedValue()
                : unavailable(cause),
            ),
          );
        if (
          identity.tenantId !== input.tenantId ||
          identity.authenticationNamespaceId !== COMMERCE_AUTHENTICATION_NAMESPACE_ID ||
          identity.bindingStatus !== 'active'
        ) {
          return yield* new CustomerAuthorityRejectedValue();
        }
        const retained = yield* runner
          .run(input, (transaction) =>
            readRetailEnrollmentAccountAuthority(transaction, {
              authBindingId: identity.authBindingId,
              principalId: identity.principalId,
              providerSubjectId: input.providerSubjectId,
            }),
          )
          .pipe(Effect.mapError(unavailable));
        if (Option.isNone(retained)) {
          return yield* new CustomerAuthorityRejectedValue();
        }
        const gatewayRequest = yield* Schema.decodeEffect(ExternalGatewayContextRequestSchema)({
          ...request,
          audience: 'commerce-customer-context',
          legalEntityId: input.legalEntityId,
        }).pipe(Effect.mapError(unavailable));
        const issued = yield* client
          .issueExternalGatewayContext(gatewayRequest, clientOptions)
          .pipe(
            Effect.mapError((cause) =>
              'status' in cause &&
              (cause.status === 401 || cause.status === 403 || cause.status === 404 || cause.status === 422)
                ? new CustomerAuthorityRejectedValue()
                : unavailable(cause),
            ),
          );
        const principal = yield* verifyCustomerPrincipal(issued.token);
        if (
          principal.principalId !== identity.principalId ||
          principal.authBindingId !== identity.authBindingId ||
          principal.tenantId !== input.tenantId ||
          principal.legalEntityId !== input.legalEntityId ||
          principal.authenticationNamespaceId !== COMMERCE_AUTHENTICATION_NAMESPACE_ID ||
          principal.authContextRef !== input.sessionRef ||
          principal.authMethod !== 'session' ||
          principal.impersonatedByPrincipalId !== undefined ||
          principal.delegatedByPrincipalId !== undefined ||
          readVerifiedGatewayCompositionRevision(principal) !== active.composition.revision
        ) {
          return yield* new CustomerAuthorityRejectedValue();
        }
        const permissions =
          input.permission === profileReadPermission
            ? ([profileReadPermission] as const)
            : ([profileReadPermission, input.permission] as const);
        yield* Effect.forEach(
          permissions,
          Effect.fnUntraced(function* checkCurrentPermission(requiredPermission) {
            const result = yield* runtime
              .runRead({
                audience: 'commerce-customer-context',
                input: {
                  profileRef: {
                    moduleId: 'commerce.customer-context',
                    resourceId: retained.value.profile_id,
                    resourceType: 'commerce.customer-context.retail-customer-profile',
                    tenantId: input.tenantId,
                  },
                  requiredPermission,
                },
                principal,
                registration: retailAccessDecisionRead,
                transport: { correlationId: yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable)) },
              })
              .pipe(Effect.mapError(readAdmissionFailure));
            if (result.decision.outcome === 'AUTHORIZATION_UNAVAILABLE') {
              return yield* new CustomerAuthorityUnavailableValue();
            }
            if (!result.decision.allowed) {
              return yield* new CustomerAuthorityRejectedValue();
            }
            return yield* Effect.void;
          }),
          { concurrency: 1, discard: true },
        );
        const current = yield* compositions.load.pipe(
          Effect.flatMap(validateActiveApplicationCompositionSnapshot),
          Effect.mapError(unavailable),
        );
        if (current.composition.revision !== active.composition.revision) {
          return yield* new CustomerAuthorityUnavailableValue();
        }
        return {
          authBindingId: identity.authBindingId,
          partyId: retained.value.party_id,
          principal,
          principalId: identity.principalId,
          profileId: retained.value.profile_id,
        };
      }),
    };
  }),
);

export const commerceCustomerAuthorityUnavailableLive = Layer.succeed(CommerceCustomerAuthority, {
  admit: () => Effect.fail(new CustomerAuthorityUnavailableValue()),
});

export {
  CustomerAuthorityRejectedValue as CustomerAuthorityRejected,
  CustomerAuthorityUnavailableValue as CustomerAuthorityUnavailable,
};
