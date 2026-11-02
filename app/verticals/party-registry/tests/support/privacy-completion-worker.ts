// TEST process driver; the registration, gateway and Core matching/ACK are real.
import {
  ApplicationCompositionAuthorityError,
  ActiveApplicationCompositionConfigLive,
  CorePersistenceLive,
  DatabaseConfigLive,
  extractOutboxWorkerSubscriptions,
  OntosOutboxSubscriptionContractSchema,
  OutboxRepositoryLive,
  OutboxRuntime,
  OutboxRuntimeLive,
  OutboxWorkerDescriptorError,
} from '@app/core-runtime';
import { defineOutboxWorkerEntry } from '@app/core-runtime/outbox/worker';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { NodeCrypto, NodeRuntime, NodeServices, NodeStream } from '@effect/platform-node';
import {
  Config,
  Context,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Redacted,
  Schema,
  Stream,
} from 'effect';
import { PgClient } from '@effect/sql-pg';
import { FetchHttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';

import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { partyRegistryBackendRegistration } from '../../vertical.runtime-declaration.ts';
import { outboxWorkerHandlerLayers } from '../../src/worker-host/layer.ts';
import { outboxWorkers } from '../../src/workers/index.ts';
import {
  ExecutePrivacyMeasureWorkerRejected,
  PrivacyMeasureOwnerGateway,
  PrivacyMeasureOwnerGatewayLive,
} from '../../src/workers/privacy-measure-owner-gateway.ts';

const subscriptions = extractOutboxWorkerSubscriptions(outboxWorkers);
const workerMessageSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('barrier'), stage: Schema.Literals(['after-execute', 'after-report']) }),
  Schema.Struct({
    type: Schema.Literal('cycle'),
    matched: Schema.Struct({ deliveriesCreated: Schema.Int, messagesMatched: Schema.Int }),
    cycle: Schema.Struct({
      claimed: Schema.Int,
      dead: Schema.Int,
      deliveriesCreated: Schema.Int,
      failed: Schema.Int,
      messagesMatched: Schema.Int,
      retried: Schema.Int,
      succeeded: Schema.Int,
    }),
  }),
  Schema.Struct({
    type: Schema.Literal('failed'),
    code: Schema.Literals(['composition-unavailable', 'worker-unavailable']),
    reasonCode: Schema.Literals(['native-claim-admission', 'other']),
  }),
  Schema.Struct({
    marker: Schema.Struct({
      appId: Schema.String,
      build: Schema.String,
      buildMarker: Schema.String,
      deployProfile: Schema.String,
      kind: Schema.Literal('microvertical-delivery-unit'),
      packageName: Schema.String,
      schemaVersion: Schema.Literal(1),
      sourceRevision: Schema.String,
      surface: Schema.Literal('api'),
      unitId: Schema.String,
      version: Schema.String,
    }),
    subscriptions: Schema.Array(OntosOutboxSubscriptionContractSchema),
  }),
]);
const writeWorkerMessage = Effect.fn('PrivacyCompletionWorker.writeMessage')(
  (message: typeof workerMessageSchema.Type) =>
    Schema.encodeEffect(Schema.fromJsonString(workerMessageSchema))(message).pipe(
      Effect.flatMap((line) => Effect.sync(() => process.stdout.write(`${line}\n`))),
    ),
);
class PrivacyCompletionWorkerFailure extends Schema.TaggedError<PrivacyCompletionWorkerFailure>()(
  'PrivacyCompletionWorkerFailure',
  { reason: Schema.String },
) {}
const failureReasonCode = (cause: unknown) =>
  Schema.is(ApplicationCompositionAuthorityError)(cause) &&
  cause.reason === 'The worker claim intrinsic admission could not be verified'
    ? ('native-claim-admission' as const)
    : ('other' as const);
const ownsWorkerConnection = (address: URL, database: string, user: string) =>
  database.startsWith('ontos_test_party_gateway_') &&
  ['postgres:', 'postgresql:'].includes(address.protocol) &&
  ['localhost', '127.0.0.1'].includes(address.hostname) &&
  address.search === '' &&
  address.hash === '' &&
  address.pathname === `/${database}` &&
  decodeURIComponent(address.username) === user;

const run = Effect.scoped(
  Effect.gen(function* completionWorker() {
    const unexpectedAdmin = yield* Config.Redacted('DATABASE_ADMIN_URL').pipe(Config.option);
    const database = yield* Config.String('ONTOS_1258_TEST_DATABASE');
    const user = yield* Config.String('ONTOS_1258_TEST_RUNTIME');
    const connection = yield* Config.Redacted('DATABASE_URL');
    const address = new URL(Redacted.value(connection));
    if (!ownsWorkerConnection(address, database, user) || Option.isSome(unexpectedAdmin)) {
      return yield* new PrivacyCompletionWorkerFailure({ reason: 'Worker fixture connection was refused' });
    }
    const reactivity = yield* Reactivity.make;
    const native = yield* PgClient.make({ url: Redacted.make(Redacted.value(connection)), maxConnections: 1 }).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
      Effect.mapError(
        () => new PrivacyCompletionWorkerFailure({ reason: 'Fixture native identity connection is unavailable' }),
      ),
    );
    const rows = yield* native`select current_database() as database, current_user as role,
      session_user as session, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
      from pg_roles where rolname=current_user`.pipe(
      Effect.mapError(() => new PrivacyCompletionWorkerFailure({ reason: 'Fixture native identity is unavailable' })),
    );
    const [row] = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          database: Schema.String,
          role: Schema.String,
          session: Schema.String,
          rolsuper: Schema.Boolean,
          rolbypassrls: Schema.Boolean,
          rolcreaterole: Schema.Boolean,
          rolcreatedb: Schema.Boolean,
        }),
      ),
    )(rows).pipe(
      Effect.mapError(() => new PrivacyCompletionWorkerFailure({ reason: 'Fixture native identity is invalid' })),
    );
    const valid =
      row?.database === database &&
      row.role === user &&
      row.session === user &&
      !row.rolsuper &&
      !row.rolbypassrls &&
      !row.rolcreaterole &&
      !row.rolcreatedb;
    if (!valid) {
      return yield* new PrivacyCompletionWorkerFailure({ reason: 'Worker fixture native identity was refused' });
    }
    const revision = yield* Config.String('ONTOS_1258_TEST_REVISION');
    const advanceMs = yield* Config.schema(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 600_000 })),
      'ONTOS_1258_TEST_CLOCK_ADVANCE_MS',
    ).pipe(Config.withDefault(0));
    const barrier = yield* Config.schema(
      Schema.Literals(['none', 'after-execute', 'after-report']),
      'ONTOS_1258_TEST_BARRIER',
    ).pipe(Config.withDefault('none'));
    const retrySession = yield* Config.schema(
      Schema.Literals(['single', 'dead-letter']),
      'ONTOS_1258_TEST_RETRY_SESSION',
    ).pipe(Config.withDefault('single'));
    if (retrySession === 'dead-letter' && (advanceMs !== 0 || barrier !== 'none')) {
      return yield* new PrivacyCompletionWorkerFailure({ reason: 'The bounded worker retry mode was contradicted' });
    }
    const gatewayContext = yield* Layer.build(PrivacyMeasureOwnerGatewayLive);
    const real = Context.get(gatewayContext, PrivacyMeasureOwnerGateway);
    const hold = (stage: 'after-execute' | 'after-report') =>
      stage === barrier
        ? writeWorkerMessage({ type: 'barrier', stage }).pipe(
            Effect.mapError(
              () =>
                new ExecutePrivacyMeasureWorkerRejected({
                  code: 'WORKER_CONTEXT_INVALID',
                  reason: 'The bounded worker barrier response could not be encoded',
                  retryable: false,
                }),
            ),
            Effect.andThen(Effect.never),
          )
        : Effect.void;
    const gateway = {
      load: real.load,
      execute: (...args: Parameters<typeof real.execute>) =>
        real.execute(...args).pipe(Effect.tap(() => hold('after-execute'))),
      report: (...args: Parameters<typeof real.report>) =>
        real.report(...args).pipe(Effect.tap(() => hold('after-report'))),
    };
    const runtime = Layer.merge(OutboxRuntimeLive, outboxWorkerHandlerLayers.projector).pipe(
      Layer.provide(outboxWorkerHandlerLayers.projectionSource),
      Layer.provide(outboxWorkerHandlerLayers.searchIngestion),
      Layer.provide(outboxWorkerHandlerLayers.searchProjectionStore),
      Layer.provide(outboxWorkerHandlerLayers.searchWorkerSnapshot),
      Layer.provide(OutboxRepositoryLive),
      Layer.provide(CorePersistenceLive),
      Layer.provide(Layer.mergeAll(DatabaseConfigLive, NodeCrypto.layer)),
    );
    const context = yield* Layer.build(runtime);
    const actualRuntime = Context.get(context, OutboxRuntime);
    const advances =
      retrySession === 'dead-letter' ? [0, 2000, 5000, 10_000, 19_000, 36_000, 69_000, 130_000, 200_000] : [advanceMs];
    const completed = yield* Deferred.make<true, PrivacyCompletionWorkerFailure>();
    const acknowledgements = yield* Queue.make<true, PrivacyCompletionWorkerFailure>({ capacity: 1 });
    yield* Effect.addFinalizer(() => Queue.shutdown(acknowledgements));
    let received = 0;
    const input =
      retrySession === 'dead-letter'
        ? yield* NodeStream.fromReadable({
            evaluate: () => process.stdin,
            onError: () => new PrivacyCompletionWorkerFailure({ reason: 'The bounded worker input is unavailable' }),
          }).pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) =>
              Effect.gen(function* acceptBoundedRetryAcknowledgement() {
                yield* Schema.decodeUnknownEffect(
                  Schema.fromJsonString(Schema.Struct({ type: Schema.Literal('continue') })),
                  { onExcessProperty: 'error' },
                )(line).pipe(
                  Effect.mapError(
                    () => new PrivacyCompletionWorkerFailure({ reason: 'Invalid bounded worker acknowledgement' }),
                  ),
                );
                received += 1;
                if (received > advances.length - 1) {
                  return yield* new PrivacyCompletionWorkerFailure({
                    reason: 'The bounded worker received an extra acknowledgement',
                  });
                }
                yield* Queue.offer(acknowledgements, true);
              }),
            ),
            Effect.andThen(
              Effect.suspend(() =>
                received === advances.length - 1
                  ? Effect.void
                  : Effect.fail(new PrivacyCompletionWorkerFailure({ reason: 'The bounded worker input ended early' })),
              ),
            ),
            Effect.tapError((cause) => Queue.fail(acknowledgements, cause)),
            Effect.forkScoped,
          )
        : undefined;
    let cycleIndex = 0;
    const observedRuntime: typeof actualRuntime = {
      matchMessages: actualRuntime.matchMessages,
      runCycle: (cycleInput) =>
        Effect.gen(function* observeActualHostedCycle() {
          const index = cycleIndex;
          const advance = advances[index];
          if (advance === undefined) {
            return yield* Effect.never;
          }
          cycleIndex += 1;
          if (cycleInput.compositionRevision !== revision) {
            return yield* new OutboxWorkerDescriptorError({
              code: 'outbox_worker_descriptor_invalid',
              reason: 'The admitted worker revision differs from the exact test session',
            });
          }
          if (index > 0) {
            yield* Queue.take(acknowledgements).pipe(
              Effect.mapError(
                () =>
                  new OutboxWorkerDescriptorError({
                    code: 'outbox_worker_descriptor_invalid',
                    reason: 'The bounded worker retry acknowledgement was refused',
                  }),
              ),
            );
          }
          const matched = yield* actualRuntime.matchMessages({ compositionRevision: cycleInput.compositionRevision });
          const cycle = yield* actualRuntime.runCycle({
            ...cycleInput,
            now: DateTime.toDateUtc(DateTime.addDuration(yield* DateTime.now, advance)),
          });
          yield* writeWorkerMessage({ type: 'cycle', matched, cycle }).pipe(
            Effect.mapError(
              () =>
                new OutboxWorkerDescriptorError({
                  code: 'outbox_worker_descriptor_invalid',
                  reason: 'The actual worker cycle result could not be encoded',
                }),
            ),
          );
          if (index === advances.length - 1) {
            yield* Deferred.succeed(completed, true);
          }
          return cycle;
        }),
    };
    const authority = ActiveApplicationCompositionConfigLive.pipe(
      Layer.provide(
        ActiveApplicationCompositionSourceLive.pipe(
          Layer.provide(
            FetchHttpClient.layer.pipe(
              Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' })),
            ),
          ),
        ),
      ),
    );
    const entry = defineOutboxWorkerEntry({
      claimOwnerPrefix: 'privacy-completion-test',
      expectedDeployment: ultramodernApiMarker,
      layer: Layer.mergeAll(
        Layer.succeedContext(Context.add(context, OutboxRuntime, observedRuntime)),
        Layer.succeed(PrivacyMeasureOwnerGateway, gateway),
        authority,
      ),
      ownerRegistration: partyRegistryBackendRegistration,
      registrations: outboxWorkers,
      subscriptions,
    });
    yield* Effect.raceFirst(
      entry.runLoop({
        config: { claimOwner: `privacy-completion-${process.pid}`, maxDeliveries: 1, pollIntervalMs: 10 },
        health: {
          cycleFailed: Deferred.fail(
            completed,
            new PrivacyCompletionWorkerFailure({ reason: 'The genuine hosted worker cycle failed' }),
          ).pipe(Effect.asVoid),
          cycleSucceeded: Effect.void,
        },
      }),
      Deferred.await(completed),
    );
    if (input !== undefined) {
      yield* Fiber.join(input);
    }
  }),
);

const program = process.argv.includes('--describe')
  ? Schema.decodeUnknownEffect(workerMessageSchema)({ marker: ultramodernApiMarker, subscriptions }).pipe(
      Effect.flatMap(writeWorkerMessage),
    )
  : run.pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          writeWorkerMessage({
            code: Schema.is(ApplicationCompositionAuthorityError)(cause)
              ? 'composition-unavailable'
              : 'worker-unavailable',
            reasonCode: failureReasonCode(cause),
            type: 'failed',
          }).pipe(Effect.andThen(Effect.fail(cause))),
        onSuccess: () => Effect.void,
      }),
    );

NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* completionWorkerEntry() {
      const services = yield* Layer.build(NodeServices.layer);
      return yield* program.pipe(Effect.provideContext(services));
    }),
  ),
);
