import { defineScopedRoutine } from '@app/core-runtime';
import type { ReadServiceFactory } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import {
  ConfigureCustomerSourceRoutePayloadSchema,
  CustomerSourceRouteSchema,
  CustomerSourceRouteUnavailable,
} from '../../shared/domain/customer-source-route.ts';
import type {
  ConfigureCustomerSourceRoutePayload,
  ConfigureCustomerSourceRouteResult,
} from '../../shared/domain/customer-source-route.ts';

const configureCustomerSourceRouteRoutine = defineScopedRoutine({
  name: 'configure_customer_source_route',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: Schema.Struct({
    outcome: Schema.Literals(['CONFIGURED', 'UNCHANGED', 'EXPECTATION_MISMATCH', 'SOURCE_IDENTITY_IMMUTABLE']),
    result: Schema.Unknown,
  }),
  routineKey: 'customer-source-route.configure',
  schema: 'commerce_customer_context',
});

const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new CustomerSourceRouteUnavailable({
      code: 'PERSISTENCE_UNAVAILABLE',
      reason: 'Commerce source route authority is unavailable',
    }),
    'cause',
    { configurable: true, value: cause },
  );
const encodePayload = Schema.encodeEffect(ConfigureCustomerSourceRoutePayloadSchema);
const decodeRoute = Schema.decodeUnknownEffect(CustomerSourceRouteSchema, { onExcessProperty: 'error' });
const decodeActual = Schema.decodeUnknownEffect(Schema.OptionFromNullOr(CustomerSourceRouteSchema), {
  onExcessProperty: 'error',
});

export interface CustomerSourceRouteServices {
  readonly configure: (
    payload: ConfigureCustomerSourceRoutePayload,
  ) => Effect.Effect<ConfigureCustomerSourceRouteResult, CustomerSourceRouteUnavailable>;
}

/** The routine reads and writes the one registry row under the trusted Tenant and legal entity. */
export const customerSourceRouteServices: ReadServiceFactory<CustomerSourceRouteServices> = (transaction) =>
  Effect.succeed({
    configure: Effect.fn('CustomerSourceRoute.configure')(function* configure(payload) {
      const input = yield* encodePayload(payload).pipe(Effect.mapError(unavailable));
      const [row] = yield* transaction
        .invoke(configureCustomerSourceRouteRoutine, [input])
        .pipe(Effect.mapError(unavailable));
      if (row === undefined) {
        return yield* unavailable();
      }
      if (row.outcome === 'CONFIGURED' || row.outcome === 'UNCHANGED') {
        const route = yield* decodeRoute(row.result).pipe(Effect.mapError(unavailable));
        return { _tag: row.outcome, route };
      }
      const actual = yield* decodeActual(row.result).pipe(Effect.mapError(unavailable));
      return { _tag: 'REJECTED', actual, reason: row.outcome };
    }),
  });
