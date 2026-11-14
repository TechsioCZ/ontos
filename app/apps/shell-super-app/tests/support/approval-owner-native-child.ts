import {
  ActiveApplicationCompositionService,
  DatabaseIdentityEnrollmentContext,
  OperationalScopeResolver,
  SHARED_RUNTIME_IDENTITY,
  loadDatabaseIdentityConnections,
  parseSpiceDbConfig,
} from '@app/core-runtime';
import { makeOwnerActionApprovalsLive } from '@app/core-runtime/access/approvals/owner-runtime';
import { CoreDatabase, makeCoreDatabase } from '@app/core-runtime/db/client';
import {
  OperationalScopeResolverLive,
  makeNativeActionV2Owner,
  makeNativeActionV2OwnerRuntime,
  nativeActionV2DatabaseIdentityEnrollment,
} from '@app/core-runtime/testing/native-action-v2';
import { NodeCrypto, NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node';
import { fromReadable } from '@effect/platform-node/NodeStream';
import { Cause, Context, Effect, Layer, Logger, Redacted, Schema, Stream } from 'effect';
import { HttpServer } from 'effect/http';

import { serveNativeOwnerApprovalHttp } from './approval-owner-native-http.ts';
import {
  NativeOwnerApprovalConfigurationSchema,
  NativeOwnerApprovalListeningSchema,
  NativeOwnerApprovalReadySchema,
} from './approval-owner-native-protocol.ts';
import { NativeOwnerApprovalRedemptionLive } from './approval-owner-native-redemption.ts';

class NativeOwnerChildUnavailable extends Schema.TaggedError<NativeOwnerChildUnavailable>()(
  'NativeOwnerChildUnavailable',
  { reason: Schema.String },
) {}
const unavailable = () =>
  new NativeOwnerChildUnavailable({ reason: 'The independent native approval owner is unavailable' });
const safeDiagnostic = (text: string) =>
  text
    .replaceAll(/(?<scheme>\w+:\/\/)[^\s/@]+:[^\s/@]+@/gu, '$<scheme>[REDACTED]@')
    .replaceAll(/eyJ[\w-]+\.[\w-]+\.[\w-]+/gu, '[REDACTED]')
    .slice(0, 16_384);
const diagnosticLogger = Logger.make((options) =>
  process.stderr.write(`${safeDiagnostic(Logger.formatSimple.log(options))}\n`),
);

const configuration = fromReadable({
  evaluate: () => process.stdin,
  onError: unavailable,
}).pipe(
  Stream.decodeText,
  Stream.runFoldEffect(
    () => ({ bytes: 0, text: '' }),
    (accumulator, chunk) =>
      accumulator.bytes + new TextEncoder().encode(chunk).byteLength > 262_144
        ? Effect.fail(unavailable())
        : Effect.succeed({
            bytes: accumulator.bytes + new TextEncoder().encode(chunk).byteLength,
            text: accumulator.text + chunk,
          }),
  ),
  Effect.flatMap(({ text }) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(NativeOwnerApprovalConfigurationSchema))(text),
  ),
  Effect.mapError(unavailable),
);

const serve = Effect.gen(function* independentOwner() {
  const serverContext = yield* Layer.build(NodeHttpServer.layerTest);
  const server = Context.get(serverContext, HttpServer.HttpServer);
  const { port } = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(server.address);
  const listening = yield* Schema.encodeEffect(Schema.fromJsonString(NativeOwnerApprovalListeningSchema))({
    baseUrl: `http://127.0.0.1:${port}/`,
    pid: process.pid,
    type: 'LISTENING',
  });
  yield* Effect.sync(() => process.stdout.write(`${listening}\n`));
  const input = yield* configuration;
  const original = makeNativeActionV2Owner({ value: 0 });
  if (
    input.expectedDeployment.appId !== original.owner.expectedDeployment.appId ||
    input.expectedDeployment.buildMarker !== original.owner.expectedDeployment.buildMarker
  ) {
    return yield* unavailable();
  }
  const enrollment = nativeActionV2DatabaseIdentityEnrollment;
  const connections = yield* loadDatabaseIdentityConnections({
    enrollment,
    environment: Redacted.value(input.databaseEnvironment),
    envPath: '/dev/null',
  });
  const connection = connections.runtime[SHARED_RUNTIME_IDENTITY.id];
  if (connection === undefined) {
    return yield* unavailable();
  }
  const database = yield* makeCoreDatabase(connection);
  const applicationComposition = { load: Effect.succeed(input.compositionSnapshot) };
  const attached = yield* makeNativeActionV2OwnerRuntime({
    configuration: yield* parseSpiceDbConfig(Redacted.value(input.spiceDbEnvironment)),
    database,
    enrollment,
    owner: {
      applicationComposition,
      expectedDeployment: input.expectedDeployment,
      ownerRegistration: original.owner.ownerRegistration,
    },
    scopeResolverLayer: OperationalScopeResolverLive,
  });
  const dependencies = Layer.mergeAll(
    Layer.succeedContext(attached.gateContext),
    Layer.succeed(CoreDatabase, database),
    Layer.succeed(DatabaseIdentityEnrollmentContext, enrollment),
    Layer.succeed(ActiveApplicationCompositionService, applicationComposition),
    Layer.succeed(OperationalScopeResolver, attached.scopeResolver),
  );
  const dependencyContext = yield* Layer.build(dependencies);
  const ownerContext = yield* Layer.build(
    makeOwnerActionApprovalsLive(input.expectedDeployment, original.owner.ownerRegistration).pipe(
      Layer.provide(Layer.succeedContext(dependencyContext)),
    ),
  );
  const redemptionContext = yield* Layer.build(
    NativeOwnerApprovalRedemptionLive.pipe(Layer.provide(Layer.succeed(CoreDatabase, database))),
  );
  const ready = yield* serveNativeOwnerApprovalHttp({
    deployment: input.expectedDeployment,
    issuer: input.issuer,
    publicJwks: input.publicJwks,
  }).pipe(
    Effect.provideContext(serverContext),
    Effect.provideContext(ownerContext),
    Effect.provideContext(redemptionContext),
    Effect.provideContext(dependencyContext),
  );
  const message = yield* Schema.encodeEffect(Schema.fromJsonString(NativeOwnerApprovalReadySchema))({
    ...ready,
    deployment: original.owner.expectedDeployment,
    type: 'READY',
  });
  yield* Effect.sync(() => process.stdout.write(`${message}\n`));
  return yield* Effect.never;
});

NodeRuntime.runMain(
  Effect.scoped(serve).pipe(
    Effect.onExit(() => Effect.sync(() => process.stderr.write('OwnerApprovalNative scoped resources released\n'))),
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, Logger.layer([diagnosticLogger]))),
    Effect.tapCause((cause) => Effect.sync(() => process.stderr.write(`${safeDiagnostic(Cause.pretty(cause))}\n`))),
  ),
  { disableErrorReporting: true },
);
