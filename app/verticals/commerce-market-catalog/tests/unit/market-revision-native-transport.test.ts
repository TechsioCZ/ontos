import { NodeServices, NodeSocket } from '@effect/platform-node';
import { Context, Effect, Fiber, FileSystem, Layer, Option, Schema, Stream } from 'effect';
import { Socket } from 'effect/socket';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';

import {
  bundleMarketRevisionNativeChild,
  marketRevisionNativeServices,
  openMarketRevisionNativeChannel,
} from '../fixtures/market-revision-native.ts';
import {
  MarketRevisionNativeCommandSchema,
  MarketRevisionNativeResponseSchema,
  MarketRevisionNativeTransportError,
  marketRevisionNativeFrameLimit,
  marketRevisionNativeLines,
} from '../support/market-revision-native-protocol.ts';

const privateNegativeIssuerPeer = Effect.fn('MarketTransportTest.knownIssueFailure')(
  function* privateNegativeIssuerPeer(socketPath: string) {
    const socket = yield* NodeSocket.makeNet({ openTimeout: '2 seconds', path: socketPath });
    const pull = yield* Socket.readerBytes(socket);
    const writer = yield* socket.writer;
    yield* marketRevisionNativeLines(pull).pipe(
      Stream.mapEffect((line) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(MarketRevisionNativeCommandSchema))(line),
      ),
      Stream.takeUntil((command) => command.type === 'STOP'),
      Stream.runForEach((command) =>
        Schema.encodeEffect(Schema.fromJsonString(MarketRevisionNativeResponseSchema))(
          command.type === 'ISSUE' ? { stage: 'ADMISSION_MISMATCH', type: 'FAILED' } : { type: 'STOPPED' },
        ).pipe(Effect.flatMap((line) => writer.write(`${line}\n`))),
      ),
    );
  },
);

it.layer(NodeServices.layer)('owned Market Unix transport', (suite) => {
  suite.effect('opens the reader before a fixed STOP exchange and cleans the private socket scope', () =>
    Effect.gen(function* stopRoundtrip() {
      const fs = yield* FileSystem.FileSystem;
      const removed = yield* Effect.scoped(
        Effect.gen(function* privateScope() {
          const channel = yield* openMarketRevisionNativeChannel();
          const directory = channel.socketPath.slice(0, channel.socketPath.lastIndexOf('/'));
          expect((yield* fs.stat(directory)).mode % 0o1000).toBe(0o700);
          const peer = yield* Effect.gen(function* readCommandAndRespond() {
            const socket = yield* NodeSocket.makeNet({ openTimeout: '2 seconds', path: channel.socketPath });
            const pull = yield* Socket.readerBytes(socket);
            const writer = yield* socket.writer;
            const line = yield* marketRevisionNativeLines(pull).pipe(Stream.runHead);
            const command = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MarketRevisionNativeCommandSchema))(
              Option.getOrThrow(line),
            );
            expect(command).toEqual({ type: 'STOP' });
            const response = yield* Schema.decodeUnknownEffect(MarketRevisionNativeResponseSchema)({ type: 'STOPPED' });
            const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(MarketRevisionNativeResponseSchema))(
              response,
            );
            yield* writer.write(`${encoded}\n`);
          }).pipe(Effect.forkChild);
          yield* channel.beginClose;
          yield* channel.send({ type: 'STOP' });
          expect(yield* channel.next).toEqual({ type: 'STOPPED' });
          yield* Fiber.join(peer);
          yield* channel.close;
          return directory;
        }),
      );
      expect(yield* fs.exists(removed)).toBe(false);
    }),
  );

  suite.effect('reports EOF before the expected response as a typed failure', () =>
    Effect.scoped(
      Effect.gen(function* rejectLostResponse() {
        const channel = yield* openMarketRevisionNativeChannel();
        const peer = yield* Effect.scoped(
          Effect.gen(function* closeWithoutResponse() {
            const socket = yield* NodeSocket.makeNet({ openTimeout: '2 seconds', path: channel.socketPath });
            const pull = yield* Socket.readerBytes(socket);
            yield* marketRevisionNativeLines(pull).pipe(Stream.runHead);
          }),
        ).pipe(Effect.forkChild);
        yield* channel.send({ type: 'STOP' });
        const failure = yield* channel.next.pipe(Effect.flip);
        expect(Schema.is(MarketRevisionNativeTransportError)(failure)).toBe(true);
        yield* Fiber.join(peer);
      }),
    ),
  );

  suite.effect('fails an owned STOP handshake immediately when the peer closes without STOPPED', () =>
    Effect.scoped(
      Effect.gen(function* rejectUnacknowledgedStop() {
        const channel = yield* openMarketRevisionNativeChannel();
        const peer = yield* Effect.scoped(
          Effect.gen(function* closeAfterActualStop() {
            const socket = yield* NodeSocket.makeNet({ openTimeout: '2 seconds', path: channel.socketPath });
            const pull = yield* Socket.readerBytes(socket);
            const line = yield* marketRevisionNativeLines(pull).pipe(Stream.runHead);
            const command = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MarketRevisionNativeCommandSchema))(
              Option.getOrThrow(line),
            );
            expect(command.type).toBe('STOP');
          }),
        ).pipe(Effect.forkChild);
        yield* channel.beginClose;
        yield* channel.send({ type: 'STOP' });
        expect(Schema.is(MarketRevisionNativeTransportError)(yield* channel.next.pipe(Effect.flip))).toBe(true);
        yield* Fiber.join(peer);
      }),
    ),
  );

  suite.effect('retains the real command channel after a typed ISSUE failure for subsequent STOP acknowledgement', () =>
    Effect.scoped(
      Effect.gen(function* failedIssueThenStop() {
        const channel = yield* openMarketRevisionNativeChannel();
        const peer = yield* privateNegativeIssuerPeer(channel.socketPath).pipe(Effect.forkChild);
        const input = yield* Schema.decodeUnknownEffect(MarketRevisionNativeCommandSchema)({
          input: {
            audience: 'commerce-market-catalog',
            compositionRevision: 'test-revision',
            legalEntityId: '11111111-1111-4111-8111-111111111111',
            requestCorrelation: 'negative-transport-only',
          },
          type: 'ISSUE',
        });
        yield* channel.send(input);
        expect(yield* channel.next).toEqual({ stage: 'ADMISSION_MISMATCH', type: 'FAILED' });
        yield* channel.beginClose;
        yield* channel.send({ type: 'STOP' });
        expect(yield* channel.next).toEqual({ type: 'STOPPED' });
        yield* Fiber.join(peer);
      }),
    ),
  );

  suite.effect('rejects a command after channel disposal before waiting for a peer', () =>
    Effect.scoped(
      Effect.gen(function* rejectDisposedChannel() {
        const channel = yield* openMarketRevisionNativeChannel();
        yield* channel.close;
        const failure = yield* channel.send({ type: 'STOP' }).pipe(Effect.flip);
        expect(Schema.is(MarketRevisionNativeTransportError)(failure)).toBe(true);
      }),
    ),
  );
});

it.effect('bounds an unterminated frame before JSON decoding', () =>
  Effect.gen(function* rejectOversizedFrame() {
    const pull = Effect.succeed([new Uint8Array(marketRevisionNativeFrameLimit + 1)] as const);
    const failure = yield* marketRevisionNativeLines(pull).pipe(Stream.runDrain, Effect.flip);
    expect(Schema.is(MarketRevisionNativeTransportError)(failure)).toBe(true);
  }),
);

const marketNativeDescription = Effect.scoped(
  Effect.gen(function* prepareMarketNativeDescription() {
    const { artifact, directory } = yield* bundleMarketRevisionNativeChild();
    const child = yield* ChildProcess.make(process.execPath, [artifact, '--describe'], {
      cwd: directory,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    });
    const [code, stdout, stderr] = yield* Effect.all(
      [
        child.exitCode,
        child.stdout.pipe(Stream.decodeText, Stream.mkString),
        child.stderr.pipe(Stream.decodeText, Stream.mkString),
      ],
      { concurrency: 3 },
    );
    const errorClasses = stderr.match(/\b(?:SyntaxError|ReferenceError|TypeError|Error \[ERR_[A-Z_]+\])/gu) ?? [];
    const missingExport =
      /does not provide an export named '(?<exportName>[A-Za-z_$][\w$]*)'/u.exec(stderr)?.groups?.exportName ?? null;
    const missingModule =
      /Cannot find (?:package|module) '(?<moduleName>[@A-Za-z0-9/._-]+)'/u
        .exec(stderr)
        ?.groups?.moduleName?.split('/')
        .slice(-4)
        .join('/') ?? null;
    return { code, errorClasses, missingExport, missingModule, stdout };
  }),
);

class MarketNativeDescription extends Context.Service<
  MarketNativeDescription,
  Effect.Success<typeof marketNativeDescription>
>()('MarketNativeTransportTest/Description') {}

// Bundling, child startup and scoped shutdown share the bounded preparation hook.
// Receipt assertions retain the default 5-second test-body budget.
const marketNativeDescriptionLayer = Layer.effect(MarketNativeDescription, marketNativeDescription).pipe(
  Layer.provideMerge(marketRevisionNativeServices),
);

it.layer(marketNativeDescriptionLayer, { timeout: '30 seconds' })(
  'Market native bundle in the actual test runner',
  (suite) => {
    suite.effect('resolves public owner exports and describes the bundled child without opening its backend', () =>
      Effect.gen(function* describeBundledChild() {
        const { code, errorClasses, missingExport, missingModule, stdout } = yield* MarketNativeDescription;
        expect({ code, errorClasses, missingExport, missingModule }).toEqual({
          code: 0,
          errorClasses: [],
          missingExport: null,
          missingModule: null,
        });
        const response = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              marker: Schema.Struct({ appId: Schema.Literal('commerce-market-catalog') }),
              protocolVersion: Schema.Number,
              responseTransport: Schema.String,
            }),
          ),
        )(stdout.trim());
        expect(response.marker.appId).toBe('commerce-market-catalog');
        expect(response.protocolVersion).toBe(2);
        expect(response.responseTransport).toBe('private-unix-duplex');
      }),
    );
  },
);
