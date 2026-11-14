import path from 'node:path';
import { readFileSync } from 'node:fs';

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
 * `tar --anchored` are GNU-only, so their shims list the directory and write a stub package; the stub records the
 * files staged for the package (the directory after `-C`), so a test can assert what a service ships.
 */
const shims = {
  curl: `#!/usr/bin/env bash
zerops="${ZEROPS_API_ORIGIN}"
args=()
for arg in "$@"; do args+=("\${arg/#"$zerops"/$FAKE_ZEROPS_ORIGIN}"); done
printf '%s\\n' "$*" >>"$RUNNER_TEMP/curl-calls"
exec "$REAL_CURL" "\${args[@]}"
`,
  find: `#!/usr/bin/env bash
ls -A1 | sort
`,
  tar: `#!/usr/bin/env bash
previous=''
directory=''
for arg in "$@"; do
  [ "$previous" = -C ] && directory="$arg"
  if [ "$previous" = -czf ]; then
    printf 'package' >"$arg"
    [ -z "$directory" ] || (cd "$directory" && command -p find . -type f) >"$RUNNER_TEMP/package-files"
  fi
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

/** What follows the fake API's origin in the upload URL it hands out. */
const PLAIN_UPLOAD = '/upload';

/** The setup to push (default `app`) and extra checkout files, keyed by their repository path. */
interface PushCheckout {
  readonly files?: Readonly<Record<string, string>>;
  readonly setup?: string;
}

const runPush = (
  answer: ProcessAnswer,
  environment: Readonly<Record<string, string>> = {},
  upload: { readonly origin?: (origin: string) => string; readonly target?: string } = {},
  pushCheckout: PushCheckout = {},
) =>
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
          const origin = yield* localOrigin;
          return json({
            id: 'version-1',
            uploadUrl: `${upload.origin?.(origin) ?? origin}${upload.target ?? PLAIN_UPLOAD}`,
          });
        }
        if (route.startsWith('PUT /upload')) {
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
      for (const [file, body] of Object.entries(pushCheckout.files ?? {})) {
        yield* fs.makeDirectory(path.dirname(path.join(checkout, file)), { recursive: true });
        yield* fs.writeFileString(path.join(checkout, file), body);
      }
      for (const [name, body] of Object.entries(shims)) {
        yield* fs.writeFileString(path.join(bin, name), body);
        yield* fs.chmod(path.join(bin, name), 0o700);
      }
      const realCurl = (yield* collectToolingProcess(
        ChildProcess.make('bash', ['-c', 'command -v curl']),
      )).stdout.trim();
      const result = yield* collectToolingProcess(
        ChildProcess.make(
          'bash',
          [path.join(import.meta.dirname, 'push-service.sh'), SERVICE_ID, pushCheckout.setup ?? 'app', 'version'],
          {
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
          },
        ),
      );
      const curlCalls = path.join(directory, 'curl-calls');
      const curlArguments = (yield* fs.exists(curlCalls)) ? yield* fs.readFileString(curlCalls) : '';
      const packageList = path.join(directory, 'package-files');
      const packageFiles = (yield* fs.exists(packageList))
        ? (yield* fs.readFileString(packageList))
            .split('\n')
            .filter((file) => file.length > 0)
            .map((file) => file.replace(/^\.\//u, ''))
            .toSorted()
        : [];
      return { ...result, calls, curlArguments, packageFiles, polls };
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

it.live(
  'every step line carries a UTC timestamp with milliseconds and the service, and never the token or upload URL',
  () =>
    Effect.gen(function* stepLines() {
      const result = yield* runPush(() => processState('FINISHED'), { PUSH_SERVICE_NAME: 'app' });
      const lines = result.stdout.trim().split('\n');
      for (const line of lines) {
        expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[app\] /u);
      }
      const steps = lines.map((line) => line.replace(/^\S+ \[app\] /u, '').replaceAll(/\d+(?:\.\d+)?/gu, 'N'));
      expect(steps).toEqual([
        'package: NK (N bytes)',
        'app version create started (attempt N)',
        'app version create ended (attempt N): version version-N',
        'upload started (attempt N, N bytes): host N.N, family IPvN, same address as project entry: unknown',
        'upload timing (attempt N): namelookup=N connect=N appconnect=N pretransfer=N starttransfer=N total=N speed_upload=N size_upload=N http_code=N',
        'upload ended (attempt N, N bytes): uploaded in Ns (attempt N)',
        'build and deploy request started',
        'build and deploy request ended',
        'build and deploy process process-N for app version version-N',
        'process state: FINISHED',
        'app deployed in Ns',
      ]);
      expect(result.stdout).not.toContain('test-token');
      expect(result.stdout).not.toContain('/upload');
    }),
);

it.live('the upload URL never reaches the log: only its host, with no user info, port, path or signed query', () =>
  Effect.gen(function* uploadHost() {
    const result = yield* runPush(
      () => processState('FINISHED'),
      {},
      {
        origin: (origin) => origin.replace('//', '//uploader:SECRET-PASSWORD@'),
        target: '/upload/SECRET-PATH?X-Amz-Signature=SECRET-SIGNATURE&token=SECRET-TOKEN#SECRET-FRAGMENT',
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(': host 127.0.0.1, family IPv4, ');
    expect(`${result.stdout}${result.stderr}`).not.toContain('SECRET');
    expect(result.stdout).not.toMatch(/127\.0\.0\.1:\d/u);
  }),
);

it.live('each attempt says whether the upload host shares an address with the project hostnames', () =>
  Effect.gen(function* projectEntry() {
    const same = yield* runPush(() => processState('FINISHED'), { PUSH_PROJECT_HOSTS: '192.0.2.7 127.0.0.1' });
    expect(same.stdout).toContain('family IPv4, same address as project entry: yes');
    const other = yield* runPush(() => processState('FINISHED'), { PUSH_PROJECT_HOSTS: '192.0.2.7' });
    expect(other.stdout).toContain('family IPv4, same address as project entry: no');
  }),
);

/** The curl calls that uploaded the package. */
const uploads = (curlArguments: string) => curlArguments.split('\n').filter((call) => call.includes(' -T '));

it.live('the upload rate limit is an experiment: off by default, passed to curl when set, refused when malformed', () =>
  Effect.gen(function* rateLimit() {
    const plain = yield* runPush(() => processState('FINISHED'));
    expect(uploads(plain.curlArguments)).toHaveLength(1);
    expect(plain.curlArguments).not.toContain('--limit-rate');
    expect(plain.stdout).not.toContain('rate limited');
    const limited = yield* runPush(() => processState('FINISHED'), { ONTOS_PUSH_UPLOAD_LIMIT_RATE: '8M' });
    expect(limited.status).toBe(0);
    expect(limited.stdout).toContain('upload rate limited to 8M (experiment)');
    expect(uploads(limited.curlArguments).map((call) => call.includes('--limit-rate 8M'))).toEqual([true]);
    const malformed = yield* runPush(() => processState('FINISHED'), { ONTOS_PUSH_UPLOAD_LIMIT_RATE: '8M; rm -rf /' });
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain('ONTOS_PUSH_UPLOAD_LIMIT_RATE must be a curl rate such as 8M');
    expect(malformed.calls).toEqual([]);
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

it('omits non-build inputs per service without mutating the runner index or weakening the upload guard', () => {
  const source = readFileSync(new URL('./push-service.sh', import.meta.url), 'utf8');
  for (const exclusion of ['*/tests', 'docs', 'app/docs', '*/.codex', '*/.next']) {
    expect(source).toContain(`--exclude='${exclusion}'`);
  }
  expect(source).toContain('app/n1-storefront/src');
  expect(source).toContain('app/akros-storefront/src');
  expect(source).toContain('git -C "$work/source" update-index --skip-worktree -z --stdin');
  expect(source).toContain('upload_limit_seconds="${UPLOAD_LIMIT_SECONDS:-25}"');
  expect(source).toContain('((took <= upload_limit_seconds)) && break');
});

/** The runner's storefront build, as build_storefronts uploads it and the deploy job downloads it into app/. */
const STOREFRONT_ARCHIVE = {
  'app/.zerops-storefront.json': '{"setup":"storefront"}\n',
  'app/.zerops-storefront.tar.gz': 'archive',
};

it.live('a storefront push ships only zerops.yaml and the runner-built archive with its manifest', () =>
  Effect.gen(function* storefrontPackage() {
    for (const setup of ['storefront', 'n1']) {
      const result = yield* runPush(
        () => processState('FINISHED'),
        {},
        {},
        {
          files: {
            ...STOREFRONT_ARCHIVE,
            'app/.zerops-prebuilt.tar.zst': 'app units',
            'app/akros-storefront/src/app/page.tsx': 'source',
            'app/n1-storefront/src/app/page.tsx': 'source',
            'app/package.json': '{}',
          },
          setup,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.packageFiles).toEqual([
        'app/.zerops-storefront.json',
        'app/.zerops-storefront.tar.gz',
        'app/zerops.yaml',
      ]);
      expect(result.stdout).toContain(`${setup} deployed in`);
    }
  }),
);

it.live('a storefront push without the runner-built archive fails before any Zerops call', () =>
  Effect.gen(function* missingArchive() {
    const result = yield* runPush(() => processState('FINISHED'), {}, {}, { setup: 'n1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the n1 push needs app/.zerops-storefront.tar.gz (the build_storefronts artifact)');
    expect(result.calls).toEqual([]);
  }),
);

it.live('an unknown setup fails before any Zerops call', () =>
  Effect.gen(function* unknownSetup() {
    const result = yield* runPush(() => processState('FINISHED'), {}, {}, { setup: 'shop' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown zerops.yaml setup: shop');
    expect(result.calls).toEqual([]);
  }),
);

it('never ships a storefront archive in the app package', () => {
  const source = readFileSync(new URL('./push-service.sh', import.meta.url), 'utf8');
  expect(source).toContain("--exclude='app/.zerops-storefront.*'");
  expect(source).toContain('cp app/zerops.yaml app/.zerops-storefront.tar.gz app/.zerops-storefront.json');
});
