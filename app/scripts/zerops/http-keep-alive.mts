/**
 * Idle keep-alive for every HTTP server in the app container: the public port, the loopback control port and each
 * unit's server (the Shell and the owners).
 *
 * Node closes an idle connection after 5 s and advertises `Keep-Alive: timeout=5`. Undici (global fetch on the
 * storefronts, `undici.request` in the host's relay and the Shell's owner calls) keeps an idle connection for that
 * hint minus its 2 s safety threshold, so after about 3 s of quiet every request connected anew, and new connects on
 * the platform sometimes stall 1–3 s. With 65 s the clients keep connections for 63 s.
 *
 * 65 s is above the idle time of any proxy in front of the public port: Zerops' L7 balancer keeps client connections
 * 30 s by default and nginx keeps upstream connections 60 s by default. A server that closed first would let such a
 * proxy reuse a connection the server is closing. Headers must arrive within a little more than that; the whole
 * request keeps Node's 300 s `requestTimeout`.
 */
import type { Server } from 'node:http';

export const SERVER_KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const SERVER_HEADERS_TIMEOUT_MS = 66_000;

/** Applies the container's keep-alive to one server before it listens. */
export const keepConnectionsAlive = <Configured extends Pick<Server, 'headersTimeout' | 'keepAliveTimeout'>>(
  server: Configured,
): Configured => {
  server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
  return server;
};

/** The same, for a server factory such as `createServer` passed to `NodeHttpServer`. */
export const withKeepAlive =
  (create: () => Server): (() => Server) =>
  () =>
    keepConnectionsAlive(create());
