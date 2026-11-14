import { v1 } from '@authzed/authzed-node';
import { openSpiceDbRpc } from './spicedb-transaction-guard.ts';
import { Data, Effect, Option } from 'effect';
import type { Scope } from 'effect';

import type { SpiceDbConfigValue } from './config.ts';

export const SPICEDB_CHECK_TIMEOUT_MS = 2000;

export const fullyConsistent = v1.Consistency.create({
  requirement: {
    fullyConsistent: true,
    oneofKind: 'fullyConsistent',
  },
});

export interface CloseableSpiceDbClient {
  readonly close: () => void;
}

export class SpiceDbPermissionClientError extends Data.TaggedError('SpiceDbPermissionClientError')<{
  readonly cause?: unknown;
  readonly reason: string;
  readonly rpcCode: number | undefined;
}> {}

export const spiceDbPermissionClientError = (cause?: unknown, rpcCode?: number): SpiceDbPermissionClientError =>
  new SpiceDbPermissionClientError({
    cause,
    reason: 'The SpiceDB client operation did not complete safely',
    rpcCode,
  });

export interface SpiceDbPermissionClient extends CloseableSpiceDbClient {
  readonly checkBulkPermissions: (
    request: v1.CheckBulkPermissionsRequest,
  ) => Effect.Effect<v1.CheckBulkPermissionsResponse, SpiceDbPermissionClientError>;
  readonly checkPermission: (
    request: v1.CheckPermissionRequest,
  ) => Effect.Effect<v1.CheckPermissionResponse, SpiceDbPermissionClientError>;
}

export const createSpiceDbPermissionClient = (
  configuration: SpiceDbConfigValue,
  timeoutMilliseconds: number,
): SpiceDbPermissionClient => {
  const rpc = openSpiceDbRpc(configuration, timeoutMilliseconds);
  return {
    checkBulkPermissions: (request) =>
      rpc
        .checkBulkPermissions(request)
        .pipe(Effect.mapError(({ cause, code }) => spiceDbPermissionClientError(cause, Option.getOrUndefined(code)))),
    checkPermission: (request) =>
      rpc
        .checkPermission(request)
        .pipe(Effect.mapError(({ cause, code }) => spiceDbPermissionClientError(cause, Option.getOrUndefined(code)))),
    close: rpc.close,
  };
};

export const acquireSpiceDbClientResource = <Client extends CloseableSpiceDbClient, Failure>(
  acquire: () => Client,
  onFailure: (cause: unknown) => Failure,
): Effect.Effect<Client, Failure, Scope.Scope> =>
  Effect.acquireRelease(Effect.try({ catch: onFailure, try: acquire }), (client) => Effect.sync(() => client.close()));
