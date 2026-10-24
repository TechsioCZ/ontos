import { randomUUID } from 'node:crypto';
import {
  BusinessPermissionCodeSchema,
  ContextAccess,
  PrincipalRefSchema,
  toBusinessPermissionAccessKey,
} from '@app/core-runtime';
import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime/modules/active-application-composition';
import { ResolveExternalSubjectRequestSchema } from '@app/shared-contracts/external-identity';
import { ExternalIdentityClient } from '@app/shared-contracts/server/external-identity-client';
import { Context, Effect, Layer, Option, Schema } from 'effect';

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
  readonly principalId: string;
  readonly profileId: string;
}

export class CommerceCustomerAuthority extends Context.Service<
  CommerceCustomerAuthority,
  {
    readonly admit: (
      input: CustomerAuthorityInput,
    ) => Effect.Effect<CurrentCustomerAuthority, CustomerAuthorityRejected | CustomerAuthorityUnavailable>;
  }
>()('@app/commerce-customer-context/api/portal-auth/session/customer-authority/CommerceCustomerAuthority') {}

const profileReadPermission = 'retail.profile.read';
const unavailable = (cause: unknown) => Object.assign(new CustomerAuthorityUnavailableValue(), { cause });

/** Every call re-admits the real provider session and reads current customer permissions. No service identity is substituted. */
export const commerceCustomerAuthorityLive = Layer.effect(
  CommerceCustomerAuthority,
  Effect.gen(function* customerAuthority() {
    const client = yield* ExternalIdentityClient;
    const configuration = yield* CommerceCoreIdentityClientConfig;
    const compositions = yield* ActiveApplicationCompositionService;
    const runner = yield* CommerceEnrollmentOwnerTransactionRunner;
    const access = yield* ContextAccess;
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
        const identity = yield* client
          .resolveExternalSubject(request, commerceCoreIdentityClientOptions(configuration, randomUUID()))
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
        if (access.businessPermissions === undefined) {
          return yield* new CustomerAuthorityUnavailableValue();
        }
        const principal = yield* Schema.decodeEffect(PrincipalRefSchema)({
          principalId: identity.principalId,
          tenantId: identity.tenantId,
        }).pipe(Effect.mapError(unavailable));
        const permissions =
          input.permission === profileReadPermission
            ? ([profileReadPermission] as const)
            : ([profileReadPermission, input.permission] as const);
        const targets = yield* Effect.forEach(
          permissions,
          (permission) =>
            Schema.decodeEffect(BusinessPermissionCodeSchema)(permission).pipe(
              Effect.map((code) => ({
                permission: code,
                target: {
                  kind: 'retail_profile' as const,
                  legalEntityId: input.legalEntityId,
                  profileId: retained.value.profile_id,
                  tenantId: input.tenantId,
                },
              })),
              Effect.mapError(unavailable),
            ),
          { concurrency: 1 },
        );
        const decisions = yield* access.businessPermissions({ principal, targets });
        if (decisions.length !== targets.length) {
          return yield* new CustomerAuthorityUnavailableValue();
        }
        for (const target of targets) {
          const matches = decisions.filter((decision) => decision.key === toBusinessPermissionAccessKey(target));
          if (matches.length !== 1 || matches[0]?.decision === 'unavailable') {
            return yield* new CustomerAuthorityUnavailableValue();
          }
          if (matches[0]?.decision !== 'allowed') {
            return yield* new CustomerAuthorityRejectedValue();
          }
        }
        return {
          authBindingId: identity.authBindingId,
          partyId: retained.value.party_id,
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
