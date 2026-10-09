import { v1 } from '@authzed/authzed-node';
import { spiceDbTransport } from '#spicedb-transport';
import { Data, Effect } from 'effect';
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
}> {}

export const spiceDbPermissionClientError = (cause?: unknown): SpiceDbPermissionClientError =>
  new SpiceDbPermissionClientError({
    cause,
    reason: 'The SpiceDB client operation did not complete safely',
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
  const rpc = spiceDbTransport.open(configuration, timeoutMilliseconds);
  return {
    checkBulkPermissions: (request) =>
      rpc.checkBulkPermissions(request).pipe(Effect.mapError(({ cause }) => spiceDbPermissionClientError(cause))),
    checkPermission: (request) =>
      rpc.checkPermission(request).pipe(Effect.mapError(({ cause }) => spiceDbPermissionClientError(cause))),
    close: rpc.close,
  };
};

export const acquireSpiceDbClientResource = <Client extends CloseableSpiceDbClient, Error>(
  acquire: () => Client,
  onFailure: (cause: unknown) => Error,
): Effect.Effect<Client, Error, Scope.Scope> =>
  Effect.acquireRelease(Effect.try({ catch: onFailure, try: acquire }), (client) => Effect.sync(() => client.close()));
