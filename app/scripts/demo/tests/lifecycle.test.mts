import { NodeHttpServer, NodeServices } from '@effect/platform-node';
import { ConfigProvider, Deferred, Effect, FileSystem, Layer, Ref, Schema, Stream } from 'effect';
import { expect, it } from 'effect-rstest';
import { HttpClient, HttpClientRequest, HttpServer } from 'effect/unstable/http';
import { ChildProcessSpawner } from 'effect/unstable/process';

import type { DemoStatus } from '../lifecycle.mts';
import {
  DemoLifecycleError,
  demoControlApplication,
  demoIdentity,
  dockerArguments,
  nativeBuildSteps,
  parseDemoConfiguration,
  parseDemoChildEnvironment,
  processCommand,
  validateDemoEnvironment,
} from '../lifecycle.mts';

it.effect('keeps the current Docker context and separates every explicit demo instance', () =>
  Effect.gen(function* isolatesInfrastructure() {
    const config = yield* parseDemoConfiguration(ConfigProvider.fromUnknown({}));
    expect(dockerArguments(config.dockerContext, ['compose', 'stop'])).toEqual(['compose', 'stop']);
    expect(dockerArguments('desktop-linux', ['info'])).toEqual(['--context', 'desktop-linux', 'info']);
    expect(demoIdentity(config.instance)).toEqual({ project: 'ontos-demo', volume: 'ontos_demo_postgres_data' });
    expect(demoIdentity('proof-one')).toEqual({
      project: 'ontos-demo-proof-one',
      volume: 'ontos_demo_proof_one_postgres_data',
    });
    expect(demoIdentity('proof-two')).not.toEqual(demoIdentity('proof-one'));
    for (const instance of ['../other', 'UPPERCASE', 'x; command']) {
      expect(
        Schema.is(DemoLifecycleError)(
          yield* parseDemoConfiguration(ConfigProvider.fromUnknown({ DEMO_INSTANCE: instance })).pipe(Effect.flip),
        ),
      ).toBe(true);
    }
  }),
);
it.effect('validates reset flags, module selection and ports before execution', () =>
  Effect.gen(function* validatesOptions() {
    const config = yield* parseDemoConfiguration(
      ConfigProvider.fromUnknown({
        DEMO_COMPOSITION_PORT: '3042',
        DEMO_RESET: '0',
        DEMO_VERTICALS: 'merchandise,party-registry',
      }),
    );
    expect(config.reset).toBe('0');
    expect(config.compositionPort).toBe(3042);
    expect(config.verticals).toBe('merchandise,party-registry');
    for (const options of [
      { DEMO_RESET: 'false' },
      { DEMO_REBUILD: 'yes' },
      { DEMO_COMPOSITION_PORT: '0' },
      { DEMO_COMPOSITION_PORT: '65536' },
    ]) {
      expect(
        Schema.is(DemoLifecycleError)(
          yield* parseDemoConfiguration(ConfigProvider.fromUnknown(options)).pipe(Effect.flip),
        ),
      ).toBe(true);
    }
  }),
);
it.effect('loads dotenv values without splitting underscore names and keeps inherited overrides', () =>
  Effect.gen(function* preservesEnvironmentContract() {
    const values = yield* parseDemoChildEnvironment(
      'DATABASE_URL=postgresql://local/siampark_demo\nONTOS_GATEWAY_PUBLIC_JWKS={"keys":[]}\nSPICEDB_CA_CERT="line1\\nline2"\nEMPTY_VALUE=\n',
      ConfigProvider.fromUnknown({ DATABASE_URL: 'overridden', PATH: 'native-path' }),
    );
    expect(values.DATABASE_URL).toBe('overridden');
    expect(values.ONTOS_GATEWAY_PUBLIC_JWKS).toBe('{"keys":[]}');
    expect(values.SPICEDB_CA_CERT).toBe('line1\nline2');
    expect(values.EMPTY_VALUE).toBe('');
    expect(values.PATH).toBe('native-path');
  }),
);
it.effect('executes trusted native build stages as argument arrays and never deploys', () =>
  Effect.gen(function* avoidsPlatformShellsAndDeployment() {
    expect(
      yield* nativeBuildSteps(
        'modern build --deploy-target node && node ../../scripts/generate.mts --target dist && modern deploy --skip-build --deploy-target node',
      ),
    ).toEqual([
      ['modern', 'build', '--deploy-target', 'node'],
      ['node', '../../scripts/generate.mts', '--target', 'dist'],
    ]);
    for (const script of [
      'modern deploy',
      'modern build; curl invalid && modern deploy --skip-build --deploy-target node',
      'modern build $(command) && modern deploy --skip-build --deploy-target node',
    ]) {
      expect(Schema.is(DemoLifecycleError)(yield* nativeBuildSteps(script).pipe(Effect.flip))).toBe(true);
    }
    const command = processCommand('mise', [
      'exec',
      '--',
      'pnpm',
      '--dir',
      'directory with spaces',
      'exec',
      'modern',
      'serve',
    ]);
    expect(command.args).toContain('directory with spaces');
    expect(command.options.shell).toBeUndefined();
    expect(command.options.forceKillAfter).toBe('5 seconds');
  }),
);
it.effect('rejects remote and primary databases without exposing connection values', () =>
  Effect.gen(function* guardsDatabaseOwnership() {
    const environment = {
      DATABASE_ADMIN_URL: 'postgresql://admin:private@localhost:5433/siampark_demo',
      DATABASE_URL: 'postgresql://runtime:private@127.0.0.1:5433/siampark_demo',
      POSTGRES_DB: 'siampark_demo',
      POSTGRES_PORT: '5433',
      SPICEDB_ENDPOINT: 'localhost:50051',
      SPICEDB_GRPC_PORT: '50051',
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'development',
    };
    yield* validateDemoEnvironment(environment);
    const spiceFailure = yield* validateDemoEnvironment({ ...environment, SPICEDB_ENDPOINT: 'localhost:50052' }).pipe(
      Effect.flip,
    );
    expect(Schema.is(DemoLifecycleError)(spiceFailure)).toBe(true);
    for (const DATABASE_URL of [
      'postgresql://runtime:private@localhost:5433/ontos',
      'postgresql://runtime:private@db.example:5433/siampark_demo',
      'postgresql://runtime:private@localhost:5434/siampark_demo',
    ]) {
      const failure = yield* validateDemoEnvironment({ ...environment, DATABASE_URL }).pipe(Effect.flip);
      expect(Schema.is(DemoLifecycleError)(failure)).toBe(true);
      expect(String(failure)).not.toContain('private');
    }
  }),
);

const controlProof = Effect.gen(function* provesTokenOwnedStop() {
  const status = yield* Ref.make<typeof DemoStatus.Type>({ state: 'ready', step: 'fixture' });
  const stopped = yield* Deferred.make<boolean>();
  yield* HttpServer.serveEffect(demoControlApplication(status, stopped, 'owned-test-token'));
  const client = yield* HttpClient.HttpClient;
  const endpoint = '';
  const foreign = yield* client.execute(
    HttpClientRequest.post(`${endpoint}/stop`).pipe(
      HttpClientRequest.setHeader('authorization', 'Bearer foreign-token'),
    ),
  );
  expect(foreign.status).toBe(403);
  expect(yield* Deferred.isDone(stopped)).toBe(false);
  const owned = yield* client.execute(
    HttpClientRequest.get(`${endpoint}/status`).pipe(
      HttpClientRequest.setHeader('authorization', 'Bearer owned-test-token'),
    ),
  );
  expect(owned.status).toBe(200);
  expect(yield* owned.text).toContain('fixture');
  const stop = yield* client.execute(
    HttpClientRequest.post(`${endpoint}/stop`).pipe(
      HttpClientRequest.setHeader('authorization', 'Bearer owned-test-token'),
    ),
  );
  expect(stop.status).toBe(200);
  expect(yield* Deferred.isDone(stopped)).toBe(true);
});
it.live('authenticates the live loopback control endpoint before allowing stop', () =>
  Effect.scoped(
    Layer.build(
      Layer.effectDiscard(controlProof).pipe(
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeHttpServer.layerTest)),
      ),
    ),
  ),
);

it.live('releases owned native child trees when their scope closes', () =>
  Effect.gen(function* provesScopedNativeCleanup() {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped();
    const marker = `${directory}/descendant-still-running`;
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'orphan'), 1500); setInterval(() => {}, 1000);`;
    const leader = `const {spawn} = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: 'ignore'}); process.stdout.write('ready'); setInterval(() => {}, 1000);`;
    const owned = yield* Effect.scoped(
      Effect.gen(function* failedPreparation() {
        const child = yield* spawner.spawn(processCommand(process.execPath, ['-e', leader]));
        yield* Stream.runCollect(child.stdout).pipe(Effect.timeoutOption('200 millis'));
        return child;
      }),
    );
    expect(yield* owned.isRunning).toBe(false);
    yield* Effect.sleep('1700 millis');
    expect(yield* fs.exists(marker)).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);
