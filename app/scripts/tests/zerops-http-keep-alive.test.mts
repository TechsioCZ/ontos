import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'effect-rstest';

import {
  SERVER_HEADERS_TIMEOUT_MS,
  SERVER_KEEP_ALIVE_TIMEOUT_MS,
  keepConnectionsAlive,
} from '../zerops/http-keep-alive.mts';
import { workspaceRoot } from '../zerops/hosted-units.mts';

const zeropsSource = (file: string) => readFileSync(path.join(workspaceRoot, 'scripts/zerops', file), 'utf-8');

it('keeps idle connections longer than the proxies in front of the container', () => {
  // Node's own defaults: 5 s idle (advertised as `Keep-Alive: timeout=5`), 60 s for headers.
  const server = keepConnectionsAlive({ headersTimeout: 60_000, keepAliveTimeout: 5000 });
  expect(server).toEqual({ headersTimeout: SERVER_HEADERS_TIMEOUT_MS, keepAliveTimeout: SERVER_KEEP_ALIVE_TIMEOUT_MS });
  // Above nginx's 60 s upstream idle and Zerops' 30 s client idle; undici clients then keep 63 s.
  expect(SERVER_KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThan(60_000);
  expect(SERVER_HEADERS_TIMEOUT_MS).toBeGreaterThan(SERVER_KEEP_ALIVE_TIMEOUT_MS);
  // Node's whole-request deadline (300 s) stays above the headers deadline.
  expect(SERVER_HEADERS_TIMEOUT_MS).toBeLessThan(300_000);
});

it('the host builds its public and control servers through the helper', () => {
  const host = zeropsSource('app-host.mts');
  const servers = host.match(/NodeHttpServer\.(?:make|layer)\([^,]+,/gu) ?? [];
  // The public server is built once, so the drain and the stop can close the very server the port listens on.
  expect(servers).toEqual([
    'NodeHttpServer.make(() => publicServer,',
    'NodeHttpServer.layer(withKeepAlive(createServer),',
  ]);
  expect(host.match(/const publicServer = [^;]+;/gu)).toEqual(['const publicServer = withKeepAlive(createServer)();']);
});

it('every unit server, the Shell and the owners, receives the helper before it listens', () => {
  expect(zeropsSource('serve-units.mts')).toContain('await start(unit.port, keepConnectionsAlive);');
});
