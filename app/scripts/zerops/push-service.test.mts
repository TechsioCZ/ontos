import path from 'node:path';

import { NodeHttpServer, NodeServices } from '@effect/platform-node';
import { Config, Effect, FileSystem, Layer } from 'effect';
import { expect, it } from 'effect-rstest';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { NetAddress } from 'effect/net';
import { ChildProcess } from 'effect/process';

import { collectToolingProcess } from '../tests/tooling-process-fixture.mts';

const ZEROPS_API_ORIGIN = 'https://api.app-prg1.zerops.io';
const SERVICE_ID = 'service-under-test';

/**
 * The real `curl` against a local stand-in for the Zerops API: the shim only points the script's fixed API origin at
 * the local server, so curl's own retry and back-off decide every transient answer. `find -printf` and
 * `tar --anchored` are GNU-only and the package is not under test, so their shims list the directory and write a stub.
 */
const shims = {
  curl: `#!/usr/bin/env bash
zerops="${ZEROPS_API_ORIGIN}"
args=()
for arg in "$@"; do args+=("\${arg/#"$zerops"/$FAKE_ZEROPS_ORIGIN}"); done
exec "$REAL_CURL" "\${args[@]}"
`,
  find: `#!/usr/bin/env bash
ls -A1 | sort
`,
  tar: `#!/usr/bin/env bash
previous=''
for arg in "$@"; do
  [ "$previous" = -czf ] && printf 'package' >"$arg"
  previous="$arg"
done
`,
};

/** Answers the polling GET; `call` counts from 1. */
type ProcessAnswer = (call: number) => { readonly body: string; readonly status: number };

const processState = (status: string) => ({ body: JSON.stringify({ id: 'process-1', status }), status: 200 });
const badGateway = { body: 'bad gateway', status: 502 };

/** The fake API's JSON answers: flat string records, as the script reads them with `jq -er`. */
type FakeApiBody = Readonly<Record<string, string>>;
const json = (body: FakeApiBody) => HttpServerResponse.text(JSON.stringify(body), { contentType: 'application/json' });

/** The local server's origin on the loopback address the script's curl reaches. */
const localOrigin = Effect.gen(function* localServerOrigin() {
  const server = yield* HttpServer.HttpServer;
  if (NetAddress.isUnixPathAddress(server.address)) {
    return yield* Effect.die('The fake Zerops API must listen on an Internet socket');
  }
  const url = yield* Effect.fromResult(NetAddress.toUrl(server.address));
  url.hostname = '127.0.0.1';
  return url.origin;
});

const runPush = (answer: ProcessAnswer, environment: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* pushAgainstFakeApi() {
    const fs = yield* FileSystem.FileSystem;
    const calls: string[] = [];
    let polls = 0;
    const api = HttpServer.serve(
      Effect.gen(function* fakeZeropsApi() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const route = `${request.method} ${request.url.split('?')[0] ?? ''}`;
        calls.push(route);
        yield* request.arrayBuffer.pipe(Effect.ignore);
        if (route === `POST /api/rest/public/service-stack/${SERVICE_ID}/app-version`) {
          return json({ id: 'version-1', uploadUrl: `${yield* localOrigin}/upload` });
        }
        if (route === 'PUT /upload') {
          return HttpServerResponse.empty({ status: 200 });
        }
        if (route === 'PUT /api/rest/public/app-version/version-1/build-and-deploy') {
          return json({ id: 'process-1' });
        }
        if (route === 'GET /api/rest/public/process/process-1') {
          polls += 1;
          const { body, status } = answer(polls);
          return HttpServerResponse.text(body, { contentType: 'application/json', status });
        }
        return HttpServerResponse.empty({ status: 404 });
      }),
    ).pipe(Layer.provideMerge(NodeHttpServer.layerTest));
    return yield* Effect.gen(function* pushOnce() {
      const origin = yield* localOrigin;
      const searchPath = yield* Config.String('PATH');
      const directory = yield* fs.makeTempDirectoryScoped();
      const bin = path.join(directory, 'bin');
      const checkout = path.join(directory, 'checkout');
      yield* fs.makeDirectory(bin);
      yield* fs.makeDirectory(path.join(checkout, 'app'), { recursive: true });
      yield* fs.writeFileString(path.join(checkout, 'app/zerops.yaml'), 'zerops: []\n');
      for (const [name, body] of Object.entries(shims)) {
        yield* fs.writeFileString(path.join(bin, name), body);
        yield* fs.chmod(path.join(bin, name), 0o700);
      }
      const realCurl = (yield* collectToolingProcess(
        ChildProcess.make('bash', ['-c', 'command -v curl']),
      )).stdout.trim();
      const result = yield* collectToolingProcess(
        ChildProcess.make('bash', [path.join(import.meta.dirname, 'push-service.sh'), SERVICE_ID, 'app', 'version'], {
          cwd: checkout,
          env: {
            ...environment,
            FAKE_ZEROPS_ORIGIN: origin,
            PATH: `${bin}:${searchPath}`,
            REAL_CURL: realCurl,
            RUNNER_TEMP: directory,
            ZEROPS_TOKEN: 'test-token',
          },
          extendEnv: true,
        }),
      );
      return { ...result, calls, polls };
    }).pipe(Effect.provide(api));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const writes = (calls: readonly string[]) => calls.filter((call) => !call.startsWith('GET '));
const ONE_EACH = [
  `POST /api/rest/public/service-stack/${SERVICE_ID}/app-version`,
  'PUT /upload',
  'PUT /api/rest/public/app-version/version-1/build-and-deploy',
];

it.live('a deploy poll that meets two 502s asks again and reports the deploy', () =>
  Effect.gen(function* transientGateway() {
    const result = yield* runPush((call) => (call <= 2 ? badGateway : processState('FINISHED')));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('app deployed in');
    expect(result.polls).toBe(3);
    // The app version and the build-and-deploy request are never repeated.
    expect(writes(result.calls)).toEqual(ONE_EACH);
  }),
);

it.live('a deploy poll that only ever meets 502s fails once its retry budget is spent', () =>
  Effect.gen(function* persistentGateway() {
    const result = yield* runPush(() => badGateway);
    expect(result.status).not.toBe(0);
    // The first request and its six retries.
    expect(result.polls).toBe(7);
    expect(writes(result.calls)).toEqual(ONE_EACH);
  }),
);

it.live('a FAILED deploy fails at the first poll', () =>
  Effect.gen(function* failedDeploy() {
    const result = yield* runPush(() => processState('FAILED'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('app build and deploy FAILED');
    expect(result.polls).toBe(1);
  }),
);

it.live('a deploy still running at its deadline fails and names the service', () =>
  Effect.gen(function* deadline() {
    const result = yield* runPush(() => processState('BUILDING'), { DEPLOY_LIMIT_SECONDS: '0' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`service ${SERVICE_ID} (app): build and deploy process process-1 still BUILDING`);
    expect(result.polls).toBe(1);
  }),
);
