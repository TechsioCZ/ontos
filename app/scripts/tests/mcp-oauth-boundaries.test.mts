import { Client } from '@modelcontextprotocol/client';
import type { FetchLike, StoredOAuthTokens } from '@modelcontextprotocol/client';
import { Cause, Effect, Exit, FiberSet, Option, Redacted, Schema, Scope } from 'effect';
import { expect, it, rs } from 'effect-rstest';
import { rotateRefreshToken, runOAuthFlow } from '../demo/mcp-oauth-e2e/flow.mts';
import { callJson } from '../demo/mcp-oauth-e2e/mcp.mts';
import { E2eOAuthProvider } from '../demo/mcp-oauth-e2e/provider.mts';
import type { E2eOAuthProviderRuntime } from '../demo/mcp-oauth-e2e/provider.mts';

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

/** The S256 code challenge of `verifier` (RFC 7636 §4.2). */
const s256 = (verifier: string) =>
  Effect.promise(async () => await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).pipe(
    Effect.map((digest) => Buffer.from(digest).toString('base64url')),
  );

it.live('keeps the returned flow provider alive for refresh until the caller Scope closes', () =>
  Effect.gen(function* flowOwnerLifetime() {
    const authorizationEndpoint = 'https://issuer.example/authorize';
    const issuerUrl = 'https://issuer.example';
    const resourceUrl = 'https://resource.example/mcp';
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
    /** What the authorization server's token endpoint received, one form per grant. */
    const grants: URLSearchParams[] = [];
    /** The verifier the flow's provider held while the refresh grant was being answered. */
    const verifiersDuringRefresh: string[] = [];
    let flowProvider = Option.none<E2eOAuthProvider>();
    const metadata = {
      authorization_endpoint: authorizationEndpoint,
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      issuer: issuerUrl,
      response_types_supported: ['code'],
      token_endpoint: 'https://issuer.example/token',
      token_endpoint_auth_methods_supported: ['none'],
    };
    const tokenAnswer = (form: URLSearchParams) =>
      Effect.gen(function* answerGrant() {
        grants.push(form);
        if (form.get('grant_type') === 'refresh_token') {
          const provider = yield* Effect.fromOption(flowProvider);
          verifiersDuringRefresh.push(yield* Effect.tryPromise(async () => await provider.codeVerifier()));
          return Response.json(nextTokens);
        }
        return Response.json(initialTokens);
      });
    /** The resource and authorization server as the SDK reaches them through its fetch. */
    const answer = (url: string | URL, init?: RequestInit) =>
      Effect.gen(function* serve() {
        const target = new URL(String(url));
        if (target.pathname.startsWith('/.well-known/oauth-protected-resource')) {
          return Response.json({ authorization_servers: [issuerUrl], resource: resourceUrl });
        }
        if (target.origin === issuerUrl && target.pathname.startsWith('/.well-known/')) {
          return Response.json(metadata);
        }
        if (target.href === metadata.token_endpoint) {
          const form = yield* Effect.promise(async () => await new Request(target, init).text());
          return yield* tokenAnswer(new URLSearchParams(form));
        }
        return new Response(null, { status: 404 });
      });
    const run = yield* FiberSet.makeRuntimePromise<never, Response, Cause.NoSuchElementError | Cause.UnknownError>();
    const fetchFn: FetchLike = (url, init) => run(answer(url, init));

    const owner = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void));
    const approvals: URL[] = [];
    const callbackTimeouts: number[] = [];
    const result = yield* runOAuthFlow({
      approve: (url) =>
        Effect.sync(() => {
          approvals.push(url);
        }),
      fetchFn,
      loopback: {
        close: Effect.void,
        redirectUrl: providerOptions.redirectUrl,
        waitForCallback: (timeoutMs) =>
          Effect.sync(() => {
            callbackTimeouts.push(timeoutMs);
            return new URLSearchParams({
              code: 'callback-code',
              iss: issuerUrl,
              state: approvals[0]?.searchParams.get('state') ?? 'callback-state',
            });
          }),
      },
      providerOptions,
      serverUrl: resourceUrl,
    }).pipe(Scope.provide(owner));
    flowProvider = Option.some(result.provider);
    // One consent at the authorization endpoint, for this client and its PKCE challenge.
    expect(approvals.map((url) => `${url.origin}${url.pathname}`)).toEqual([authorizationEndpoint]);
    expect(approvals[0]?.searchParams.get('client_id')).toBe(providerOptions.clientMetadataUrl);
    expect(approvals[0]?.searchParams.get('code_challenge_method')).toBe('S256');
    expect(callbackTimeouts).toEqual([180_000]);
    // The code was redeemed once, with the verifier the provider saved when it redirected.
    const [exchange] = grants;
    expect(grants).toHaveLength(1);
    expect(exchange?.get('grant_type')).toBe('authorization_code');
    expect(exchange?.get('code')).toBe('callback-code');
    expect(yield* s256(exchange?.get('code_verifier') ?? '')).toBe(approvals[0]?.searchParams.get('code_challenge'));
    expect(Redacted.value(result.accessToken)).toBe('initial-access-token');
    // This executes after runOAuthFlow has returned, when an inner Scope would already be closed.
    result.provider.saveCodeVerifier('verifier-after-flow-return');
    const rotated = yield* rotateRefreshToken({
      fetchFn,
      issuer: issuerUrl,
      provider: result.provider,
      resource: resourceUrl,
    });
    expect(verifiersDuringRefresh).toEqual(['verifier-after-flow-return']);
    expect(grants).toHaveLength(2);
    expect(grants[1]?.get('refresh_token')).toBe('initial-refresh-token');
    expect(grants[1]?.get('client_id')).toBe(providerOptions.clientMetadataUrl);
    expect(Redacted.value(rotated.accessToken)).toBe('refreshed-access-token');
    expect(yield* result.provider.currentTokens()).toMatchObject(nextTokens);
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
