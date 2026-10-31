// TEST process driver; the registration, gateway and Core matching/ACK are real.
import {
  ApplicationCompositionAuthorityError,
  CorePersistenceLive,
  DatabaseConfigLive,
  extractOutboxWorkerSubscriptions,
  matchOutboxMessages,
  OntosOutboxSubscriptionContractSchema,
  OutboxRepositoryLive,
  OutboxRuntimeLive,
  runOutboxCycle,
} from '@app/core-runtime';
import { NodeCrypto, NodeRuntime, NodeServices, NodeStream } from '@effect/platform-node';
import { Config, Context, DateTime, Effect, Fiber, Layer, Option, Queue, Redacted, Schema, Stream } from 'effect';
import { PgClient } from '@effect/sql-pg';
import { Reactivity } from 'effect/reactivity';

import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { outboxWorkerDatabaseIdentityEnrollmentLive, outboxWorkerHandlerLayers } from '../../src/worker-host/layer.ts';
import { outboxWorkers } from '../../src/workers/index.ts';
import {
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
        ? writeWorkerMessage({ type: 'barrier', stage }).pipe(Effect.andThen(Effect.never))
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
      Layer.provide(outboxWorkerHandlerLayers.searchIngestionRegistry),
      Layer.provide(OutboxRepositoryLive),
      Layer.provide(CorePersistenceLive),
      Layer.provide(Layer.mergeAll(DatabaseConfigLive, outboxWorkerDatabaseIdentityEnrollmentLive, NodeCrypto.layer)),
    );
    const context = yield* Layer.build(runtime);
    const advances =
      retrySession === 'dead-letter' ? [0, 2000, 5000, 10_000, 19_000, 36_000, 69_000, 130_000, 200_000] : [advanceMs];
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
    // Shell's installed-catalog matcher runs concurrently and skip-locks the same unmatched messages. While its
    // transaction is open this worker's match skips them, and the claim would then miss their uncommitted
    // deliveries. Match again until no unmatched message remains, so every cycle claims what was dispatched.
    const unmatchedRemain = native<{ readonly unmatched: boolean }>`
      select exists(select 1 from core.outbox_messages where matched_at is null) as unmatched`.pipe(
      Effect.map(([probe]) => probe?.unmatched === true),
      Effect.mapError(() => new PrivacyCompletionWorkerFailure({ reason: 'Unmatched Outbox messages are unreadable' })),
    );
    const matchSettled = Effect.fn('PrivacyCompletionWorker.matchSettled')(function* matchSettled(
      attempt: number,
    ): Effect.fn.Return<
      Effect.Success<ReturnType<typeof matchOutboxMessages>>,
      Effect.Error<ReturnType<typeof matchOutboxMessages>> | PrivacyCompletionWorkerFailure,
      Effect.Services<ReturnType<typeof matchOutboxMessages>>
    > {
      const matched = yield* matchOutboxMessages({ compositionRevision: revision });
      if (attempt >= 100 || !(yield* unmatchedRemain)) {
        return matched;
      }
      yield* Effect.sleep('10 millis');
      const later = yield* matchSettled(attempt + 1);
      return {
        deliveriesCreated: matched.deliveriesCreated + later.deliveriesCreated,
        messagesMatched: matched.messagesMatched + later.messagesMatched,
      };
    });
    for (const [index, advance] of advances.entries()) {
      if (index > 0) {
        yield* Queue.take(acknowledgements);
      }
      const result = yield* Effect.gen(function* actualCycle() {
        const matched = yield* matchSettled(0);
        const cycle = yield* runOutboxCycle({
          claimOwner: `privacy-completion-${process.pid}`,
          compositionRevision: revision,
          maxDeliveries: 1,
          now: DateTime.toDateUtc(DateTime.addDuration(yield* DateTime.now, advance)),
          registrations: outboxWorkers,
          subscriptions,
        });
        return { matched, cycle };
      }).pipe(Effect.provideService(PrivacyMeasureOwnerGateway, gateway), Effect.provideContext(context));
      yield* writeWorkerMessage({ type: 'cycle', ...result });
    }
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
