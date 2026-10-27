import { NodeServices } from '@effect/platform-node';
import { Effect, Fiber, FiberSet, FileSystem, Redacted } from 'effect';
import type { Cause } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it, rs } from 'effect-rstest';
import { refreshIsRejected } from './flow.mts';
import { E2eOAuthProvider } from './provider.mts';
import { proofToolCall } from './tool-call.mts';

const issuer = 'https://issuer.example';
const privateDiagnostic = 'private-provider-diagnostic';
const storedTokens = {
  access_token: 'original-access',
  refresh_token: 'original-refresh',
  token_type: 'Bearer',
};
const metadata = {
  authorization_endpoint: `${issuer}/authorize`,
  issuer,
  response_types_supported: ['code'],
  token_endpoint: `${issuer}/token`,
};
const stableWrite = { id: 'work.tasks/command/CreateTask', idempotencyKey: 'same-operation' };

const replayFixture = Effect.gen(function* makeReplayFixture() {
  const fetch = yield* Effect.acquireRelease(
    Effect.sync(() => rs.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected HTTP request'))),
    (spy) => Effect.sync(() => spy.mockRestore()),
  );
  fetch.mockResolvedValueOnce(Response.json(metadata));
  const runtime = yield* FiberSet.makeRuntimePromise<never, string, Cause.NoSuchElementError>();
  const provider = new E2eOAuthProvider(
    {
      clientMetadataUrl: 'https://client.example/metadata.json',
      clientName: 'refresh-rejection-regression',
      redirectUrl: 'http://localhost/callback',
    },
    runtime,
  );
  provider.saveTokens(storedTokens);
  const replay = refreshIsRejected({
    issuer,
    provider,
    refreshToken: Redacted.make(storedTokens.refresh_token),
    resource: 'https://resource.example/mcp',
  });
  return { fetch, provider, replay };
});

it.effect('accepts only a real SDK invalid_grant rejection as refresh-replay evidence without saving tokens', () =>
  Effect.gen(function* invalidGrantEvidence() {
    const { fetch, provider, replay } = yield* replayFixture;
    fetch.mockResolvedValueOnce(
      Response.json({ error: 'invalid_grant', error_description: privateDiagnostic }, { status: 400 }),
    );
    expect(yield* replay).toBe(true);
    expect(yield* provider.currentTokens()).toBe(storedTokens);
    expect(fetch).toHaveBeenCalledTimes(2);
  }).pipe(Effect.scoped),
);

it.effect('reports a successful replay as failed rejection evidence and never saves the returned token pair', () =>
  Effect.gen(function* successfulReplayIsNotRejection() {
    const { fetch, provider, replay } = yield* replayFixture;
    fetch.mockResolvedValueOnce(
      Response.json({ access_token: 'must-not-be-saved', refresh_token: 'must-not-be-saved', token_type: 'Bearer' }),
    );
    expect(yield* replay).toBe(false);
    expect(yield* provider.currentTokens()).toBe(storedTokens);
    expect(fetch).toHaveBeenCalledTimes(2);
  }).pipe(Effect.scoped),
);

for (const error of ['invalid_client', 'server_error']) {
  it.effect(`keeps ${error} as a typed failure rather than accepting it as refresh-replay evidence`, () =>
    Effect.gen(function* unrelatedOAuthError() {
      const { fetch, provider, replay } = yield* replayFixture;
      fetch.mockResolvedValueOnce(Response.json({ error, error_description: privateDiagnostic }, { status: 400 }));
      const failure = yield* replay.pipe(Effect.flip);
      expect(failure.message).toContain('invalid_grant rejection');
      expect(failure.message).not.toContain(privateDiagnostic);
      expect(yield* provider.currentTokens()).toBe(storedTokens);
      expect(fetch).toHaveBeenCalledTimes(2);
    }).pipe(Effect.scoped),
  );
}

it.effect('keeps a network error mentioning invalid_grant as a typed failure, never rejection evidence', () =>
  Effect.gen(function* transportFailureIsNotRejection() {
    const { fetch, provider, replay } = yield* replayFixture;
    fetch.mockRejectedValueOnce(new TypeError(`invalid_grant ${privateDiagnostic}`));
    const failure = yield* replay.pipe(Effect.flip);
    expect(failure.message).toContain('invalid_grant rejection');
    expect(failure.message).not.toContain(privateDiagnostic);
    expect(yield* provider.currentTokens()).toBe(storedTokens);
    expect(fetch).toHaveBeenCalledTimes(2);
  }).pipe(Effect.scoped),
);

it.effect('bounds an uncertain write at 30 seconds, interrupts it, and never retries it despite a stable key', () =>
  Effect.gen(function* uncertainWriteDeadline() {
    let attempts = 0;
    let interrupted = false;
    const invoke = Effect.suspend(() => {
      attempts += 1;
      return Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true;
          }),
        ),
      );
    });
    const fiber = yield* proofToolCall('ontos_execute', stableWrite, invoke).pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust('30 seconds');
    const failure = yield* Fiber.join(fiber);
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain('deadline exceeded');
    expect(failure.message).toContain('remote outcome unknown');
    expect(attempts).toBe(1);
    expect(interrupted).toBe(true);
    yield* TestClock.adjust('1 second');
    expect(attempts).toBe(1);
  }),
);

it.layer(NodeServices.layer)('remote revocation proof preservation', (suite) => {
  for (const file of ['prove.mts', 'prove-agent-entity.mts']) {
    suite.effect(`${file} requires both 401 and invalid_token within the original grace window`, () =>
      Effect.gen(function* verifyRevocationPredicate() {
        const fs = yield* FileSystem.FileSystem;
        const source = yield* fs.readFileString(new URL(file, import.meta.url).pathname);
        expect(source).toMatch(
          /response\.status === 401\s*&&\s*Option\.getOrElse\(response\.wwwAuthenticate, \(\) => ''\)\.includes\('error="invalid_token"'\)/u,
        );
        expect(source).toContain('35_000_000_000n');
        expect(source).toContain('Clock.monotonicTimeNanos');
        expect(source).not.toContain('asdescribeValue');
      }),
    );
  }
});
