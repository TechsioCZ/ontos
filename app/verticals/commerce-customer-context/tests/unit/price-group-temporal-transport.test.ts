import { NodeChildProcessSpawner, NodeCrypto, NodeServices, NodeSocket } from '@effect/platform-node';
import { Crypto, Effect, Fiber, FileSystem, Layer, Option, Schema, Stream } from 'effect';
import { Socket } from 'effect/socket';
import { FetchHttpClient, HttpClient } from 'effect/http';
import { assert, expect, it } from 'effect-rstest';
import {
  describePriceGroupTemporalOwner,
  openPriceGroupTemporalChannel,
  guardPriceGroupTemporalSocketPath,
  makePriceGroupTemporalComposition,
  priceGroupTemporalLines,
  priceGroupTemporalProtocol,
  PriceGroupTemporalResponseSchema,
  TemporalFixtureUnavailable,
} from '../support/price-group-temporal-protocol.ts';

const responseSchema = Schema.Struct({ type: Schema.Literal('STOPPED') });
it.layer(
  NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(NodeCrypto.layer)),
)('Price Group private Unix transport #1248', (suite) => {
  suite.effect('retains the real reader through STOP/STOPPED and removes its private directory', () =>
    Effect.gen(function* roundtrip() {
      const fs = yield* FileSystem.FileSystem;
      const removed = yield* Effect.scoped(
        Effect.gen(function* privateScope() {
          const channel = yield* openPriceGroupTemporalChannel(responseSchema);
          const directory = channel.socketPath.slice(0, channel.socketPath.lastIndexOf('/'));
          yield* guardPriceGroupTemporalSocketPath(channel.socketPath);
          for (const invalidPath of [
            `${directory}/other.sock`,
            `${directory}/../owner.sock`,
            `${directory}/nested/owner.sock`,
            '/pg1248-foreign/owner.sock',
          ]) {
            const failure = yield* guardPriceGroupTemporalSocketPath(invalidPath).pipe(Effect.flip);
            assert(Schema.is(TemporalFixtureUnavailable)(failure));
            expect(failure.stage).toBe('private-socket-path');
          }
          expect((yield* fs.stat(directory)).mode % 0o1000).toBe(0o700);
          const peer = yield* Effect.gen(function* readAndAcknowledge() {
            const socket = yield* NodeSocket.makeNet({ openTimeout: '2 seconds', path: channel.socketPath });
            const pull = yield* Socket.readerBytes(socket);
            const writer = yield* socket.writer;
            const line = yield* priceGroupTemporalLines(pull).pipe(Stream.runHead);
            const command = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.Struct({ type: Schema.Literal('STOP') })),
            )(Option.getOrThrow(line));
            expect(command.type).toBe('STOP');
            const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(responseSchema))({ type: 'STOPPED' });
            yield* writer.write(`${encoded}\n`);
          }).pipe(Effect.forkChild);
          yield* channel.beginClose;
          yield* channel.send('{"type":"STOP"}');
          expect(yield* channel.next).toEqual({ type: 'STOPPED' });
          yield* Fiber.join(peer);
          return directory;
        }),
      );
      expect(yield* fs.exists(removed)).toBe(false);
    }),
  );
  suite.effect('fails typed when the actual peer closes after STOP without acknowledgement', () =>
    Effect.scoped(
      Effect.gen(function* earlyEof() {
        const channel = yield* openPriceGroupTemporalChannel(responseSchema);
        const peer = yield* Effect.scoped(
          Effect.gen(function* closeWithoutAcknowledgement() {
            const socket = yield* NodeSocket.makeNet({ openTimeout: '2 seconds', path: channel.socketPath });
            const pull = yield* Socket.readerBytes(socket);
            yield* priceGroupTemporalLines(pull).pipe(Stream.runHead);
          }),
        ).pipe(Effect.forkChild);
        yield* channel.beginClose;
        yield* channel.send('{"type":"STOP"}');
        const failure = yield* channel.next.pipe(Effect.flip);
        expect(Schema.is(TemporalFixtureUnavailable)(failure)).toBe(true);
        expect(failure.stage).toBe('private-channel-ended');
        yield* Fiber.join(peer);
      }),
    ),
  );
  suite.effect('preserves a declared owner failure and still completes the real STOP exchange', () =>
    Effect.scoped(
      Effect.gen(function* failureThenStop() {
        const channel = yield* openPriceGroupTemporalChannel(PriceGroupTemporalResponseSchema);
        const peer = yield* Effect.gen(function* declaredFailurePeer() {
          const socket = yield* NodeSocket.makeNet({ openTimeout: '2 seconds', path: channel.socketPath });
          const pull = yield* Socket.readerBytes(socket);
          const writer = yield* socket.writer;
          const encodedFailure = yield* Schema.encodeEffect(Schema.fromJsonString(PriceGroupTemporalResponseSchema))({
            code: 'action_permission_check_failed',
            stage: 'CREATE_UNAVAILABLE',
            type: 'FAILED',
            version: priceGroupTemporalProtocol,
          });
          yield* writer.write(`${encodedFailure}\n`);
          const line = yield* priceGroupTemporalLines(pull).pipe(Stream.runHead);
          const command = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Struct({ type: Schema.Literal('STOP') })),
          )(Option.getOrThrow(line));
          expect(command.type).toBe('STOP');
          const encodedStop = yield* Schema.encodeEffect(Schema.fromJsonString(PriceGroupTemporalResponseSchema))({
            type: 'STOPPED',
            version: priceGroupTemporalProtocol,
          });
          yield* writer.write(`${encodedStop}\n`);
        }).pipe(Effect.forkChild);
        expect(yield* channel.next).toEqual({
          code: 'action_permission_check_failed',
          stage: 'CREATE_UNAVAILABLE',
          type: 'FAILED',
          version: priceGroupTemporalProtocol,
        });
        yield* channel.beginClose;
        yield* channel.send('{"type":"STOP"}');
        expect(yield* channel.next).toEqual({ type: 'STOPPED', version: priceGroupTemporalProtocol });
        yield* Fiber.join(peer);
      }),
    ),
  );
  for (const owner of ['commerce-customer-context', 'party-registry', 'price-group-catalog'] as const) {
    suite.effect(
      `resolves published ${owner} TEST entry and describes its real child without a database`,
      () =>
        Effect.gen(function* describePublishedOwner() {
          const bundle = yield* describePriceGroupTemporalOwner(owner);
          expect(bundle.marker.appId).toBe(owner);
          expect(bundle.marker.buildMarker.length).toBeGreaterThan(0);
          expect(bundle.contract.deployment.appId).toBe(owner);
          expect(bundle.contract.deployment.buildMarker).toBe(bundle.marker.buildMarker);
          const snapshot = yield* makePriceGroupTemporalComposition([bundle]);
          const [module] = snapshot.composition.modules;
          expect(module?.contractDocument).toBeDefined();
          if (module?.federation.execution === 'browser') {
            const response = yield* HttpClient.get(module.federation.manifest.url).pipe(
              Effect.provide(FetchHttpClient.layer),
            );
            const body = yield* response.text;
            expect(response.status).toBe(200);
            const crypto = yield* Crypto.Crypto;
            const actualDigest = Buffer.from(yield* crypto.digest('SHA-256', new TextEncoder().encode(body))).toString(
              'hex',
            );
            expect(actualDigest).toBe(module.federation.manifest.sha256);
            const metadata = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(
                Schema.Struct({
                  exposes: Schema.Array(Schema.String),
                  name: Schema.String,
                  shared: Schema.Array(Schema.Never),
                }),
              ),
            )(body);
            expect(metadata.exposes).toEqual(
              bundle.contract.manifest.publicSurface.components.map(({ expose }) => expose),
            );
            expect(metadata.name).toBe(module.federation.remoteName);
          }
        }),
      30_000,
    );
  }
});
