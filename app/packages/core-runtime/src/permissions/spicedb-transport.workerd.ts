// @effect-diagnostics strictEffectProvide:off -- Composition root that binds the Workers VPC fetcher to the Effect HttpClient for SpiceDB; expires: 2027-03-31.
import { env } from 'cloudflare:workers';
import { Effect, Redacted } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import type { HttpClient } from 'effect/unstable/http';

import { SpiceDbConfigError } from './config-error.ts';
import { allowsInsecureSpiceDbTransport } from './config.ts';
import { spiceDbHttpRpc } from './spicedb-http-rpc.ts';
import type { SpiceDbRpcError, SpiceDbTransport } from './spicedb-rpc.ts';

/**
 * workerd has no HTTP/2 client for gRPC, so SpiceDB is reached through its HTTP gateway. This
 * module is the runtime's composition root for that client: the Effect `HttpClient` is the fetch
 * client bound to the `SPICEDB` Workers VPC binding, because workerd's global fetch cannot reach
 * private origins. `SPICEDB_ENDPOINT` is the gateway's host:port; plaintext is allowed only where
 * the gRPC transport allows it (explicit localhost or the stage-private `spicedb` host), because
 * the binding carries it through the tunnel.
 */
export const spiceDbTransport: SpiceDbTransport = Object.freeze<SpiceDbTransport>({
  open: (configuration, timeoutMilliseconds) => {
    if (!allowsInsecureSpiceDbTransport(configuration)) {
      throw new SpiceDbConfigError({
        reason: 'Insecure SpiceDB client credentials are not allowed for this endpoint',
      });
    }
    const binding = env.SPICEDB;
    if (binding === undefined) {
      throw new SpiceDbConfigError({ reason: 'The SPICEDB Worker binding is required' });
    }
    const vpcFetch = binding.fetch.bind(binding);
    const overVpc = <Response>(
      call: Effect.Effect<Response, SpiceDbRpcError, HttpClient.HttpClient>,
    ): Effect.Effect<Response, SpiceDbRpcError> =>
      call.pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, vpcFetch));
    const rpc = spiceDbHttpRpc({
      origin: new URL(`${configuration.insecureLocal ? 'http' : 'https'}://${configuration.endpoint}`),
      preSharedKey: Redacted.make(configuration.preSharedKey),
      timeoutMilliseconds,
    });
    return {
      checkBulkPermissions: (request) => overVpc(rpc.checkBulkPermissions(request)),
      checkPermission: (request) => overVpc(rpc.checkPermission(request)),
      close: () => {
        // Each call is a standalone request on the binding; there is no connection to release.
      },
      readRelationships: (request) => overVpc(rpc.readRelationships(request)),
      writeRelationships: (request) => overVpc(rpc.writeRelationships(request)),
      writeSchema: (request) => overVpc(rpc.writeSchema(request)),
    };
  },
});
