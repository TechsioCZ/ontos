import { NodeServices } from '@effect/platform-node';
import { Cause, Effect, Fiber, FiberSet, FileSystem, Redacted } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it, rs } from 'effect-rstest';
import { refreshIsRejected } from './flow.mts';
import { E2eOAuthProvider } from './provider.mts';
import { Recorder } from './report.mts';
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

it.effect('names what answered an unclassified failure: status, body excerpt and who answered, never a token', () =>
  Effect.gen(function* unclassifiedFailure() {
    // What the SDK throws for an error answer, carrying the body the proof's fetch annotated.
    const answer = Object.assign(
      new Error(
        'Error POSTing to endpoint: [server=nginx; via=-; content-type=text/html] <html>502 Bad Gateway</html>',
      ),
      {
        code: 'CLIENT_HTTP_NOT_IMPLEMENTED',
        data: {
          status: 502,
          statusText: 'Bad Gateway',
          text: '[server=nginx; via=-; content-type=text/html] <html>502 Bad Gateway</html> Bearer secret-token',
        },
        name: 'SdkHttpError',
      },
    );
    const failure = yield* proofToolCall(
      'ontos_execute',
      stableWrite,
      Effect.fail(new Cause.UnknownError(answer)),
    ).pipe(Effect.flip);
    expect(failure.message).toContain('HTTP 502 Bad Gateway');
    expect(failure.message).toContain('server=nginx');
    expect(failure.message).toContain('code=CLIENT_HTTP_NOT_IMPLEMENTED');
    expect(failure.message).not.toContain('secret-token');
    expect(failure.retryable).toBe(false);
    // A reset before any response byte, wrapped by the SDK, is still a transport failure of a stable write.
    const reset = Object.assign(new Error('wrapped'), {
      cause: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' }, name: 'TypeError' }),
      name: 'SdkError',
    });
    // (A read, so no same-key retry runs here; a stable write would be retried once.)
    const resetFailure = yield* proofToolCall(
      'ontos_read',
      stableWrite,
      Effect.fail(new Cause.UnknownError(reset)),
    ).pipe(Effect.flip);
    expect(resetFailure.message).toContain('transport ECONNRESET before any response');
  }),
);

it.effect('a step that passed only on a same-key retry says so in its own line', () =>
  Effect.gen(function* retriedStep() {
    let attempts = 0;
    const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' }, name: 'TypeError' });
    const invoke = Effect.suspend(() => {
      attempts += 1;
      return attempts === 1 ? Effect.fail(new Cause.UnknownError(reset)) : Effect.succeed('executed');
    });
    const recorder = new Recorder();
    const step = yield* recorder
      .stepEffect(
        'v1',
        'zápis s opakováním',
        proofToolCall('ontos_execute', stableWrite, invoke).pipe(
          Effect.map((value) => ({ detail: value, pass: value === 'executed' })),
        ),
      )
      .pipe(Effect.forkChild);
    yield* TestClock.adjust('1 second');
    yield* Fiber.join(step);
    expect(attempts).toBe(2);
    const [line] = recorder.steps;
    expect(line?.pass).toBe(true);
    expect(line?.detail).toContain('po opakování');
    expect(line?.detail).toContain('transport ECONNRESET before any response');
  }),
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
