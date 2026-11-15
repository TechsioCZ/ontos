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
const PUSH_SERVICE_SCRIPT = 'push-service.sh';
const TOKEN = 'test-token';
const UPLOAD_ROUTE = 'PUT /upload';
const DEPLOYED = 'app deployed in';

/**
 * The real `curl` against a local stand-in for the Zerops API: the shim only points the script's fixed API origin at
 * the local server, so curl's own retry and back-off decide every transient answer. `find -printf` and
 * `tar --anchored` are GNU-only, so their shims list the directory and write a stub package; the stub records the
 * files staged for the package (the directory after `-C`), so a test can assert what a service ships.
 */
const shims = {
  curl: `#!/usr/bin/env bash
zerops="${ZEROPS_API_ORIGIN}"
printf '%s\\n' "$*" >>"$RUNNER_TEMP/curl-calls"
# FAKE_CURL_HEAD_FAIL makes the warm-up HEAD fail the way curl does: 7 cannot connect, 28 timed out.
# FAKE_CURL_HEAD_DELAY holds the warm-up HEAD for that many seconds before the real curl runs.
if [ -n "\${FAKE_CURL_HEAD_FAIL:-}" ]; then
  for arg in "$@"; do
    if [ "$arg" = -I ]; then exit "$FAKE_CURL_HEAD_FAIL"; fi
  done
fi
if [ -n "\${FAKE_CURL_HEAD_DELAY:-}" ]; then
  for arg in "$@"; do
    if [ "$arg" = -I ]; then sleep "$FAKE_CURL_HEAD_DELAY"; fi
  done
fi
args=()
for arg in "$@"; do args+=("\${arg/#"$zerops"/$FAKE_ZEROPS_ORIGIN}"); done
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
  upload: {
    readonly buildAndDeploy?: { readonly body: string; readonly status: number };
    readonly delayFirstUploadMs?: number;
    readonly origin?: (origin: string) => string;
    readonly target?: string;
  } = {},
  pushCheckout: PushCheckout = {},
) =>
  Effect.gen(function* pushAgainstFakeApi() {
    const fs = yield* FileSystem.FileSystem;
    const calls: string[] = [];
    let polls = 0;
    let uploadCount = 0;
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
        if (route.startsWith(UPLOAD_ROUTE)) {
          uploadCount += 1;
          if (uploadCount === 1 && upload.delayFirstUploadMs !== undefined) {
            yield* Effect.sleep(upload.delayFirstUploadMs);
          }
          return HttpServerResponse.empty({ status: 200 });
        }
        if (route === 'PUT /api/rest/public/app-version/version-1/build-and-deploy') {
          return upload.buildAndDeploy === undefined
            ? json({ id: 'process-1' })
            : HttpServerResponse.text(upload.buildAndDeploy.body, {
                contentType: 'application/json',
                status: upload.buildAndDeploy.status,
              });
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
          [path.join(import.meta.dirname, PUSH_SERVICE_SCRIPT), SERVICE_ID, pushCheckout.setup ?? 'app', 'version'],
          {
            cwd: checkout,
            env: {
              ...environment,
              FAKE_ZEROPS_ORIGIN: origin,
              PATH: `${bin}:${searchPath}`,
              REAL_CURL: realCurl,
              RUNNER_TEMP: directory,
              ZEROPS_TOKEN: TOKEN,
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
  UPLOAD_ROUTE,
  'PUT /api/rest/public/app-version/version-1/build-and-deploy',
];

it.live('a deploy poll that meets two 502s asks again and reports the deploy', () =>
  Effect.gen(function* transientGateway() {
    const result = yield* runPush((call) => (call <= 2 ? badGateway : processState('FINISHED')));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(DEPLOYED);
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
      expect(result.stdout).not.toContain(TOKEN);
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

/** The curl calls that warmed the upload host up: a HEAD, so the only ones with -I. */
const warmups = (curlArguments: string) => curlArguments.split('\n').filter((call) => call.includes(' -I '));

it.live('the upload warm-up is an experiment: off by default, exactly one before the first upload when on', () =>
  Effect.gen(function* uploadWarmup() {
    const plain = yield* runPush(() => processState('FINISHED'));
    expect(plain.stdout).not.toContain('warm-up');
    expect(warmups(plain.curlArguments)).toHaveLength(0);
    expect(writes(plain.calls)).toEqual(ONE_EACH);
    // Spelling the switch out as false changes nothing either.
    const explicit = yield* runPush(() => processState('FINISHED'), { ONTOS_PUSH_UPLOAD_WARMUP: 'false' });
    expect(explicit.stdout).not.toContain('warm-up');
    expect(explicit.calls).toEqual(plain.calls);

    const warm = yield* runPush(() => processState('FINISHED'), { ONTOS_PUSH_UPLOAD_WARMUP: 'true' });
    expect(warm.status).toBe(0);
    // One warm-up, once, before the first upload, and the deploy's command sequence is otherwise unchanged.
    expect(warm.calls.filter((call) => call === 'HEAD /')).toHaveLength(1);
    expect(warm.calls.indexOf('HEAD /')).toBeLessThan(warm.calls.indexOf(UPLOAD_ROUTE));
    expect(writes(warm.calls).filter((call) => call !== 'HEAD /')).toEqual(ONE_EACH);
    expect(warmups(warm.curlArguments)).toHaveLength(1);
    expect(uploads(warm.curlArguments)).toHaveLength(1);
    expect(warm.curlArguments.split('\n')[1]).toContain(' -I ');
    // One fact line with the same fields as the upload facts: start time, duration, status and bytes.
    expect(warm.stdout).toMatch(
      /upload warm-up \(attempt 1, 0 bytes\): host 127\.0\.0\.1, started \d{4}-\d{2}-\d{2}T[\d:.]+Z, namelookup=[\d.]+ connect=[\d.]+ appconnect=[\d.]+ pretransfer=[\d.]+ starttransfer=[\d.]+ total=[\d.]+ speed_upload=[\d.]+ size_upload=0 http_code=\d+ curl_exit=0/u,
    );
  }),
);

it.live('the warm-up runs only before the first upload: a retried upload is not warmed again', () =>
  Effect.gen(function* uploadWarmupRetry() {
    const result = yield* runPush(
      () => processState('FINISHED'),
      { ONTOS_PUSH_UPLOAD_WARMUP: 'true', UPLOAD_LIMIT_SECONDS: '1' },
      { delayFirstUploadMs: 3000 },
    );
    expect(result.status).toBe(0);
    expect(uploads(result.curlArguments)).toHaveLength(2);
    expect(warmups(result.curlArguments)).toHaveLength(1);
    expect(result.calls.filter((call) => call === 'HEAD /')).toHaveLength(1);
    expect(result.stdout).toContain('upload warm-up (attempt 1, 0 bytes)');
    expect(result.stdout).toContain('upload started (attempt 2');
    expect(result.stdout).not.toContain('upload warm-up (attempt 2');
  }),
);

it.live('a warm-up that cannot connect is logged and the deploy carries on unchanged', () =>
  Effect.gen(function* uploadWarmupError() {
    const result = yield* runPush(() => processState('FINISHED'), {
      FAKE_CURL_HEAD_FAIL: '7',
      ONTOS_PUSH_UPLOAD_WARMUP: 'true',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(DEPLOYED);
    expect(result.stdout).toContain('curl_exit=7 (the warm-up failed; the push continues)');
    expect(warmups(result.curlArguments)).toHaveLength(1);
    expect(uploads(result.curlArguments)).toHaveLength(1);
  }),
);

it.live('a warm-up that times out inside its 15 s cap is logged and the deploy carries on unchanged', () =>
  Effect.gen(function* uploadWarmupTimeout() {
    const result = yield* runPush(() => processState('FINISHED'), {
      FAKE_CURL_HEAD_FAIL: '28',
      ONTOS_PUSH_UPLOAD_WARMUP: 'true',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(DEPLOYED);
    expect(result.stdout).toContain('curl_exit=28 (the warm-up failed; the push continues)');
    expect(warmups(result.curlArguments)[0]).toContain('--max-time 15');
    expect(uploads(result.curlArguments)).toHaveLength(1);
  }),
);

it.live('a slow warm-up is not charged to the upload: the attempt keeps its budget and its own duration', () =>
  Effect.gen(function* uploadWarmupNotCharged() {
    const delaySeconds = 3;
    const result = yield* runPush(() => processState('FINISHED'), {
      FAKE_CURL_HEAD_DELAY: `${delaySeconds}`,
      ONTOS_PUSH_UPLOAD_WARMUP: 'true',
      UPLOAD_LIMIT_SECONDS: '2',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(DEPLOYED);
    // The warm-up ate the whole limit, but the real upload is fast, so the package goes up once and is never redone.
    expect(warmups(result.curlArguments)).toHaveLength(1);
    expect(uploads(result.curlArguments)).toHaveLength(1);
    expect(result.stdout).toContain('upload warm-up (attempt 1, 0 bytes)');
    expect(result.stdout).not.toContain('upload started (attempt 2');
    // "uploaded in N s" is the upload's own duration, so it excludes the warm-up it followed.
    const logged = /upload ended \(attempt 1, \d+ bytes\): uploaded in (?<seconds>\d+)s \(attempt 1\)/u.exec(
      result.stdout,
    );
    expect(logged).not.toBeNull();
    expect(Number(logged?.groups?.seconds)).toBeLessThan(delaySeconds);
  }),
);

it.live('the warm-up carries no credential: no token, no user info, no signed path or query', () =>
  Effect.gen(function* uploadWarmupSecrets() {
    const result = yield* runPush(
      () => processState('FINISHED'),
      { ONTOS_PUSH_UPLOAD_WARMUP: 'true' },
      {
        origin: (origin) => origin.replace('//', '//uploader:SECRET-PASSWORD@'),
        target: '/upload/SECRET-PATH?X-Amz-Signature=SECRET-SIGNATURE&token=SECRET-TOKEN',
      },
    );
    expect(result.status).toBe(0);
    const head = warmups(result.curlArguments)[0] ?? '';
    expect(head).toContain(' -I ');
    expect(head).toContain('http://127.0.0.1:');
    expect(head).not.toContain('SECRET');
    expect(`${result.stdout}${result.stderr}`).not.toContain('SECRET');
    expect(result.stdout).not.toContain(TOKEN);
  }),
);

it.live('the warm-up switch refuses a value that is neither true nor false, before any remote mutation', () =>
  Effect.gen(function* uploadWarmupSwitch() {
    const result = yield* runPush(() => processState('FINISHED'), { ONTOS_PUSH_UPLOAD_WARMUP: 'maybe' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ONTOS_PUSH_UPLOAD_WARMUP must be true or false');
    expect(result.calls).toEqual([]);
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
  const source = readFileSync(new URL(PUSH_SERVICE_SCRIPT, import.meta.url), 'utf-8');
  for (const exclusion of ['*/tests', 'docs', 'app/docs', '*/.codex', '*/.next']) {
    expect(source).toContain(`--exclude='${exclusion}'`);
  }
  expect(source).toContain('app/n1-storefront/src');
  expect(source).toContain('app/akros-storefront/src');
  expect(source).toContain('git -C "$work/source" update-index --skip-worktree -z --stdin');
  expect(source).toContain(`upload_limit_seconds="\${UPLOAD_LIMIT_SECONDS:-25}"`);
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
  const source = readFileSync(new URL(PUSH_SERVICE_SCRIPT, import.meta.url), 'utf-8');
  expect(source).toContain("--exclude='app/.zerops-storefront.*'");
  expect(source).toContain('cp app/zerops.yaml app/.zerops-storefront.tar.gz app/.zerops-storefront.json');
});

/** Zerops's answer to a zerops.yaml it refuses (stage, 2026-11-15): the reason is the only way to know what to fix. */
const REFUSED_YAML = JSON.stringify({
  error: { code: 'validation', message: 'invalid retryPeriod <10s, 1h0m0s>', meta: [{ parameterName: 'retryPeriod' }] },
});

it.live("a refused build-and-deploy request fails with Zerops's status and reason, never the token", () =>
  Effect.gen(function* refusedRequest() {
    const result = yield* runPush(
      () => processState('FINISHED'),
      {},
      { buildAndDeploy: { body: REFUSED_YAML, status: 400 } },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Zerops PUT /app-version/version-1/build-and-deploy answered HTTP 400');
    expect(result.stderr).toContain('invalid retryPeriod <10s, 1h0m0s>');
    expect(result.stderr).toContain('"parameterName":"retryPeriod"');
    expect(`${result.stdout}${result.stderr}`).not.toContain(TOKEN);
    // Nothing is polled for a process Zerops never started.
    expect(result.calls).not.toContain('GET /api/rest/public/process/process-1');
  }),
);

it('sends every Zerops API request through the call that reports a refusal, never through a silent curl -f', () => {
  const source = readFileSync(new URL(PUSH_SERVICE_SCRIPT, import.meta.url), 'utf-8');
  expect(source).not.toMatch(/curl -f/u);
  for (const request of [
    'zerops_api POST "/service-stack/$service_id/app-version"',
    'zerops_api PUT "/app-version/$version_id/build-and-deploy"',
    'zerops_api GET "/process/$process_id"',
  ]) {
    expect(source).toContain(request);
  }
  expect(source).toContain('log_error "upload refused (attempt $attempt): HTTP $upload_code');
});
