import { auth, Client, discoverAuthorizationServerMetadata, refreshAuthorization } from '@modelcontextprotocol/client';
import type { StoredOAuthTokens } from '@modelcontextprotocol/client';
import { Cause, Effect, Exit, FiberSet, Option, Redacted, Schema, Scope } from 'effect';
import { expect, it, rs } from 'effect-rstest';
import { rotateRefreshToken, runOAuthFlow } from '../demo/mcp-oauth-e2e/flow.mts';
import { callJson } from '../demo/mcp-oauth-e2e/mcp.mts';
import { E2eOAuthProvider } from '../demo/mcp-oauth-e2e/provider.mts';
import type { E2eOAuthProviderRuntime } from '../demo/mcp-oauth-e2e/provider.mts';

// Keep the native Client and content guards; only the OAuth network operations are replaced below.
rs.mock('@modelcontextprotocol/client', { spy: true });

const providerOptions = {
  clientMetadataUrl: 'https://client.example/metadata.json',
  clientName: 'oauth-boundary-regression',
  redirectUrl: 'http://localhost/callback',
};

it.live('reads the current verifier through the native SDK callback in its owning Scope', () =>
  Effect.gen(function* currentVerifier() {
    const runtime = yield* FiberSet.makeRuntimePromise<never, string, Cause.NoSuchElementError>();
    const provider = new E2eOAuthProvider(providerOptions, runtime);
    provider.saveCodeVerifier('first-verifier');
    expect(yield* Effect.tryPromise(async () => await provider.codeVerifier())).toBe('first-verifier');
    provider.saveCodeVerifier('replacement-verifier');
    expect(yield* Effect.tryPromise(async () => await provider.codeVerifier())).toBe('replacement-verifier');
  }).pipe(Effect.scoped),
);

it.live('rejects a missing verifier with the original typed failure squashed by the native runner', () =>
  Effect.gen(function* missingVerifier() {
    const runtime = yield* FiberSet.makeRuntimePromise<never, string, Cause.NoSuchElementError>();
    let observedFailure = Option.none<Cause.NoSuchElementError>();
    const observeRuntime: E2eOAuthProviderRuntime = (effect, options) =>
      runtime(
        effect.pipe(
          Effect.tapError((verifierFailure) =>
            Effect.sync(() => {
              observedFailure = Option.some(verifierFailure);
            }),
          ),
        ),
        options,
      );
    const provider = new E2eOAuthProvider(providerOptions, observeRuntime);
    const rejected = yield* Effect.tryPromise(async () => await provider.codeVerifier()).pipe(Effect.flip);
    const original = yield* Effect.fromOption(observedFailure);
    expect(Cause.isNoSuchElementError(rejected.cause)).toBe(true);
    expect(original.message).toBe('Chybí code verifier.');
    expect(rejected.cause).toBe(original);
    expect(rejected.cause).toBe(Cause.squash(Cause.fail(original)));
  }).pipe(Effect.scoped),
);

it.live('rejects a verifier callback after its owner Scope closes instead of leaving the Promise pending', () =>
  Effect.gen(function* closedVerifierOwner() {
    const provider = yield* Effect.gen(function* createOwnedProvider() {
      const runtime = yield* FiberSet.makeRuntimePromise<never, string, Cause.NoSuchElementError>();
      const owned = new E2eOAuthProvider(providerOptions, runtime);
      owned.saveCodeVerifier('must-not-be-returned-after-close');
      return owned;
    }).pipe(Effect.scoped);
    const rejected = yield* Effect.tryPromise(async () => await provider.codeVerifier()).pipe(
      Effect.flip,
      Effect.timeout('1 second'),
    );
    expect(rejected.cause).toMatchObject({ message: 'All fibers interrupted without error' });
  }),
);

it.live('keeps the returned flow provider alive for refresh until the caller Scope closes', () =>
  Effect.gen(function* flowOwnerLifetime() {
    const authorizationEndpoint = 'https://issuer.example/authorize';
    const issuerUrl = 'https://issuer.example';
    const initialTokens: StoredOAuthTokens = {
      access_token: 'initial-access-token',
      refresh_token: 'initial-refresh-token',
      token_type: 'Bearer',
    };
    const nextTokens: StoredOAuthTokens = {
      access_token: 'refreshed-access-token',
      refresh_token: 'rotated-refresh-token',
      token_type: 'Bearer',
    };
    const authorize = rs
      .mocked(auth)
      .mockReset()
      .mockImplementation(async (provider, options) => {
        if (options.authorizationCode === undefined) {
          await provider.saveCodeVerifier('flow-verifier');
          await provider.redirectToAuthorization(new URL(authorizationEndpoint));
          return 'REDIRECT';
        }
        expect(options.authorizationCode).toBe('callback-code');
        expect(await provider.codeVerifier()).toBe('flow-verifier');
        await provider.saveTokens(initialTokens);
        return 'AUTHORIZED';
      });
    const discovery = rs
      .mocked(discoverAuthorizationServerMetadata)
      .mockReset()
      .mockResolvedValue({
        authorization_endpoint: authorizationEndpoint,
        issuer: issuerUrl,
        response_types_supported: ['code'],
        token_endpoint: 'https://issuer.example/token',
      });
    const refresh = rs.mocked(refreshAuthorization).mockReset();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        authorize.mockReset();
        discovery.mockReset();
        refresh.mockReset();
      }),
    );
    const owner = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void));
    const approvals: string[] = [];
    const callbackTimeouts: number[] = [];
    const result = yield* runOAuthFlow({
      approve: (url) =>
        Effect.sync(() => {
          approvals.push(url.href);
        }),
      loopback: {
        close: Effect.void,
        redirectUrl: providerOptions.redirectUrl,
        waitForCallback: (timeoutMs) =>
          Effect.sync(() => {
            callbackTimeouts.push(timeoutMs);
            return new URLSearchParams({
              code: 'callback-code',
              iss: issuerUrl,
              state: 'callback-state',
            });
          }),
      },
      providerOptions,
      serverUrl: 'https://resource.example/mcp',
    }).pipe(Scope.provide(owner));
    expect(approvals).toEqual([authorizationEndpoint]);
    expect(callbackTimeouts).toEqual([180_000]);
    expect(authorize).toHaveBeenCalledTimes(2);
    // This executes after runOAuthFlow has returned, when an inner Scope would already be closed.
    result.provider.saveCodeVerifier('verifier-after-flow-return');
    refresh.mockImplementation(async (_issuer, options) => {
      expect(await result.provider.codeVerifier()).toBe('verifier-after-flow-return');
      expect(options.refreshToken).toBe('initial-refresh-token');
      expect(options.clientInformation.client_id).toBe(providerOptions.clientMetadataUrl);
      return nextTokens;
    });
    const rotated = yield* rotateRefreshToken({
      issuer: issuerUrl,
      provider: result.provider,
      resource: 'https://resource.example/mcp',
    });
    expect(Redacted.value(rotated.accessToken)).toBe('refreshed-access-token');
    expect(yield* result.provider.currentTokens()).toBe(nextTokens);
    expect(refresh).toHaveBeenCalledTimes(1);
    yield* Scope.close(owner, Exit.void);
    const rejected = yield* Effect.tryPromise(async () => await result.provider.codeVerifier()).pipe(
      Effect.flip,
      Effect.timeout('1 second'),
    );
    expect(rejected.cause).toMatchObject({ message: 'All fibers interrupted without error' });
  }).pipe(Effect.scoped),
);

type NativeToolReply = Awaited<ReturnType<Client['callTool']>>;

it.live('preserves optional structuredContent and native JSON values with the text fallback', () =>
  Effect.gen(function* nativeStructuredContent() {
    const client = new Client({ name: 'mcp-boundary-regression', version: '1.0.0' });
    const callTool = yield* Effect.acquireRelease(
      Effect.sync(() => rs.spyOn(client, 'callTool')),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
    const plainText = 'plain text';
    const cases: readonly {
      readonly expected: Schema.Json;
      readonly label: string;
      readonly reply: NativeToolReply;
    }[] = [
      {
        expected: { fallback: true },
        label: 'missing',
        reply: { content: [{ text: '{"fallback":true}', type: 'text' }] },
      },
      {
        expected: 7,
        label: 'undefined',
        // A native data descriptor defaults to undefined but still creates an own, enumerable property.
        reply: Object.defineProperty({ content: [{ text: '7', type: 'text' }] }, 'structuredContent', {
          enumerable: true,
        }),
      },
      { expected: plainText, label: plainText, reply: { content: [{ text: plainText, type: 'text' }] } },
      {
        expected: null,
        label: 'null',
        reply: { content: [{ text: 'fallback', type: 'text' }], structuredContent: null },
      },
      {
        expected: [null, { count: 1 }],
        label: 'array',
        reply: { content: [], structuredContent: [null, { count: 1 }] },
      },
      { expected: 0, label: 'number', reply: { content: [], structuredContent: 0 } },
      { expected: false, label: 'boolean', reply: { content: [], structuredContent: false } },
      { expected: '', label: 'string', reply: { content: [], structuredContent: '' } },
      {
        expected: { result: 'native' },
        label: 'object',
        reply: { content: [], structuredContent: { result: 'native' } },
      },
    ];
    for (const testCase of cases) {
      callTool.mockResolvedValue(testCase.reply);
      const outcome = yield* callJson(client, 'ontos_read', { id: testCase.label });
      expect(outcome.value).toEqual(testCase.expected);
      expect(outcome.isError).toBe(false);
    }
    callTool.mockResolvedValue({
      content: [
        { text: 'first', type: 'text' },
        { data: 'aWdub3JlZA==', mimeType: 'image/png', type: 'image' },
        { text: 'second', type: 'text' },
      ],
      isError: true,
    });
    expect(yield* callJson(client, 'ontos_read')).toEqual({
      isError: true,
      text: 'first\nsecond',
      value: 'first\nsecond',
    });
    expect(callTool).toHaveBeenCalledTimes(cases.length + 1);
  }).pipe(Effect.scoped),
);

it.live('rejects malformed non-JSON structuredContent instead of accepting valid fallback text', () =>
  Effect.gen(function* malformedStructuredContent() {
    const client = new Client({ name: 'mcp-boundary-regression', version: '1.0.0' });
    const callTool = yield* Effect.acquireRelease(
      Effect.sync(() => rs.spyOn(client, 'callTool')),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
    // Unlike an omitted key, this native descriptor creates an own undefined-valued JSON member.
    for (const structuredContent of [
      () => 'not JSON',
      Object.defineProperty({}, 'invalid', { enumerable: true }),
      Number.NaN,
    ]) {
      callTool.mockResolvedValue({ content: [{ text: '{"valid":"fallback"}', type: 'text' }], structuredContent });
      const failure = yield* callJson(client, 'ontos_read').pipe(Effect.flip);
      expect(Schema.isSchemaError(failure)).toBe(true);
    }
    expect(callTool).toHaveBeenCalledTimes(3);
  }).pipe(Effect.scoped),
);
