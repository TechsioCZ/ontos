import { ConsentAuthorityUnavailableProblemSchema } from '@app/consent-authority-contracts/api';
import { ActionRuntime, ReadRuntime } from '@app/core-runtime';
import { HttpApiBuilder, HttpApiMiddleware, Layer } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Option, Schema } from 'effect';
import type { HttpServerRequest } from 'effect/http';

import { commerceCustomerContextApi } from '../../../shared/api.ts';
import {
  ConsentConflictProblemSchema,
  CustomerOwnConsentSchema,
  CustomerOwnConsentSchemaError,
  DEMO_NEWSLETTER_NOTICE,
} from '../../../shared/portal-auth/consent-api.ts';
import type { UpdateCustomerOwnConsent } from '../../../shared/portal-auth/consent-api.ts';
import { UpdateOwnCustomerConsentPayloadSchema } from '../../../shared/portal-auth/own-session.ts';
import { updateOwnCustomerConsentAction } from '../../../src/actions/update-own-customer-consent.action.ts';
import { customerOwnConsentRead } from '../../../src/api/customer-own-consent.read.ts';
import { noStoreHeaders, requireTrustedOrigin } from '../http-transport.ts';
import {
  OWN_PORTAL_AUDIENCE,
  isOwnPortalRefusal,
  ownPortalTransport,
  ownSessionOf,
} from '../own/own-portal-invocation.ts';
import { withConsentUpdateExchange } from '../own/own-portal-exchange.ts';
import { admitCustomerAccount } from '../session/http.ts';
import type { StoredChoiceSchema } from './choice-persistence.ts';
import { consentAuthentication, consentForbidden, consentInvalid, consentUnavailable } from './problems.ts';

/*
 * The storefront customer's own newsletter consent: the same two portal routes, methods and response bodies as
 * before, served by one governed read and one Action of the registered storefront client, invoked in-process for
 * exactly the admitted session's own account. The gate and the owner overlay decide; the consent evidence and its
 * receipts are the owner routine's own, unchanged.
 */

const isConsentProblem = Schema.is(
  Schema.Union([ConsentConflictProblemSchema, ConsentAuthorityUnavailableProblemSchema]),
);

/** A governed refusal is the route's 403; the owner's own problems pass as they are; anything else is 503. */
const consentProblemOf = (error: { readonly _tag: string }) => {
  if (isConsentProblem(error)) {
    return error;
  }
  return isOwnPortalRefusal(error) ? consentForbidden() : consentUnavailable();
};

const admitted = Effect.fn('CustomerConsent.admit')(function* admit(request: HttpServerRequest.HttpServerRequest) {
  yield* noStoreHeaders;
  const current = yield* admitCustomerAccount(request, 'retail.consent.manage').pipe(
    Effect.mapError((problem) => {
      if (problem.status === 401) {
        return consentAuthentication();
      }
      if (problem.status === 403) {
        return consentForbidden();
      }
      return consentUnavailable();
    }),
  );
  if (current.state !== 'authenticated') {
    return yield* Effect.fail(consentAuthentication());
  }
  return current;
});

const read = Effect.fn('CustomerConsent.read')(function* readConsent(request: HttpServerRequest.HttpServerRequest) {
  const current = yield* admitted(request);
  const [session, { correlationId }] = yield* Effect.all(
    [ownSessionOf(current, consentUnavailable), ownPortalTransport(consentUnavailable)],
    { concurrency: 1 },
  );
  return yield* (yield* ReadRuntime)
    .runRead({
      audience: OWN_PORTAL_AUDIENCE,
      input: { session },
      principal: current.workloadPrincipal,
      registration: customerOwnConsentRead,
      transport: { correlationId },
    })
    .pipe(Effect.mapError(consentProblemOf));
});

const update = Effect.fn('CustomerConsent.update')(function* updateConsent(
  request: HttpServerRequest.HttpServerRequest,
  input: UpdateCustomerOwnConsent,
) {
  yield* noStoreHeaders;
  yield* requireTrustedOrigin(request.headers, consentForbidden);
  const current = yield* admitted(request);
  const payload = yield* Schema.encodeEffect(UpdateOwnCustomerConsentPayloadSchema)({
    session: yield* ownSessionOf(current, consentUnavailable),
    update: input,
  }).pipe(Effect.mapError(consentInvalid));
  const transport = yield* ownPortalTransport(consentUnavailable);
  const recorded = yield* Deferred.make<typeof StoredChoiceSchema.Type>();
  yield* (yield* ActionRuntime)
    .runAction({
      audience: OWN_PORTAL_AUDIENCE,
      payload,
      principal: current.workloadPrincipal,
      registration: updateOwnCustomerConsentAction,
      transport,
    })
    .pipe(
      withConsentUpdateExchange({
        deliver: (choice) => Deferred.succeed(recorded, choice).pipe(Effect.asVoid),
        sessionRef: current.session.sessionRef,
      }),
      Effect.mapError(consentProblemOf),
    );
  // The Action returns only after its owner routine delivered the choice its scoped transaction committed.
  const saved = yield* Deferred.poll(recorded);
  if (Option.isNone(saved)) {
    return yield* Effect.fail(consentUnavailable());
  }
  const choice = yield* saved.value;
  return yield* Schema.decodeEffect(CustomerOwnConsentSchema)({
    decision: choice.decision,
    notice: DEMO_NEWSLETTER_NOTICE,
    revision: choice.revision,
  }).pipe(Effect.mapError(consentUnavailable));
});

const schemaErrorLive = HttpApiMiddleware.layerSchemaErrorTransform(CustomerOwnConsentSchemaError, () =>
  Effect.fail(consentInvalid()),
);
export const customerOwnConsentReadApiLive = HttpApiBuilder.group(
  commerceCustomerContextApi,
  'customerOwnConsentRead',
  (handlers) => handlers.handle('execute', ({ request }) => read(request)),
).pipe(Layer.provide(schemaErrorLive));
export const customerOwnConsentUpdateApiLive = HttpApiBuilder.group(
  commerceCustomerContextApi,
  'customerOwnConsentUpdate',
  (handlers) => handlers.handle('execute', ({ payload, request }) => update(request, payload)),
).pipe(Layer.provide(schemaErrorLive));
