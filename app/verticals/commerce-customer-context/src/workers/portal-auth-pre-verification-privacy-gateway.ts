import type { CommunicationRequestEncoded } from '@app/communications-contracts/communication-request';
import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import { BindPreVerificationSubjectPayloadSchema } from '@app/privacy/api/bind-pre-verification-subject-action';
import { executeBindPreVerificationSubjectWithAuthorization } from '@app/privacy/api/bind-pre-verification-subject-action/client';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import { Config, Context, Effect, Layer, Option, Schema } from 'effect';
import { SecureRandom } from 'effect/crypto';

import { withSafeCause } from '../../api/portal-auth/provider/safe-failure.ts';
import {
  bindPreVerificationSubjectBy,
  preVerificationBindPayloadOfRequest,
} from '../portal-auth/communications/pre-verification-privacy-binding.ts';
import type { PreVerificationPrivacyTransportService } from '../portal-auth/communications/pre-verification-privacy-transport.ts';
import { PreVerificationPrivacyBindingUnavailable } from '../portal-auth/communications/privacy-binding-unavailable.ts';
import {
  GatewayHttpUrlSchema,
  PORTAL_AUTH_COMMUNICATION_RELAY_VARIABLES,
} from '../portal-auth/communications/relay-configuration.ts';
import { SubmitPortalAuthCommunicationRequestRejected } from './submit-portal-auth-communication-request-rejected.ts';

const PRIVACY_AUDIENCE = 'privacy';
const BIND_DECLARATION_KEY = 'privacy.core.pre-verification-subject.bind';

const configuration = Config.schema(GatewayHttpUrlSchema, PORTAL_AUTH_COMMUNICATION_RELAY_VARIABLES.privacyBaseUrl);

/**
 * The production transport of the Auth -> Privacy bind of a pre-verification subject (#1406 D.8). It runs on the SAME path as
 * the Communication Request: the issuance and its request committed in the Auth-local outbox, the relay queued the request
 * through the module's relay Action, and the module's own source worker, inside its genuine Core delivery, binds the subject
 * here BEFORE it submits the request, so the binding exists whenever Communications decides. The Auth callback never calls
 * Privacy and signup never waits on Privacy.
 *
 * The worker acquires a fresh registered-workload assertion for Privacy's public `bind-pre-verification-subject` Action
 * (`privacy.core.pre-verification-subject-source`), whose declaration the Action names beside that workload. The idempotency
 * key derives from the issuance alone, so a redelivery lands on Privacy's stored binding. The bind carries no address, token,
 * link or code; a failure keeps only its safe kind.
 *
 * Privacy's final answer that binds nothing (its published refusal, a refused payload, a conflicting replay) is final: the
 * request is still submitted and Communications stops it for lack of a binding. An unreachable Privacy stays retryable.
 */
export interface PortalAuthPreVerificationPrivacyGatewayService {
  readonly bind: (
    request: CommunicationRequestEncoded,
    context: OutboxWorkerHandlerContext,
  ) => Effect.Effect<void, SubmitPortalAuthCommunicationRequestRejected>;
}

export class PortalAuthPreVerificationPrivacyGateway extends Context.Service<
  PortalAuthPreVerificationPrivacyGateway,
  PortalAuthPreVerificationPrivacyGatewayService
>()(
  '@app/commerce-customer-context/workers/portal-auth-pre-verification-privacy-gateway/PortalAuthPreVerificationPrivacyGateway',
) {}

/** Privacy's answers that settle the bind for good without a binding. */
const FinalPrivacyAnswerSchema = Schema.Struct({
  _tag: Schema.Literals([
    'BindPreVerificationSubjectActionAlreadyCommittedProblem',
    'BindPreVerificationSubjectActionConflictProblem',
    'BindPreVerificationSubjectActionIneligibleProblem',
    'BindPreVerificationSubjectActionInvalidProblem',
  ]),
});
const isFinalPrivacyAnswer = Schema.is(FinalPrivacyAnswerSchema);

const bindFailure = (reason: PreVerificationPrivacyBindingUnavailable['reason']) => (cause: unknown) =>
  withSafeCause(new PreVerificationPrivacyBindingUnavailable({ reason }), cause);

const decodePayload = Schema.decodeUnknownEffect(BindPreVerificationSubjectPayloadSchema);

/** The registered-workload transport of ONE delivery. */
const registeredWorkloadTransport = (
  baseUrl: URL,
  crypto: SecureRandom.SecureRandom['Service'],
  context: OutboxWorkerHandlerContext,
): PreVerificationPrivacyTransportService => ({
  bind: Effect.fn('PortalAuthPreVerificationPrivacyGateway.transport')(function* bind(encoded) {
    const requestCorrelation = context.correlationId ?? context.messageId;
    const payload = yield* decodePayload(encoded).pipe(Effect.mapError(bindFailure('PRIVACY_REFUSED')));
    const issued = yield* acquireDelegatedGatewayContext(
      {
        audience: PRIVACY_AUDIENCE,
        legalEntityScope: 'subject',
        requestCorrelation,
        subject: { _tag: 'RegisteredWorkload', context, declarationKey: BIND_DECLARATION_KEY },
      },
      crypto,
    ).pipe(Effect.mapError(bindFailure('PRIVACY_UNAVAILABLE')));
    return yield* executeBindPreVerificationSubjectWithAuthorization(
      payload,
      issued.authorization,
      requestCorrelation,
      {
        baseUrl,
        compositionRevision: context.compositionRevision,
        idempotencyKey: `portal-auth.pre-verification-bind.${encoded.occurrence.occurrenceId}`,
      },
    ).pipe(
      Effect.mapError((cause) =>
        bindFailure(isFinalPrivacyAnswer(cause) ? 'PRIVACY_REFUSED' : 'PRIVACY_UNAVAILABLE')(cause),
      ),
    );
  }),
});

const privacyUnavailable = (cause: unknown) =>
  withSafeCause(
    new SubmitPortalAuthCommunicationRequestRejected({
      code: 'PRIVACY_UNAVAILABLE',
      reason: 'Privacy could not bind the pre-verification subject now; the same request is delivered again',
      retryable: true,
    }),
    cause,
  );

const makeGateway = (
  baseUrl: URL,
  crypto: SecureRandom.SecureRandom['Service'],
): PortalAuthPreVerificationPrivacyGatewayService => ({
  bind: (request, context) =>
    Option.match(preVerificationBindPayloadOfRequest(request), {
      // a request that names no Portal Auth account has no subject to bind
      onNone: () => Effect.void,
      onSome: (payload) =>
        bindPreVerificationSubjectBy(registeredWorkloadTransport(baseUrl, crypto, context).bind)(payload).pipe(
          Effect.asVoid,
          // a final Privacy answer binds nothing: the request still goes on and Communications stops it unbound
          Effect.catchIf(
            (failure) => failure.reason !== 'PRIVACY_UNAVAILABLE',
            () => Effect.void,
          ),
          Effect.mapError(privacyUnavailable),
        ),
    }),
});

/** The gateway of this deployment; without a configured Privacy origin every delivery stays retryable. */
export const PortalAuthPreVerificationPrivacyGatewayLive = Layer.effect(
  PortalAuthPreVerificationPrivacyGateway,
  Effect.gen(function* portalAuthPreVerificationPrivacyGatewayLayer() {
    const crypto = yield* SecureRandom.SecureRandom;
    return yield* configuration.pipe(
      Effect.match({
        onFailure: (cause): PortalAuthPreVerificationPrivacyGatewayService => ({
          bind: () => Effect.fail(privacyUnavailable(cause)),
        }),
        onSuccess: (baseUrl) => makeGateway(baseUrl, crypto),
      }),
    );
  }),
);
