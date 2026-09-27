import { deadlineInterceptor, v1 } from '@authzed/authzed-node';
import { Cause, Data, Duration, Effect } from 'effect';
import type { Scope } from 'effect';

import { SpiceDbConfigError } from './config-error.ts';
import { allowsInsecureSpiceDbTransport } from './config.ts';
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

const permissionTimeout = Effect.timeoutOrElse({
  duration: Duration.millis(SPICEDB_CHECK_TIMEOUT_MS),
  orElse: () => Effect.fail(spiceDbPermissionClientError(new Cause.TimeoutError('SpiceDB client operation timed out'))),
});

export const spiceDbClientSecurity = (
  configuration: Pick<SpiceDbConfigValue, 'deploymentEnvironment' | 'endpoint' | 'insecureLocal'>,
): v1.ClientSecurity => {
  if (!allowsInsecureSpiceDbTransport(configuration)) {
    throw new SpiceDbConfigError({
      reason: 'Insecure SpiceDB client credentials are not allowed for this endpoint',
    });
  }
  return configuration.insecureLocal ? v1.ClientSecurity.INSECURE_PLAINTEXT_CREDENTIALS : v1.ClientSecurity.SECURE;
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
    checkBulkPermissions: (request) =>
      Effect.tryPromise({
        catch: spiceDbPermissionClientError,
        // oxlint-disable-next-line typescript/promise-function-async -- Effect owns this foreign SDK Promise boundary.
        try: () => client.promises.checkBulkPermissions(request),
      }).pipe(permissionTimeout),
    checkPermission: (request) =>
      Effect.tryPromise({
        catch: spiceDbPermissionClientError,
        // oxlint-disable-next-line typescript/promise-function-async -- Effect owns this foreign SDK Promise boundary.
        try: () => client.promises.checkPermission(request),
      }).pipe(permissionTimeout),
    close: () => client.close(),
  };
};

export const acquireSpiceDbClientResource = <Client extends CloseableSpiceDbClient, Error>(
  acquire: () => Client,
  onFailure: (cause: unknown) => Error,
): Effect.Effect<Client, Error, Scope.Scope> =>
  Effect.acquireRelease(Effect.try({ catch: onFailure, try: acquire }), (client) => Effect.sync(() => client.close()));
