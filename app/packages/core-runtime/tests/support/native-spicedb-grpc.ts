import { v1 } from '@authzed/authzed-node';
import { Server, ServerCredentials, status } from '@grpc/grpc-js';
import type {
  MethodDefinition,
  ServerUnaryCall,
  ServerWritableStream,
  handleServerStreamingCall,
  handleUnaryCall,
  sendUnaryData,
} from '@grpc/grpc-js';
import { Data, Effect, FiberSet, FileSystem, Path, Schema, Stream } from 'effect';
import type { Scope } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

const INVALID_PRE_SHARED_KEY = 'invalid preshared key';

/** A scripted SpiceDB refusal, delivered to the client as a native gRPC UNAVAILABLE status. */
export class ScriptedSpiceDbUnavailable extends Data.TaggedError('ScriptedSpiceDbUnavailable')<{
  readonly details: string;
}> {}

/** The PermissionsService RPCs a scripted SpiceDB answers; any other RPC is UNIMPLEMENTED natively. */
export interface ScriptedSpiceDbPermissions {
  readonly checkPermission: (
    request: v1.CheckPermissionRequest,
  ) => Effect.Effect<v1.CheckPermissionResponse, ScriptedSpiceDbUnavailable>;
  readonly writeRelationships: (
    request: v1.WriteRelationshipsRequest,
  ) => Effect.Effect<v1.WriteRelationshipsResponse, ScriptedSpiceDbUnavailable>;
}

interface ProtobufMessage<Message> {
  readonly fromBinary: (bytes: Uint8Array) => Message;
  readonly toBinary: (message: Message) => Uint8Array;
}
const unary = <Request, Response>(
  name: string,
  request: ProtobufMessage<Request>,
  response: ProtobufMessage<Response>,
  service = 'PermissionsService',
): MethodDefinition<Request, Response> => ({
  path: `/authzed.api.v1.${service}/${name}`,
  requestDeserialize: (bytes) => request.fromBinary(bytes),
  requestSerialize: (message) => Buffer.from(request.toBinary(message)),
  requestStream: false,
  responseDeserialize: (bytes) => response.fromBinary(bytes),
  responseSerialize: (message) => Buffer.from(response.toBinary(message)),
  responseStream: false,
});

/** A self-signed loopback certificate made for this listener; its key never leaves the scope's directory. */
const loopbackCertificate = Effect.gen(function* loopbackCertificate() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-spicedb-tls-' });
  const key = path.join(directory, 'key.pem');
  const cert = path.join(directory, 'cert.pem');
  const openssl = yield* spawner.spawn(
    ChildProcess.make('openssl', [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ]),
  );
  const [exitCode, diagnostics] = yield* Effect.all(
    [openssl.exitCode, openssl.stderr.pipe(Stream.decodeText(), Stream.mkString), Stream.runDrain(openssl.stdout)],
    { concurrency: 'unbounded' },
  );
  if (exitCode !== 0) {
    return yield* Effect.die(new Error(`openssl could not create the loopback certificate: ${diagnostics}`));
  }
  return { cert: yield* fs.readFileString(cert), key: yield* fs.readFileString(key) };
});

/**
 * A SpiceDB PermissionsService over native gRPC and TLS on localhost, answering through `permissions` and
 * accepting only `preSharedKey`. The production authzed client reaches it exactly as it reaches SpiceDB.
 */
export const serveScriptedSpiceDb = Effect.fn('NativeSpiceDbGrpc.serve')(function* serveScriptedSpiceDb(
  preSharedKey: string,
  permissions: ScriptedSpiceDbPermissions,
): Effect.fn.Return<
  { readonly caCertificate: string; readonly endpoint: string },
  Error,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  const { cert, key } = yield* loopbackCertificate.pipe(Effect.orDie);
  const runAnswer = yield* FiberSet.makeRuntime();
  const respond = <Request, Response>(
    call: ServerUnaryCall<Request, Response>,
    reply: sendUnaryData<Response>,
    answer: (request: Request) => Effect.Effect<Response, ScriptedSpiceDbUnavailable>,
  ) => {
    if (!call.metadata.get('authorization').includes(`Bearer ${preSharedKey}`)) {
      reply({ code: status.UNAUTHENTICATED, details: INVALID_PRE_SHARED_KEY });
      return;
    }
    runAnswer(
      answer(call.request).pipe(
        Effect.match({
          onFailure: ({ details }) => reply({ code: status.UNAVAILABLE, details }),
          onSuccess: (response) => reply(null, response),
        }),
      ),
    );
  };
  const server = yield* Effect.acquireRelease(
    Effect.sync(() => new Server()),
    (running) => Effect.sync(() => running.forceShutdown()),
  );
  const checkPermission: handleUnaryCall<v1.CheckPermissionRequest, v1.CheckPermissionResponse> = (call, reply) =>
    respond(call, reply, permissions.checkPermission);
  const writeRelationships: handleUnaryCall<v1.WriteRelationshipsRequest, v1.WriteRelationshipsResponse> = (
    call,
    reply,
  ) => respond(call, reply, permissions.writeRelationships);
  server.addService(
    {
      checkPermission: unary('CheckPermission', v1.CheckPermissionRequest, v1.CheckPermissionResponse),
      writeRelationships: unary('WriteRelationships', v1.WriteRelationshipsRequest, v1.WriteRelationshipsResponse),
    },
    {
      checkPermission,
      writeRelationships,
    },
  );
  const credentials = ServerCredentials.createSsl(
    null,
    [{ cert_chain: Buffer.from(cert), private_key: Buffer.from(key) }],
    false,
  );
  const port = yield* Effect.callback<number, Error>((resume) => {
    server.bindAsync('localhost:0', credentials, (failure, bound) =>
      resume(failure === null ? Effect.succeed(bound) : Effect.fail(failure)),
    );
  });
  return { caCertificate: cert.trim(), endpoint: `localhost:${port}` };
});

/** The SpiceDB RPCs `SpiceDbRpc` sends, by their gRPC method name. */
export const RecordedSpiceDbMethodSchema = Schema.Literals([
  'CheckBulkPermissions',
  'CheckPermission',
  'ReadRelationships',
  'WriteRelationships',
  'WriteSchema',
]);
export type RecordedSpiceDbMethod = typeof RecordedSpiceDbMethodSchema.Type;

/**
 * A SpiceDB over native gRPC and TLS on localhost that records every call its handlers received, in order, and
 * answers each through `answer`: success is SpiceDB's empty answer (a check is NO_PERMISSION, a denial). Its
 * `recycleConnections` sends every open connection the GOAWAY SpiceDB sends at `--grpc-max-conn-age`, and the
 * listener keeps accepting the client's next connection.
 */
export const serveRecordingSpiceDb = Effect.fn('NativeSpiceDbGrpc.serveRecording')(function* serveRecordingSpiceDb(
  preSharedKey: string,
  answer: (method: RecordedSpiceDbMethod) => Effect.Effect<void, ScriptedSpiceDbUnavailable>,
): Effect.fn.Return<
  {
    readonly caCertificate: string;
    readonly endpoint: string;
    readonly received: RecordedSpiceDbMethod[];
    readonly recycleConnections: Effect.Effect<void>;
  },
  Error,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  const { cert, key } = yield* loopbackCertificate.pipe(Effect.orDie);
  const runAnswer = yield* FiberSet.makeRuntime();
  const received: RecordedSpiceDbMethod[] = [];
  const authorized = (metadata: ServerUnaryCall<unknown, unknown>['metadata']) =>
    metadata.get('authorization').includes(`Bearer ${preSharedKey}`);
  const respond =
    <Request, Response>(method: RecordedSpiceDbMethod, response: Response): handleUnaryCall<Request, Response> =>
    (call, reply: sendUnaryData<Response>) => {
      if (!authorized(call.metadata)) {
        reply({ code: status.UNAUTHENTICATED, details: INVALID_PRE_SHARED_KEY });
        return;
      }
      received.push(method);
      runAnswer(
        answer(method).pipe(
          Effect.match({
            onFailure: ({ details }) => reply({ code: status.UNAVAILABLE, details }),
            onSuccess: () => reply(null, response),
          }),
        ),
      );
    };
  const readRelationships: handleServerStreamingCall<v1.ReadRelationshipsRequest, v1.ReadRelationshipsResponse> = (
    call: ServerWritableStream<v1.ReadRelationshipsRequest, v1.ReadRelationshipsResponse>,
  ) => {
    if (!authorized(call.metadata)) {
      call.emit('error', { code: status.UNAUTHENTICATED, details: INVALID_PRE_SHARED_KEY });
      return;
    }
    received.push('ReadRelationships');
    runAnswer(
      answer('ReadRelationships').pipe(
        Effect.match({
          onFailure: ({ details }) => call.emit('error', { code: status.UNAVAILABLE, details }),
          onSuccess: () => call.end(),
        }),
      ),
    );
  };
  const server = yield* Effect.acquireRelease(
    Effect.sync(() => new Server()),
    (running) => Effect.sync(() => running.forceShutdown()),
  );
  server.addService(
    {
      checkBulkPermissions: unary(
        'CheckBulkPermissions',
        v1.CheckBulkPermissionsRequest,
        v1.CheckBulkPermissionsResponse,
      ),
      checkPermission: unary('CheckPermission', v1.CheckPermissionRequest, v1.CheckPermissionResponse),
      readRelationships: {
        ...unary('ReadRelationships', v1.ReadRelationshipsRequest, v1.ReadRelationshipsResponse),
        responseStream: true,
      },
      writeRelationships: unary('WriteRelationships', v1.WriteRelationshipsRequest, v1.WriteRelationshipsResponse),
    },
    {
      checkBulkPermissions: respond('CheckBulkPermissions', v1.CheckBulkPermissionsResponse.create({})),
      checkPermission: respond(
        'CheckPermission',
        v1.CheckPermissionResponse.create({ permissionship: v1.CheckPermissionResponse_Permissionship.NO_PERMISSION }),
      ),
      readRelationships,
      writeRelationships: respond('WriteRelationships', v1.WriteRelationshipsResponse.create({})),
    },
  );
  server.addService(
    { writeSchema: unary('WriteSchema', v1.WriteSchemaRequest, v1.WriteSchemaResponse, 'SchemaService') },
    { writeSchema: respond('WriteSchema', v1.WriteSchemaResponse.create({})) },
  );
  const credentials = ServerCredentials.createSsl(
    null,
    [{ cert_chain: Buffer.from(cert), private_key: Buffer.from(key) }],
    false,
  );
  const port = yield* Effect.callback<number, Error>((resume) => {
    server.bindAsync('localhost:0', credentials, (failure, bound) =>
      resume(failure === null ? Effect.succeed(bound) : Effect.fail(failure)),
    );
  });
  const endpoint = `localhost:${port}`;
  return {
    caCertificate: cert.trim(),
    endpoint,
    received,
    // `drain` sends GOAWAY on every open connection and leaves the listener open, as SpiceDB's age limit does.
    recycleConnections: Effect.sync(() => server.drain(endpoint, 1000)),
  };
});
