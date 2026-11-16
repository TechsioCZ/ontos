/**
 * The options of an API request that runs on a connection of its own.
 *
 * Playwright sends API requests through one process-wide `keepAlive` Node agent without an idle timeout, and Node
 * ignores a server's `Keep-Alive: timeout=` hint when the agent has none. A pooled socket therefore stays in the pool
 * until the server's idle timer closes it, and a request written to it at that moment is lost unread: the server
 * logs nothing and the test sees `socket hang up` (run 43757038239, a POST to the module-target endpoint).
 * `Connection: close` makes the server close the socket after its response, so no socket is ever pooled and the race
 * cannot occur. Nothing is retried. `harness-connections.spec.ts` keeps every API call of the specs on it.
 */
export const onOwnConnection = <Options extends { readonly headers?: Readonly<Record<string, string>> }>(
  options?: Options,
) => ({
  ...options,
  headers: { ...options?.headers, connection: 'close' },
});
