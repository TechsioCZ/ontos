import { Socket } from 'node:net';
import type { Writable } from 'node:stream';

import { GatewayAssertionRedemptionService } from '@app/core-runtime';
import {
  ActiveApplicationCompositionSnapshotSchema,
  makeActiveApplicationCompositionLayer,
} from '@app/core-runtime/modules/active-application-composition';
import {
  ActionPrincipalInvalidErrorSchema,
  bindGatewayPrincipalVerifier,
} from '@app/gateway-principal-verifier/server';
import { NodeRuntime, NodeSink, NodeStream } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Context, Effect, Layer, Logger, Redacted, Ref, Result, Schema, Stream } from 'effect';
import { Reactivity } from 'effect/reactivity';

import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive,
} from '../../src/auth/gateway-assertion-redemption-runtime.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';

const version = 'ontos.ccc.redemption-restart.v1';
const credential = Schema.RedactedFromValue(Schema.String);
const fields = {
  compositionSnapshot: ActiveApplicationCompositionSnapshotSchema,
  databaseName: Schema.String,
  issuer: Schema.String,
  publicJwks: Schema.String,
  runtimeConnectionString: Schema.RedactedFromValue(Schema.String),
  runtimeUser: Schema.String,
  version: Schema.Literal(version),
};

/** One private, closed command. No administrative URL, SQL or arbitrary operation is accepted. */
export const GatewayRedemptionRestartCommandSchema = Schema.Union([
  Schema.Struct({ ...fields, credentials: Schema.Tuple([credential]), type: Schema.Literal('first-process') }),
  Schema.Struct({
    ...fields,
    credentials: Schema.Tuple([credential, credential]),
    type: Schema.Literal('restarted-process'),
  }),
]);
export const GatewayRedemptionRestartStageSchema = Schema.Literals([
  'READ_COMMAND',
  'DECODE_COMMAND',
  'TARGET_GUARD',
  'CONNECT',
  'IDENTITY_QUERY',
  'IDENTITY_GUARD',
  'STORE_LAYER',
  'VERIFY_ASSERTION',
  'VERIFY_AND_REDEEM',
  'STORE_CONSUME',
  'POOL_FINALIZE',
  'CHILD_TIMEOUT',
  'CHILD_NO_RESPONSE',
  'RESPONSE_PROTOCOL',
  'PRIVATE_OUTPUT',
]);
type RestartStage = typeof GatewayRedemptionRestartStageSchema.Type;
export const GatewayRedemptionRestartResponseSchema = Schema.Union([
  Schema.Struct({
    outcomes: Schema.Array(Schema.Literals(['accepted', 'replay'])).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
    pid: Schema.Int.check(Schema.isGreaterThan(0)),
    type: Schema.Literal('completed'),
    version: Schema.Literal(version),
  }),
  Schema.Struct({
    pid: Schema.Int.check(Schema.isGreaterThan(0)),
    reason: Schema.Literal('REDEMPTION_RESTART_CHILD_FAILED'),
    stage: GatewayRedemptionRestartStageSchema,
    type: Schema.Literal('failed'),
    version: Schema.Literal(version),
  }),
]);

class RedemptionRestartChildFailure extends Schema.TaggedError<RedemptionRestartChildFailure>()(
  'RedemptionRestartChildFailure',
  { reason: Schema.Literal('REDEMPTION_RESTART_CHILD_FAILED'), stage: GatewayRedemptionRestartStageSchema },
) {}
const unavailable = (stage: RestartStage) =>
  new RedemptionRestartChildFailure({ reason: 'REDEMPTION_RESTART_CHILD_FAILED', stage });
// Only a closed operation label crosses IPC; no captured error or cause is serialized.
const atStage = <Value, Failure, Requirements>(
  stage: RestartStage,
  operation: Effect.Effect<Value, Failure, Requirements>,
) => operation.pipe(Effect.catchCause(() => Effect.fail(unavailable(stage))));
const IdentitySchema = Schema.Struct({
  databaseName: Schema.String,
  runtimeUser: Schema.String,
  safeRole: Schema.Literal(true),
});

const redeemInThisProcess = Effect.gen(function* redeemInThisProcessEffect() {
  const commandInput = yield* Effect.acquireRelease(
    Effect.sync(() => new Socket({ fd: 4, readable: true, writable: false })),
    (socket) => Effect.sync(() => socket.destroy()),
  );
  const lines = yield* atStage(
    'READ_COMMAND',
    NodeStream.fromReadable({
      closeOnDone: false,
      evaluate: () => commandInput,
      onError: () => unavailable('READ_COMMAND'),
    }).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.length > 0),
      Stream.runCollect,
    ),
  );
  if (lines.length !== 1) {
    return yield* unavailable('READ_COMMAND');
  }
  const command = yield* atStage(
    'DECODE_COMMAND',
    Schema.decodeUnknownEffect(Schema.fromJsonString(GatewayRedemptionRestartCommandSchema), {
      onExcessProperty: 'error',
    })(lines[0]),
  );
  if (!/^ontos_test_party_gateway_[a-f0-9]{32}$/u.test(command.databaseName)) {
    return yield* unavailable('TARGET_GUARD');
  }
  const connection = yield* Effect.try({
    catch: () => unavailable('TARGET_GUARD'),
    try: () => new URL(Redacted.value(command.runtimeConnectionString)),
  });
  if (
    !['postgres:', 'postgresql:'].includes(connection.protocol) ||
    !['localhost', '127.0.0.1'].includes(connection.hostname) ||
    connection.pathname !== `/${command.databaseName}` ||
    decodeURIComponent(connection.username) !== command.runtimeUser
  ) {
    return yield* unavailable('TARGET_GUARD');
  }
  const client = yield* atStage('CONNECT', PgClient.make({ url: command.runtimeConnectionString }));
  const [identity] = yield* atStage(
    'IDENTITY_QUERY',
    client.unsafe(
      `select current_database() as "databaseName", current_user as "runtimeUser",
      not rolsuper and not rolbypassrls as "safeRole" from pg_roles where rolname = current_user`,
    ),
  );
  const decoded = yield* atStage('IDENTITY_GUARD', Schema.decodeUnknownEffect(IdentitySchema)(identity));
  if (decoded.databaseName !== command.databaseName || decoded.runtimeUser !== command.runtimeUser) {
    return yield* unavailable('IDENTITY_GUARD');
  }
  const storeContext = yield* atStage(
    'STORE_LAYER',
    Layer.build(
      GatewayAssertionRedemptionLive.pipe(
        Layer.provide(GatewayAssertionRedemptionDatabaseLive),
        Layer.provide(Layer.succeed(PgClient.PgClient, client)),
      ),
    ),
  );
  const store = Context.get(storeContext, GatewayAssertionRedemptionService);
  const verifier = bindGatewayPrincipalVerifier('commerce-customer-context', ultramodernApiMarker);
  const replaySeen = yield* Ref.make(false);
  const storeReached = yield* Ref.make(false);
  const observedStore = {
    consume: (input: Parameters<typeof store.consume>[0]) =>
      Ref.set(storeReached, true).pipe(
        Effect.andThen(store.consume(input)),
        Effect.tapErrorTag('GatewayAssertionReplayError', () => Ref.set(replaySeen, true)),
      ),
  };
  const redeem = Effect.fn('GatewayRedemptionRestart.verifyAndRedeem')(function* redeem(assertion: Redacted.Redacted) {
    yield* Ref.set(replaySeen, false);
    yield* Ref.set(storeReached, false);
    const result = yield* atStage(
      'VERIFY_AND_REDEEM',
      verifier
        .verifyAndRedeem(assertion, {
          environment: { ONTOS_GATEWAY_ISSUER: command.issuer, ONTOS_GATEWAY_PUBLIC_JWKS: command.publicJwks },
          redemption: observedStore,
        })
        .pipe(
          Effect.provide(makeActiveApplicationCompositionLayer(Effect.succeed(command.compositionSnapshot))),
          Effect.result,
        ),
    );
    if (Result.isSuccess(result)) {
      return 'accepted' as const;
    }
    if (Schema.is(ActionPrincipalInvalidErrorSchema)(result.failure) && (yield* Ref.get(replaySeen))) {
      return 'replay' as const;
    }
    return yield* unavailable((yield* Ref.get(storeReached)) ? 'STORE_CONSUME' : 'VERIFY_ASSERTION');
  });
  return yield* Effect.forEach(redeem)(command.credentials);
});

/** One response per child; completion includes flushing the writable, not merely queueing bytes. */
export const writeGatewayRedemptionRestartResponse = (
  output: Writable,
  response: typeof GatewayRedemptionRestartResponseSchema.Type,
) =>
  Schema.encodeEffect(Schema.fromJsonString(GatewayRedemptionRestartResponseSchema))(response).pipe(
    Effect.flatMap((line) =>
      Stream.make(`${line}\n`).pipe(
        Stream.run(
          NodeSink.fromWritable({
            endOnDone: true,
            evaluate: () => output,
            onError: () => unavailable('PRIVATE_OUTPUT'),
          }),
        ),
      ),
    ),
  );

// Await asynchronous close/error notification so a real output finalizer failure remains a failed child.
export const closeGatewayRedemptionRestartOutput = (output: Writable) =>
  Effect.callback<true, RedemptionRestartChildFailure>((resume) => {
    if (output.closed) {
      resume(Effect.succeed(true));
      return Effect.void;
    }
    const onError = () => resume(Effect.fail(unavailable('PRIVATE_OUTPUT')));
    const onClose = () => resume(Effect.succeed(true));
    output.once('error', onError);
    output.once('close', onClose);
    output.destroy();
    return Effect.sync(() => {
      output.off('error', onError);
      output.off('close', onClose);
    });
  }).pipe(Effect.asVoid);

const childProgram = Effect.scoped(
  Effect.gen(function* redemptionRestartChild() {
    const output = yield* Effect.acquireRelease(
      Effect.sync(() => new Socket({ fd: 3, readable: false, writable: true })),
      (stream) => closeGatewayRedemptionRestartOutput(stream).pipe(Effect.orDie),
    );
    const send = (response: typeof GatewayRedemptionRestartResponseSchema.Type) =>
      writeGatewayRedemptionRestartResponse(output, response);
    const fail = (stage: RestartStage) =>
      send({ pid: process.pid, reason: 'REDEMPTION_RESTART_CHILD_FAILED', stage, type: 'failed', version }).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      );
    // All pools close before the completion response; the parent additionally awaits actual process exit.
    yield* Effect.scoped(redeemInThisProcess).pipe(
      Effect.timeoutOrElse({ duration: '10 seconds', orElse: () => Effect.fail(unavailable('CHILD_TIMEOUT')) }),
      Effect.result,
      Effect.flatMap((result) =>
        Result.isSuccess(result)
          ? send({ outcomes: result.success, pid: process.pid, type: 'completed', version })
          : fail(result.failure.stage),
      ),
      Effect.catchCause(() => fail('POOL_FINALIZE')),
    );
  }),
);

// Static schema imports are inert. Only the explicit child entry runs native work.
if (process.argv.includes('--gateway-redemption-restart-child')) {
  NodeRuntime.runMain(
    childProgram.pipe(
      Effect.provide(Reactivity.layer),
      Effect.provide(Logger.layer([])),
      Effect.catchCause(() =>
        Effect.sync(() => {
          process.exitCode = 1;
        }),
      ),
    ),
  );
}
