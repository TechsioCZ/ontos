import { NodeChildProcessSpawner, NodeCrypto, NodeServices, NodeSocket } from '@effect/platform-node';
import { Effect, Fiber, FileSystem, Layer, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ApiKeyGatewayNativeFixtureError,
  ShellNativeChildCommandSchema,
  ShellNativeIssueCommandSchema,
  ShellNativeIssuedResponseSchema,
  ShellNativeSessionGatewayCommandSchema,
  ShellNativeSessionGatewayResponseSchema,
  ShellNativeChildReadySchema,
  ShellNativeChildResponseSchema,
  makeApiKeyGatewayNativeFixture,
  openShellNativePrivateChannel,
} from '../fixtures/api-key-gateway-native.ts';

const infrastructure = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const connection = (database: string, user: string) =>
  Object.freeze({
    connectionString: `postgresql://${user}:fixture@localhost/${database}`,
    database,
    expectedRole: user,
    host: 'localhost',
    port: 5432,
    user,
  });
const credentials = (database: string) => ({
  ownedDatabase: {
    composition: {
      closeAdmission: () => Effect.die('Fixture cannot change composition'),
      drain: () => Effect.die('Fixture cannot change composition'),
      observe: () => Effect.die('Invalid fixture input cannot inspect the owned database'),
      observeRetainedOriginal: () => Effect.die('Invalid fixture input cannot inspect the owned database'),
      publishReplacement: () => Effect.die('Fixture cannot change composition'),
      seal: () => Effect.die('Fixture cannot change composition'),
    },
    connections: { admin: connection(database, 'administrator'), runtime: connection(database, 'runtime') },
  },
  snapshotJson: '{}',
});

it.layer(infrastructure)('owned Shell native fixture', (suite) => {
  suite.effect('refuses a source database before migration, bundling or client construction', () =>
    Effect.scoped(
      Effect.gen(function* rejectSourceDatabase() {
        const failure = yield* makeApiKeyGatewayNativeFixture(credentials('source_database')).pipe(Effect.flip);
        expect(failure).toBeInstanceOf(ApiKeyGatewayNativeFixtureError);
      }),
    ),
  );
  suite.effect('rejects an invalid immutable snapshot before constructing any owned infrastructure', () =>
    Effect.scoped(
      Effect.gen(function* rejectInvalidComposition() {
        const failure = yield* makeApiKeyGatewayNativeFixture(credentials('ontos_test_party_gateway_component')).pipe(
          Effect.flip,
        );
        expect(failure).toBeInstanceOf(ApiKeyGatewayNativeFixtureError);
      }),
    ),
  );
  suite.effect('carries a closed issue command and private issued credential through a real owned Unix socket', () =>
    Effect.gen(function* realPrivateChannel() {
      const fs = yield* FileSystem.FileSystem;
      const socketPath = yield* Effect.scoped(
        Effect.gen(function* privateExchangeScope() {
          const channel = yield* openShellNativePrivateChannel();
          const socket = yield* NodeSocket.makeNet({ openTimeout: '2 seconds', path: channel.socketPath });
          const peer = yield* Effect.gen(function* privateChildPeer() {
            // This is transport-only; no identity, authorization, key issuance, or gateway outcome is simulated.
            const reader = yield* socket.reader;
            const chunks = yield* reader.pull;
            let input = '';
            for (const chunk of chunks) {
              input += Schema.is(Schema.String)(chunk) ? chunk : new TextDecoder().decode(chunk);
            }
            const command = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ShellNativeChildCommandSchema))(
              input.trim(),
            );
            expect(Schema.is(ShellNativeIssueCommandSchema)(command)).toBe(true);
            const writer = yield* socket.writer;
            const line = yield* Schema.decodeUnknownEffect(ShellNativeChildResponseSchema)({
              _tag: 'issued',
              providerKeyId: '11111111-1111-4111-8111-111111111111',
              secret: 'private-protocol-test-value',
            }).pipe(Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(ShellNativeChildResponseSchema))));
            yield* writer.write(`${line}\n`);
          }).pipe(Effect.forkChild);
          const response = yield* channel.exchange({
            _tag: 'issue',
            principalId: '22222222-2222-4222-8222-222222222222',
            tenantId: '33333333-3333-4333-8333-333333333333',
          });
          expect(Schema.is(ShellNativeChildResponseSchema)(response)).toBe(true);
          expect(Schema.is(ShellNativeIssuedResponseSchema)(response)).toBe(true);
          yield* Fiber.join(peer);
          yield* channel.close;
          return channel.socketPath;
        }),
      );
      expect(yield* fs.exists(socketPath)).toBe(false);
    }),
  );
});

it.layer(infrastructure)('private channel disposal', (suite) => {
  suite.effect('refuses a new command after explicit scoped close before waiting for a peer', () =>
    Effect.scoped(
      Effect.gen(function* refuseClosedChannel() {
        const channel = yield* openShellNativePrivateChannel();
        yield* channel.close;
        const failure = yield* channel.exchange({ _tag: 'bound' }).pipe(Effect.flip);
        expect(Schema.is(ApiKeyGatewayNativeFixtureError)(failure)).toBe(true);
      }),
    ),
  );
});

it('keeps the private protocol closed and public readiness separate from issued credentials', () => {
  expect(Schema.is(ShellNativeChildCommandSchema)({ _tag: 'reset' })).toBe(false);
  expect(Schema.is(ShellNativeChildCommandSchema)({ _tag: 'sign', principalId: 'caller-selected' })).toBe(false);
  expect(Schema.is(ShellNativeChildCommandSchema)({ _tag: 'issue', principalId: 'invalid', tenantId: 'invalid' })).toBe(
    false,
  );
  expect(Schema.is(ShellNativeChildResponseSchema)({ _tag: 'issued', providerKeyId: '', secret: 'credential' })).toBe(
    false,
  );
  expect(Schema.is(ShellNativeChildReadySchema)({ _tag: 'issued', providerKeyId: 'key', secret: 'credential' })).toBe(
    false,
  );
});

it('keeps session issuance closed to public gateway inputs without caller identity or cookie injection', () => {
  const request = { audience: 'privacy', compositionRevision: 'a'.repeat(64) };
  const decode = Schema.decodeUnknownResult(ShellNativeSessionGatewayCommandSchema, { onExcessProperty: 'error' });
  expect(Schema.is(ShellNativeSessionGatewayCommandSchema)({ _tag: 'session-gateway', request })).toBe(true);
  for (const command of [
    { _tag: 'session-gateway', request: { ...request, audience: '' } },
    { _tag: 'session-gateway', request: { ...request, compositionRevision: 'invalid' } },
    { _tag: 'session-gateway', request: { ...request, legalEntityId: 'invalid' } },
    { _tag: 'session-gateway', cookie: 'caller-selected', request },
    { _tag: 'session-gateway', request: { ...request, principalId: 'caller-selected' } },
  ]) {
    expect(Result.isFailure(decode(command))).toBe(true);
  }
});

it('keeps session assertion replies private and validates the published gateway result', () => {
  // Codec-only data is never accepted by an authority or advertised as real issuance.
  const response = {
    _tag: 'session-gateway',
    gateway: {
      apiBaseUrl: '/privacy-api',
      compositionRevision: 'a'.repeat(64),
      expiresAt: 1_900_000_000,
      token: 'private-codec-only-token',
    },
  };
  expect(Schema.is(ShellNativeSessionGatewayResponseSchema)(response)).toBe(true);
  expect(Schema.is(ShellNativeChildReadySchema)(response)).toBe(false);
  expect(
    Schema.is(ShellNativeSessionGatewayResponseSchema)({ ...response, gateway: { ...response.gateway, token: '' } }),
  ).toBe(false);
});
