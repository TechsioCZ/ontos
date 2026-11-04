import { NodeRuntime, NodeSocket, NodeServices } from '@effect/platform-node';
import { Cause, Config, Effect, FileSystem, Layer, Path, Stream, Schema } from 'effect';
import { Socket } from 'effect/socket';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import {
  marketRevisionNativeBackend,
  MarketRevisionNativeIssueUnavailable,
  marketRevisionNativeServices,
} from '../fixtures/market-revision-native-backend.ts';
import {
  MarketRevisionNativeCommandSchema,
  marketRevisionNativeLines,
  marketRevisionNativeSocketEnvironment,
  validateMarketRevisionNativeSocket,
  MarketRevisionNativeResponseSchema,
} from './market-revision-native-protocol.ts';
import type { CreateMarketResultSchema } from '../../shared/action-contracts.ts';

class MarketRevisionNativeChildError extends Schema.TaggedError<MarketRevisionNativeChildError>()(
  'MarketRevisionNativeChildError',
  {},
) {}
const unavailable = () => new MarketRevisionNativeChildError({});

// Test-only closed startup receipt. Do not serialize error messages, actual schema values or configuration.
const StartupPhaseSchema = Schema.Literals(['services', 'backend', 'ready_decode', 'command']);
const StartupErrorCategorySchema = Schema.Literals([
  'MarketRevisionNativeUnavailable',
  'MarketRevisionNativeChildError',
  'SchemaError',
  'PlatformError',
  'FileSystemError',
  'ConfigError',
  'ApplicationCompositionValidationError',
  'ActiveApplicationCompositionUnavailableError',
  'SqlError',
  'ReferenceError',
  'TypeError',
  'UNKNOWN',
]);
const StartupErrorCodeSchema = Schema.Literals([
  'ENOENT',
  'EACCES',
  'ECONNREFUSED',
  'application_composition_invalid',
  'NotFound',
  'PermissionDenied',
  'BadArgument',
  'SystemError',
  'UNKNOWN',
]);
const StartupSchemaIssueSchema = Schema.Literals([
  'Filter',
  'Encoding',
  'Pointer',
  'MissingKey',
  'UnexpectedKey',
  'Composite',
  'InvalidType',
  'InvalidValue',
  'Forbidden',
  'AnyOf',
  'OneOf',
  'UNKNOWN',
]);
const StartupSchemaFieldSchema = Schema.Literals([
  'composition',
  'modules',
  'requirements',
  'coreCapabilities',
  'operationContracts',
  'deployment',
  'appId',
  'buildMarker',
  'moduleId',
  'contractDocument',
  'schemaVersion',
  'shell',
  'publicSurface',
  'intrinsic',
  'requiredOperations',
  'manifest',
  'publicContract',
  'entrypoint',
  'entrypointKey',
  'id',
  'version',
]);
const StartupDiagnosticSchema = Schema.Struct({
  causes: Schema.Array(
    Schema.Struct({
      category: StartupErrorCategorySchema,
      code: StartupErrorCodeSchema,
      schemaIssue: StartupSchemaIssueSchema,
      schemaPath: Schema.Array(StartupSchemaFieldSchema),
    }),
  ).check(Schema.isMaxLength(3)),
  phase: StartupPhaseSchema,
});
const startupErrorCategory = Schema.Struct({ _tag: StartupErrorCategorySchema });
const startupErrorName = Schema.Struct({ name: StartupErrorCategorySchema });
const startupErrorCode = Schema.Struct({ code: StartupErrorCodeSchema });
const startupPlatformReason = Schema.Struct({ reason: Schema.Struct({ _tag: StartupErrorCodeSchema }) });
const startupSchemaIssue = Schema.Struct({ _tag: StartupSchemaIssueSchema });
const startupSchemaPath = Schema.Struct({ path: Schema.Array(StartupSchemaFieldSchema).check(Schema.isMaxLength(16)) });
const hiddenStartupCause = Schema.Struct({ cause: Schema.Unknown });
const observeStartupFailure =
  (phase: typeof StartupPhaseSchema.Type) =>
  <Value, Failure, Requirements>(program: Effect.Effect<Value, Failure, Requirements>) =>
    program.pipe(
      Effect.tapCause((cause) =>
        Effect.gen(function* writeClosedStartupDiagnostic() {
          const causes: (typeof StartupDiagnosticSchema.Type)['causes'][number][] = [];
          let current: unknown = Cause.squash(cause);
          for (let depth = 0; depth < 3 && current !== undefined; depth += 1) {
            const issue = Schema.isSchemaError(current) ? current.issue : undefined;
            let category: typeof StartupErrorCategorySchema.Type = 'UNKNOWN';
            if (Schema.is(startupErrorCategory)(current)) {
              category = current._tag;
            } else if (Schema.is(startupErrorName)(current)) {
              category = current.name;
            }
            let code: typeof StartupErrorCodeSchema.Type = 'UNKNOWN';
            if (Schema.is(startupErrorCode)(current)) {
              ({ code } = current);
            } else if (Schema.is(startupPlatformReason)(current)) {
              code = current.reason._tag;
            }
            causes.push({
              category,
              code,
              schemaIssue: Schema.is(startupSchemaIssue)(issue) ? issue._tag : 'UNKNOWN',
              schemaPath: Schema.is(startupSchemaPath)(issue) ? issue.path : [],
            });
            current = Schema.is(hiddenStartupCause)(current) ? current.cause : undefined;
          }
          const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(StartupDiagnosticSchema))({ causes, phase });
          const filesystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = path.join(process.cwd(), '.cache', 'ontos-1250');
          yield* filesystem.makeDirectory(directory, { recursive: true });
          yield* filesystem.writeFileString(path.join(directory, `startup-diagnostic-${process.pid}.json`), encoded);
        }).pipe(Effect.exit, Effect.asVoid),
      ),
    );
const serve = Effect.scoped(
  Effect.gen(function* serveOwnerNativeMarket() {
    const socketPath = yield* Config.String(marketRevisionNativeSocketEnvironment).pipe(Effect.mapError(unavailable));
    yield* validateMarketRevisionNativeSocket(socketPath);
    const socket = yield* NodeSocket.makeNet({ openTimeout: '2 seconds', path: socketPath });
    // Retain the opened reader through READY and the complete fixed-command loop.
    const pull = yield* Socket.readerBytes(socket);
    const writer = yield* socket.writer;
    const send = (response: typeof MarketRevisionNativeResponseSchema.Type) =>
      Schema.encodeEffect(Schema.fromJsonString(MarketRevisionNativeResponseSchema))(response).pipe(
        Effect.flatMap((line) => writer.write(`${line}\n`)),
        Effect.mapError(unavailable),
      );
    const managementExecutor = yield* Config.String('ONTOS_NATIVE_MARKET_MANAGEMENT_EXECUTOR').pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Literals(['allowed', 'denied']))),
      Effect.mapError(unavailable),
    );
    const owner = yield* marketRevisionNativeBackend(managementExecutor).pipe(observeStartupFailure('backend'));
    let original: typeof CreateMarketResultSchema.Type | undefined;
    let revised = false;
    const ready = yield* Schema.decodeUnknownEffect(Schema.toType(MarketRevisionNativeResponseSchema))({
      ...owner,
      type: 'READY',
    }).pipe(observeStartupFailure('ready_decode'));
    yield* send(ready);
    yield* marketRevisionNativeLines(pull).pipe(
      Stream.mapEffect((line) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(MarketRevisionNativeCommandSchema), {
          onExcessProperty: 'error',
        })(line),
      ),
      Stream.takeUntil((command) => command.type === 'STOP'),
      Stream.runForEach((command) =>
        Effect.gen(function* runFixedOwnerCommand() {
          if (command.type === 'STOP') {
            return yield* send({ type: 'STOPPED' });
          }
          if (command.type === 'CREATE_R1') {
            if (original !== undefined) {
              return yield* unavailable();
            }
            original = yield* owner.createR1();
            return yield* send({ result: original, type: 'CREATED' });
          }
          if (command.type === 'REVISE_R2') {
            if (original === undefined || revised) {
              return yield* unavailable();
            }
            const result = yield* owner.reviseR2(original);
            revised = true;
            return yield* send({ result, type: 'REVISED' });
          }
          if (command.type === 'ISSUE') {
            return yield* owner.issue(command.input).pipe(
              Effect.map((result): typeof MarketRevisionNativeResponseSchema.Type => ({ type: 'ISSUED', ...result })),
              Effect.catchIf(Schema.is(MarketRevisionNativeIssueUnavailable), (error) =>
                Schema.decodeUnknownEffect(MarketRevisionNativeResponseSchema)({ stage: error.stage, type: 'FAILED' }),
              ),
              Effect.flatMap(send),
            );
          }
          if (command.type === 'SET_CCC_STATE') {
            const actual = yield* owner.setCustomerContextState(command.state);
            return yield* send({ state: actual.state, type: 'CCC_STATE_SET' });
          }
          if (command.type === 'CLOSE_STOREFRONT') {
            yield* owner.closeStorefront();
            return yield* send({ type: 'STOREFRONT_CLOSED' });
          }
          if (command.type === 'EVIDENCE') {
            return yield* owner.evidence().pipe(Effect.flatMap((value) => send({ ...value, type: 'EVIDENCE' })));
          }
          return yield* unavailable();
        }),
      ),
      observeStartupFailure('command'),
    );
  }),
);
const describe = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
  marker: ultramodernApiMarker,
  protocolVersion: 2,
  responseTransport: 'private-unix-duplex',
}).pipe(Effect.flatMap((line) => Effect.sync(() => process.stdout.write(`${line}\n`))));
NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* ownedChildEntry() {
      if (process.argv.includes('--describe')) {
        return yield* describe;
      }
      const services = yield* Layer.build(marketRevisionNativeServices).pipe(observeStartupFailure('services'));
      return yield* serve.pipe(Effect.provideContext(services));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
  { disableErrorReporting: true },
);
