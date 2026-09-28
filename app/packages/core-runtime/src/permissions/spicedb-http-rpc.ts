import { v1 } from '@authzed/authzed-node';
import { Effect, Option, Redacted, Schema } from 'effect';
import { HttpClientRequest, HttpClientResponse } from 'effect/unstable/http';

import { SpiceDbRpcError, spiceDbDeadline } from './spicedb-rpc.ts';
import type { SpiceDbRpc } from './spicedb-rpc.ts';

/**
 * Where the SpiceDB HTTP gateway (`serve --http-enabled`) answers. `fetch` is the global fetch on
 * Node and a Workers VPC binding's `fetch` on workerd, whose global fetch cannot reach private
 * origins.
 */
export interface SpiceDbHttpEndpoint {
  readonly fetch: typeof globalThis.fetch;
  readonly origin: URL;
  readonly preSharedKey: Redacted.Redacted;
  readonly timeoutMilliseconds: number;
}

interface JsonMessageType<Message> {
  readonly fromJsonString: (json: string, options: { readonly ignoreUnknownFields: boolean }) => Message;
  readonly toJsonString: (message: Message) => string;
}

// Unknown fields are skipped, as a gRPC client skips unknown binary fields.
const jsonReadOptions = { ignoreUnknownFields: true } as const;

// The gateway's error body and stream error frames are a `google.rpc.Status`.
const RpcStatusSchema = Schema.Struct({ code: Schema.Finite, message: Schema.String });
const decodeRpcStatusText = Schema.decodeUnknownOption(Schema.fromJsonString(RpcStatusSchema));
const decodeRpcStatus = Schema.decodeUnknownOption(RpcStatusSchema);

// Server streaming arrives as newline-delimited `{"result": …}` / `{"error": …}` frames.
const decodeStreamFrame = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ error: Schema.optionalKey(Schema.Json), result: Schema.optionalKey(Schema.Json) }),
  ),
);

// A per-item bulk error is a `google.rpc.Status` whose `details` are `google.protobuf.Any` values
// (`google.rpc.ErrorInfo`). authzed-node ships no message type for them, so proto3 JSON cannot be
// read back into `Any`. Callers read only the item/error kind and the status code, so each item
// error keeps `code` and `message` and its details are dropped.
const JsonFields = [Schema.Record(Schema.String, Schema.Json)] as const;
const decodeBulkResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.StructWithRest(
      Schema.Struct({
        pairs: Schema.optionalKey(
          Schema.Array(
            Schema.StructWithRest(Schema.Struct({ error: Schema.optionalKey(RpcStatusSchema) }), JsonFields),
          ),
        ),
      }),
      JsonFields,
    ),
  ),
);

const transportFailure = (cause: unknown): SpiceDbRpcError => new SpiceDbRpcError({ cause, code: Option.none() });

const statusFailure = (status: Schema.Json): SpiceDbRpcError =>
  new SpiceDbRpcError({ cause: status, code: Option.map(decodeRpcStatus(status), ({ code }) => code) });

const readMessage = <Message>(type: JsonMessageType<Message>, text: string): Effect.Effect<Message, SpiceDbRpcError> =>
  Effect.try({ catch: transportFailure, try: () => type.fromJsonString(text, jsonReadOptions) });

const encodeJsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

// Decoded frames and bulk responses are re-encoded to text so protobuf-ts parses them as it parses
// any gateway body.
const readJsonMessage = <Message>(
  type: JsonMessageType<Message>,
  json: Schema.Json,
): Effect.Effect<Message, SpiceDbRpcError> =>
  encodeJsonText(json).pipe(
    Effect.mapError(transportFailure),
    Effect.flatMap((text) => readMessage(type, text)),
  );

const readFrame = (line: string): Effect.Effect<v1.ReadRelationshipsResponse, SpiceDbRpcError> =>
  decodeStreamFrame(line).pipe(
    Effect.mapError(transportFailure),
    Effect.flatMap(({ error, result = null }) =>
      error === undefined ? readJsonMessage(v1.ReadRelationshipsResponse, result) : Effect.fail(statusFailure(error)),
    ),
  );

const readFrames = (text: string): Effect.Effect<readonly v1.ReadRelationshipsResponse[], SpiceDbRpcError> =>
  Effect.forEach(
    text.split('\n').filter((line) => line.trim().length > 0),
    readFrame,
    // Frames decode in stream order; decoding is local and cheap.
    { concurrency: 1 },
  );

const readBulkResponse = (text: string): Effect.Effect<v1.CheckBulkPermissionsResponse, SpiceDbRpcError> =>
  decodeBulkResponse(text).pipe(
    Effect.mapError(transportFailure),
    Effect.flatMap((response) => readJsonMessage(v1.CheckBulkPermissionsResponse, response)),
  );

const failWithStatus = (text: string): Effect.Effect<never, SpiceDbRpcError> =>
  Effect.fail(new SpiceDbRpcError({ cause: text, code: Option.map(decodeRpcStatusText(text), ({ code }) => code) }));

/** SpiceDB over its HTTP/JSON gateway, for runtimes without an HTTP/2 gRPC client. */
export const openSpiceDbHttpRpc = (endpoint: SpiceDbHttpEndpoint): SpiceDbRpc => {
  const deadline = spiceDbDeadline(endpoint.timeoutMilliseconds);
  const readBody = (url: URL, response: Response): Effect.Effect<string, SpiceDbRpcError> =>
    HttpClientResponse.fromWeb(HttpClientRequest.post(url), response).text.pipe(
      Effect.mapError(transportFailure),
      Effect.timeoutOrElse(deadline),
      Effect.filterOrElse(() => response.ok, failWithStatus),
    );
  // The whole exchange (request, status and body) shares one deadline, like a gRPC deadline.
  const post = <Request>(path: string, type: JsonMessageType<Request>, request: Request) => {
    const url = new URL(path, endpoint.origin);
    return Effect.tryPromise({
      catch: transportFailure,
      // oxlint-disable-next-line typescript/promise-function-async -- Effect owns this fetch Promise boundary and aborts it on interruption.
      try: (signal) =>
        endpoint.fetch(url, {
          body: type.toJsonString(request),
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${Redacted.value(endpoint.preSharedKey)}`,
            'content-type': 'application/json',
          },
          method: 'POST',
          signal,
        }),
    }).pipe(
      Effect.flatMap((response) => readBody(url, response)),
      Effect.timeoutOrElse(deadline),
    );
  };

  const unary =
    <Request, Response>(path: string, requestType: JsonMessageType<Request>, responseType: JsonMessageType<Response>) =>
    (request: Request): Effect.Effect<Response, SpiceDbRpcError> =>
      post(path, requestType, request).pipe(Effect.flatMap((text) => readMessage(responseType, text)));

  return {
    checkBulkPermissions: (request) =>
      post('/v1/permissions/checkbulk', v1.CheckBulkPermissionsRequest, request).pipe(Effect.flatMap(readBulkResponse)),
    checkPermission: unary('/v1/permissions/check', v1.CheckPermissionRequest, v1.CheckPermissionResponse),
    close: () => {
      // Each call is a standalone fetch; there is no connection to release.
    },
    // A failed stream fails the whole read, as a failed gRPC stream rejects `readRelationships`.
    readRelationships: (request) =>
      post('/v1/relationships/read', v1.ReadRelationshipsRequest, request).pipe(Effect.flatMap(readFrames)),
    writeRelationships: unary('/v1/relationships/write', v1.WriteRelationshipsRequest, v1.WriteRelationshipsResponse),
    writeSchema: unary('/v1/schema/write', v1.WriteSchemaRequest, v1.WriteSchemaResponse),
  };
};
