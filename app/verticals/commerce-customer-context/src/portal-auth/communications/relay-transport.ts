import {
  ActiveApplicationCompositionService,
  loadActiveApplicationComposition,
} from '@app/core-runtime/modules/active-application-composition';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { Config, Effect, Layer, Option, Schema } from 'effect';

import { withSafeCause } from '../../../api/portal-auth/provider/safe-failure.ts';
import { executeRelayPortalAuthCommunicationRequestWithAuthorization } from '../../api/relay-portal-auth-communication-request-action-client.ts';
import { CommercePortalAuthCommunicationRequestSubmitter } from './communication-request-submitter.ts';
import type { CommunicationRequestSubmitterService } from './communication-request-submitter.ts';
import { PortalAuthCommunicationUnavailable } from './communication-unavailable.ts';

/**
 * The production transport of the Portal Auth relay (#1406 D1). Communications admits a Communication Request only from the
 * source module's own Outbox Worker, inside a genuine Core delivery of that module (`communications.core.request-source`; the
 * Shell seals the calling module on that delivery). A user-triggered Better Auth flow has no principal after its commit and no
 * Core delivery, so the relay does not call Communications itself: it hands each committed row to this module's own
 * `relay-portal-auth-communication-request` Action under the realm's registered workload credential
 * (`commerce.customer-context.portal-auth-communication-relay`, an API key the operator binds to one principal of the Tenant),
 * and that Action queues the request for the module's source worker (`submit-portal-auth-communication-request`), which
 * submits it with a fresh registered-workload assertion. Core idempotency (the request's own replay key) makes a repeated
 * relay of one row commit once; Communications' owner-local idempotency makes a redelivery land on the stored decision.
 *
 * Its answer is RELAYED: the request is durably queued in Core, not yet decided. The decision is Communications' and reaches
 * Auth through the outcome Read, never through this call. Without its configuration the transport is unavailable and every row
 * stays due (fail closed); nothing is sent another way.
 */

const RELAY_AUDIENCE = 'commerce-customer-context';
const RELAY_OPERATION = 'relay-portal-auth-communication-request';

/** An HTTP(S) origin of a governed gateway or owner API: no credentials, query or fragment. */
export const GatewayHttpUrlSchema = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
      ? undefined
      : 'Gateway URL must be HTTP(S) without credentials, query, or fragment',
  ),
);
const configuration = Config.all({
  apiKey: Config.Redacted('COMMERCE_PORTAL_AUTH_COMMUNICATION_RELAY_API_KEY'),
  ownerBaseUrl: Config.schema(GatewayHttpUrlSchema, 'ONTOS_COMMERCE_CUSTOMER_CONTEXT_API_BASE_URL'),
  shellBaseUrl: Config.schema(GatewayHttpUrlSchema, 'ONTOS_SHELL_GATEWAY_BASE_URL'),
});

const unavailable = (cause: unknown) =>
  withSafeCause(new PortalAuthCommunicationUnavailable({ operation: RELAY_OPERATION }), cause);

export const PortalAuthRelayTransportLive = Layer.effect(
  CommercePortalAuthCommunicationRequestSubmitter,
  Effect.gen(function* makePortalAuthRelayTransport() {
    const compositions = yield* ActiveApplicationCompositionService;
    const configured = yield* configuration.pipe(Effect.option);
    const submit: CommunicationRequestSubmitterService['submit'] = Effect.fn('PortalAuthRelayTransport.submit')(
      function* relay(request) {
        if (Option.isNone(configured)) {
          return yield* unavailable('unconfigured');
        }
        const { apiKey, ownerBaseUrl, shellBaseUrl } = configured.value;
        const requestCorrelation = request.idempotency.correlationId ?? request.idempotency.key;
        const snapshot = yield* loadActiveApplicationComposition(compositions).pipe(Effect.mapError(unavailable));
        const compositionRevision = snapshot.composition.revision;
        const issued = yield* issueApiKeyGatewayContext(
          { audience: RELAY_AUDIENCE, compositionRevision },
          { apiKey, baseUrl: shellBaseUrl, requestCorrelation },
        ).pipe(Effect.mapError(unavailable));
        yield* executeRelayPortalAuthCommunicationRequestWithAuthorization(
          { request },
          `Bearer ${issued.token}`,
          requestCorrelation,
          {
            baseUrl: ownerBaseUrl,
            compositionRevision: issued.compositionRevision,
            idempotencyKey: request.idempotency.key,
          },
        ).pipe(Effect.mapError(unavailable));
        return { outcome: 'RELAYED' } as const;
      },
    );
    return { submit } satisfies CommunicationRequestSubmitterService;
  }),
);
