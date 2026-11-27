import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NodeHttpServer, NodeHttpServerRequest } from '@effect/platform-node';
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem } from 'effect';
import { HttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { afterEach, expect, it, rstest } from 'effect-rstest';

import {
  createDevelopmentContractMiddleware,
  makeDevelopmentContractMiddleware,
} from '../../packages/shared-contracts/tooling/modern-config.ts';

type Middleware = Parameters<Parameters<ReturnType<typeof createDevelopmentContractMiddleware>>[0]['unshift']>[0];

const CONTRACT = '{\n  "moduleId": "party.registry", "label": "Příliš žluťoučký 🚜"\n}\n';
const MCP_TOOLS = '{"tools":[]}';
const TOOL_CATALOG_URL = '/.well-known/ontos-module-mcp-tools.json';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const captureMiddleware = (setup: ReturnType<typeof createDevelopmentContractMiddleware>) => {
  const installed: Middleware[] = [];
  setup({
    push: (...middlewares) => {
      installed.push(...middlewares);
    },
    unshift: (...middlewares) => {
      installed.unshift(...middlewares);
    },
  });
  const [middleware, ...rest] = installed;
  expect(rest).toEqual([]);
  if (middleware === undefined) {
    throw new Error('The development contract middleware was not installed');
  }
  return middleware;
};

// A unit's dev server must answer the Shell's contract discovery ahead of its locale redirects.
const installMiddleware = ({
  manifest = 'file',
  moduleUrl,
  toolCatalog = 'file',
}: {
  manifest?: 'file' | 'absent';
  moduleUrl?: string;
  toolCatalog?: 'file' | 'absent' | 'directory';
} = {}) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ontos-dev-contract-'));
  roots.push(root);
  mkdirSync(path.join(root, '.dev-public/.well-known'), { recursive: true });
  if (manifest === 'file') {
    writeFileSync(path.join(root, '.dev-public/.well-known/ontos-module-manifest.json'), CONTRACT);
  }
  const toolCatalogPath = path.join(root, '.dev-public/.well-known/ontos-module-mcp-tools.json');
  if (toolCatalog === 'file') {
    writeFileSync(toolCatalogPath, MCP_TOOLS);
  } else if (toolCatalog === 'directory') {
    mkdirSync(toolCatalogPath);
  }
  return captureMiddleware(
    createDevelopmentContractMiddleware(moduleUrl ?? pathToFileURL(path.join(root, 'modern.config.ts')).href),
  );
};

interface ObservedResponse {
  body: Buffer | null;
  ended: boolean;
  readonly headers: ReturnType<ServerResponse['getHeaders']>;
  nextCalled: boolean;
  nextError?: unknown;
  statusCode: number;
}

interface DisconnectControl {
  readonly afterDisconnect: Effect.Effect<void>;
  readonly beforeDisconnect: Effect.Effect<void>;
}

const observeMiddleware = (
  middleware: Middleware,
  nativeRequest: HttpServerRequest.HttpServerRequest,
  disconnect: DisconnectControl | undefined,
) => {
  const incoming = NodeHttpServerRequest.toIncomingMessage(nativeRequest);
  const response = NodeHttpServerRequest.toServerResponse(nativeRequest);
  const observed = Effect.callback<ObservedResponse>((resume) => {
    const next = rstest.fn<Parameters<Middleware>[2]>(() => {
      response.destroy();
    });
    const snapshot = (): ObservedResponse => {
      const result: ObservedResponse = {
        body: null,
        ended: response.writableEnded,
        headers: response.getHeaders(),
        nextCalled: next.mock.calls.length > 0,
        statusCode: response.statusCode,
      };
      const [error] = next.mock.calls.at(0) ?? [];
      if (error !== undefined) {
        result.nextError = error;
      }
      const remaining = new Set(response.listeners('close'));
      expect(middlewareListeners.filter((listener) => remaining.has(listener))).toHaveLength(0);
      return result;
    };
    const onClosed = () => {
      resume((disconnect?.afterDisconnect ?? Effect.void).pipe(Effect.andThen(Effect.sync(snapshot))));
    };
    const baselineCloseListeners = new Set(response.listeners('close'));
    middleware(incoming, response, next);
    const middlewareListeners = response.listeners('close').filter((listener) => !baselineCloseListeners.has(listener));
    response.once('close', onClosed);
    return Effect.sync(() => response.removeListener('close', onClosed));
  });
  return disconnect === undefined
    ? observed
    : disconnect.beforeDisconnect.pipe(
        Effect.andThen(Effect.sync(() => incoming.socket.destroy())),
        Effect.forkChild,
        Effect.andThen(observed),
      );
};

const request = (middleware: Middleware, url: string, disconnect?: DisconnectControl) =>
  Effect.gen(function* requestEffect() {
    const server = yield* HttpServer.HttpServer;
    const client = yield* HttpClient.HttpClient;
    const observed = yield* Deferred.make<Exit.Exit<ObservedResponse>>();
    yield* server.serve(
      HttpServerRequest.HttpServerRequest.pipe(
        Effect.flatMap((nativeRequest) => observeMiddleware(middleware, nativeRequest, disconnect)),
        Effect.exit,
        Effect.flatMap((result) => Deferred.succeed(observed, result)),
        Effect.as(HttpServerResponse.empty()),
      ),
    );
    const received = yield* client.get(url).pipe(
      Effect.flatMap((response) =>
        response.arrayBuffer.pipe(Effect.map((body) => ({ body: Buffer.from(body), response }))),
      ),
      Effect.exit,
    );
    const result = yield* yield* Deferred.await(observed);
    if (result.ended) {
      if (Exit.isFailure(received)) {
        return yield* Effect.failCause(received.cause);
      }
      expect(received.value.response.status).toBe(result.statusCode);
      for (const [name, value] of Object.entries(result.headers)) {
        expect(received.value.response.headers[name]).toEqual(value);
      }
      result.body = received.value.body;
    } else {
      expect(Exit.isFailure(received)).toBe(true);
    }
    return result;
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest), Effect.orDie);

it.live(
  'cancels an in-flight filesystem read when the connection closes without writing or forwarding interruption',
  Effect.fn(function* testEffect() {
    const readStarted = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
    const releaseRead = yield* Deferred.make<Uint8Array>();
    const fileSystem = FileSystem.makeNoop({
      readFile: () =>
        Effect.gen(function* controlledRead() {
          yield* Deferred.succeed(readStarted, yield* Effect.fiber);
          return yield* Deferred.await(releaseRead);
        }),
    });
    const setup = yield* makeDevelopmentContractMiddleware(import.meta.url).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
    const response = yield* request(captureMiddleware(setup), TOOL_CATALOG_URL, {
      afterDisconnect: Effect.gen(function* awaitMiddlewareTermination() {
        const fiber = yield* Deferred.await(readStarted);
        yield* Deferred.succeed(releaseRead, Buffer.from(MCP_TOOLS));
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      }),
      beforeDisconnect: Deferred.await(readStarted).pipe(Effect.asVoid),
    });
    expect(response).toEqual({
      body: null,
      ended: false,
      headers: {},
      nextCalled: false,
      statusCode: 200,
    });
  }),
);

it.live(
  'serves the prepared module contract as exact uncached JSON bytes, ignoring the query string',
  Effect.fn(function* testEffect() {
    const response = yield* request(installMiddleware(), '/.well-known/ontos-module-manifest.json?cache-bust=1');
    expect(response.nextCalled).toBe(false);
    expect(response.ended).toBe(true);
    expect(response.body).toEqual(Buffer.from(CONTRACT));
    expect(response.headers).toEqual({
      'cache-control': 'no-cache',
      'content-length': String(Buffer.byteLength(CONTRACT)),
      'content-type': 'application/json',
    });
  }),
);

it.live(
  'serves the prepared MCP tool catalog next to the module contract',
  Effect.fn(function* testEffect() {
    const response = yield* request(installMiddleware(), TOOL_CATALOG_URL);
    expect(response.nextCalled).toBe(false);
    expect(response.ended).toBe(true);
    expect(response.body).toEqual(Buffer.from(MCP_TOOLS));
    expect(response.headers).toEqual({
      'cache-control': 'no-cache',
      'content-length': String(Buffer.byteLength(MCP_TOOLS)),
      'content-type': 'application/json',
    });
  }),
);

it.live(
  'answers 404 for the tool catalog of a module without an MCP contribution',
  Effect.fn(function* testEffect() {
    const middleware = installMiddleware({ toolCatalog: 'absent' });
    const catalog = yield* request(middleware, TOOL_CATALOG_URL);
    expect(catalog).toEqual({
      body: Buffer.alloc(0),
      ended: true,
      headers: { 'cache-control': 'no-cache' },
      nextCalled: false,
      statusCode: 404,
    });
    const manifest = yield* request(middleware, '/.well-known/ontos-module-manifest.json');
    expect(manifest.statusCode).toBe(200);
    expect(manifest.body).toEqual(Buffer.from(CONTRACT));
  }),
);

it.live(
  'forwards a tool catalog read error other than a missing file to Connect instead of answering 404',
  Effect.fn(function* testEffect() {
    const response = yield* request(installMiddleware({ toolCatalog: 'directory' }), TOOL_CATALOG_URL);
    expect(response.nextCalled).toBe(true);
    expect(response.nextError).toMatchObject({ cause: { code: 'EISDIR' } });
    expect(response.ended).toBe(false);
    expect(response.body).toBeNull();
    expect(response.headers).toEqual({});
  }),
);

it.live(
  'forwards an unexpected URL defect to Connect instead of leaving an unhandled fiber failure',
  Effect.fn(function* testEffect() {
    const response = yield* request(installMiddleware({ moduleUrl: 'not-a-url' }), TOOL_CATALOG_URL);
    expect(response.nextCalled).toBe(true);
    expect(response.nextError).toMatchObject({ code: 'ERR_INVALID_URL' });
    expect(response.ended).toBe(false);
    expect(response.body).toBeNull();
    expect(response.headers).toEqual({});
  }),
);

it.live(
  'forwards a missing mandatory manifest to Connect instead of treating it as an absent MCP contribution',
  Effect.fn(function* testEffect() {
    const response = yield* request(
      installMiddleware({ manifest: 'absent' }),
      '/.well-known/ontos-module-manifest.json',
    );
    expect(response.nextCalled).toBe(true);
    expect(response.nextError).toMatchObject({ cause: { code: 'ENOENT' } });
    expect(response.ended).toBe(false);
    expect(response.body).toBeNull();
    expect(response.headers).toEqual({});
  }),
);

it.live(
  'passes every other request to the next middleware',
  Effect.fn(function* testEffect() {
    const middleware = installMiddleware();
    for (const url of [
      '/en/contacts',
      '/.well-known/other.json',
      '/prefix/.well-known/ontos-module-manifest.json',
      '/.well-known/ontos-module-mcp-tools.json/extra',
    ]) {
      const response = yield* request(middleware, url);
      expect(response.nextCalled, url).toBe(true);
      expect(response.nextError, url).toBeUndefined();
      expect(response.body, url).toBeNull();
    }
  }),
);
