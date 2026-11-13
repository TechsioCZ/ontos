import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { NodeSocketServer } from '@effect/platform-node';
import { Deferred, Effect, Match, Stream } from 'effect';
import { NetAddress } from 'effect/net';
import { Socket } from 'effect/socket';
import { expect, it } from 'effect-rstest';

import { accessReleaseActivationArguments } from '../access-release-activation-child.mts';

/*
 * The two release steps that project tenants through the access writer are stopped with SIGTERM (the migrator's or
 * the app host's budget, a container stop). Each must take the signal as an interrupt — its finalizers run, so a
 * projection that holds a tenant's access fence finishes and gives it back — and say so, instead of dying at once.
 * Each step is started against a local server that accepts its connection and never answers, and is stopped the
 * moment it connects.
 */
const appDirectory = fileURLToPath(new URL('../../', import.meta.url));
const PEM = '-----BEGIN CERTIFICATE-----\nMIIBsilent\n-----END CERTIFICATE-----';

/** A server that accepts and never answers; `connected` completes on the first connection. */
const silentServer = Effect.gen(function* silentServerEffect() {
  const connected = yield* Deferred.make<boolean>();
  const server = yield* NodeSocketServer.make({ host: '127.0.0.1', port: 0 });
  // Each handler drains its socket, so the listener owns every accepted connection and can close.
  yield* server
    .run((socket) => Deferred.succeed(connected, true).pipe(Effect.andThen(Stream.runDrain(Socket.toStream(socket)))))
    .pipe(Effect.forkScoped);
  const { port } = yield* Match.value(server.address).pipe(
    Match.when(NetAddress.isInetAddress, (inetAddress) => Effect.succeed(inetAddress)),
    Match.orElse(() => Effect.die('The silent listener did not bind to TCP')),
  );
  return { connected, port };
});

/** Starts a step, sends SIGTERM once it has connected, and answers its exit code and output. */
const stopOnConnect = (
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  connected: Deferred.Deferred<boolean>,
) =>
  Effect.gen(function* stopStepOnConnect() {
    const child = spawn(process.execPath, [...args], {
      cwd: appDirectory,
      env: { ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: string[] = [];
    const collect = (chunk: Buffer) => {
      chunks.push(chunk.toString('utf-8'));
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const exited = Effect.callback<number | null>((resume) => {
      child.once('exit', (code) => resume(Effect.succeed(code)));
    });
    yield* Deferred.await(connected);
    child.kill('SIGTERM');
    const code = yield* exited;
    return { code, output: chunks.join('') };
  });

it.live('the access release activation takes SIGTERM as an interrupt and reports the stop', () =>
  Effect.scoped(
    Effect.gen(function* activationStops() {
      const { connected, port } = yield* silentServer;
      const { code, output } = yield* stopOnConnect(
        [...accessReleaseActivationArguments(appDirectory), '--dry-run'],
        { DATABASE_URL: `postgresql://ontos_runtime:silent@127.0.0.1:${String(port)}/ontos` },
        connected,
      );
      expect(output).toContain(
        '[access-release] ACCESS CATALOG RELEASE ACTIVATION FAILED: stopped by a signal; a projection already under way was finished first',
      );
      expect(code).not.toBe(0);
    }),
  ),
);

it.live('the release module step takes SIGTERM as an interrupt and reports the stop', () =>
  Effect.scoped(
    Effect.gen(function* releaseStepStops() {
      const { connected, port } = yield* silentServer;
      const silent = `127.0.0.1:${String(port)}`;
      const { code, output } = yield* stopOnConnect(
        ['scripts/demo/release-tenant-modules.mts'],
        {
          DATABASE_URL: `postgresql://ontos_runtime:silent@${silent}/ontos`,
          ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: `http://${silent}/_host/composition`,
          SPICEDB_CA_CERT: PEM,
          SPICEDB_ENDPOINT: silent,
          SPICEDB_PRESHARED_KEY: 'silent',
          ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
        },
        connected,
      );
      expect(output).toContain(
        '[release-modules] RELEASE MODULE INSTALLATION FAILED: stopped by a signal; a projection already under way was finished first',
      );
      expect(code).not.toBe(0);
    }),
  ),
);

it('the migrator stops a child gracefully and takes SIGTERM as an interrupt itself', () => {
  const migrator = readFileSync(new URL('../run-zerops-migrator.mjs', import.meta.url), 'utf-8');
  const stop = migrator.slice(migrator.indexOf('const stopChild = '), migrator.indexOf('const run = '));
  // SIGTERM first, wait for the exit, and SIGKILL only after the grace: a projection under way runs to its end.
  expect(stop).toContain("child.kill('SIGTERM')");
  expect(stop).toContain("child.once('exit', onExit)");
  expect(stop).toContain("child.kill('SIGKILL')");
  expect(migrator).toContain('NodeRuntime.runMain(main');
  expect(migrator).not.toContain('Effect.runPromiseExit(main)');
});

it.live('the release module step does nothing outside stage and never reaches the database there', () =>
  Effect.scoped(
    Effect.gen(function* otherEnvironments() {
      for (const environment of ['production', 'development']) {
        const { connected, port } = yield* silentServer;
        const silent = `127.0.0.1:${String(port)}`;
        const child = spawn(process.execPath, ['scripts/demo/release-tenant-modules.mts'], {
          cwd: appDirectory,
          env: {
            DATABASE_URL: `postgresql://ontos_runtime:silent@${silent}/ontos`,
            ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: `http://${silent}/_host/composition`,
            SPICEDB_CA_CERT: PEM,
            SPICEDB_ENDPOINT: silent,
            SPICEDB_PRESHARED_KEY: 'silent',
            ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: environment,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const chunks: string[] = [];
        const collect = (chunk: Buffer) => {
          chunks.push(chunk.toString('utf-8'));
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        const code = yield* Effect.callback<number | null>((resume) => {
          child.once('exit', (exitCode) => resume(Effect.succeed(exitCode)));
        });
        expect({ code, output: chunks.join('') }).toEqual({
          code: 0,
          output: `[release-modules] ${environment} declares no Tenant modules; nothing to do\n`,
        });
        expect(yield* Deferred.isDone(connected)).toBe(false);
      }
    }),
  ),
);
