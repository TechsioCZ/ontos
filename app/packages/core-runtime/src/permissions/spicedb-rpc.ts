import type { v1 } from '@authzed/authzed-node';
import { Cause, Data, Duration, Effect, Option } from 'effect';

import type { SpiceDbConfigValue } from './config.ts';

/**
 * A SpiceDB RPC that did not complete. `code` is the gRPC status code when SpiceDB answered with
 * one (both transports report the same code for the same request); `cause` is the transport's own
 * failure and never reaches a caller-visible reason.
 */
export class SpiceDbRpcError extends Data.TaggedError('SpiceDbRpcError')<{
  readonly cause: unknown;
  readonly code: Option.Option<number>;
}> {}

/**
 * The SpiceDB permissions and schema RPCs OntOS uses, typed with the official authzed-node messages
 * so both transports accept and return identical values.
 */
export interface SpiceDbRpc {
  readonly checkBulkPermissions: (
    request: v1.CheckBulkPermissionsRequest,
  ) => Effect.Effect<v1.CheckBulkPermissionsResponse, SpiceDbRpcError>;
  readonly checkPermission: (
    request: v1.CheckPermissionRequest,
  ) => Effect.Effect<v1.CheckPermissionResponse, SpiceDbRpcError>;
  readonly close: () => void;
  readonly readRelationships: (
    request: v1.ReadRelationshipsRequest,
  ) => Effect.Effect<readonly v1.ReadRelationshipsResponse[], SpiceDbRpcError>;
  readonly writeRelationships: (
    request: v1.WriteRelationshipsRequest,
  ) => Effect.Effect<v1.WriteRelationshipsResponse, SpiceDbRpcError>;
  readonly writeSchema: (request: v1.WriteSchemaRequest) => Effect.Effect<v1.WriteSchemaResponse, SpiceDbRpcError>;
}

/**
 * The runtime's way to reach SpiceDB. `#spicedb-transport` resolves to gRPC on Node and to the
 * HTTP gateway on workerd, which has no HTTP/2 client for gRPC.
 */
export interface SpiceDbTransport {
  readonly open: (configuration: SpiceDbConfigValue, timeoutMilliseconds: number) => SpiceDbRpc;
}

/**
 * Every SpiceDB call is bounded by the caller's deadline (`Effect.timeoutOrElse(spiceDbDeadline(ms))`);
 * a late reply fails with a `TimeoutError` cause.
 */
export const spiceDbDeadline = (timeoutMilliseconds: number) => ({
  duration: Duration.millis(timeoutMilliseconds),
  orElse: () =>
    Effect.fail(
      new SpiceDbRpcError({
        cause: new Cause.TimeoutError('SpiceDB client operation timed out'),
        code: Option.none(),
      }),
    ),
});
