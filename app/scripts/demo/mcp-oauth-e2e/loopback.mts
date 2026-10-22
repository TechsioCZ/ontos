import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface LoopbackCallback {
  /** http://localhost:<random port>/callback */
  readonly redirectUrl: string;
  readonly waitForCallback: (timeoutMs: number) => Promise<URLSearchParams>;
  readonly close: () => Promise<void>;
}

/** One-shot OAuth redirect listener on a random port, dual-stack so both localhost resolutions work. */
export async function startLoopbackCallback(): Promise<LoopbackCallback> {
  let resolveParams: (params: URLSearchParams) => void = () => undefined;
  const received = new Promise<URLSearchParams>((resolve) => {
    resolveParams = resolve;
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html lang="cs"><meta charset="utf-8"><title>OntOS</title><p>Připojení dokončeno. Okno můžete zavřít.</p></html>');
    resolveParams(url.searchParams);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '::', ipv6Only: false, port: 0 }, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    redirectUrl: `http://localhost:${port}/callback`,
    waitForCallback: (timeoutMs) =>
      Promise.race([
        received,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error(`OAuth callback did not arrive within ${timeoutMs} ms`)), timeoutMs).unref();
        }),
      ]),
  };
}
