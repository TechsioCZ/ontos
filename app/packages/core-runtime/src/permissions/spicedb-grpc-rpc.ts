import { deadlineInterceptor, v1 } from '@authzed/authzed-node';
import { Effect, Option, Predicate } from 'effect';

import { SpiceDbConfigError } from './config-error.ts';
import type { SpiceDbConfigValue } from './config.ts';
import { SpiceDbRpcError, spiceDbDeadline } from './spicedb-rpc.ts';
import type { SpiceDbRpc } from './spicedb-rpc.ts';

/**
 * The gRPC channel's only trusted CA: `SPICEDB_CA_CERT`, the certificate SpiceDB serves on its
 * gRPC port. There is no plaintext or system-trust mode.
 */
export const spiceDbCaCertificate = (configuration: Pick<SpiceDbConfigValue, 'caCertificate'>): Buffer => {
  if (configuration.caCertificate === undefined) {
    throw new SpiceDbConfigError({ reason: 'SPICEDB_CA_CERT is required for the SpiceDB gRPC client' });
  }
  return Buffer.from(configuration.caCertificate);
};

/**
 * SpiceDB recycles every gRPC connection after `--grpc-max-conn-age` (30 s by default; no stage sets it) with a
 * GOAWAY. A call queued on that connection in the turn the GOAWAY arrives is refused by the client's own HTTP/2
 * session and never sent, but grpc-js reports it as a write error (UNAVAILABLE) and skips the transparent retry
 * it gives other refused streams. The read-only calls are therefore retried on UNAVAILABLE, on the next
 * connection and within the call's deadline: a read changes nothing, and every other answer, a denial included,
 * is returned as SpiceDB gave it. Writes are never repeated, because UNAVAILABLE cannot tell a refused write from
 * one SpiceDB applied, and an applied `TOUCH` repeated after a concurrent `DELETE` would restore a revoked grant.
 */
const SPICEDB_READ_RETRY_SERVICE_CONFIG = `{
  "methodConfig": [{
    "name": [
      { "service": "authzed.api.v1.PermissionsService", "method": "CheckPermission" },
      { "service": "authzed.api.v1.PermissionsService", "method": "CheckBulkPermissions" },
      { "service": "authzed.api.v1.PermissionsService", "method": "ReadRelationships" }
    ],
    "retryPolicy": {
      "maxAttempts": 3,
      "initialBackoff": "0.02s",
      "maxBackoff": "0.1s",
      "backoffMultiplier": 2,
      "retryableStatusCodes": ["UNAVAILABLE"]
    }
  }]
}`;

/** An authzed-node gRPC client that trusts only `SPICEDB_CA_CERT`. Every Node caller opens SpiceDB through it. */
export const newSpiceDbGrpcClient = (
  configuration: Pick<SpiceDbConfigValue, 'caCertificate' | 'endpoint' | 'preSharedKey'>,
  options?: Parameters<typeof v1.NewClientWithCustomCert>[4],
): v1.ZedClientInterface =>
  v1.NewClientWithCustomCert(
    configuration.preSharedKey,
    configuration.endpoint,
    spiceDbCaCertificate(configuration),
    undefined,
    options,
  );

const rpcFailure = (cause: unknown): SpiceDbRpcError =>
  new SpiceDbRpcError({
    cause,
    code:
      Predicate.hasProperty(cause, 'code') && Predicate.isNumber(cause.code) ? Option.some(cause.code) : Option.none(),
  });

/** SpiceDB over gRPC through the official authzed-node client (HTTP/2, Node only). */
export const openSpiceDbGrpcRpc = (configuration: SpiceDbConfigValue, timeoutMilliseconds: number): SpiceDbRpc => {
  // The retry policy goes only to this client, whose every call carries a deadline: a retried read gets what is
  // left of it. A client opened without a deadline keeps single attempts, so no retry of its can wait forever.
  // The policy is this client's own; a DNS TXT record cannot replace it.
  const client = newSpiceDbGrpcClient(configuration, {
    'grpc.service_config': SPICEDB_READ_RETRY_SERVICE_CONFIG,
    'grpc.service_config_disable_resolution': 1,
    interceptors: [deadlineInterceptor(timeoutMilliseconds)],
  });
  const deadline = spiceDbDeadline(timeoutMilliseconds);
  const call =
    <Request, Response>(rpc: (request: Request) => Promise<Response>) =>
    (request: Request): Effect.Effect<Response, SpiceDbRpcError> =>
      Effect.tryPromise({
        catch: rpcFailure,
        // oxlint-disable-next-line typescript/promise-function-async -- Effect owns this foreign SDK Promise boundary.
        try: () => rpc(request),
      }).pipe(Effect.timeoutOrElse(deadline));
  const { promises } = client;
  return {
    checkBulkPermissions: call(promises.checkBulkPermissions.bind(promises)),
    checkPermission: call(promises.checkPermission.bind(promises)),
    close: () => client.close(),
    readRelationships: call(promises.readRelationships.bind(promises)),
    writeRelationships: call(promises.writeRelationships.bind(promises)),
    writeSchema: call(promises.writeSchema.bind(promises)),
  };
};
