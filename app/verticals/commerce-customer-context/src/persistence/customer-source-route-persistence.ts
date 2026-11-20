import { defineScopedRoutine, ReadHandlerUnavailable } from '@app/core-runtime';
import type { ReadServiceFactory } from '@app/core-runtime';
import {
  readActiveWorkloadBindingHolders,
  readScopedSystemWorkloadEnrollment,
} from '@app/core-runtime/access/enforcement';
import type { WorkloadBindingHolder } from '@app/core-runtime/access/enforcement';
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
  ConfigureCustomerSourceRoutePayloadSchema,
  ConfigureCustomerSourceRouteResultSchema,
  CustomerSourceRouteGenerationSchema,
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
      'PAUSED',
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
const encodePayload = Schema.encodeEffect(ConfigureCustomerSourceRoutePayloadSchema);
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

/**
 * The principals Core admits for a route in its legal entity, from Core's enrollment and the holders of both source
 * workloads read with that legal entity. A route belongs to one legal entity, and Core's company gate admits a workload
 * there only through an active registration for it (D6): the enrolled writer, which runs source writes as a verified
 * gateway workload, through the registration of that very source-write binding; a requested reader, an integration
 * principal that reads directly, through one of any of its active bindings. Anyone else is not enrolled, so the
 * routine answers PRINCIPAL_INELIGIBLE.
 */
export const customerSourceRouteEnrollment = (input: {
  readonly readers: readonly WorkloadBindingHolder[];
  readonly requestedReaders: readonly string[];
  readonly writer: Option.Option<{ readonly principalId: string }>;
  readonly writers: readonly WorkloadBindingHolder[];
}) => ({
  // Core answers a principal id in lower case; a route may state it in any case.
  enrolledReaderPrincipalIds: input.requestedReaders.filter((principalId) =>
    input.readers.some(
      (holder) =>
        holder.principalId === principalId.toLowerCase() &&
        holder.kind === 'integration' &&
        (holder.companyRegistration === 'binding' || holder.companyRegistration === 'other_binding'),
    ),
  ),
  enrolledWriterPrincipalId: input.writer.pipe(
    Option.filter(({ principalId }) =>
      input.writers.some((holder) => holder.principalId === principalId && holder.companyRegistration === 'binding'),
    ),
    Option.map(({ principalId }) => principalId),
    Option.getOrNull,
  ),
});

/** The routines read and write the one registry row under the trusted Tenant and legal entity, in one transaction. */
export const customerSourceRouteServices: ReadServiceFactory<CustomerSourceRouteServices> = (transaction) => {
  /** Core's holders of a workload, each with where it is registered for the route's legal entity (D6). */
  const holdersOf = (workloadKey: string) =>
    readActiveWorkloadBindingHolders(
      transaction,
      transaction.scope.tenantId,
      workloadKey,
      transaction.scope.legalEntityId,
    ).pipe(Effect.mapError(unavailable));

  /**
   * Core's enrollment for the route, read in this transaction after the route's lock is held: the Tenant's one
   * enrolled system principal of the source-write workload, and the holders of both source workloads with where each
   * is registered for the route's legal entity. The routine compares the route with the principals they admit.
   */
  const enrolledPrincipals = Effect.fn('CustomerSourceRoute.enrolledPrincipals')(function* enrolledPrincipals(
    route: CustomerSourceRoute,
  ) {
    const requestedReaders = Match.value(route).pipe(
      Match.tag('PROFILE', 'GROUP_DEFINITION', ({ sourceReaderPrincipalIds }) => sourceReaderPrincipalIds),
      Match.orElse(() => []),
    );
    // One owner transaction: its reads run one after another, and a route naming no reader reads no reader.
    const [writer, writers, readers] = yield* Effect.all(
      [
        readScopedSystemWorkloadEnrollment(transaction, SOURCE_WRITE_WORKLOAD).pipe(Effect.mapError(unavailable)),
        holdersOf(SOURCE_WRITE_WORKLOAD),
        requestedReaders.length === 0 ? Effect.succeed([]) : holdersOf(SOURCE_READ_WORKLOAD),
      ],
      { concurrency: 1 },
    );
    return customerSourceRouteEnrollment({ readers, requestedReaders, writer, writers });
  });

  /** CONFIGURE: lock the route, then read Core's enrollment for it in this transaction, before the routine decides. */
  const lockedEnrollment = Effect.fn('CustomerSourceRoute.lockedEnrollment')(function* lockedEnrollment(
    route: CustomerSourceRoute,
  ) {
    const [lock] = yield* transaction
      .invoke(lockCustomerSourceRouteRoutine, [route._tag, route.route.id])
      .pipe(Effect.mapError(unavailable));
    if (lock === undefined) {
      return yield* unavailable();
    }
    return yield* enrolledPrincipals(route);
  });

  /** The one routine decides both requests; a pause reads no Core enrollment, as it only clears the active flag. */
  const configure = Effect.fn('CustomerSourceRoute.configure')(function* configure({
    actingPrincipalId,
    actionInvocationId,
    payload,
  }: CustomerSourceRouteConfiguration) {
    const request = yield* encodePayload(payload).pipe(Effect.mapError(unavailable));
    const enrolled = yield* Match.value(payload).pipe(
      Match.tagsExhaustive({
        CONFIGURE: ({ route }) => lockedEnrollment(route),
        PAUSE: () => Effect.succeed({}),
      }),
    );
    const [row] = yield* transaction
      .invoke(configureCustomerSourceRouteRoutine, [{ ...request, actingPrincipalId, actionInvocationId, ...enrolled }])
      .pipe(Effect.mapError(unavailable));
    if (row === undefined) {
      return yield* unavailable();
    }
    const result = yield* decodeResult(
      Match.value(row.outcome).pipe(
        Match.when(Match.is('CONFIGURED', 'UNCHANGED'), (tag) => ({
          _tag: tag,
          generation: row.current_generation,
          route: row.stored_route,
        })),
        Match.when('PAUSED', () => ({ _tag: 'PAUSED', generation: row.current_generation })),
        Match.orElse((reason) => ({ _tag: 'REJECTED', currentGeneration: row.current_generation, reason })),
      ),
    ).pipe(Effect.mapError(unavailable));
    return {
      currentGeneration: Option.fromNullishOr(row.current_generation),
      previousGeneration: Option.fromNullishOr(row.previous_generation),
      result,
    } satisfies CustomerSourceRouteDecision;
  });

  return Effect.succeed({ configure });
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
