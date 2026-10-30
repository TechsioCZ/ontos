// TEST transport v2: the trusted parent owns the private Unix listener and its 0700 directory.
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { NodeSocket } from '@effect/platform-node';
import { Config, Effect, FileSystem, Path, Schema } from 'effect';

export const privacyCompletionResponseEnvironment = 'ONTOS_1258_TEST_RESPONSE_SOCKET';
export const privacyCompletionResponseTransport = 'private-unix-socket';
export const privacyCompletionResponseLimit = 65_536;

export class PrivacyCompletionResponseFailure extends Schema.TaggedError<PrivacyCompletionResponseFailure>()(
  'PrivacyCompletionResponseFailure',
  { reason: Schema.String },
) {}

export const PrivacyCompletionReadySchema = Schema.Struct({
  apiKey: Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(1))),
  legalEntityId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrivacyCompletionLegalEntityId')),
  marker: Schema.Unknown,
  port: Schema.Number.check(Schema.isInt(), Schema.isBetween({ maximum: 65_535, minimum: 1 })),
  principal: TrustedPrincipalContextSchema,
  protocolVersion: Schema.Literal(2),
  responseTransport: Schema.Literal(privacyCompletionResponseTransport),
  tenantId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrivacyCompletionTenantId')),
  type: Schema.Literal('ready'),
});

const unavailable = () => new PrivacyCompletionResponseFailure({ reason: 'Private response socket is unavailable' });

export const validatePrivacyCompletionResponseSocket = Effect.fn('PrivacyCompletionResponse.validate')(
  function* validatePrivacyCompletionResponseSocket(socketPath: string) {
    const path = yield* Path.Path;
    if (
      !path.isAbsolute(socketPath) ||
      socketPath.includes('\0') ||
      new TextEncoder().encode(socketPath).length > 96 ||
      path.basename(socketPath) !== 'response.sock'
    ) {
      return yield* new PrivacyCompletionResponseFailure({ reason: 'Invalid private response socket path' });
    }
    const fs = yield* FileSystem.FileSystem;
    const directory = path.dirname(socketPath);
    const info = yield* fs.stat(directory).pipe(Effect.mapError(unavailable));
    const canonical = yield* fs.realPath(directory).pipe(Effect.mapError(unavailable));
    if (info.type !== 'Directory' || info.mode % 0o1000 !== 0o700 || canonical !== directory) {
      return yield* new PrivacyCompletionResponseFailure({
        reason: 'Private response socket directory must be canonical and mode 0700',
      });
    }
    const socket = yield* fs.stat(socketPath).pipe(Effect.mapError(unavailable));
    if (socket.type !== 'Socket') {
      return yield* unavailable();
    }
    return socketPath;
  },
);

export const loadPrivacyCompletionResponseSocket = Effect.fn('PrivacyCompletionResponse.load')(
  function* loadPrivacyCompletionResponseSocket() {
    const socketPath = yield* Config.String(privacyCompletionResponseEnvironment).pipe(
      Effect.mapError(
        () => new PrivacyCompletionResponseFailure({ reason: 'Private response socket configuration is required' }),
      ),
    );
    return yield* validatePrivacyCompletionResponseSocket(socketPath);
  },
);

export const sendPrivacyCompletionResponse = Effect.fn('PrivacyCompletionResponse.send')(
  function* sendPrivacyCompletionResponse(socketPath: string, payload: typeof PrivacyCompletionReadySchema.Type) {
    const line = yield* Schema.encodeEffect(Schema.fromJsonString(PrivacyCompletionReadySchema))(payload).pipe(
      Effect.mapError(() => new PrivacyCompletionResponseFailure({ reason: 'Invalid private response payload' })),
    );
    if (new TextEncoder().encode(line).length + 1 > privacyCompletionResponseLimit) {
      return yield* new PrivacyCompletionResponseFailure({ reason: 'Private response payload exceeds its bound' });
    }
    yield* validatePrivacyCompletionResponseSocket(socketPath);
    return yield* Effect.scoped(
      Effect.gen(function* writePrivateResponse() {
        const socket = yield* NodeSocket.makeNet({ openTimeout: '2 seconds', path: socketPath });
        // Acquisition opens the connection; acquiring only the writer would wait forever for this latch.
        yield* socket.reader.pipe(Effect.mapError(unavailable));
        const writer = yield* socket.writer;
        yield* writer.write(`${line}\n`).pipe(Effect.mapError(unavailable));
      }),
    ).pipe(Effect.mapError(unavailable));
  },
);
