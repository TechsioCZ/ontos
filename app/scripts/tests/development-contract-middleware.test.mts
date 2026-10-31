import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, expect, it } from 'effect-rstest';

import { createDevelopmentContractMiddleware } from '../../packages/shared-contracts/tooling/modern-config.ts';

type Middleware = Parameters<Parameters<ReturnType<typeof createDevelopmentContractMiddleware>>[0]['unshift']>[0];

const CONTRACT = '{"moduleId":"party.registry"}';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

// A unit's dev server must answer the Shell's contract discovery ahead of its locale redirects.
const installMiddleware = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ontos-dev-contract-'));
  roots.push(root);
  mkdirSync(path.join(root, '.dev-public/.well-known'), { recursive: true });
  writeFileSync(path.join(root, '.dev-public/.well-known/ontos-module-manifest.json'), CONTRACT);
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
  readonly headers: Record<string, string>;
  nextCalled: boolean;
}

const request = (middleware: Middleware, url: string) => {
  const headers: Record<string, string> = {};
  const result: ObservedResponse = { body: null, headers, nextCalled: false };
  middleware(
    { url },
    {
      end: (body) => {
        result.body = body.toString('utf-8');
      },
      setHeader: (name, value) => {
        headers[name] = value;
      },
    },
    () => {
      result.nextCalled = true;
    },
  );
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

it('passes every other request to the next middleware', () => {
  const middleware = installMiddleware();
  for (const url of ['/en/contacts', '/.well-known/other.json', '/prefix/.well-known/ontos-module-manifest.json']) {
    const response = request(middleware, url);
    expect(response.nextCalled, url).toBe(true);
    expect(response.body, url).toBeNull();
  }
});
