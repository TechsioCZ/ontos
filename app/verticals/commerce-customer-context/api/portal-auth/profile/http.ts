import { ActionRuntime, ReadRuntime } from '@app/core-runtime';
import { HttpApiBuilder, HttpApiMiddleware, Layer } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Option, Schema } from 'effect';
import type { HttpServerRequest } from 'effect/http';

import { commerceCustomerContextApi } from '../../../shared/api.ts';
import { UpdateOwnCustomerProfilePayloadSchema } from '../../../shared/portal-auth/own-session.ts';
import {
  CustomerOwnProfileSchemaError,
  ProfileConflictProblemSchema,
  ProfileInvalidProblemSchema,
  ProfileUnavailableProblemSchema,
} from '../../../shared/portal-auth/profile-api.ts';
import type { CustomerOwnProfile, UpdateCustomerOwnProfile } from '../../../shared/portal-auth/profile-api.ts';
import { updateOwnCustomerProfileAction } from '../../../src/actions/update-own-customer-profile.action.ts';
import { customerOwnProfileRead } from '../../../src/api/customer-own-profile.read.ts';
import { noStoreHeaders, requireTrustedOrigin } from '../http-transport.ts';
import {
  OWN_PORTAL_AUDIENCE,
  isOwnPortalRefusal,
  ownPortalTransport,
  ownSessionOf,
} from '../own/own-portal-invocation.ts';
import { withProfileUpdateExchange } from '../own/own-portal-exchange.ts';
import { admitCustomerAccount } from '../session/http.ts';
import { profileAuthentication, profileForbidden, profileInvalid, profileUnavailable } from './problems.ts';

/*
 * The storefront customer's own profile: the same two portal routes, methods and response bodies as before, served by
 * one governed read and one Action of the registered storefront client. The route admits the session from its cookie
 * and invokes the read or Action in-process for exactly that session's own account; it decides nothing itself. The
 * gate (workload binding and company registration) and the owner overlay (the session's own Party) are the only
 * authority, and the owner routines run unchanged inside them.
 */

const isProfileProblem = Schema.is(
  Schema.Union([ProfileConflictProblemSchema, ProfileInvalidProblemSchema, ProfileUnavailableProblemSchema]),
);

/** A governed refusal is the route's 403; the owner's own problems pass as they are; anything else is 503. */
const profileProblemOf = (error: { readonly _tag: string }) => {
  if (isProfileProblem(error)) {
    return error;
  }
  return isOwnPortalRefusal(error) ? profileForbidden() : profileUnavailable();
};

const admitted = Effect.fn('CustomerOwnProfile.admit')(function* admit(request: HttpServerRequest.HttpServerRequest) {
  yield* noStoreHeaders;
  const current = yield* admitCustomerAccount(request).pipe(
    Effect.mapError((problem) => {
      if (problem.status === 401) {
        return profileAuthentication();
      }
      if (problem.status === 403) {
        return profileForbidden();
      }
      return profileUnavailable();
    }),
  );
  if (current.state !== 'authenticated') {
    return yield* Effect.fail(profileAuthentication());
  }
  return current;
});

const read = Effect.fn('CustomerOwnProfile.read')(function* readProfile(request: HttpServerRequest.HttpServerRequest) {
  const current = yield* admitted(request);
  const [session, { correlationId }] = yield* Effect.all(
    [ownSessionOf(current, profileUnavailable), ownPortalTransport(profileUnavailable)],
    { concurrency: 1 },
  );
  return yield* (yield* ReadRuntime)
    .runRead({
      audience: OWN_PORTAL_AUDIENCE,
      input: { session },
      principal: current.workloadPrincipal,
      registration: customerOwnProfileRead,
      transport: { correlationId },
    })
    .pipe(Effect.mapError(profileProblemOf));
});

const update = Effect.fn('CustomerOwnProfile.update')(function* updateProfile(
  request: HttpServerRequest.HttpServerRequest,
  input: UpdateCustomerOwnProfile,
) {
  yield* noStoreHeaders;
  yield* requireTrustedOrigin(request.headers, profileForbidden);
  const current = yield* admitted(request);
  const payload = yield* Schema.encodeEffect(UpdateOwnCustomerProfilePayloadSchema)({
    session: yield* ownSessionOf(current, profileUnavailable),
    update: input,
  }).pipe(Effect.mapError(profileInvalid));
  const transport = yield* ownPortalTransport(profileUnavailable);
  const changed = yield* Deferred.make<CustomerOwnProfile>();
  yield* (yield* ActionRuntime)
    .runAction({
      audience: OWN_PORTAL_AUDIENCE,
      payload,
      principal: current.workloadPrincipal,
      registration: updateOwnCustomerProfileAction,
      transport,
    })
    .pipe(
      withProfileUpdateExchange({
        deliver: (profile) => Deferred.succeed(changed, profile).pipe(Effect.asVoid),
        sessionRef: current.session.sessionRef,
      }),
      Effect.mapError(profileProblemOf),
    );
  // The Action returns only after its owner routine delivered the changed, freshly read profile.
  const profile = yield* Deferred.poll(changed);
  return Option.isSome(profile) ? yield* profile.value : yield* Effect.fail(profileUnavailable());
});

const schemaErrorLive = HttpApiMiddleware.layerSchemaErrorTransform(CustomerOwnProfileSchemaError, () =>
  Effect.fail(profileInvalid()),
);
export const customerOwnProfileReadApiLive = HttpApiBuilder.group(
  commerceCustomerContextApi,
  'customerOwnProfileRead',
  (handlers) => handlers.handle('execute', ({ request }) => read(request)),
).pipe(Layer.provide(schemaErrorLive));
export const customerOwnProfileUpdateApiLive = HttpApiBuilder.group(
  commerceCustomerContextApi,
  'customerOwnProfileUpdate',
  (handlers) => handlers.handle('execute', ({ payload, request }) => update(request, payload)),
).pipe(Layer.provide(schemaErrorLive));
