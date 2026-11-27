import type { CommunicationRequestEncoded } from '@app/communications-contracts/communication-request';
import { CommunicationRequestSchema } from '@app/communications-contracts/communication-request';
import { executeSubmitCommunicationRequestWithAuthorization } from '@app/communications-contracts/submit-communication-request/client';
import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import { Config, Context, Effect, Layer, Option, Schema } from 'effect';
import { SecureRandom } from 'effect/crypto';

import { withSafeCause } from '../../api/portal-auth/provider/safe-failure.ts';
import type { PortalAuthSubmission } from '../portal-auth/communications/communication-request-submitter.ts';
import {
  GatewayHttpUrlSchema,
  PORTAL_AUTH_COMMUNICATION_RELAY_VARIABLES,
} from '../portal-auth/communications/relay-configuration.ts';
import { PortalAuthCommunicationRequestRefused } from './portal-auth-communication-request-refused.ts';
import type { PortalAuthCommunicationRefusalCode } from './portal-auth-communication-request-refused.ts';
import { SubmitPortalAuthCommunicationRequestRejected } from './submit-portal-auth-communication-request-rejected.ts';

const COMMUNICATIONS_AUDIENCE = 'communications';
const SUBMIT_DECLARATION_KEY = 'communications.core.communication-request.submit';

const configuration = Config.schema(
  GatewayHttpUrlSchema,
  PORTAL_AUTH_COMMUNICATION_RELAY_VARIABLES.communicationsBaseUrl,
);

/**
 * The last hop of the Portal Auth transport (#1406 D1): the module's own source worker, inside its genuine Core delivery,
 * acquires a fresh registered-workload assertion for the public `submit-communication-request` Action and submits the request
 * there. The Shell seals this module as the verified caller of that exact delivery, which is what Communications binds the
 * request's claimed source to. The idempotency key is the request's own replay identity, so a redelivery lands on the stored
 * decision. A failure keeps only its safe kind; the request itself is secret-free by construction.
 *
 * The module declares this registered-workload call (`registered-workload-calls.ts`), the reviewed caller table names it for
 * `communications.core.request-source`, and the Communications Action declares the same declaration beside that workload. A
 * Tenant still needs an active registration of the workload; without one the Shell refuses the assertion and the delivery
 * stays retryable (fail closed), never sent another way.
 */
export interface PortalAuthCommunicationSourceGatewayService {
  /**
   * Communications' stored decision of the request (or the conflict it recorded), as its public Action answered it; or its
   * final refusal of the request itself (`PortalAuthCommunicationRequestRefused`), which no redelivery can change.
   */
  readonly submit: (
    request: CommunicationRequestEncoded,
    context: OutboxWorkerHandlerContext,
  ) => Effect.Effect<
    PortalAuthSubmission,
    PortalAuthCommunicationRequestRefused | SubmitPortalAuthCommunicationRequestRejected
  >;
}

export class PortalAuthCommunicationSourceGateway extends Context.Service<
  PortalAuthCommunicationSourceGateway,
  PortalAuthCommunicationSourceGatewayService
>()(
  '@app/commerce-customer-context/workers/portal-auth-communication-source-gateway/PortalAuthCommunicationSourceGateway',
) {}

const unavailable = (cause: unknown) =>
  withSafeCause(
    new SubmitPortalAuthCommunicationRequestRejected({
      code: 'COMMUNICATIONS_UNAVAILABLE',
      reason: 'The Communications intake could not be reached; the same request is delivered again',
      retryable: true,
    }),
    cause,
  );

const decodeRequest = Schema.decodeUnknownEffect(CommunicationRequestSchema);

/** Communications' answer that the request does not match its published contract. */
const InvalidRequestProblemSchema = Schema.TaggedStruct('SubmitCommunicationRequestActionInvalidProblem', {});
/** Communications' other answers that refuse the request itself for good, each with its closed code. */
const CodedRefusalProblemSchema = Schema.Union([
  Schema.TaggedStruct('SubmitCommunicationRequestActionForbiddenProblem', {
    code: Schema.Literals(['communication_request_scope_mismatch', 'communication_request_source_mismatch']),
  }),
  Schema.TaggedStruct('SubmitCommunicationRequestActionConflictProblem', {
    code: Schema.Literal('action_request_hash_conflict'),
  }),
  Schema.TaggedStruct('SubmitCommunicationRequestActionIneligibleProblem', {
    code: Schema.Literal('action_policy_denied'),
  }),
]);
const isInvalidRequestProblem = Schema.is(InvalidRequestProblemSchema);
const decodeCodedRefusal = Schema.decodeUnknownOption(CodedRefusalProblemSchema);
const refused = (code: PortalAuthCommunicationRefusalCode) => new PortalAuthCommunicationRequestRefused({ code });

const makeGateway = (
  baseUrl: URL,
  crypto: SecureRandom.SecureRandom['Service'],
): PortalAuthCommunicationSourceGatewayService => ({
  submit: Effect.fn('PortalAuthCommunicationSourceGateway.submit')(function* submit(request, context) {
    const requestCorrelation = context.correlationId ?? context.messageId;
    const issued = yield* acquireDelegatedGatewayContext(
      {
        audience: COMMUNICATIONS_AUDIENCE,
        legalEntityScope: 'subject',
        requestCorrelation,
        subject: { _tag: 'RegisteredWorkload', context, declarationKey: SUBMIT_DECLARATION_KEY },
      },
      crypto,
    ).pipe(Effect.mapError(unavailable));
    // a stored request that no longer decodes through the published contract can never be admitted
    const payload = yield* decodeRequest(request).pipe(
      Effect.mapError((cause) => withSafeCause(refused('communication_request_invalid'), cause)),
    );
    return yield* executeSubmitCommunicationRequestWithAuthorization(
      payload,
      issued.authorization,
      requestCorrelation,
      {
        baseUrl,
        compositionRevision: context.compositionRevision,
        idempotencyKey: request.idempotency.key,
      },
    ).pipe(
      Effect.mapError((cause) => {
        // a refusal of the request itself is final; anything else (an outage, a missing registration) is delivered again
        const code = isInvalidRequestProblem(cause)
          ? Option.some('communication_request_invalid' as const)
          : Option.map(decodeCodedRefusal(cause), (problem) => problem.code);
        return Option.match(code, { onNone: () => unavailable(cause), onSome: refused });
      }),
    );
  }),
});

const unconfiguredGateway = (cause: unknown): PortalAuthCommunicationSourceGatewayService => ({
  submit: () => Effect.fail(unavailable(cause)),
});

/** The gateway of this deployment; without a configured Communications origin every delivery stays retryable. */
export const PortalAuthCommunicationSourceGatewayLive = Layer.effect(
  PortalAuthCommunicationSourceGateway,
  Effect.gen(function* portalAuthCommunicationSourceGatewayLayer() {
    const crypto = yield* SecureRandom.SecureRandom;
    return yield* configuration.pipe(
      Effect.match({ onFailure: unconfiguredGateway, onSuccess: (baseUrl) => makeGateway(baseUrl, crypto) }),
    );
  }),
);
