import type { PAYMENT_GATEWAY_RELAY_PATH_PREFIX } from '@app/payment/payment-gateway-relay';
import type { problemDetailsContentType } from '@app/shared-contracts/problem-details';
import type { SYMMY_REST_PREFIX } from '@app/shared-contracts/symmy/route-catalog';
import { DEFAULT_DATA_BATCH_ENDPOINT } from '@modern-js/bff-effect/data-platform';
import type effectServerPlugin from '@modern-js/plugin-bff-extensions/effect-server';
import { flow } from 'effect/Function';
import { Literal, String as SchemaString, TaggedStruct } from 'effect/Schema';

import { symmyRouteNotFoundPayload } from '../shared/symmy-route-not-found.ts';

// Modern's unbundled Node server config keeps these imports type-only.
const symmyRestPrefix = '/api/symmy/v1' satisfies typeof SYMMY_REST_PREFIX;
const paymentGatewayRelayPrefix = '/api/payment/v1' satisfies typeof PAYMENT_GATEWAY_RELAY_PATH_PREFIX;
const problemContentType = 'application/problem+json' satisfies typeof problemDetailsContentType;

const PaymentGatewayRouteNotFoundWireSchema = TaggedStruct('PaymentGatewayRouteNotFoundProblem', {
  detail: SchemaString,
  status: Literal(404),
  title: SchemaString,
  type: SchemaString,
});
/** The same 404 the Payment relay transport answers for a path outside its typed routes. */
const paymentGatewayRouteNotFoundPayload = PaymentGatewayRouteNotFoundWireSchema.make({
  detail: 'The requested payment gateway route does not exist.',
  status: PaymentGatewayRouteNotFoundWireSchema.fields.status.literal,
  title: 'Payment gateway route not found',
  type: 'https://ontos.dev/problems/payment-gateway-route-not-found',
});

type RouteNotFoundPayload = typeof symmyRouteNotFoundPayload | typeof paymentGatewayRouteNotFoundPayload;

const rejectBatchAlias =
  (payload: RouteNotFoundPayload) =>
  (context: { json: (problem: RouteNotFoundPayload, status: 404, headers: Record<string, string>) => Response }) =>
    context.json(payload, payload.status, {
      'Cache-Control': 'no-store',
      'Content-Type': problemContentType,
    });

/**
 * The framework handles its batch envelope under every mounted BFF prefix before any Effect route policy
 * runs. The Symmy and Payment relay mounts serve only their typed routes, so the alias is refused there.
 */
const integrationMounts: readonly { readonly path: string; readonly payload: RouteNotFoundPayload }[] = [
  { path: symmyRestPrefix, payload: symmyRouteNotFoundPayload },
  { path: paymentGatewayRelayPrefix, payload: paymentGatewayRouteNotFoundPayload },
];

const rejectIntegrationBatchAliases: ReturnType<typeof effectServerPlugin> = {
  name: 'ontos:reject-integration-batch-aliases',
  setup(api) {
    api.onPrepare(() => {
      const prefix = api.getServerConfig()?.bff?.prefix;
      if (!Array.isArray(prefix)) {
        return;
      }
      for (const mount of integrationMounts) {
        if (prefix.includes(mount.path)) {
          api.getServerContext().middlewares.push({
            handler: flow(
              rejectBatchAlias(mount.payload),
              Promise.resolve.bind<PromiseConstructor, [], [Response], Promise<Response>>(Promise),
            ),
            method: 'all',
            name: `ontos:reject-batch-alias:${mount.path}`,
            order: 'pre',
            path: `${mount.path}${DEFAULT_DATA_BATCH_ENDPOINT}`,
          });
        }
      }
    });
  },
};

export default { plugins: [rejectIntegrationBatchAliases] };
