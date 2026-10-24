import { Consistency } from '@authzed/authzed-node/v1/permissions';
import type {
  CheckBulkPermissionsRequest,
  CheckBulkPermissionsResponse,
  CheckPermissionRequest,
  CheckPermissionResponse,
} from '@authzed/authzed-node/v1/permissions';
import { openSpiceDbRpc } from './spicedb-transaction-guard.ts';
import { Data, Effect } from 'effect';
import type { Scope } from 'effect';

import type { SpiceDbConfigValue } from './config.ts';

export const SPICEDB_CHECK_TIMEOUT_MS = 2000;

export const fullyConsistent = Consistency.create({
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
    request: CheckBulkPermissionsRequest,
  ) => Effect.Effect<CheckBulkPermissionsResponse, SpiceDbPermissionClientError>;
  readonly checkPermission: (
    request: CheckPermissionRequest,
  ) => Effect.Effect<CheckPermissionResponse, SpiceDbPermissionClientError>;
}

export const createSpiceDbPermissionClient = (
  configuration: SpiceDbConfigValue,
  timeoutMilliseconds: number,
): SpiceDbPermissionClient => {
  const rpc = openSpiceDbRpc(configuration, timeoutMilliseconds);
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
