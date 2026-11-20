import { defineScopedRoutine, ReadHandlerUnavailable } from '@app/core-runtime';
import type { ReadServiceFactory } from '@app/core-runtime';
import {
  readScopedSystemWorkloadEnrollment,
  readWorkerWorkloadPrincipalEligibility,
} from '@app/core-runtime/access/enforcement';
import { Effect, Match, Option, Schema } from 'effect';
import {
  CustomerSourceRouteRequestSchema,
  CustomerSourceRouteResponseSchema,
} from '../../shared/apis/customer-source-route.ts';
import type {
  CustomerSourceRouteRequest,
  CustomerSourceRouteResponse,
} from '../../shared/apis/customer-source-route.ts';
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

const OWNER_MODULE_KEY = 'commerce.customer-context';
const DATABASE_SCHEMA = 'commerce_customer_context';
const generationColumn = Schema.toEncoded(Schema.OptionFromNullOr(CustomerSourceRouteGenerationSchema));

const lockCustomerSourceRouteRoutine = defineScopedRoutine({
  name: 'lock_customer_source_route',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
  ],
  resultSchema: Schema.Struct({ locked: Schema.Literal(true) }),
  routineKey: 'customer-source-route.lock',
  schema: DATABASE_SCHEMA,
});
const configureCustomerSourceRouteRoutine = defineScopedRoutine({
  name: 'configure_customer_source_route',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: Schema.Struct({
    current_generation: generationColumn,
    outcome: Schema.Literals([
      'CONFIGURED',
      'UNCHANGED',
      'EXPECTATION_MISMATCH',
      'PRINCIPAL_INELIGIBLE',
      'SOURCE_IDENTITY_IMMUTABLE',
    ]),
    previous_generation: generationColumn,
    stored_route: Schema.Unknown,
  }),
  routineKey: 'customer-source-route.configure',
  schema: DATABASE_SCHEMA,
});
const pauseCustomerSourceRouteRoutine = defineScopedRoutine({
  name: 'pause_customer_source_route',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: Schema.Struct({
    current_generation: generationColumn,
    outcome: Schema.Literals(['PAUSED', 'UNCHANGED', 'EXPECTATION_MISMATCH']),
    previous_generation: generationColumn,
  }),
  routineKey: 'customer-source-route.pause',
  schema: DATABASE_SCHEMA,
});
const readCustomerSourceRouteRoutine = defineScopedRoutine({
  name: 'read_customer_source_route',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: Schema.Struct({ result: Schema.Unknown }),
  routineKey: 'customer-source-route.read',
  schema: DATABASE_SCHEMA,
});

/** Source writes of this owner run as the source-write workload; Profile and Group source reads as source-read. */
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

/** The routines read and write the one registry row under the trusted Tenant and legal entity, in one transaction. */
export const customerSourceRouteServices: ReadServiceFactory<CustomerSourceRouteServices> = (transaction) => {
  /**
   * Core's enrollment for the route, read in this transaction after the route's lock is held: the Tenant's one
   * enrolled system principal of the source-write workload, and those requested Profile or Group definition
   * readers Core binds as active integration principals to the source-read workload. The routine compares the
   * route with them.
   */
  const enrolledPrincipals = Effect.fn('CustomerSourceRoute.enrolledPrincipals')(function* enrolledPrincipals(
    route: CustomerSourceRoute,
  ) {
    const writer = yield* readScopedSystemWorkloadEnrollment(transaction, SOURCE_WRITE_WORKLOAD).pipe(
      Effect.mapError(unavailable),
    );
    const readers = yield* Effect.forEach(
      Match.value(route).pipe(
        Match.tag('PROFILE', 'GROUP_DEFINITION', ({ sourceReaderPrincipalIds }) => sourceReaderPrincipalIds),
        Match.orElse(() => []),
      ),
      (principalId) =>
        readWorkerWorkloadPrincipalEligibility(transaction, transaction.scope.tenantId, {
          kind: 'integration',
          principalId,
          workloadKey: SOURCE_READ_WORKLOAD,
        }).pipe(
          Effect.mapError(unavailable),
          Effect.map((eligible) => (eligible ? [principalId] : [])),
        ),
      // One owner transaction: its reads run one after another.
      { concurrency: 1 },
    );
    return {
      enrolledReaderPrincipalIds: readers.flat(),
      enrolledWriterPrincipalId: writer.pipe(
        Option.map(({ principalId }) => principalId),
        Option.getOrNull,
      ),
    };
  });

  const configureRoute = Effect.fn('CustomerSourceRoute.configureRoute')(function* configureRoute(
    { actingPrincipalId, actionInvocationId }: CustomerSourceRouteConfiguration,
    payload: Extract<ConfigureCustomerSourceRoutePayload, { readonly _tag: 'CONFIGURE' }>,
  ) {
    // lock -> read Core's enrollment -> write, all in this one transaction, whose statements run one after another.
    const [route, [lock]] = yield* Effect.all(
      [
        encodeRoute(payload.route),
        transaction.invoke(lockCustomerSourceRouteRoutine, [payload.route._tag, payload.route.route.id]),
      ],
      { concurrency: 1 },
    ).pipe(Effect.mapError(unavailable));
    if (lock === undefined) {
      return yield* unavailable();
    }
    const enrolled = yield* enrolledPrincipals(payload.route);
    const [row] = yield* transaction
      .invoke(configureCustomerSourceRouteRoutine, [
        {
          actingPrincipalId,
          actionInvocationId,
          expectedGeneration: Option.getOrNull(payload.expectedGeneration),
          reason: payload.reason,
          route,
          ...enrolled,
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
  });

  /** A pause reads no Core enrollment: it changes only the stored active flag of a route that already exists. */
  const pauseRoute = Effect.fn('CustomerSourceRoute.pauseRoute')(function* pauseRoute(
    { actingPrincipalId, actionInvocationId }: CustomerSourceRouteConfiguration,
    payload: Extract<ConfigureCustomerSourceRoutePayload, { readonly _tag: 'PAUSE' }>,
  ) {
    const [row] = yield* transaction
      .invoke(pauseCustomerSourceRouteRoutine, [
        {
          actingPrincipalId,
          actionInvocationId,
          expectedGeneration: payload.expectedGeneration,
          reason: payload.reason,
          routeId: payload.routeId,
          routeKind: payload.routeKind,
        },
      ])
      .pipe(Effect.mapError(unavailable));
    if (row === undefined) {
      return yield* unavailable();
    }
    const result = yield* decodeResult(
      row.outcome === 'EXPECTATION_MISMATCH'
        ? { _tag: 'REJECTED', currentGeneration: row.current_generation, reason: row.outcome }
        : { _tag: 'PAUSED', generation: row.current_generation },
    ).pipe(Effect.mapError(unavailable));
    return {
      currentGeneration: Option.fromNullishOr(row.current_generation),
      previousGeneration: Option.fromNullishOr(row.previous_generation),
      result,
    } satisfies CustomerSourceRouteDecision;
  });

  return Effect.succeed({
    configure: (configuration: CustomerSourceRouteConfiguration) =>
      Match.value(configuration.payload).pipe(
        Match.tagsExhaustive({
          CONFIGURE: (payload) => configureRoute(configuration, payload),
          PAUSE: (payload) => pauseRoute(configuration, payload),
        }),
      ),
  });
};

const readUnavailable = (cause?: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Commerce source routes are unavailable',
    }),
    'cause',
    { configurable: true, value: cause },
  );
const encodeRouteRequest = Schema.encodeEffect(CustomerSourceRouteRequestSchema);
const decodeStoredRoute = Schema.decodeUnknownEffect(CustomerSourceRouteResponseSchema, { onExcessProperty: 'error' });

export interface CustomerSourceRouteReadServices {
  readonly read: (
    input: CustomerSourceRouteRequest,
  ) => Effect.Effect<CustomerSourceRouteResponse, ReadHandlerUnavailable>;
}

/** The stored route exactly as its owner holds it, with one page of its history, under the trusted scope. */
export const customerSourceRouteReadServices: ReadServiceFactory<CustomerSourceRouteReadServices> = (transaction) =>
  Effect.succeed({
    read: Effect.fn('CustomerSourceRoute.read')(function* read(input: CustomerSourceRouteRequest) {
      const [row] = yield* encodeRouteRequest(input).pipe(
        Effect.flatMap((request) => transaction.invoke(readCustomerSourceRouteRoutine, [request])),
        Effect.mapError(readUnavailable),
      );
      if (row === undefined) {
        return yield* readUnavailable();
      }
      return yield* decodeStoredRoute(row.result).pipe(Effect.mapError(readUnavailable));
    }),
  });
