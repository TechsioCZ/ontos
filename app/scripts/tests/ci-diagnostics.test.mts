import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'effect-rstest';
import { Config, ConfigProvider, Effect } from 'effect';
import { diagnosticScope } from '../../apps/shell-super-app/tests/support/access-admin-finalizer-diagnostics.ts';

const app = path.resolve(import.meta.dirname, '../..');
const observer = path.join(app, 'verticals/commerce-customer-context/tests/support/preproposal-http-diagnostics.mts');
const testOwner = 'test-owner';
const moduleInput = '--input-type=module';
const childEnvironment = Config.all({
  HOME: Config.String('HOME'),
  NODE_COMPILE_CACHE: Config.String('NODE_COMPILE_CACHE').pipe(Config.withDefault('')),
  PATH: Config.String('PATH'),
  TMPDIR: Config.String('TMPDIR').pipe(Config.withDefault('/tmp')),
}).parse(ConfigProvider.fromEnv({ preserveEmptyStrings: true }));

it.effect('retains native request completion and abort without headers, bodies or URLs, in a bounded ring', () =>
  Effect.gen(function* requestLifecycleDiagnostics() {
    const inherited = yield* childEnvironment;
    const directory = mkdtempSync(path.join(tmpdir(), 'preproposal-http-test-'));
    try {
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          observer,
          moduleInput,
          '--eval',
          `
        import { createServer, request } from 'node:http';
        const server = createServer((req, res) => {
          req.resume();
          req.on('end', () => req.url.startsWith('/abort') ? res.destroy() : res.end('secret-response'));
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        for (const [route, id] of [['ok', 41], ['abort', 42]]) {
          await new Promise(resolve => {
            const req = request({host:'127.0.0.1', port, path:'/' + route + '?secret-url', method:'POST',
              headers:{authorization:'Bearer secret-header', 'x-ontos-preproposal-request-id':String(id)}}, res => {
                res.resume(); res.on('end', resolve);
              });
            req.on('error', resolve); req.end('secret-body');
          });
        }
        await new Promise(resolve => server.close(resolve));
      `,
        ],
        {
          encoding: 'utf-8',
          env: { ...inherited, ONTOS_PREPROPOSAL_HTTP_OWNER: testOwner, TMPDIR: directory },
          timeout: 5000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const trace = readFileSync(
        path.join(directory, readdirSync(directory).find((name) => name.endsWith('.diag.log')) ?? ''),
        'utf-8',
      );
      expect(trace).toContain('"requestId":41');
      expect(trace).toContain('"requestId":42');
      expect(trace).toContain('"event":"response-end"');
      expect(trace).toContain('"complete":false');
      expect(trace).toContain('"event":"owner-exit"');
      expect(trace).not.toContain('secret-');
      const bounded = spawnSync(
        process.execPath,
        [
          moduleInput,
          '--eval',
          `
        import {httpDiagnostic} from ${JSON.stringify(observer)};
        httpDiagnostic('test-owner', 'owner-port-bound', {port:12345, ownerPid:6789});
        for(let i=0;i<300;i++) httpDiagnostic('test-owner','bounded',{requestId:i});
      `,
        ],
        {
          encoding: 'utf-8',
          env: { ...inherited, ONTOS_PREPROPOSAL_HTTP_OWNER: '', TMPDIR: directory },
          timeout: 5000,
        },
      );
      expect(bounded.status, bounded.stderr).toBe(0);
      const ring = readFileSync(path.join(directory, `preproposal-http-${bounded.pid}.diag.log`), 'utf-8');
      expect(ring.trim().split('\n')).toHaveLength(257);
      expect(ring).toContain('"event":"owner-port-bound"');
      expect(ring).toContain('"ownerPid":6789');
      expect(ring).not.toContain('"requestId":0}');
      expect(ring).toContain('"requestId":299}');
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }),
);

it.effect(
  'observes the existing Effect placement server and correlates its native request without another listener',
  () =>
    Effect.gen(function* placementDiagnostics() {
      const inherited = yield* childEnvironment;
      const directory = mkdtempSync(path.join(tmpdir(), 'preproposal-placement-test-'));
      try {
        const result = spawnSync(
          process.execPath,
          [
            moduleInput,
            '--eval',
            `
        import { NodeHttpServer, NodeHttpServerRequest, NodeRuntime } from '@effect/platform-node';
        import { Context, Effect, Layer } from 'effect';
        import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
        import { bindHttpPlacementDiagnostic, httpDiagnosticRequestId } from ${JSON.stringify(observer)};
        NodeRuntime.runMain(Effect.scoped(Effect.gen(function* placement() {
          const layer = yield* Layer.build(NodeHttpServer.layerTest);
          const server = Context.get(layer, HttpServer.HttpServer);
          const port = server.address.port;
          const unbind = bindHttpPlacementDiagnostic('placement-owner', port);
          yield* Effect.addFinalizer(() => Effect.sync(unbind));
          yield* server.serve(Effect.gen(function* respond() {
            const incoming = yield* HttpServerRequest.HttpServerRequest;
            return HttpServerResponse.text(String(httpDiagnosticRequestId(NodeHttpServerRequest.toIncomingMessage(incoming))));
          }));
          const text = yield* Effect.promise(async () => {
            const response = await fetch('http://127.0.0.1:' + port, {
              headers: { connection: 'close', 'x-ontos-preproposal-request-id': '73' }
            });
            return await response.text();
          });
          if (text !== '73') throw new Error('placement request correlation missing: ' + text);
        })));
      `,
          ],
          {
            encoding: 'utf-8',
            env: { ...inherited, ONTOS_PREPROPOSAL_HTTP_OWNER: '', TMPDIR: directory },
            timeout: 5000,
          },
        );
        expect(result.status, result.stderr).toBe(0);
        const trace = readFileSync(path.join(directory, `preproposal-http-${result.pid}.diag.log`), 'utf-8');
        expect(trace).toContain('"owner":"placement-owner"');
        expect(trace).toContain('"requestId":73');
        expect(trace).toContain('"event":"socket-open"');
        expect(trace).toContain('"event":"response-end"');
        expect(trace).toContain('"event":"placement-closed"');
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    }),
);

it.effect('records the actual child exit signal independently of Effect scope shutdown', () =>
  Effect.gen(function* childExitDiagnostics() {
    const inherited = yield* childEnvironment;
    const directory = mkdtempSync(path.join(tmpdir(), 'preproposal-exit-test-'));
    try {
      const result = spawnSync(
        process.execPath,
        [
          moduleInput,
          '--eval',
          `
        import { spawn } from 'node:child_process';
        import { bindNativeChildDiagnostic } from ${JSON.stringify(observer)};
        const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
        bindNativeChildDiagnostic('test-owner', child.pid);
        child.kill('SIGTERM');
        await new Promise(resolve => child.on('exit', resolve));
      `,
        ],
        { encoding: 'utf-8', env: { ...inherited, TMPDIR: directory }, timeout: 5000 },
      );
      expect(result.status, result.stderr).toBe(0);
      const trace = readFileSync(path.join(directory, `preproposal-http-${result.pid}.diag.log`), 'utf-8');
      expect(trace).toContain('"event":"child-exit"');
      expect(trace).toContain('"signal":"SIGTERM"');
      expect(trace).toContain('"code":null');
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }),
);

const executable = (directory: string, name: string, content: string) => {
  const file = path.join(directory, name);
  writeFileSync(file, `#!/bin/bash\nset -eu\n${content}\n`);
  chmodSync(file, 0o755);
};

it.effect('prints Chromium phase timings and the actual installed network/cache packages, preserving apt failure', () =>
  Effect.gen(function* chromiumDiagnostics() {
    const inherited = yield* childEnvironment;
    const directory = mkdtempSync(path.join(tmpdir(), 'chromium-diagnostics-'));
    const home = path.join(directory, 'home');
    const cache = path.join(home, '.cache/playwright-apt-debs');
    mkdirSync(cache, { recursive: true });
    writeFileSync(path.join(cache, 'libcache_1.0_amd64.deb'), 'fixture');
    executable(directory, 'sudo', 'exit 0');
    executable(directory, 'find', `if [[ "$1" == /var/cache/apt/archives ]]; then exit 0; fi; exec /usr/bin/find "$@"`);
    executable(directory, 'dpkg-deb', `printf 'libcache:amd64\\t1.0\\n'`);
    executable(
      directory,
      'dpkg-query',
      `printf 'existing:amd64\\t1.0\\n'
      if [[ -e "$RUNNER_TEMP/installed" ]]; then printf 'libcache:amd64\\t1.0\\nlibnetwork:amd64\\t2.0\\n'; fi`,
    );
    executable(
      directory,
      'mise',
      `echo "$*" >> "$RUNNER_TEMP/commands"
      if [[ "$*" == *install-deps* ]]; then
        echo 'Get:1 https://archive.ubuntu.com/ubuntu noble/main amd64 libnetwork amd64 2.0 [12 kB]'
        touch "$RUNNER_TEMP/installed"
        exit "\${APT_STATUS:-0}"
      fi`,
    );
    try {
      const env = {
        ...inherited,
        CHROMIUM_CACHED: 'false',
        HOME: home,
        PATH: `${directory}:/usr/bin:/bin`,
        RUNNER_TEMP: directory,
      };
      const result = spawnSync('/bin/bash', ['scripts/ci/install-chromium-with-diagnostics.sh'], {
        cwd: app,
        encoding: 'utf-8',
        env,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('apt installed: libcache:amd64 version=1.0 source=cache');
      expect(result.stdout).toContain('apt installed: libnetwork:amd64 version=2.0 source=network');
      expect(result.stdout).toContain('Chromium phase start: apt-runtime-dependencies');
      expect(result.stdout).toContain('Chromium phase end: chromium-browser elapsed=');
      const commands = readFileSync(path.join(directory, 'commands'), 'utf-8');
      expect(commands).toContain('playwright install-deps chromium');
      expect(commands).toContain('playwright install chromium');
      const failure = spawnSync('/bin/bash', ['scripts/ci/install-chromium-with-diagnostics.sh'], {
        cwd: app,
        encoding: 'utf-8',
        env: { ...env, APT_STATUS: '23' },
      });
      expect(failure.status, failure.stderr).toBe(23);
      expect(failure.stdout).toContain('Chromium phase end: apt-runtime-dependencies');
      expect(failure.stdout).toContain('status=23');
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }),
);

it.effect('captures live Shell diagnostics before killing even a TERM-resistant task group', () =>
  Effect.gen(function* shellHangDiagnostics() {
    const inherited = yield* childEnvironment;
    const directory = mkdtempSync(path.join(tmpdir(), 'shell-hang-diagnostics-'));
    // macOS lacks setsid(1); exercise the same POSIX session ownership without starting Docker or a database.
    if (process.platform === 'darwin') {
      const python = execFileSync('/usr/bin/which', ['python3'], { encoding: 'utf-8' }).trim();
      executable(
        directory,
        'setsid',
        `exec ${JSON.stringify(python)} -S -c 'import os,sys; os.setsid(); os.execvp(sys.argv[1],sys.argv[1:])' "$@"`,
      );
    }
    executable(directory, 'ps', 'echo "PID PPID PGID STAT ELAPSED COMMAND"');
    executable(
      directory,
      'docker',
      `kill -0 "$(cat "$RUNNER_TEMP/task.pid")"
      echo 'database snapshot while task alive'
      cat`,
    );
    try {
      const task = `require('fs').writeFileSync(process.env.RUNNER_TEMP+'/task.pid',String(process.pid));
        process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`;
      const timeout = execFileSync('/usr/bin/which', ['timeout'], { encoding: 'utf-8', env: inherited }).trim();
      const result = spawnSync(
        timeout,
        [
          '--foreground',
          '--kill-after=20s',
          '1s',
          '/bin/bash',
          'scripts/ci/run-integration-suites.sh',
          '--shell-shard',
          './apps/shell-super-app#1/6',
          process.execPath,
          '-e',
          task,
        ],
        {
          cwd: app,
          encoding: 'utf-8',
          env: {
            ...inherited,
            ONTOS_CI_ISOLATED_WORKERS: '2',
            ONTOS_CI_WORKER_SLOT: '1',
            PATH: `${directory}:${inherited.PATH}`,
            POSTGRES_DB: 'ontos_ci',
            POSTGRES_USER: 'fixture',
            RUNNER_TEMP: directory,
          },
          timeout: 8000,
        },
      );
      expect(result.status, result.stderr).toBe(124);
      const trace = readFileSync(
        path.join(directory, readdirSync(directory).find((name) => name.endsWith('.diag.log')) ?? ''),
        'utf-8',
      );
      expect(trace).toContain('database snapshot while task alive');
      expect(trace).toContain('pg_stat_activity');
      expect(trace).toContain('pg_locks');
      const pid = Number(readFileSync(path.join(directory, 'task.pid'), 'utf-8'));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }),
);

it.effect('finalizer labels preserve the parent scope lifetime and reverse release order', () =>
  Effect.gen(function* finalizerDiagnostics() {
    const released: string[] = [];
    yield* Effect.scoped(
      Effect.gen(function* releaseResources() {
        for (const label of ['pool', 'engine', 'handler']) {
          yield* diagnosticScope(
            label,
            Effect.acquireRelease(Effect.succeed(label), (resource) =>
              Effect.sync(() => {
                released.push(resource);
              }),
            ),
          );
        }
        expect(released).toEqual([]);
      }),
    );
    expect(released).toEqual(['handler', 'engine', 'pool']);
  }),
);
