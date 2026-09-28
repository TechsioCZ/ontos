import { env } from 'cloudflare:workers';
import { Redacted } from 'effect';

import { SpiceDbConfigError } from './config-error.ts';
import { allowsInsecureSpiceDbTransport } from './config.ts';
import { openSpiceDbHttpRpc } from './spicedb-http-rpc.ts';
import type { SpiceDbTransport } from './spicedb-rpc.ts';

/**
 * workerd has no HTTP/2 client for gRPC, so SpiceDB is reached through its HTTP gateway over the
 * `SPICEDB` Workers VPC binding. `SPICEDB_ENDPOINT` is the gateway's host:port; plaintext is
 * allowed only where the gRPC transport allows it (explicit localhost or the stage-private
 * `spicedb` host), because the binding carries it through the tunnel.
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
    return openSpiceDbHttpRpc({
      fetch: binding.fetch.bind(binding),
      origin: new URL(`${configuration.insecureLocal ? 'http' : 'https'}://${configuration.endpoint}`),
      preSharedKey: Redacted.make(configuration.preSharedKey),
      timeoutMilliseconds,
    });
  },
});
