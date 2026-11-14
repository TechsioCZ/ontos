import { ActionRuntime } from '@app/core-runtime';
import { HttpApiBuilder, HttpApiMiddleware, Layer } from '@modern-js/bff-effect/effect-edge';
import { Effect, Redacted, Schema } from 'effect';
import type { HttpServerRequest } from 'effect/http';

import { commerceCustomerContextApi } from '../../../shared/api.ts';
import { ChangeOwnCustomerPasswordPayloadSchema } from '../../../shared/portal-auth/own-session.ts';
import {
  CustomerOwnPasswordChangeSchemaError,
  PasswordChangeCurrentInvalidProblemSchema,
  PasswordChangeInvalidProblemSchema,
  PasswordChangeRateLimitedProblemSchema,
  PasswordChangeUnavailableProblemSchema,
} from '../../../shared/portal-auth/password-change-api.ts';
import type { UpdateCustomerPassword } from '../../../shared/portal-auth/password-change-api.ts';
import { changeOwnCustomerPasswordAction } from '../../../src/actions/change-own-customer-password.action.ts';
import { noStoreHeaders, requestHeaders, requireTrustedOrigin } from '../http-transport.ts';
import {
  OWN_PORTAL_AUDIENCE,
  isOwnPortalRefusal,
  ownPortalTransport,
  ownSessionOf,
} from '../own/own-portal-invocation.ts';
import { withPasswordChangeExchange } from '../own/own-portal-exchange.ts';
import { admitCustomerAccount } from '../session/http.ts';
import {
  passwordChangeAuthentication,
  passwordChangeForbidden,
  passwordChangeInvalid,
  passwordChangeUnavailable,
} from './problems.ts';

/*
 * The storefront customer's own password change: the same portal route, method and response body as before, served
 * by one Action of the registered storefront client, invoked in-process for exactly the admitted session's own
 * account. The gate and the owner overlay decide; the unchanged password routine (`changeOwnPassword`) runs once the
 * Action committed. The passwords are wrapped as redacted values the moment the request is decoded and travel only in
 * this request's own exchange: never in the Action's payload, its request hash, its invocation, its evidence or a log.
 */

const isPasswordProblem = Schema.is(
  Schema.Union([
    PasswordChangeCurrentInvalidProblemSchema,
    PasswordChangeInvalidProblemSchema,
    PasswordChangeRateLimitedProblemSchema,
    PasswordChangeUnavailableProblemSchema,
  ]),
);

/** A governed refusal is the route's 403; the routine's own problems pass as they are; anything else is 503. */
const passwordProblemOf = (error: { readonly _tag: string }) => {
  if (isPasswordProblem(error)) {
    return error;
  }
  return isOwnPortalRefusal(error) ? passwordChangeForbidden() : passwordChangeUnavailable();
};

const admissionProblem = (problem: { readonly status?: number }) => {
  if (problem.status === 401) {
    return passwordChangeAuthentication();
  }
  if (problem.status === 403) {
    return passwordChangeForbidden();
  }
  return passwordChangeUnavailable();
};

const changePassword = Effect.fn('CustomerPasswordChange.route')(function* changePasswordRoute(
  request: HttpServerRequest.HttpServerRequest,
  input: UpdateCustomerPassword,
) {
  const currentPassword = Redacted.make(input.currentPassword);
  const newPassword = Redacted.make(input.newPassword);
  yield* noStoreHeaders;
  yield* requireTrustedOrigin(request.headers, passwordChangeForbidden);
  const current = yield* admitCustomerAccount(request).pipe(Effect.mapError(admissionProblem));
  if (current.state !== 'authenticated') {
    return yield* Effect.fail(passwordChangeAuthentication());
  }
  const payload = yield* Schema.encodeEffect(ChangeOwnCustomerPasswordPayloadSchema)({
    session: yield* ownSessionOf(current, passwordChangeUnavailable),
  }).pipe(Effect.mapError(passwordChangeInvalid));
  const transport = yield* ownPortalTransport(passwordChangeUnavailable);
  yield* (yield* ActionRuntime)
    .runAction({
      audience: OWN_PORTAL_AUDIENCE,
      payload,
      principal: current.workloadPrincipal,
      registration: changeOwnCustomerPasswordAction,
      transport,
    })
    .pipe(
      withPasswordChangeExchange({
        currentPassword,
        newPassword,
        requestHeaders: requestHeaders(request.headers),
        sessionRef: current.session.sessionRef,
      }),
      Effect.mapError(passwordProblemOf),
    );
  return { outcome: 'PASSWORD_CHANGED' as const };
});

const schemaErrorLive = HttpApiMiddleware.layerSchemaErrorTransform(CustomerOwnPasswordChangeSchemaError, () =>
  Effect.fail(passwordChangeInvalid()),
);
export const customerOwnPasswordChangeApiLive = HttpApiBuilder.group(
  commerceCustomerContextApi,
  'customerOwnPasswordChange',
  (handlers) => handlers.handle('execute', ({ payload, request }) => changePassword(request, payload)),
).pipe(Layer.provide(schemaErrorLive));
