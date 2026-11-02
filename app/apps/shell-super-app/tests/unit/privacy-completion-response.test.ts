import { NodeServices, NodeSocketServer } from '@effect/platform-node';
import { ConfigProvider, Deferred, Effect, FileSystem, Fiber, Path, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import type { Socket } from 'effect/socket';

import {
  loadPrivacyCompletionResponseSocket,
  PrivacyCompletionReadySchema,
  privacyCompletionResponseEnvironment,
  PrivacyCompletionResponseFailure,
  privacyCompletionResponseLimit,
  privacyCompletionResponseTransport,
  sendPrivacyCompletionResponse,
  validatePrivacyCompletionResponseSocket,
} from '../support/privacy-completion-response.ts';

const fixtureReady = () =>
  Schema.decodeUnknownEffect(PrivacyCompletionReadySchema)({
    apiKey: 'private-test-key-never-stdout',
    legalEntityId: '11111111-1111-4111-8111-111111111111',
    marker: { appId: 'shell-super-app', label: 'Příprava' },
    port: 4123,
    principal: {
      authContextRef: 'job:fixture:run:private-response',
      authMethod: 'system',
      principalId: '22222222-2222-4222-8222-222222222222',
      tenantId: '33333333-3333-4333-8333-333333333333',
    },
    protocolVersion: 2,
    responseTransport: privacyCompletionResponseTransport,
    tenantId: '33333333-3333-4333-8333-333333333333',
    type: 'ready',
  });

const privateDirectory = Effect.gen(function* privateDirectory() {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ directory: '/tmp', prefix: 'p1258-' });
  yield* fs.chmod(directory, 0o700);
  return yield* fs.realPath(directory);
});

const receivePrivateLine = Effect.fn('PrivacyCompletionResponseTest.receive')(function* receivePrivateLine(
  socket: Socket.Socket,
  received: Deferred.Deferred<string>,
) {
  const reader = yield* socket.reader;
  const decoder = new TextDecoder();
  let line = '';
  while (!line.endsWith('\n')) {
    const chunks = yield* reader.pull;
    for (const chunk of chunks) {
      line += Schema.is(Schema.String)(chunk) ? chunk : decoder.decode(chunk, { stream: true });
    }
    if (new TextEncoder().encode(line).length > privacyCompletionResponseLimit) {
      return yield* new PrivacyCompletionResponseFailure({
        reason: 'Private response payload exceeds its bound',
      });
    }
  }
  yield* Deferred.succeed(received, line);
  return yield* Effect.void;
});

it.layer(NodeServices.layer)('private completion response socket', (suite) => {
  suite.effect(
    'delivers one bounded schema-valid private response over a real owned Unix socket and removes its directory',
    () =>
      Effect.gen(function* socketRoundtrip() {
        const fs = yield* FileSystem.FileSystem;
        const removedDirectory = yield* Effect.scoped(
          Effect.gen(function* scopedRoundtrip() {
            const directory = yield* privateDirectory;
            const path = `${directory}/response.sock`;
            const info = yield* fs.stat(directory);
            expect(info.mode % 0o1000).toBe(0o700);
            const server = yield* NodeSocketServer.make({ path });
            const received = yield* Deferred.make<string>();
            const listener = yield* server
              .run((socket) => receivePrivateLine(socket, received).pipe(Effect.scoped))
              .pipe(Effect.forkChild);
            const payload = yield* fixtureReady();
            yield* sendPrivacyCompletionResponse(path, payload);
            const line = yield* Deferred.await(received);
            expect(line.split('\n')).toHaveLength(2);
            const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PrivacyCompletionReadySchema))(
              line.trim(),
            );
            expect(Redacted.value(decoded.apiKey)).toBe(Redacted.value(payload.apiKey));
            expect(decoded.principal).toEqual(payload.principal);
            expect(decoded.protocolVersion).toBe(2);
            yield* Fiber.interrupt(listener);
            return directory;
          }),
        );
        expect(yield* fs.exists(removedDirectory)).toBe(false);
      }),
  );

  suite.effect('rejects missing configuration and invalid paths with sanitized typed failures', () =>
    Effect.gen(function* rejectInvalidConfiguration() {
      const missing = yield* Effect.flip(
        loadPrivacyCompletionResponseSocket().pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
        ),
      );
      expect(Schema.is(PrivacyCompletionResponseFailure)(missing)).toBe(true);
      expect(missing.reason).toBe('Private response socket configuration is required');
      for (const path of ['http://localhost:1234', 'relative/response.sock', `/${'x'.repeat(100)}/response.sock`]) {
        const failure = yield* Effect.flip(validatePrivacyCompletionResponseSocket(path));
        expect(failure.reason).toBe('Invalid private response socket path');
      }
      expect(privacyCompletionResponseEnvironment).toBe('ONTOS_1258_TEST_RESPONSE_SOCKET');
    }),
  );

  suite.effect('rejects an invalid directory mode, a missing listener and a regular file without sending secrets', () =>
    Effect.scoped(
      Effect.gen(function* rejectUnavailableSocket() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* privateDirectory;
        const socketPath = path.join(directory, 'response.sock');
        const payload = yield* fixtureReady();
        const missing = yield* Effect.flip(sendPrivacyCompletionResponse(socketPath, payload));
        expect(missing.reason).toBe('Private response socket is unavailable');
        yield* fs.writeFileString(socketPath, 'not a socket');
        expect((yield* Effect.flip(sendPrivacyCompletionResponse(socketPath, payload))).reason).toBe(missing.reason);
        yield* fs.chmod(directory, 0o600);
        const unsafe = yield* Effect.flip(sendPrivacyCompletionResponse(socketPath, payload));
        expect(unsafe.reason).toBe('Private response socket directory must be canonical and mode 0700');
        // The scoped cleanup cannot traverse a 0600 directory; restore the owner mode before it removes the directory.
        yield* fs.chmod(directory, 0o700);
      }),
    ),
  );

  suite.effect('rejects malformed and oversized readiness before connecting', () =>
    Effect.gen(function* rejectInvalidResponse() {
      const malformed = yield* Effect.flip(Schema.decodeUnknownEffect(PrivacyCompletionReadySchema)({ type: 'ready' }));
      expect(Schema.is(PrivacyCompletionReadySchema)(malformed)).toBe(false);
      const payload = yield* fixtureReady();
      const oversized = yield* Effect.flip(
        sendPrivacyCompletionResponse('/not-used/response.sock', {
          ...payload,
          marker: 'x'.repeat(privacyCompletionResponseLimit),
        }),
      );
      expect(oversized.reason).toBe('Private response payload exceeds its bound');
    }),
  );
});
