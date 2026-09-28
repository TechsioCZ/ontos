import { deadlineInterceptor, v1 } from '@authzed/authzed-node';
import { Effect, Option, Predicate } from 'effect';

import { SpiceDbConfigError } from './config-error.ts';
import { allowsInsecureSpiceDbTransport } from './config.ts';
import type { SpiceDbConfigValue } from './config.ts';
import { SpiceDbRpcError, spiceDbDeadline } from './spicedb-rpc.ts';
import type { SpiceDbRpc } from './spicedb-rpc.ts';

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

const rpcFailure = (cause: unknown): SpiceDbRpcError =>
  new SpiceDbRpcError({
    cause,
    code:
      Predicate.hasProperty(cause, 'code') && Predicate.isNumber(cause.code) ? Option.some(cause.code) : Option.none(),
  });

/** SpiceDB over gRPC through the official authzed-node client (HTTP/2, Node only). */
export const openSpiceDbGrpcRpc = (configuration: SpiceDbConfigValue, timeoutMilliseconds: number): SpiceDbRpc => {
  const client = v1.NewClient(
    configuration.preSharedKey,
    configuration.endpoint,
    spiceDbClientSecurity(configuration),
    undefined,
    { interceptors: [deadlineInterceptor(timeoutMilliseconds)] },
  );
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
