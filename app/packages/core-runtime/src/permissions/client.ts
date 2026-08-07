import { deadlineInterceptor, v1 } from '@authzed/authzed-node';
import { Effect } from 'effect';
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

export interface SpiceDbPermissionClient extends CloseableSpiceDbClient {
  readonly checkBulkPermissions: (
    request: v1.CheckBulkPermissionsRequest,
  ) => Promise<v1.CheckBulkPermissionsResponse>;
  readonly checkPermission: (
    request: v1.CheckPermissionRequest,
  ) => Promise<v1.CheckPermissionResponse>;
}

export const createSpiceDbPermissionClient = (
  configuration: SpiceDbConfigValue,
  timeoutMilliseconds: number,
): SpiceDbPermissionClient => {
  const client = v1.NewClient(
    configuration.preSharedKey,
    configuration.endpoint,
    configuration.insecureLocal
      ? v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED
      : v1.ClientSecurity.SECURE,
    undefined,
    { interceptors: [deadlineInterceptor(timeoutMilliseconds)] },
  );
  return {
    checkBulkPermissions: (request) => client.promises.checkBulkPermissions(request),
    checkPermission: (request) => client.promises.checkPermission(request),
    close: () => client.close(),
  };
};

export const acquireSpiceDbClientResource = <Client extends CloseableSpiceDbClient, Error>(
  acquire: () => Client,
  onFailure: () => Error,
): Effect.Effect<Client, Error, Scope.Scope> =>
  Effect.acquireRelease(Effect.try({ catch: onFailure, try: acquire }), (client) =>
    Effect.sync(() => client.close()),
  );
