#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';

import type { PlatformError } from 'effect/PlatformError';

import { NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node';
import {
  Config,
  ConfigProvider,
  Console,
  DateTime,
  Option,
  Result,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Match,
  Ref,
  Schedule,
  Schema,
  Stream,
} from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/unstable/http';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

export class DemoLifecycleError extends Schema.TaggedError<DemoLifecycleError>()('DemoLifecycleError', {
  reason: Schema.String,
}) {}
const fail = (reason: string) => new DemoLifecycleError({ reason });
const Environment = Schema.Record(Schema.String, Schema.String);
type ChildEnvironment = typeof Environment.Type;
const workspaceRoot = path.resolve(import.meta.dirname, '../..');
const failureFileName = 'failure.txt';
const defaults =
  'party-registry siampark-work siampark-billing-finance commerce-customer-context workforce tagging sales-pipeline merchandise sales-insights siampark-property siampark-occupancy siampark-agreements';
const port = Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ maximum: 65_535, minimum: 1 }));
const Toggle = Schema.Literals(['0', '1']);
const configuration = Config.all({
  compositionPort: Config.schema(port, 'DEMO_COMPOSITION_PORT').pipe(Config.withDefault(3041)),
  dockerContext: Config.String('DEMO_DOCKER_CONTEXT').pipe(Config.withDefault('')),
  instance: Config.schema(Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,39}$/u)), 'DEMO_INSTANCE').pipe(
    Config.withDefault('default'),
  ),
  rebuild: Config.schema(Toggle, 'DEMO_REBUILD').pipe(Config.withDefault('0')),
  reset: Config.schema(Toggle, 'DEMO_RESET').pipe(Config.withDefault('1')),
  strictVerify: Config.schema(Toggle, 'DEMO_STRICT_VERIFY').pipe(Config.withDefault('0')),
  verticals: Config.String('DEMO_VERTICALS').pipe(Config.withDefault(defaults)),
});
export type DemoConfiguration = Effect.Success<typeof configuration>;
export const parseDemoConfiguration = (provider: ConfigProvider.ConfigProvider) =>
  configuration
    .parse(provider)
    .pipe(Effect.mapError(() => fail('Invalid demo options: check instance, ports and module selection.')));
export const dockerArguments = (context: string, args: readonly string[]) =>
  context ? ['--context', context, ...args] : [...args];
export const demoIdentity = (instance: string) => ({
  project: instance === 'default' ? 'ontos-demo' : `ontos-demo-${instance}`,
  volume:
    instance === 'default' ? 'ontos_demo_postgres_data' : `ontos_demo_${instance.replaceAll('-', '_')}_postgres_data`,
});
const Topology = Schema.fromJsonString(
  Schema.Struct({
    verticals: Schema.Array(
      Schema.Struct({ id: Schema.String, moduleFederation: Schema.Struct({ manifestUrl: Schema.URLFromString }) }),
    ),
  }),
);
const Package = Schema.fromJsonString(Schema.Struct({ scripts: Schema.Struct({ build: Schema.String }) }));
const State = Schema.Struct({
  port: Schema.Int.check(Schema.isBetween({ maximum: 65_535, minimum: 1 })),
  token: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
export const DemoStatus = Schema.Struct({
  state: Schema.Literals(['starting', 'ready', 'failed']),
  step: Schema.String,
});
const stateJson = Schema.fromJsonString(State);
const statusJson = Schema.fromJsonString(DemoStatus);
const appDirectory = (id: string) => (id === 'shell-super-app' ? 'apps/shell-super-app' : `verticals/${id}`);
export const nativeBuildSteps = (script: string) => {
  const suffix = ' && modern deploy --skip-build --deploy-target node';
  if (!script.endsWith(suffix)) {
    return Effect.fail(fail('Unexpected native build script; refusing deployment.'));
  }
  const steps = script
    .slice(0, -suffix.length)
    .split(' && ')
    .map((step) => step.split(/\s+/u));
  if (steps.some((step) => step.some((arg) => !/^[a-zA-Z0-9_./:@=-]+$/u.test(arg)))) {
    return Effect.fail(fail('Native build requires an unsupported shell expression.'));
  }
  return Effect.succeed(steps);
};
const stateDirectory = (config: DemoConfiguration) => path.join(workspaceRoot, '.scratch', `demo-${config.instance}`);
const stateFile = (config: DemoConfiguration) => path.join(stateDirectory(config), 'supervisor.json');
const composeArguments = (config: DemoConfiguration, action: readonly string[]) =>
  dockerArguments(config.dockerContext, [
    'compose',
    '-p',
    demoIdentity(config.instance).project,
    '-f',
    'docker-compose.yml',
    '-f',
    'scripts/demo/compose.demo.yml',
    ...action,
  ]);
const composeEnvironment = (config: DemoConfiguration) => ({
  DEMO_PROJECT: demoIdentity(config.instance).project,
  DEMO_VOLUME: demoIdentity(config.instance).volume,
});
export const processCommand = (
  command: string,
  args: readonly string[],
  env: ChildEnvironment = {},
  cwd = workspaceRoot,
) =>
  ChildProcess.make(command, args, {
    cwd,
    env: { ...env, MISE_ARGV0: '' },
    extendEnv: true,
    forceKillAfter: '5 seconds',
    stdin: 'ignore',
  });
const pnpmCommand = (args: readonly string[], env: ChildEnvironment = {}) =>
  processCommand('mise', ['exec', '--', 'pnpm', ...args], env);
const control = (state: typeof State.Type, stop: boolean) =>
  Effect.gen(function* requestOwnedSupervisor() {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.make(stop ? 'POST' : 'GET')(`http://127.0.0.1:${state.port}/${stop ? 'stop' : 'status'}`).pipe(
        HttpClientRequest.setHeader('authorization', `Bearer ${state.token}`),
      ),
    );
    if (response.status !== 200) {
      return yield* fail('Supervisor ownership could not be verified; no process was stopped.');
    }
    return yield* Schema.decodeUnknownEffect(statusJson)(yield* response.text);
  }).pipe(Effect.timeout('2 seconds'));

const stopSupervisor = (config: DemoConfiguration) =>
  Effect.gen(function* stopOwnedDemo() {
    const fs = yield* FileSystem.FileSystem;
    const file = stateFile(config);
    if (!(yield* fs.exists(file))) {
      return yield* Effect.void;
    }
    const state = yield* Schema.decodeUnknownEffect(stateJson)(yield* fs.readFileString(file));
    const reachable = yield* control(state, false).pipe(Effect.result);
    if (Result.isFailure(reachable)) {
      // A stale descriptor is never authority to kill a PID or an arbitrary process.
      return yield* fail(
        'Saved supervisor is unreachable. Check its log and remove only the stale supervisor.json; no PID was killed.',
      );
    }
    yield* control(state, true);
    yield* Effect.gen(function* awaitScopeCleanup() {
      if (yield* fs.exists(file)) {
        return yield* fail('Supervisor cleanup is still running.');
      }
      return yield* Effect.void;
    }).pipe(Effect.retry(Schedule.spaced('200 millis')), Effect.timeout('30 seconds'));
    return yield* Effect.void;
  });

const changedSince = (
  entries: readonly string[],
  timestamp: Option.Option<Date>,
): Effect.Effect<boolean, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* detectSourceChanges() {
    if (Option.isNone(timestamp)) {
      return true;
    }
    const fs = yield* FileSystem.FileSystem;
    const ignored = new Set([
      'node_modules',
      'dist',
      '.dev-public',
      'cloudflare-dist',
      '.output',
      '.modern',
      'tsconfig.tsbuildinfo',
    ]);
    for (const entry of entries) {
      const absolute = path.join(workspaceRoot, entry);
      const stat = yield* fs.stat(absolute);
      if (stat.type === 'Directory') {
        const children = (yield* fs.readDirectory(absolute))
          .filter((name) => !ignored.has(name))
          .map((name) => path.join(entry, name));
        if (yield* changedSince(children, timestamp)) {
          return true;
        }
      } else if (Option.isSome(stat.mtime) && stat.mtime.value > timestamp.value) {
        return true;
      }
    }
    return false;
  });
export const parseDemoChildEnvironment = (source: string, overrides: ConfigProvider.ConfigProvider) =>
  Effect.gen(function* decodeChildEnvironment() {
    const provider = ConfigProvider.orElse(
      overrides,
      ConfigProvider.fromDotEnvContents(source, { preserveEmptyStrings: true }),
    );
    const keys = [
      ...new Set([
        'PATH',
        ...[...source.matchAll(/^(?<key>[A-Z][A-Z0-9_]*)=/gmu)].flatMap((match) =>
          match.groups?.key === undefined ? [] : [match.groups.key],
        ),
      ]),
    ];
    const entries = yield* Effect.forEach(
      keys,
      (key) =>
        Config.String(key)
          .pipe(Config.withDefault(''))
          .parse(provider)
          .pipe(Effect.map((value) => [key, value] as const)),
      { concurrency: 1 },
    );
    return Object.fromEntries(entries);
  });
const LocalInfrastructure = Schema.Struct({
  POSTGRES_DB: Schema.Literal('siampark_demo'),
  POSTGRES_PORT: port,
  SPICEDB_ENDPOINT: Schema.String,
  SPICEDB_GRPC_PORT: port,
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: Schema.Literal('development'),
});
const localHostname = (hostname: string) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
export const validateDemoEnvironment = (environment: ChildEnvironment) =>
  Effect.gen(function* checkLocalDatabase() {
    const infrastructure = yield* Schema.decodeUnknownEffect(LocalInfrastructure)(environment).pipe(
      Effect.mapError(() => fail('Local demo infrastructure configuration is missing or invalid.')),
    );
    for (const key of ['DATABASE_URL', 'DATABASE_ADMIN_URL']) {
      const url = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(environment[key]);
      if (
        !localHostname(url.hostname) ||
        url.pathname !== '/siampark_demo' ||
        !['postgresql:', 'postgres:'].includes(url.protocol)
      ) {
        return yield* fail('Only a local siampark_demo database is permitted.');
      }
      if (Number(url.port || '5432') !== infrastructure.POSTGRES_PORT) {
        return yield* fail('Database URLs must use the port published by this demo Compose project.');
      }
    }
    const spice = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(`https://${infrastructure.SPICEDB_ENDPOINT}`);
    if (!localHostname(spice.hostname) || Number(spice.port || '443') !== infrastructure.SPICEDB_GRPC_PORT) {
      return yield* fail('SpiceDB must use the local port published by this demo Compose project.');
    }
    return yield* Effect.void;
  });
const prepareAndServe = (config: DemoConfiguration, status: Ref.Ref<typeof DemoStatus.Type>) =>
  Effect.gen(function* runSalesDemoLifecycle() {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = stateDirectory(config);
    const logs = path.join(directory, 'logs');
    const stamps = path.join(directory, 'build');
    const bin = path.join(directory, 'bin');
    for (const folder of [logs, stamps, bin]) {
      yield* fs.makeDirectory(folder, { recursive: true });
    }
    let environment: ChildEnvironment = composeEnvironment(config);
    const start = Effect.fn('SalesDemo.start')(function* startLogged(name: string, command: ChildProcess.Command) {
      yield* Ref.set<typeof DemoStatus.Type>(status, { state: 'starting', step: name });
      const handle = yield* spawner.spawn(command);
      yield* Stream.run(handle.all, fs.sink(path.join(logs, `${name}.log`))).pipe(Effect.forkScoped);
      return handle;
    });
    const step = Effect.fn('SalesDemo.step')(function* runStep(name: string, command: ChildProcess.Command) {
      const handle = yield* start(name, command);
      const code = yield* handle.exitCode;
      if (code !== 0) {
        return yield* fail(`${name} failed; see its private log in ${logs}.`);
      }
      return yield* Effect.void;
    });
    const pnpm = (args: readonly string[]) => pnpmCommand(args, environment);
    // Fail before writing environment or starting services when a prerequisite is unavailable.
    yield* step('mise-version', processCommand('mise', ['--version']));
    yield* step('pnpm-version', pnpm(['--version']));
    yield* step(
      'docker-ready',
      processCommand('docker', dockerArguments(config.dockerContext, ['info', '--format', '{{.ServerVersion}}'])),
    );
    yield* step(
      'docker-compose',
      processCommand('docker', dockerArguments(config.dockerContext, ['compose', 'version'])),
    );
    const topology = yield* Schema.decodeUnknownEffect(Topology)(
      yield* fs.readFileString(path.join(workspaceRoot, 'topology/reference-topology.json')),
    );
    const verticals = [...new Set(config.verticals.split(/[\s,]+/u).filter(Boolean))];
    const modules = verticals.map((id) => topology.verticals.find((vertical) => vertical.id === id));
    if (modules.some((module) => module === undefined)) {
      return yield* fail('Unknown vertical in DEMO_VERTICALS.');
    }
    const applications = [
      { contract: '/.well-known/ontos-shell-runtime.json', id: 'shell-super-app', port: 3020 },
      ...modules.flatMap((module) =>
        module
          ? [
              {
                contract: '/.well-known/ontos-module-manifest.json',
                id: module.id,
                port: Number(module.moduleFederation.manifestUrl.port),
              },
            ]
          : [],
      ),
    ];
    // Bind and release through the platform layer; port conflicts fail before database resets.
    for (const item of [...applications, { id: 'composition', port: config.compositionPort }]) {
      yield* Effect.scoped(
        Layer.build(NodeHttpServer.layer(createServer, { host: '127.0.0.1', port: item.port })),
      ).pipe(
        Effect.mapError(() => fail(`Port ${item.port} (${item.id}) is occupied; no process on that port was killed.`)),
      );
    }
    const envPath = path.join(workspaceRoot, '.env');
    if (!(yield* fs.exists(envPath))) {
      const template = yield* fs.readFileString(path.join(workspaceRoot, '.env.example'));
      const source = template
        .replace(/^BETTER_AUTH_SECRET=.*$/mu, `BETTER_AUTH_SECRET=${randomBytes(24).toString('hex')}`)
        .replace(/^POSTGRES_DB=.*$/mu, 'POSTGRES_DB=siampark_demo')
        .replaceAll(/@localhost:5433\/ontos$/gmu, '@localhost:5433/siampark_demo')
        .replaceAll(/^COMMERCE_.*\r?\n/gmu, '');
      yield* fs.writeFileString(envPath, `${source}\nULTRAMODERN_DEPLOYMENT_ENVIRONMENT=development\n`, {
        mode: 0o600,
      });
    }
    yield* step('env-local-ensure', pnpm(['env:local:ensure']));
    yield* step('spicedb-tls', pnpm(['spicedb:tls:local']));
    const values = yield* parseDemoChildEnvironment(yield* fs.readFileString(envPath), ConfigProvider.fromEnv());
    environment = {
      ...values,
      ...composeEnvironment(config),
      MISE_ARGV0: '',
      ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: `http://127.0.0.1:${config.compositionPort}/active`,
      ONTOS_DEMO_VERTICALS: verticals.join(','),
    };
    yield* validateDemoEnvironment(environment);
    yield* step('containers', processCommand('docker', composeArguments(config, ['up', '-d', '--wait']), environment));
    for (const name of [
      'db:migrate',
      'local:initialize',
      ...(config.reset === '0' ? [] : ['demo:reset', 'demo:reset:sales']),
    ]) {
      yield* step(name.replaceAll(':', '-'), pnpm([name]));
    }
    const verified = yield* step('db-verify', pnpm(['db:verify'])).pipe(Effect.result);
    if (Result.isFailure(verified) && config.strictVerify === '1') {
      return yield* verified.failure;
    }
    yield* step('authorization-provision', pnpm(['exec', 'node', 'scripts/demo/provision-actions.mts']));
    // Cross-platform stubs preserve the existing non-promotable workspace identity.
    yield* fs.writeFileString(path.join(bin, 'git'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    if (process.platform === 'win32') {
      // execFileSync does not launch .cmd scripts. A renamed Node executable
      // rejects Git arguments and fails closed without invoking any real git.
      yield* fs.copyFile(process.execPath, path.join(bin, 'git.exe'));
    }
    const buildEnvironment = {
      ...environment,
      PATH: `${bin}${path.delimiter}${environment.PATH ?? ''}`,
      ULTRAMODERN_SOURCE_REVISION: 'workspace',
    };
    for (const application of applications) {
      const relative = appDirectory(application.id);
      const stamp = path.join(stamps, `${application.id}.stamp`);
      const contract = path.join(workspaceRoot, relative, 'dist/public', application.contract);
      const needsBuild = config.rebuild === '1' || !(yield* fs.exists(stamp)) || !(yield* fs.exists(contract));
      const newer =
        needsBuild || (yield* changedSince([relative, 'packages', 'pnpm-lock.yaml'], (yield* fs.stat(stamp)).mtime));
      if (!newer) {
        continue;
      }
      const build = yield* Schema.decodeUnknownEffect(Package)(
        yield* fs.readFileString(path.join(workspaceRoot, relative, 'package.json')),
      );
      const steps = yield* nativeBuildSteps(build.scripts.build);
      const started = DateTime.toDateUtc(yield* DateTime.now);
      for (const [index, args] of steps.entries()) {
        yield* step(
          `build-${application.id}-${index}`,
          pnpmCommand(['--dir', relative, 'exec', ...args], buildEnvironment),
        );
      }
      yield* fs.writeFileString(stamp, started.toISOString());
      yield* fs.utimes(stamp, started, started);
    }
    const handles = [];
    for (const application of applications) {
      handles.push(
        yield* start(application.id, pnpm(['--dir', appDirectory(application.id), 'exec', 'modern', 'serve'])),
      );
    }
    const client = yield* HttpClient.HttpClient;
    const ready = (url: string) =>
      Effect.gen(function* probeReadiness() {
        const response = yield* client.get(url).pipe(Effect.timeout('3 seconds'));
        if (response.status < 200 || response.status >= 300) {
          return yield* fail('Waiting for local readiness.');
        }
        return yield* Effect.void;
      }).pipe(Effect.retry(Schedule.spaced('2 seconds')), Effect.timeout('180 seconds'));
    for (const application of applications) {
      yield* ready(`http://127.0.0.1:${application.port}${application.contract}`);
    }
    handles.push(
      yield* start(
        'composition',
        pnpmCommand(
          [
            'exec',
            'node',
            'scripts/siampark/development-composition.mts',
            '--environment',
            'development',
            '--port',
            String(config.compositionPort),
          ],
          buildEnvironment,
        ),
      ),
    );
    yield* ready(`http://127.0.0.1:${config.compositionPort}/active`);
    handles.push(
      yield* start(
        'outbox-worker-host',
        pnpm(['exec', 'node', '--experimental-strip-types', 'scripts/outbox-worker-host.generated.mts']),
      ),
    );
    yield* step('demo-permissions', pnpm(['exec', 'node', 'scripts/demo/reset-permissions.mts']));
    yield* Ref.set<typeof DemoStatus.Type>(status, { state: 'ready', step: 'http://localhost:3020/cs' });
    return handles;
  });
const waitForServerExit = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  handle.exitCode.pipe(Effect.flatMap(() => fail('A demo server exited; owned processes were stopped.')));
const keepDemoAlive = (config: DemoConfiguration, status: Ref.Ref<typeof DemoStatus.Type>) =>
  Effect.scoped(
    Effect.gen(function* keepOwnedServersAlive() {
      const handles = yield* prepareAndServe(config, status).pipe(Effect.timeout('30 minutes'));
      return yield* Effect.raceAll(handles.map(waitForServerExit));
    }),
  );
export const demoControlApplication = (
  status: Ref.Ref<typeof DemoStatus.Type>,
  stopped: Deferred.Deferred<boolean>,
  token: string,
) =>
  Effect.gen(function* controlOwnedProcesses() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.headers.authorization !== `Bearer ${token}`) {
      return HttpServerResponse.empty({ status: 403 });
    }
    if (request.method === 'POST' && request.url === '/stop') {
      yield* Deferred.succeed(stopped, true);
    } else if (request.method !== 'GET' || request.url !== '/status') {
      return HttpServerResponse.empty({ status: 404 });
    }
    return HttpServerResponse.text(yield* Schema.encodeEffect(statusJson)(yield* Ref.get(status)), {
      contentType: 'application/json',
    });
  });
const supervise = (config: DemoConfiguration) =>
  Effect.scoped(
    Effect.gen(function* ownDemoResources() {
      const fs = yield* FileSystem.FileSystem;
      const stopped = yield* Deferred.make<boolean>();
      const status = yield* Ref.make<typeof DemoStatus.Type>({ state: 'starting', step: 'prerequisites' });
      const token = randomBytes(32).toString('hex');
      const server = yield* HttpServer.HttpServer;
      const controlPort = yield* Match.value(server.address).pipe(
        Match.tag('UnixPathAddress', () => Effect.fail(fail('Supervisor requires a loopback TCP listener.'))),
        Match.orElse((address) => Effect.succeed(address.port)),
      );
      const descriptor = { port: controlPort, token };
      yield* HttpServer.serveEffect(demoControlApplication(status, stopped, token));
      yield* fs.writeFileString(stateFile(config), yield* Schema.encodeEffect(stateJson)(descriptor), {
        flag: 'wx',
        mode: 0o600,
      });
      yield* Effect.addFinalizer(() => fs.remove(stateFile(config)).pipe(Effect.orDie));
      const running = keepDemoAlive(config, status).pipe(
        Effect.tapError((failure) =>
          fs.writeFileString(
            path.join(stateDirectory(config), failureFileName),
            Schema.is(DemoLifecycleError)(failure)
              ? failure.reason
              : `Demo prerequisite or operation failed (${failure._tag}). See private logs.`,
            { mode: 0o600 },
          ),
        ),
      );
      yield* Effect.raceFirst(running, Deferred.await(stopped));
      return yield* Effect.void;
    }),
  );

const launch = (config: DemoConfiguration) =>
  Effect.gen(function* launchSupervisor() {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* fs.makeDirectory(stateDirectory(config), { mode: 0o700, recursive: true });
    yield* stopSupervisor(config);
    yield* fs.remove(path.join(stateDirectory(config), failureFileName), { force: true });
    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [path.join(workspaceRoot, 'scripts/demo/lifecycle.mts'), '--supervise'], {
        cwd: workspaceRoot,
        detached: true,
        extendEnv: true,
        forceKillAfter: '5 seconds',
        stderr: 'ignore',
        stdin: 'ignore',
        stdout: 'ignore',
      }),
    );
    const wait = Effect.gen(function* observeStartup() {
      if (!(yield* child.isRunning)) {
        const file = path.join(stateDirectory(config), failureFileName);
        return yield* fail(
          (yield* fs.exists(file))
            ? yield* fs.readFileString(file)
            : 'Demo startup stopped. Inspect private per-instance logs.',
        );
      }
      if (!(yield* fs.exists(stateFile(config)))) {
        return false;
      }
      const state = yield* Schema.decodeUnknownEffect(stateJson)(yield* fs.readFileString(stateFile(config)));
      const status = yield* control(state, false);
      yield* Console.log(`[demo] ${status.step}`);
      return status.state === 'ready';
    });
    yield* wait.pipe(
      Effect.repeat({ schedule: Schedule.spaced('2 seconds'), while: (ready) => !ready }),
      Effect.timeout('30 minutes'),
    );
    yield* child.unref;
    yield* Console.log(
      `[demo] UP: http://localhost:3020/cs. Stop with scripts/demo/down.sh or down.cmd. Logs: ${stateDirectory(config)}/logs`,
    );
  });
const command = Command.make(
  'sales-demo',
  {
    containers: Flag.Boolean('containers').pipe(Flag.withDefault(false)),
    down: Flag.Boolean('down').pipe(Flag.withDefault(false)),
    supervise: Flag.Boolean('supervise').pipe(Flag.withDefault(false)),
  },
  ({ containers, down, supervise: background }) =>
    Effect.gen(function* executeDemoCommand() {
      const config = yield* parseDemoConfiguration(ConfigProvider.fromEnv());
      if (background) {
        return yield* Effect.scoped(
          Layer.build(
            Layer.effectDiscard(supervise(config)).pipe(
              Layer.provide(NodeHttpServer.layer(createServer, { host: '127.0.0.1', port: 0 })),
            ),
          ),
        );
      }
      if (!down) {
        return yield* launch(config);
      }
      yield* stopSupervisor(config);
      if (containers) {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const code = yield* spawner.exitCode(
          ChildProcess.make('docker', composeArguments(config, ['stop']), {
            cwd: workspaceRoot,
            env: composeEnvironment(config),
            extendEnv: true,
            stderr: 'inherit',
            stdout: 'inherit',
          }),
        );
        if (code !== 0) {
          return yield* fail('Stopping demo containers failed.');
        }
      }
      yield* Console.log('[demo] stopped; database volumes were preserved.');
      return yield* Effect.void;
    }).pipe(
      Effect.scoped,
      Effect.tapError((failure) =>
        Console.error(
          Schema.is(DemoLifecycleError)(failure)
            ? failure.reason
            : `Demo operation failed (${failure._tag}); inspect private local logs.`,
        ),
      ),
    ),
);
if (import.meta.main) {
  NodeRuntime.runMain(
    Effect.scoped(
      Layer.build(
        Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
          Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
        ),
      ),
    ),
  );
}
