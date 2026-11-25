import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Option, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { buildSync } from 'esbuild';

import { RuntimeTelemetrySchema } from '../../packages/storefront-runtime/src/telemetry.ts';

const revision = 'a'.repeat(40);
const akrosFamily = 'akros-storefront';
const families = [akrosFamily, 'n1-storefront'] as const;
const registered = 'instrumentation.registered';
const observerStopped = 'Storefront observability stopped';
const ShutdownSignalSchema = Schema.Literals(['SIGTERM', 'SIGINT']);
const ShutdownOwnerSchema = Schema.Literals(['none', 'before', 'after']);
const Registration = Schema.Struct({ event: Schema.Literal(registered), observers: Schema.Number });
const ConnectionDefaults = Schema.Struct({
  event: Schema.Literal('storefront.connection.defaults'),
  targetConfigured: Schema.Boolean,
});
const HookEventJson = Schema.fromJsonString(Schema.Union([RuntimeTelemetrySchema, Registration, ConnectionDefaults]));

// Execute the real Next hook and sampler in a separate native Node process, not a mocked Effect.
const runHook = (family: (typeof families)[number], runtime: 'nodejs' | 'edge', sourceRevision = revision) =>
  Effect.gen(function* runNativeHook() {
    const hook = new URL(`../../${family}/src/instrumentation.ts`, import.meta.url).href;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `
            const { hasSubscribers } = await import('node:diagnostics_channel');
            const connectionChannel = 'undici:client:beforeConnect';
            const baseline = hasSubscribers(connectionChannel);
            const { register } = await import(${JSON.stringify(hook)});
            await Promise.all([register(), register(), register()]);
            if (${family === akrosFamily && runtime === 'nodejs' && sourceRevision === revision}) {
              if (!hasSubscribers(connectionChannel)) throw Error('Missing Shell observer');
              process.once('exit', () => { if (hasSubscribers(connectionChannel) !== baseline) process.exitCode = 1; });
            }
            process.stdout.write(JSON.stringify({
              event: '${registered}',
              observers: process.listenerCount('ontos:storefront-observer')
            }) + '\\n');
          `,
        ],
        {
          env: {
            NEXT_RUNTIME: runtime,
            ONTOS_SHELL_URL: 'https://fixture.invalid:3000',
            ONTOS_SOURCE_REVISION: sourceRevision,
            ONTOS_STOREFRONT_APP_ID: family,
          },
          extendEnv: true,
          forceKillAfter: Duration.seconds(1),
          stdin: 'ignore',
        },
      ),
    );
    const captured = yield* Stream.merge(child.stdout, child.stderr).pipe(
      Stream.decodeText(),
      Stream.scan(
        () => '',
        (output, chunk) => output + chunk,
      ),
      Stream.takeUntil(
        (output) =>
          output.includes(registered) &&
          (runtime === 'edge' ||
            output.includes('"event":"storefront.runtime.summary"') ||
            output.includes(observerStopped)),
      ),
      Stream.runLast,
      Effect.flatMap(Effect.fromOption),
    );
    // An observer with no server must not pin Node merely to await the next sample.
    expect(yield* child.exitCode).toBe(0);
    return captured;
  }).pipe(Effect.scoped, Effect.timeout(Duration.seconds(5)), TestClock.withLive);

const runShutdownHook = (
  family: (typeof families)[number],
  signal: typeof ShutdownSignalSchema.Type,
  shutdownOwner: typeof ShutdownOwnerSchema.Type,
  samples = 1,
) =>
  Effect.gen(function* runListeningHook() {
    const hook = new URL(`../../${family}/src/instrumentation.ts`, import.meta.url).href;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `
            import { createServer } from 'node:net';
            import { Effect } from 'effect';
            const server = createServer();
            const report = (event) => process.stdout.write(JSON.stringify({
              event,
              listening: server.listening,
              observers: process.listenerCount('ontos:storefront-observer'),
              termListeners: process.listenerCount('SIGTERM'),
              intListeners: process.listenerCount('SIGINT'),
            }) + '\\n');
            process.on('removeListener', (event) => {
              if (event === 'ontos:storefront-observer') report('observer.released');
            });
            const closeServer = () => Effect.runFork(Effect.gen(function* closeServer() {
                report('owner.started');
                yield* Effect.sleep('50 millis');
                yield* Effect.callback((resume) => {
                  server.close(() => resume(Effect.void));
                });
                report('owner.closed');
              }));
            if (${JSON.stringify(shutdownOwner)} === 'before') {
              process.once('${signal}', closeServer);
            }
            const { register } = await import(${JSON.stringify(hook)});
            await register();
            process.stdin.once('data', () => {
              if (${JSON.stringify(shutdownOwner)} === 'after') {
                process.prependOnceListener('${signal}', closeServer);
              }
              report('shutdown.ready');
              process.stdin.destroy();
            });
            server.listen(0, '127.0.0.1', () => report('server.listening'));
          `,
        ],
        {
          env: {
            NEXT_RUNTIME: 'nodejs',
            ONTOS_SOURCE_REVISION: revision,
            ONTOS_STOREFRONT_APP_ID: family,
          },
          extendEnv: true,
          forceKillAfter: Duration.seconds(1),
          stdin: 'pipe',
        },
      ),
    );
    const started = yield* Deferred.make<boolean>();
    const ready = yield* Deferred.make<boolean>();
    const collected = yield* child.all.pipe(
      Stream.decodeText(),
      Stream.scan(
        () => '',
        (output, chunk) => output + chunk,
      ),
      Stream.tap((output) =>
        output.includes('"event":"server.listening"') &&
        (output.match(/"event":"storefront.runtime.summary"/gu)?.length ?? 0) >= samples
          ? Deferred.succeed(started, true)
          : Effect.void,
      ),
      Stream.tap((output) =>
        output.includes('"event":"shutdown.ready"') ? Deferred.succeed(ready, true) : Effect.void,
      ),
      Stream.runLast,
      Effect.forkScoped,
    );
    yield* Deferred.await(started);
    yield* Stream.make(new TextEncoder().encode('ready')).pipe(Stream.run(child.stdin));
    yield* Deferred.await(ready);
    // Send exactly one signal; ChildProcessHandle.kill also waits/escalates and could mask this regression.
    yield* Effect.sync(() => process.kill(child.pid, signal));
    const exit = yield* Effect.exit(child.exitCode);
    const output = yield* Fiber.join(collected).pipe(Effect.flatMap(Effect.fromOption));
    return { exit, output };
  }).pipe(Effect.scoped, Effect.timeout(Duration.seconds(samples === 1 ? 5 : 15)), TestClock.withLive);

it.layer(NodeServices.layer)('native storefront instrumentation', (test) => {
  test.effect('the non-pinning Clock still wakes the sampler while a server is listening', () =>
    Effect.gen(function* recurringNativeObserver() {
      const { exit, output } = yield* runShutdownHook(akrosFamily, 'SIGTERM', 'after', 2);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(output.match(/"event":"storefront.runtime.summary"/gu)).toHaveLength(2);
      expect(output).toContain('"event":"owner.closed","listening":false');
      expect(output).toContain('"event":"observer.released","listening":false,"observers":0');
      expect(output).not.toContain(observerStopped);
      expect(output).not.toContain('ERROR');
    }),
  );

  for (const family of families) {
    for (const signal of ShutdownSignalSchema.literals) {
      for (const shutdownOwner of ShutdownOwnerSchema.literals) {
        test.effect(`${family}: one ${signal} with shutdown owner ${shutdownOwner}`, () =>
          Effect.gen(function* nativeShutdown() {
            const { exit, output } = yield* runShutdownHook(family, signal, shutdownOwner);
            expect(output).not.toContain(observerStopped);
            expect(output).not.toContain('ERROR');
            expect(output.match(/"event":"storefront.runtime.summary"/gu)).toHaveLength(1);
            if (shutdownOwner === 'none') {
              expect(output).toContain(
                '"event":"shutdown.ready","listening":true,"observers":1,"termListeners":0,"intListeners":0',
              );
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                expect(Cause.pretty(exit.cause)).toContain(`Process interrupted due to receipt of signal: '${signal}'`);
              }
            } else {
              expect(output).toContain(
                '"event":"owner.closed","listening":false,"observers":1,"termListeners":0,"intListeners":0',
              );
              expect(output).toContain(
                '"event":"observer.released","listening":false,"observers":0,"termListeners":0,"intListeners":0',
              );
              expect(output.indexOf('"event":"owner.started"')).toBeLessThan(output.indexOf('"event":"owner.closed"'));
              expect(Exit.isSuccess(exit)).toBe(true);
              if (Exit.isSuccess(exit)) {
                expect(exit.value).toBe(0);
              }
            }
          }),
        );
      }
    }

    test.effect(`${family}: registration returns while exactly one real observer samples the source revision`, () =>
      Effect.gen(function* oneNativeObserver() {
        const output = yield* runHook(family, 'nodejs');
        const events = yield* Effect.forEach(output.trim().split('\n'), (line) =>
          Schema.decodeUnknownEffect(HookEventJson)(line),
        );
        const connections = events.filter((event) => event.event === 'storefront.connection.defaults');
        expect(connections).toHaveLength(family === akrosFamily ? 1 : 0);
        if (family === akrosFamily) {
          expect(connections[0]?.targetConfigured).toBe(true);
        }
        const boots = events.filter((event) => event.event === 'storefront.runtime.boot');
        const summaries = events.filter((event) => event.event === 'storefront.runtime.summary');
        expect(boots).toHaveLength(1);
        expect(summaries.length).toBeGreaterThan(0);
        expect(events.find((event) => event.event === registered)?.observers).toBe(1);
        const boot = yield* Effect.fromOption(Option.fromUndefinedOr(boots[0]));
        for (const event of [...boots, ...summaries]) {
          expect(event.revision).toBe(revision);
          expect(event.family).toBe(family);
          expect(event.service).toBe(family);
          expect(event.bootId).toBe(boot.bootId);
          expect(event.pid).toBe(boot.pid);
        }
        const summary = yield* Effect.fromOption(Option.fromUndefinedOr(summaries[0]));
        expect(summary.rssBytes).toBeGreaterThan(0);
        expect(summary.heapLimitBytes).toBeGreaterThan(0);
        expect(summary.windowMs).toBeGreaterThan(0);
        expect(summary.cgroup).toBeDefined();
      }),
    );

    test.effect(`${family}: non-Node runtime does not start a sampler`, () =>
      Effect.gen(function* nonNodeHook() {
        const output = yield* runHook(family, 'edge');
        const event = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Registration))(output.trim());
        expect(event.observers).toBe(0);
      }),
    );

    test.effect(`${family}: an actual telemetry schema failure is visible at the native boundary`, () =>
      Effect.gen(function* visibleNativeFailure() {
        const output = yield* runHook(family, 'nodejs', 'invalid-source-revision');
        expect(output).toContain(observerStopped);
        expect(output).not.toContain('"event":"storefront.runtime.boot"');
        expect(output).toContain('"observers":0');
      }),
    );
  }
});

for (const storefront of families) {
  it(`${storefront} render after waits for its first disposal's gated async finalizer`, () => {
    const cwd = fileURLToPath(new URL(`../../${storefront}/`, import.meta.url));
    const bundle = buildSync({
      alias: { 'server-only': `${cwd}node_modules/next/dist/compiled/server-only/empty.js` },
      bundle: true,
      external: ['react', 'next/*', 'effect'],
      format: 'cjs',
      platform: 'node',
      stdin: {
        contents: `
          import 'next/dist/server/node-environment-baseline';
          import { Effect, Scope } from 'effect';
          import { NextRequest } from 'next/server';
          import { createRequestStoreForAPI } from 'next/dist/server/async-storage/request-store';
          import { createWorkStore } from 'next/dist/server/async-storage/work-store';
          import { workAsyncStorage } from 'next/dist/server/app-render/work-async-storage.external';
          import { workUnitAsyncStorage } from 'next/dist/server/app-render/work-unit-async-storage.external';
          import { renderOperation } from './src/ontos/render-operation';
          const request = new NextRequest('http://storefront.test/');
          const unit = createRequestStoreForAPI(request, new URL(request.url),
            { tags: [], expirationsByCacheKind: new Map() }, undefined, undefined, undefined);
          const closes = [];
          const waits = [];
          const errors = [];
          const work = createWorkStore({
            page: '/test/page', buildId: 'test', deploymentId: 'test', previouslyRevalidatedTags: [],
            renderOpts: {
              cacheLifeProfiles: {}, staticPageGenerationTimeout: 30, cacheComponents: false,
              validationLevel: 'none', experimental: { useCacheTimeout: 30, durableUseCacheEntries: false },
              isBuildTimePrerendering: false, isDraftMode: false,
              onClose: callback => closes.push(callback), waitUntil: promise => waits.push(promise),
              onAfterTaskError: error => errors.push(String(error)),
            },
          });
          workAsyncStorage.run(work, () => workUnitAsyncStorage.run(unit, async () => {
            const operation = await renderOperation();
            const entered = Promise.withResolvers();
            const release = Promise.withResolvers();
            const finalized = Promise.withResolvers();
            let finalizerRuns = 0;
            Effect.runSync(Scope.addFinalizer(operation.scope, Effect.promise(async () => {
              finalizerRuns++;
              entered.resolve();
              await release.promise;
              finalized.resolve();
            })));
            let afterSettled = false;
            const completion = Promise.all(waits).then(() => { afterSettled = true; });
            for (const close of closes) close();
            await entered.promise;
            // Drain runnable callbacks while the finalizer remains gated, without a timed sleep.
            await new Promise(setImmediate);
            const beforeRelease = { afterSettled, aborted: operation.signal.aborted };
            release.resolve();
            await completion;
            await finalized.promise;
            console.log(JSON.stringify({ beforeRelease, afterSettled, finalizerRuns, errors, waits: waits.length }));
          })).catch(error => { console.error(error); process.exitCode = 1; });
        `,
        resolveDir: cwd,
      },
      write: false,
    });
    const [output] = bundle.outputFiles;
    if (output === undefined) {
      throw new Error('Missing native render lifetime entry');
    }
    const result = execFileSync(
      process.execPath,
      ['--conditions=react-server', '--input-type=commonjs', '-e', output.text],
      { cwd, encoding: 'utf-8', timeout: 10_000 },
    );
    expect(JSON.parse(result)).toEqual({
      afterSettled: true,
      beforeRelease: { aborted: true, afterSettled: false },
      errors: [],
      finalizerRuns: 1,
      waits: 1,
    });
  });
}
