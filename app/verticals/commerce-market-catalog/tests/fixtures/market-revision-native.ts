import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices, NodeSocketServer } from '@effect/platform-node';
import { Deferred, Duration, Effect, FileSystem, Layer, Queue, Ref, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { Socket } from 'effect/socket';
import { FetchHttpClient } from 'effect/http';
import {
  MarketRevisionNativeCommandSchema,
  MarketRevisionNativeIssueFailureStageSchema,
  MarketRevisionNativeTransportError,
  marketRevisionNativeLines,
  marketRevisionNativeSocketEnvironment,
  MarketRevisionNativeReadySchema,
  MarketRevisionNativeResponseSchema,
} from '../support/market-revision-native-protocol.ts';
import type {
  MarketRevisionNativeCustomerContextState,
  MarketRevisionNativeIssueSchema,
} from '../support/market-revision-native-protocol.ts';
import type { CreateMarketResultSchema } from '../../shared/action-contracts.ts';

class MarketRevisionNativeLauncherError extends Schema.TaggedError<MarketRevisionNativeLauncherError>()(
  'MarketRevisionNativeLauncherError',
  { stage: Schema.optionalKey(MarketRevisionNativeIssueFailureStageSchema) },
) {}
const unavailable = () => new MarketRevisionNativeLauncherError({});
export const marketRevisionNativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);
const transportFailure = () =>
  new MarketRevisionNativeTransportError({ reason: 'Private Market channel closed before its response' });
export const openMarketRevisionNativeChannel = Effect.fn('MarketRevisionNativeTransport.open')(
  function* openMarketRevisionNativeChannel() {
    const fs = yield* FileSystem.FileSystem;
    const temporary = yield* fs.makeTempDirectoryScoped({ directory: '/tmp', prefix: 'm1250-' });
    yield* fs.chmod(temporary, 0o700);
    const directory = yield* fs.realPath(temporary);
    const socketPath = `${directory}/market.sock`;
    const server = yield* NodeSocketServer.make({ path: socketPath }).pipe(Effect.mapError(transportFailure));
    const writer = yield* Deferred.make<Socket.Writer>();
    const responses = yield* Queue.unbounded<typeof MarketRevisionNativeResponseSchema.Type>();
    const failed = yield* Deferred.make<never, MarketRevisionNativeTransportError>();
    const closing = yield* Ref.make(false);
    const closed = yield* Ref.make(false);
    const connected = yield* Ref.make(false);
    const stopped = yield* Ref.make(false);
    yield* server
      .run((socket) =>
        Effect.scoped(
          Effect.gen(function* receivePrivateOwnerResponses() {
            if (yield* Ref.getAndSet(connected, true)) {
              return yield* transportFailure();
            }
            const pull = yield* Socket.readerBytes(socket);
            yield* Deferred.succeed(writer, yield* socket.writer);
            return yield* marketRevisionNativeLines(pull).pipe(
              Stream.mapEffect((line) =>
                Schema.decodeUnknownEffect(Schema.fromJsonString(MarketRevisionNativeResponseSchema), {
                  onExcessProperty: 'error',
                })(line).pipe(Effect.mapError(transportFailure)),
              ),
              Stream.runForEach((response) =>
                Queue.offer(responses, response).pipe(
                  Effect.andThen(response.type === 'STOPPED' ? Ref.set(stopped, true) : Effect.void),
                ),
              ),
            );
          }),
        ).pipe(
          Effect.catchIf(
            (error) =>
              Socket.isSocketError(error) &&
              Schema.is(Socket.SocketCloseError)(error.reason) &&
              error.reason.code === 1000,
            (error) =>
              Effect.all([Ref.get(closing), Ref.get(stopped)]).pipe(
                Effect.flatMap(([expected, acknowledged]) =>
                  expected && acknowledged ? Effect.void : Effect.fail(error),
                ),
              ),
          ),
          Effect.catch(() => Deferred.fail(failed, transportFailure())),
        ),
      )
      .pipe(Effect.forkScoped);
    const beginClose = Ref.set(closing, true);
    const close = beginClose.pipe(
      Effect.andThen(Ref.set(closed, true)),
      Effect.andThen(Deferred.fail(failed, transportFailure())),
      Effect.andThen(Queue.shutdown(responses)),
      Effect.asVoid,
    );
    yield* Effect.addFinalizer(() => close);
    const next = Effect.raceFirst(Queue.take(responses), Deferred.await(failed));
    return Object.freeze({
      beginClose,
      close,
      next,
      send: Effect.fn('MarketRevisionNativeTransport.send')(function* send(
        command: typeof MarketRevisionNativeCommandSchema.Type,
      ) {
        if (yield* Ref.get(closed)) {
          return yield* transportFailure();
        }
        const line = yield* Schema.encodeEffect(Schema.fromJsonString(MarketRevisionNativeCommandSchema))(command).pipe(
          Effect.mapError(transportFailure),
        );
        const output = yield* Effect.raceFirst(Deferred.await(writer), Deferred.await(failed));
        return yield* output.write(`${line}\n`).pipe(Effect.mapError(transportFailure));
      }),
      socketPath,
    });
  },
);

/** Transpile the two published owner test exports while preserving their own resource base URLs. */
export const bundleMarketRevisionNativeChild = Effect.fn('MarketRevisionNativeLauncher.bundle')(
  function* bundleMarketRevisionNativeChild() {
    const fs = yield* FileSystem.FileSystem;
    const directory = fileURLToPath(new URL('../../', import.meta.url));
    const cache = `${directory}/.cache/ontos-1250`;
    yield* fs.makeDirectory(cache, { recursive: true });
    const temporary = yield* fs.makeTempDirectoryScoped({ directory: cache, prefix: 'market-' });
    const aliases: string[] = [];
    const runBundle = Effect.fn('MarketRevisionNativeLauncher.bundleEntry')(function* runBundle(
      args: readonly string[],
    ) {
      const bundle = yield* ChildProcess.make('../../node_modules/esbuild/bin/esbuild', args, {
        cwd: directory,
        stderr: 'pipe',
        stdout: 'pipe',
      });
      const [code] = yield* Effect.all(
        [bundle.exitCode, Stream.runDrain(bundle.stderr), Stream.runDrain(bundle.stdout)],
        { concurrency: 3 },
      );
      if (code !== 0) {
        return yield* unavailable();
      }
      return yield* Effect.void;
    });
    for (const [index, specifier] of [
      '@app/shell-super-app/testing/api-key-gateway-native',
      '@app/storefront-registry/testing/current-storefront-native',
      '@app/commerce-customer-context/testing/market-retirement-native',
    ].entries()) {
      const originalUrl = pathToFileURL(
        createRequire(new URL('../../package.json', import.meta.url)).resolve(specifier),
      ).href;
      const ownerCache = fileURLToPath(new URL('../../node_modules/.cache/ontos-1094-exports/', originalUrl));
      yield* fs.makeDirectory(ownerCache, { recursive: true });
      const ownerTemporary = yield* fs.makeTempDirectoryScoped({ directory: ownerCache, prefix: 'native-' });
      const output = `${ownerTemporary}/public-owner-${index}.mjs`;
      const originalUrlJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(originalUrl);
      yield* runBundle([
        fileURLToPath(originalUrl),
        '--bundle',
        '--platform=node',
        '--format=esm',
        '--packages=external',
        `--define:import.meta.url=${originalUrlJson}`,
        `--outfile=${output}`,
      ]);
      aliases.push(`--alias:${specifier}=${output}`, `--external:${output}`);
    }
    const artifact = `${temporary}/owner.mjs`;
    yield* runBundle([
      'tests/support/market-revision-native-child.ts',
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--packages=external',
      ...aliases,
      `--outfile=${artifact}`,
    ]);
    return { artifact, directory };
  },
);

/** Published launcher only: producer, database, runtime and HTTP verifier remain in the Market owner process. */
export const makeMarketRevisionNativeFixture = Effect.fn('MarketRevisionNativeLauncher.make')(
  function* makeMarketRevisionNativeFixture() {
    const { artifact, directory } = yield* bundleMarketRevisionNativeChild();
    const channel = yield* openMarketRevisionNativeChannel();
    const child = yield* ChildProcess.make(process.execPath, [artifact], {
      cwd: directory,
      env: { [marketRevisionNativeSocketEnvironment]: channel.socketPath },
      extendEnv: true,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    });
    yield* Effect.addFinalizer(() => channel.beginClose);
    yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
    yield* Stream.runDrain(child.stdout).pipe(Effect.forkScoped);
    const responseTimeout = Effect.timeoutOrElse({
      duration: Duration.seconds(60),
      orElse: () => Effect.fail(unavailable()),
    });
    const childStopped = child.exitCode.pipe(Effect.andThen(Effect.fail(transportFailure())));
    const nextResponse = Effect.raceFirst(channel.next, childStopped).pipe(responseTimeout);
    const ready = yield* nextResponse.pipe(
      responseTimeout,
      Effect.flatMap((response) =>
        Schema.is(MarketRevisionNativeReadySchema)(response) ? Effect.succeed(response) : Effect.fail(unavailable()),
      ),
    );
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* stopOwnedMarketChild() {
        yield* channel.beginClose;
        yield* channel.send({ type: 'STOP' }).pipe(
          responseTimeout,
          Effect.mapError(
            () => new MarketRevisionNativeTransportError({ reason: 'Market STOP command could not be delivered' }),
          ),
        );
        const response = yield* Effect.raceFirst(channel.next, childStopped).pipe(
          responseTimeout,
          Effect.mapError(
            () =>
              new MarketRevisionNativeTransportError({ reason: 'Market child closed before STOPPED acknowledgement' }),
          ),
        );
        if (response.type !== 'STOPPED') {
          return yield* transportFailure();
        }
        yield* child.exitCode.pipe(
          responseTimeout,
          Effect.mapError(
            () =>
              new MarketRevisionNativeTransportError({
                reason: 'Market child did not exit after STOPPED acknowledgement',
              }),
          ),
        );
        return yield* Effect.void;
      }).pipe(Effect.ensuring(channel.close), Effect.orDie),
    );
    const exchange = (command: typeof MarketRevisionNativeCommandSchema.Type) =>
      Effect.raceFirst(channel.send(command).pipe(Effect.andThen(channel.next)), childStopped).pipe(responseTimeout);
    let original: typeof CreateMarketResultSchema.Type | undefined;
    return Object.freeze({
      ...ready,
      closeStorefront: Effect.fn('MarketRevisionNativeLauncher.closeStorefront')(function* closeStorefront() {
        const response = yield* exchange({ type: 'CLOSE_STOREFRONT' });
        if (response.type !== 'STOREFRONT_CLOSED') {
          return yield* unavailable();
        }
        return yield* Effect.void;
      }),
      createR1: Effect.fn('MarketRevisionNativeLauncher.createR1')(function* createR1() {
        const response = yield* exchange({ type: 'CREATE_R1' });
        if (response.type !== 'CREATED') {
          return yield* unavailable();
        }
        original = response.result;
        return response.result;
      }),
      evidence: Effect.fn('MarketRevisionNativeLauncher.evidence')(function* evidence() {
        const response = yield* exchange({ type: 'EVIDENCE' });
        if (response.type !== 'EVIDENCE') {
          return yield* unavailable();
        }
        return response;
      }),
      issue: Effect.fn('MarketRevisionNativeLauncher.issue')(function* issue(
        input: typeof MarketRevisionNativeIssueSchema.Type,
      ) {
        const response = yield* exchange({ input, type: 'ISSUE' });
        if (response.type === 'FAILED') {
          return yield* new MarketRevisionNativeLauncherError({ stage: response.stage });
        }
        if (response.type !== 'ISSUED') {
          return yield* unavailable();
        }
        return { baseUrl: response.baseUrl, credential: response.credential };
      }),
      reviseR2: Effect.fn('MarketRevisionNativeLauncher.reviseR2')(function* reviseR2(basis: {
        readonly definitionRevisionRef: { readonly resourceId: string };
        readonly revision: number;
      }) {
        if (
          original === undefined ||
          basis.revision !== original.revision ||
          basis.definitionRevisionRef.resourceId !== original.definitionRevisionRef.resourceId
        ) {
          return yield* unavailable();
        }
        const response = yield* exchange({ type: 'REVISE_R2' });
        if (response.type !== 'REVISED') {
          return yield* unavailable();
        }
        return response.result;
      }),
      setCustomerContextState: Effect.fn('MarketRevisionNativeLauncher.setCustomerContextState')(
        function* setCustomerContextState(state: MarketRevisionNativeCustomerContextState) {
          const response = yield* exchange({ state, type: 'SET_CCC_STATE' });
          if (response.type !== 'CCC_STATE_SET' || response.state !== state) {
            return yield* unavailable();
          }
          return yield* Effect.void;
        },
      ),
    });
  },
);
