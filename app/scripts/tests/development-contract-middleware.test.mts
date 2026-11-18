import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, expect, it } from 'effect-rstest';

import { createDevelopmentContractMiddleware } from '../../packages/shared-contracts/tooling/modern-config.ts';

type Middleware = Parameters<Parameters<ReturnType<typeof createDevelopmentContractMiddleware>>[0]['unshift']>[0];

const CONTRACT = '{"moduleId":"party.registry"}';
const MCP_TOOLS = '{"tools":[]}';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

// A unit's dev server must answer the Shell's contract discovery ahead of its locale redirects.
const installMiddleware = ({ withToolCatalog = true } = {}) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ontos-dev-contract-'));
  roots.push(root);
  mkdirSync(path.join(root, '.dev-public/.well-known'), { recursive: true });
  writeFileSync(path.join(root, '.dev-public/.well-known/ontos-module-manifest.json'), CONTRACT);
  if (withToolCatalog) {
    writeFileSync(path.join(root, '.dev-public/.well-known/ontos-module-mcp-tools.json'), MCP_TOOLS);
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

interface ObservedResponse {
  body: string | null;
  ended: boolean;
  readonly headers: Record<string, string>;
  nextCalled: boolean;
  statusCode: number;
}

const request = (middleware: Middleware, url: string) => {
  const headers: Record<string, string> = {};
  const result: ObservedResponse = { body: null, ended: false, headers, nextCalled: false, statusCode: 200 };
  const response = {
    end: (body?: Buffer) => {
      result.ended = true;
      result.body = body?.toString('utf-8') ?? null;
    },
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    statusCode: 200,
  };
  middleware({ url }, response, () => {
    result.nextCalled = true;
  });
  result.statusCode = response.statusCode;
  return result;
};

it('serves the prepared module contract as uncached JSON, ignoring the query string', () => {
  const response = request(installMiddleware(), '/.well-known/ontos-module-manifest.json?cache-bust=1');
  expect(response.nextCalled).toBe(false);
  expect(JSON.parse(response.body ?? '')).toEqual({ moduleId: 'party.registry' });
  expect(response.headers).toEqual({
    'Cache-Control': 'no-cache',
    'Content-Length': String(Buffer.byteLength(CONTRACT)),
    'Content-Type': 'application/json',
  });
});

it('serves the prepared MCP tool catalog next to the module contract', () => {
  const response = request(installMiddleware(), '/.well-known/ontos-module-mcp-tools.json');
  expect(response.nextCalled).toBe(false);
  expect(JSON.parse(response.body ?? '')).toEqual({ tools: [] });
  expect(response.headers).toEqual({
    'Cache-Control': 'no-cache',
    'Content-Length': String(Buffer.byteLength(MCP_TOOLS)),
    'Content-Type': 'application/json',
  });
});

it('answers 404 for the tool catalog of a module without an MCP contribution', () => {
  const middleware = installMiddleware({ withToolCatalog: false });
  const catalog = request(middleware, '/.well-known/ontos-module-mcp-tools.json');
  expect(catalog).toEqual({ body: null, ended: true, headers: {}, nextCalled: false, statusCode: 404 });
  const manifest = request(middleware, '/.well-known/ontos-module-manifest.json');
  expect(manifest.statusCode).toBe(200);
  expect(JSON.parse(manifest.body ?? '')).toEqual({ moduleId: 'party.registry' });
});

it('passes every other request to the next middleware', () => {
  const middleware = installMiddleware();
  for (const url of [
    '/en/contacts',
    '/.well-known/other.json',
    '/prefix/.well-known/ontos-module-manifest.json',
    '/.well-known/ontos-module-mcp-tools.json/extra',
  ]) {
    const response = request(middleware, url);
    expect(response.nextCalled, url).toBe(true);
    expect(response.body, url).toBeNull();
  }
});
