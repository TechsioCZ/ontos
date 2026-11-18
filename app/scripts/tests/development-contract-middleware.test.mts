import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, expect, it, rstest } from 'effect-rstest';

import { createDevelopmentContractMiddleware } from '../../packages/shared-contracts/tooling/modern-config.ts';

type Middleware = Parameters<Parameters<ReturnType<typeof createDevelopmentContractMiddleware>>[0]['unshift']>[0];

const CONTRACT = '{"moduleId":"party.registry"}';
const MCP_TOOLS = '{"tools":[]}';
const TOOL_CATALOG_URL = '/.well-known/ontos-module-mcp-tools.json';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

// A unit's dev server must answer the Shell's contract discovery ahead of its locale redirects.
const installMiddleware = ({ toolCatalog = 'file' }: { toolCatalog?: 'file' | 'absent' | 'directory' } = {}) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ontos-dev-contract-'));
  roots.push(root);
  mkdirSync(path.join(root, '.dev-public/.well-known'), { recursive: true });
  writeFileSync(path.join(root, '.dev-public/.well-known/ontos-module-manifest.json'), CONTRACT);
  const toolCatalogPath = path.join(root, '.dev-public/.well-known/ontos-module-mcp-tools.json');
  if (toolCatalog === 'file') {
    writeFileSync(toolCatalogPath, MCP_TOOLS);
  } else if (toolCatalog === 'directory') {
    mkdirSync(toolCatalogPath);
  }
  const installed: Middleware[] = [];
  createDevelopmentContractMiddleware(pathToFileURL(path.join(root, 'modern.config.ts')).href)({
    unshift: (middleware) => {
      installed.unshift(middleware);
    },
  });
  const [middleware, ...rest] = installed;
  expect(rest).toEqual([]);
  if (middleware === undefined) {
    throw new Error('The development contract middleware was not installed');
  }
  return middleware;
};

const request = (middleware: Middleware, url: string | undefined) => {
  // Modern passes Node HTTP objects, not a Fetch response or a partial HTTP-shaped object.
  const incoming = new IncomingMessage(new Socket());
  incoming.url = url;
  const response = new ServerResponse(incoming);
  const end = rstest.spyOn(response, 'end').mockReturnValue(response);
  const next = rstest.fn<() => void>();
  middleware(incoming, response, next);
  const body: unknown = end.mock.calls[0]?.[0];
  return {
    body: Buffer.isBuffer(body) ? body.toString('utf-8') : null,
    ended: end.mock.calls.length > 0,
    headers: response.getHeaders(),
    nextCalled: next.mock.calls.length > 0,
    statusCode: response.statusCode,
  };
};

it('serves the prepared module contract as uncached JSON, ignoring the query string', () => {
  const response = request(installMiddleware(), '/.well-known/ontos-module-manifest.json?cache-bust=1');
  expect(response.nextCalled).toBe(false);
  expect(JSON.parse(response.body ?? '')).toEqual({ moduleId: 'party.registry' });
  expect(response.headers).toEqual({
    'cache-control': 'no-cache',
    'content-length': String(Buffer.byteLength(CONTRACT)),
    'content-type': 'application/json',
  });
});

it('serves the prepared MCP tool catalog next to the module contract', () => {
  const response = request(installMiddleware(), TOOL_CATALOG_URL);
  expect(response.nextCalled).toBe(false);
  expect(JSON.parse(response.body ?? '')).toEqual({ tools: [] });
  expect(response.headers).toEqual({
    'cache-control': 'no-cache',
    'content-length': String(Buffer.byteLength(MCP_TOOLS)),
    'content-type': 'application/json',
  });
});

it('answers 404 for the tool catalog of a module without an MCP contribution', () => {
  const middleware = installMiddleware({ toolCatalog: 'absent' });
  const catalog = request(middleware, TOOL_CATALOG_URL);
  expect(catalog).toEqual({
    body: '',
    ended: true,
    headers: { 'cache-control': 'no-cache' },
    nextCalled: false,
    statusCode: 404,
  });
  const manifest = request(middleware, '/.well-known/ontos-module-manifest.json');
  expect(manifest.statusCode).toBe(200);
  expect(JSON.parse(manifest.body ?? '')).toEqual({ moduleId: 'party.registry' });
});

it('rethrows a tool catalog read error other than a missing file instead of answering 404', () => {
  const middleware = installMiddleware({ toolCatalog: 'directory' });
  expect(() => request(middleware, TOOL_CATALOG_URL)).toThrow(/EISDIR/u);
});

it('passes every other request to the next middleware', () => {
  const middleware = installMiddleware();
  for (const url of [
    undefined,
    '/en/contacts',
    '/.well-known/other.json',
    '/prefix/.well-known/ontos-module-manifest.json',
    '/.well-known/ontos-module-manifest.json/extra',
    '/.well-known/ontos-module-mcp-tools.json/extra',
  ]) {
    const response = request(middleware, url);
    expect(response.nextCalled, url).toBe(true);
    expect(response.body, url).toBeNull();
    expect(response.headers, url).toEqual({});
  }
});
