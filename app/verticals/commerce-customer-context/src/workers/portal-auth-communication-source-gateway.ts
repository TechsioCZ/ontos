import type { CommunicationRequestEncoded } from '@app/communications-contracts/communication-request';
import { CommunicationRequestSchema } from '@app/communications-contracts/communication-request';
import { executeSubmitCommunicationRequestWithAuthorization } from '@app/communications/api/submit-communication-request-action/client';
import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import { Config, Context, Crypto, Effect, Layer, Schema } from 'effect';

import { withSafeCause } from '../../api/portal-auth/provider/safe-failure.ts';
import { GatewayHttpUrlSchema } from '../portal-auth/communications/relay-transport.ts';
import { SubmitPortalAuthCommunicationRequestRejected } from './submit-portal-auth-communication-request-rejected.ts';

const COMMUNICATIONS_AUDIENCE = 'communications';
const SUBMIT_DECLARATION_KEY = 'communications.core.submit-communication-request';

const configuration = Config.schema(GatewayHttpUrlSchema, 'ONTOS_COMMUNICATIONS_API_BASE_URL');

/**
 * The last hop of the Portal Auth transport (#1406 D1): the module's own source worker, inside its genuine Core delivery,
 * acquires a fresh registered-workload assertion for the public `submit-communication-request` Action and submits the request
 * there. The Shell seals this module as the verified caller of that exact delivery, which is what Communications binds the
 * request's claimed source to. The idempotency key is the request's own replay identity, so a redelivery lands on the stored
 * decision. A failure keeps only its safe kind; the request itself is secret-free by construction.
 */
export interface PortalAuthCommunicationSourceGatewayService {
  readonly submit: (
    request: CommunicationRequestEncoded,
    context: OutboxWorkerHandlerContext,
  ) => Effect.Effect<void, SubmitPortalAuthCommunicationRequestRejected>;
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

const makeGateway = (baseUrl: URL, crypto: Crypto.Crypto): PortalAuthCommunicationSourceGatewayService => ({
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
    const payload = yield* decodeRequest(request).pipe(Effect.mapError(unavailable));
    yield* executeSubmitCommunicationRequestWithAuthorization(payload, issued.authorization, requestCorrelation, {
      baseUrl,
      compositionRevision: context.compositionRevision,
      idempotencyKey: request.idempotency.key,
    }).pipe(Effect.mapError(unavailable));
  }),
});

const unconfiguredGateway = (cause: unknown): PortalAuthCommunicationSourceGatewayService => ({
  submit: () => Effect.fail(unavailable(cause)),
});

/** The gateway of this deployment; without a configured Communications origin every delivery stays retryable. */
export const PortalAuthCommunicationSourceGatewayLive = Layer.effect(
  PortalAuthCommunicationSourceGateway,
  Effect.gen(function* portalAuthCommunicationSourceGatewayLayer() {
    const crypto = yield* Crypto.Crypto;
    return yield* configuration.pipe(
      Effect.match({ onFailure: unconfiguredGateway, onSuccess: (baseUrl) => makeGateway(baseUrl, crypto) }),
    );
  }),
);
