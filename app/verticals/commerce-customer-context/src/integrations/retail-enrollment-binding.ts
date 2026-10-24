import { ActionPermissionCheckError } from '@app/core-runtime';
import type { ActionAuthorizationPreflightInput, ActionAuthorizationPreflightService } from '@app/core-runtime';
import { Context, Effect, Option, Schema } from 'effect';
import { BindRetailPortalProfilePayloadSchema } from '../../shared/actions/bind-retail-portal-profile.ts';
import type { RetailPortalBindingPayload } from '../../shared/actions/bind-retail-portal-profile.ts';
import { ProfilePersistenceDependencyFailure } from '../persistence/profile-persistence.ts';

export interface RetailEnrollmentBindingTarget {
  readonly authBindingId: string;
  readonly principalId: string;
}
export type RetailEnrollmentBindingPreparer = (
  input: ActionAuthorizationPreflightInput,
  payload: RetailPortalBindingPayload,
) => Effect.Effect<Option.Option<RetailEnrollmentBindingTarget>, ActionPermissionCheckError>;

/** Missing deployment support never authorizes delegation. Ordinary self-service is independent. */
export const RetailEnrollmentBindingAuthority = Context.Reference<RetailEnrollmentBindingPreparer | null>(
  '@app/commerce-customer-context/RetailEnrollmentBindingAuthority',
  { defaultValue: () => null },
);

export class RetailEnrollmentBindingCapability extends Context.Service<
  RetailEnrollmentBindingCapability,
  {
    readonly take: (
      payload: RetailPortalBindingPayload,
      actionInvocationId: string,
      actorPrincipalId: string,
    ) => Effect.Effect<RetailEnrollmentBindingTarget, ProfilePersistenceDependencyFailure>;
  }
>()('@app/commerce-customer-context/integrations/retail-enrollment-binding/RetailEnrollmentBindingCapability') {}

const sameBindingPayload = Schema.toEquivalence(BindRetailPortalProfilePayloadSchema);

/** One native invocation owns this consumable witness; nothing survives its scoped runtime. */
export const prepareRetailEnrollmentBinding = (prepare: RetailEnrollmentBindingPreparer | null = null) => {
  let retained: {
    readonly input: ActionAuthorizationPreflightInput;
    readonly payload: RetailPortalBindingPayload;
    readonly target: RetailEnrollmentBindingTarget;
  } | null = null;
  const capability: typeof RetailEnrollmentBindingCapability.Service = {
    take: (payload, actionInvocationId, actorPrincipalId) =>
      Effect.suspend(() => {
        const current = retained;
        retained = null;
        if (
          current === null ||
          current.input.actionInvocationId !== actionInvocationId ||
          current.input.principal.principalId !== actorPrincipalId ||
          !sameBindingPayload(current.payload, payload)
        ) {
          return Effect.fail(
            new ProfilePersistenceDependencyFailure({
              reason: 'No exact current enrollment binding authority was prepared',
            }),
          );
        }
        return Effect.succeed(current.target);
      }),
  };
  const preflight: ActionAuthorizationPreflightService = {
    prepare: Effect.fn('RetailEnrollmentBinding.prepare')(function* prepareBinding(input) {
      retained = null;
      if (input.actionKey !== 'commerce.customer-context.bind-retail-portal-profile') {
        return { outcome: 'not_applicable' } as const;
      }
      const payload = yield* Schema.decodeUnknownEffect(BindRetailPortalProfilePayloadSchema)(input.payload).pipe(
        Effect.mapError((cause) =>
          Object.assign(
            new ActionPermissionCheckError({
              code: 'action_permission_check_failed',
              reason: 'The binding request could not be prepared',
            }),
            { cause },
          ),
        ),
      );
      if (payload.principalRef.resourceId === input.principal.principalId) {
        return { outcome: 'not_applicable' } as const;
      }
      if (prepare === null) {
        return { outcome: 'denied' } as const;
      }
      const target = yield* prepare(input, payload);
      if (Option.isNone(target)) {
        return { outcome: 'denied' } as const;
      }
      retained = { input, payload, target: target.value };
      // This proves the target, never substitutes for the workload's native execute permission.
      return { outcome: 'not_applicable' } as const;
    }),
  };
  return {
    capability,
    clear: () => {
      retained = null;
    },
    preflight,
  };
};
