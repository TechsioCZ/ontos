import { env } from 'cloudflare:workers';
import { Effect, Redacted } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import type { HttpClient } from 'effect/unstable/http';

import { SpiceDbConfigError } from './config-error.ts';
import { spiceDbHttpRpc } from './spicedb-http-rpc.ts';
import type { SpiceDbRpcError, SpiceDbTransport } from './spicedb-rpc.ts';

/**
 * workerd has no HTTP/2 client for gRPC, so SpiceDB is reached through its HTTP gateway. This
 * module is the runtime's composition root for that client: the Effect `HttpClient` is the fetch
 * client bound to the `SPICEDB` Workers VPC binding, because workerd's global fetch cannot reach
 * private origins. In a Worker, `SPICEDB_ENDPOINT` names the HTTP gateway's TLS server name (stage:
 * `ontos-stage-spicedb.<zone>`), not the gRPC endpoint Node uses; each runtime has its own
 * environment. The request is always HTTPS: the Workers VPC service sends it to the gateway's TLS
 * port and verifies the gateway certificate for that name.
 */
export const spiceDbTransport: SpiceDbTransport = Object.freeze<SpiceDbTransport>({
  open: (configuration, timeoutMilliseconds) => {
    const binding = env.SPICEDB;
    if (binding === undefined) {
      throw new SpiceDbConfigError({ reason: 'The SPICEDB Worker binding is required' });
    }
    const vpcFetch = binding.fetch.bind(binding);
    const overVpc = <Response>(
      call: Effect.Effect<Response, SpiceDbRpcError, HttpClient.HttpClient>,
    ): Effect.Effect<Response, SpiceDbRpcError> =>
      call.pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off -- The SPICEDB binding's fetch backs the gateway HttpClient here until Worker roots provide it; owner: BleedingDev; tracking: TechsioCZ/ontos#1000; remove-when: the Worker API roots provide the SpiceDB HttpClient.
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, vpcFetch),
      );
    const rpc = spiceDbHttpRpc({
      origin: new URL(`https://${configuration.endpoint}`),
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
