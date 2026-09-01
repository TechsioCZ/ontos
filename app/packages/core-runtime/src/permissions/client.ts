import { deadlineInterceptor, v1 } from '@authzed/authzed-node';
import { Effect } from 'effect';
import type { Scope } from 'effect';
import { allowsInsecureSpiceDbTransport } from './config.ts';
import type { SpiceDbConfigValue } from './config.ts';
import { SpiceDbConfigError } from './config-error.ts';

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

export const spiceDbClientSecurity = (
  configuration: Pick<SpiceDbConfigValue, 'deploymentEnvironment' | 'endpoint' | 'insecureLocal'>,
): v1.ClientSecurity => {
  if (!allowsInsecureSpiceDbTransport(configuration)) {
    throw new SpiceDbConfigError({
      reason: 'Insecure SpiceDB client credentials are not allowed for this endpoint',
    });
  }
  return configuration.insecureLocal
    ? v1.ClientSecurity.INSECURE_PLAINTEXT_CREDENTIALS
    : v1.ClientSecurity.SECURE;
};

export const createSpiceDbPermissionClient = (
  configuration: SpiceDbConfigValue,
  timeoutMilliseconds: number,
): SpiceDbPermissionClient => {
  const client = v1.NewClient(
    configuration.preSharedKey,
    configuration.endpoint,
    spiceDbClientSecurity(configuration),
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
