import { defineScopedRoutine } from '@app/core-runtime';
import type { ReadServiceFactory } from '@app/core-runtime';
import {
  readScopedSystemWorkloadEnrollment,
  readWorkerWorkloadPrincipalEligibility,
} from '@app/core-runtime/access/enforcement';
import { Effect, Match, Option, Schema } from 'effect';
import {
  ConfigureCustomerSourceRouteResultSchema,
  CustomerSourceRouteGenerationSchema,
  CustomerSourceRouteSchema,
  CustomerSourceRouteUnavailable,
} from '../../shared/domain/customer-source-route.ts';
import type {
  ConfigureCustomerSourceRoutePayload,
  ConfigureCustomerSourceRouteResult,
  CustomerSourceRoute,
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
    current_generation: Schema.toEncoded(Schema.OptionFromNullOr(CustomerSourceRouteGenerationSchema)),
    outcome: Schema.Literals([
      'CONFIGURED',
      'UNCHANGED',
      'EXPECTATION_MISMATCH',
      'PRINCIPAL_INELIGIBLE',
      'SOURCE_IDENTITY_IMMUTABLE',
    ]),
    previous_generation: Schema.toEncoded(Schema.OptionFromNullOr(CustomerSourceRouteGenerationSchema)),
    stored_route: Schema.Unknown,
  }),
  routineKey: 'customer-source-route.configure',
  schema: 'commerce_customer_context',
});

/** Every source write of this owner runs as the source-write workload; Profile source reads as source-read. */
const SOURCE_WRITE_WORKLOAD = 'commerce.customer-context.source-write';
const SOURCE_READ_WORKLOAD = 'commerce.customer-context.source-read';

const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new CustomerSourceRouteUnavailable({
      code: 'PERSISTENCE_UNAVAILABLE',
      reason: 'Commerce source route authority is unavailable',
    }),
    'cause',
    { configurable: true, value: cause },
  );
const encodeRoute = Schema.encodeEffect(CustomerSourceRouteSchema);
const decodeResult = Schema.decodeUnknownEffect(ConfigureCustomerSourceRouteResultSchema, {
  onExcessProperty: 'error',
});

export interface CustomerSourceRouteConfiguration {
  readonly actingPrincipalId: string;
  readonly actionInvocationId: string;
  readonly payload: ConfigureCustomerSourceRoutePayload;
}

/** The answer, with the stored generation the decision read and the one it left (none: no stored route). */
export interface CustomerSourceRouteDecision {
  readonly currentGeneration: Option.Option<number>;
  readonly previousGeneration: Option.Option<number>;
  readonly result: ConfigureCustomerSourceRouteResult;
}

export interface CustomerSourceRouteServices {
  readonly configure: (
    configuration: CustomerSourceRouteConfiguration,
  ) => Effect.Effect<CustomerSourceRouteDecision, CustomerSourceRouteUnavailable>;
}

/** The routine reads and writes the one registry row under the trusted Tenant and legal entity. */
export const customerSourceRouteServices: ReadServiceFactory<CustomerSourceRouteServices> = (transaction) => {
  /**
   * Core's current enrollment facts, read in this transaction: the writer is the Tenant's one enrolled system
   * principal of the source-write workload, and each Profile reader an active integration principal bound to
   * the source-read workload of the Profile source reads.
   */
  const principalsEligible = Effect.fn('CustomerSourceRoute.principalsEligible')(function* principalsEligible(
    route: CustomerSourceRoute,
  ) {
    const writer = yield* readScopedSystemWorkloadEnrollment(transaction, SOURCE_WRITE_WORKLOAD).pipe(
      Effect.mapError(unavailable),
    );
    if (!Option.exists(writer, ({ principalId }) => principalId.toLowerCase() === route.principalId.toLowerCase())) {
      return false;
    }
    const readers = yield* Effect.forEach(
      Match.value(route).pipe(
        Match.tag('PROFILE', ({ sourceReaderPrincipalIds }) => sourceReaderPrincipalIds),
        Match.orElse(() => []),
      ),
      (principalId) =>
        readWorkerWorkloadPrincipalEligibility(transaction, transaction.scope.tenantId, {
          kind: 'integration',
          principalId,
          workloadKey: SOURCE_READ_WORKLOAD,
        }).pipe(Effect.mapError(unavailable)),
      { concurrency: 1 },
    );
    return readers.every(Boolean);
  });

  return Effect.succeed({
    configure: Effect.fn('CustomerSourceRoute.configure')(function* configure({
      actingPrincipalId,
      actionInvocationId,
      payload,
    }: CustomerSourceRouteConfiguration) {
      const [route, eligible] = yield* Effect.all(
        [encodeRoute(payload.route).pipe(Effect.mapError(unavailable)), principalsEligible(payload.route)],
        // One owner transaction: its reads run one after another.
        { concurrency: 1 },
      );
      const [row] = yield* transaction
        .invoke(configureCustomerSourceRouteRoutine, [
          {
            actingPrincipalId,
            actionInvocationId,
            expectedGeneration: Option.getOrNull(payload.expectedGeneration),
            principalsEligible: eligible,
            reason: payload.reason,
            route,
          },
        ])
        .pipe(Effect.mapError(unavailable));
      if (row === undefined) {
        return yield* unavailable();
      }
      const result = yield* decodeResult(
        row.outcome === 'CONFIGURED' || row.outcome === 'UNCHANGED'
          ? { _tag: row.outcome, generation: row.current_generation, route: row.stored_route }
          : { _tag: 'REJECTED', currentGeneration: row.current_generation, reason: row.outcome },
      ).pipe(Effect.mapError(unavailable));
      return {
        currentGeneration: Option.fromNullishOr(row.current_generation),
        previousGeneration: Option.fromNullishOr(row.previous_generation),
        result,
      } satisfies CustomerSourceRouteDecision;
    }),
  });
};
