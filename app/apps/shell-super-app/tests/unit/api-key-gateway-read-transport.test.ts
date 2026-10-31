// @rstest-environment node
import { makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpRouter,
  HttpServer,
} from '@modern-js/bff-effect/effect-edge';
import { Context, Effect, Layer, Result, Schema, Struct } from 'effect';
import { FetchHttpClient, HttpServerResponse } from 'effect/http';
import { BadRequest } from 'effect/http-api/HttpApiError';
import { expect, it } from 'effect-rstest';

import {
  API_KEY_GATEWAY_CONTEXT_HEADER,
  ApiKeyGatewayContextRequestSchema,
  GatewayAuthenticationRequiredProblemSchema,
  GatewayContextApiGroup,
  GatewayContextResponseSchema,
} from '@app/shared-contracts';
import type { GatewayContextProblem } from '@app/shared-contracts';

import { decodeApiKeyGatewayReadRequest } from '../../api/auth/api-key-gateway-read-transport.ts';
import type { ApiKeyGatewayReadRequest } from '../../api/auth/api-key-gateway-read-transport.ts';
import { relayModuleResponse } from '../../src/module-api/response-relay.ts';

const route = '/auth/api-key/gateway-read';
const origin = 'https://shell.test';
const legalEntityId = '71000000-0000-4000-8000-000000000024';
const compositionRevision = 'a'.repeat(64);
const envelope = {
  audience: 'merchandise',
  legalEntityId,
  query: { view: { storefront: true } },
  readName: 'records',
};
const encodeText = (text: string) => new TextEncoder().encode(text);
const encodeEnvelope = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const context = Schema.decodeSync(GatewayContextResponseSchema)({
  apiBaseUrl: '/shell-super-app-api/module-api/merchandise/build-1/merchandise-api',
  compositionRevision,
  expiresAt: 1_700_000_300,
  token: 'owner-assertion',
});
const encodedContext = Schema.encodeSync(Schema.fromJsonString(GatewayContextResponseSchema))(context);
const exactOwnerBody = encodeText('{\n  "name": "Příliš 😀", "number": 1e2, "escaped": "\\u0061"\n}\n');

const fixtureApi = HttpApi.make('GatewayReadByteFixture').add(
  HttpApiGroup.make('gatewayContext').add(GatewayContextApiGroup.endpoints.readWithApiKeyGatewayContext),
);
const ownerApi = HttpApi.make('GatewayReadOwnerFixture').add(
  HttpApiGroup.make('records').add(
    HttpApiEndpoint.post('execute', '/reads/records', {
      payload: Schema.Struct({ view: Schema.Struct({ storefront: Schema.Literal(true) }) }),
      success: Schema.Struct({ ok: Schema.Boolean }),
    }),
  ),
);

interface FixtureOptions {
  readonly gatewayProblem?: GatewayContextProblem;
  readonly ownerStatus?: number;
}

interface FixtureState {
  readonly admittedPayloads: ApiKeyGatewayReadRequest[];
  readonly incomingBodies: Uint8Array[];
  readonly issuerInputs: { readonly audience: string; readonly legalEntityId?: string }[];
  readonly ownerBodies: string[];
  readonly ownerRequests: Request[];
  readonly phases: ('authorization' | 'query-serialization')[];
}

const makeOwnerFixture = (options: FixtureOptions) => {
  const ownerHandlers = HttpApiBuilder.group(ownerApi, 'records', (handlers) =>
    handlers.handle('execute', () =>
      Effect.succeed(
        HttpServerResponse.uint8Array(exactOwnerBody, {
          headers: {
            'cache-control': 'public, max-age=3600',
            'content-type': 'application/json; charset=utf-8',
            etag: '"owner-byte-identity"',
            refresh: '0;url=https://untrusted.test',
            'retry-after': '3',
            'set-cookie': 'unreviewed=must-not-cross',
            'www-authenticate': 'Bearer realm="owner"',
            'x-unreviewed-owner-header': 'must-not-cross',
          },
          status: options.ownerStatus ?? 200,
        }),
      ),
    ),
  );
  return HttpRouter.toWebHandler(
    HttpApiBuilder.layer(ownerApi).pipe(Layer.provide(ownerHandlers), Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );
};

const makeGatewayHandler =
  (owner: ReturnType<typeof makeOwnerFixture>, state: FixtureState, options: FixtureOptions) =>
  ({
    headers,
    payload: payloadBytes,
    request,
  }: HttpApiEndpoint.Request<typeof GatewayContextApiGroup.endpoints.readWithApiKeyGatewayContext>) =>
    Effect.gen(function* fixtureGatewayReadHandler() {
      state.incomingBodies.push(payloadBytes);
      const payload = yield* decodeApiKeyGatewayReadRequest(payloadBytes);
      state.admittedPayloads.push(payload);
      state.phases.push('authorization');
      const issuerInput =
        payload.legalEntityId === undefined
          ? { audience: payload.audience }
          : { audience: payload.audience, legalEntityId: payload.legalEntityId };
      state.issuerInputs.push(issuerInput);
      if (options.gatewayProblem !== undefined) {
        return yield* Effect.fail(options.gatewayProblem);
      }
      if (headers['x-api-key'] !== 'credential') {
        return yield* Effect.fail(
          GatewayAuthenticationRequiredProblemSchema.make({
            detail: 'A valid API key is required.',
            status: 401,
            title: 'Authentication required',
            type: 'urn:ontos:test:gateway-authentication-required',
          }),
        );
      }
      state.phases.push('query-serialization');
      const body = yield* payload.ownerBody.pipe(Effect.orDie);
      const ownerRequest = new Request(`${origin}/reads/${encodeURIComponent(payload.readName)}`, {
        body,
        headers: {
          authorization: `Bearer ${context.token}`,
          'content-type': 'application/json',
          'x-correlation-id': request.headers['x-correlation-id'] ?? 'fixture-correlation',
          'x-ontos-composition-revision': context.compositionRevision,
        },
        method: 'POST',
      });
      state.ownerRequests.push(ownerRequest.clone());
      state.ownerBodies.push(body);
      const response = yield* Effect.promise(() => owner.handler(ownerRequest, Context.empty()));
      return HttpServerResponse.fromWeb(relayModuleResponse(response, origin)).pipe(
        HttpServerResponse.setHeader(API_KEY_GATEWAY_CONTEXT_HEADER, encodedContext),
        HttpServerResponse.setHeader('cache-control', 'no-store'),
      );
    });

const fixture = (options: FixtureOptions = {}) =>
  Effect.gen(function* gatewayReadHttpFixture() {
    const state: FixtureState = {
      admittedPayloads: [],
      incomingBodies: [],
      issuerInputs: [],
      ownerBodies: [],
      ownerRequests: [],
      phases: [],
    };
    const owner = yield* Effect.acquireRelease(
      Effect.sync(() => makeOwnerFixture(options)),
      (server) => Effect.promise(() => server.dispose()),
    );
    const handlers = HttpApiBuilder.group(fixtureApi, 'gatewayContext', (builder) =>
      builder.handle('readWithApiKeyGatewayContext', makeGatewayHandler(owner, state, options)),
    );
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(fixtureApi).pipe(Layer.provide(handlers), Layer.provide(HttpServer.layerServices)),
          { disableLogger: true },
        ),
      ),
      (webHandler) => Effect.promise(() => webHandler.dispose()),
    );
    const request = (body: string | Blob, apiKey = 'credential') =>
      Effect.promise(() =>
        server.handler(
          new Request(`${origin}${route}`, {
            body,
            headers: {
              authorization: 'Bearer must-not-forward',
              'content-type': 'application/json',
              cookie: 'unreviewed=must-not-forward',
              'x-api-key': apiKey,
              'x-correlation-id': 'caller-correlation',
              'x-unreviewed-header': 'must-not-forward',
            },
            method: 'POST',
          }),
          Context.empty(),
        ),
      );
    return { ...state, request, server };
  });

it.effect('privately decodes only the original metadata and preserves native JSON duplicate-key semantics', () =>
  Effect.gen(function* privateEnvelopeDecode() {
    const decoded = yield* decodeApiKeyGatewayReadRequest(
      encodeText(
        `{"audience":"ignored","audience":"merchandise","legalEntityId":"${legalEntityId}","compositionRevision":"${compositionRevision}","readName":"records","query":{"value":1},"query":{"value":2,"__proto__":{"safe":true}}}`,
      ),
    );
    expect(Struct.omit(decoded, ['ownerBody'])).toEqual({
      audience: 'merchandise',
      legalEntityId,
      readName: 'records',
    });
    expect(Object.hasOwn(decoded, 'query')).toBe(false);
    const query = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(yield* decoded.ownerBody);
    expect(query).toEqual({ ['__proto__']: { safe: true }, value: 2 });
    expect(Object.getPrototypeOf(query)).toBe(Object.prototype);
    const withBom = yield* decodeApiKeyGatewayReadRequest(encodeText(`\uFEFF${encodeEnvelope(envelope)}`));
    expect(Struct.omit(withBom, ['ownerBody'])).toEqual(Struct.omit(envelope, ['query']));
    expect(yield* withBom.ownerBody).toBe(encodeEnvelope(envelope.query));
  }),
);

it.live('strips injected old or malformed composition revisions before issuance and owner dispatch', () =>
  Effect.gen(function* injectedRevisionCannotPinRead() {
    const server = yield* fixture();
    for (const injectedRevision of ['b'.repeat(64), 'bad', null, 123]) {
      const body = encodeEnvelope({ ...envelope, compositionRevision: injectedRevision });
      const decoded = yield* decodeApiKeyGatewayReadRequest(encodeText(body));
      expect(Struct.omit(decoded, ['ownerBody'])).toEqual(Struct.omit(envelope, ['query']));
      expect(Object.hasOwn(decoded, 'query')).toBe(false);
      expect(yield* decoded.ownerBody).toBe(encodeEnvelope(envelope.query));
      const response = yield* server.request(body);
      expect(response.status).toBe(200);
      expect(server.admittedPayloads.map((payload) => Struct.omit(payload, ['ownerBody'])).at(-1)).toEqual(
        Struct.omit(envelope, ['query']),
      );
      expect(server.issuerInputs.at(-1)).toEqual({ audience: 'merchandise', legalEntityId });
      expect(server.ownerRequests.at(-1)?.headers.get('x-ontos-composition-revision')).toBe(compositionRevision);
      expect(response.headers.get(API_KEY_GATEWAY_CONTEXT_HEADER)).toBe(encodedContext);
      expect(new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))).toEqual(exactOwnerBody);
    }
    const withoutLegalEntity = yield* decodeApiKeyGatewayReadRequest(
      encodeText(
        encodeEnvelope({
          audience: 'merchandise',
          compositionRevision: 'b'.repeat(64),
          query: {},
          readName: 'records',
        }),
      ),
    );
    expect(Struct.omit(withoutLegalEntity, ['ownerBody'])).toEqual({ audience: 'merchandise', readName: 'records' });
    expect(yield* withoutLegalEntity.ownerBody).toBe('{}');
  }),
);

it.effect('keeps native UTF-8 replacement behavior and JSON query values without interpreting owner DTOs', () =>
  Effect.gen(function* nativeUtf8AndOpaqueQueries() {
    const bytes = Uint8Array.from([
      ...encodeText('{"audience":"merchandise","readName":"records","query":"'),
      255,
      ...encodeText('"}'),
    ]);
    const decoded = yield* decodeApiKeyGatewayReadRequest(bytes);
    expect(yield* decoded.ownerBody).toBe(encodeEnvelope('\uFFFD'));
    for (const query of [null, false, 3, 'owner-value', [], {}]) {
      const request = yield* decodeApiKeyGatewayReadRequest(encodeText(encodeEnvelope({ ...envelope, query })));
      expect(Object.hasOwn(request, 'query')).toBe(false);
      expect(yield* request.ownerBody).toBe(encodeEnvelope(query));
    }
  }),
);

it.effect('matches the original native envelope decoder and post-auth encoder without eager query recursion', () =>
  Effect.gen(function* originalEnvelopeAndLazyBodyCompatibility() {
    const previousEnvelope = Schema.Struct({
      audience: ApiKeyGatewayContextRequestSchema.fields.audience,
      legalEntityId: ApiKeyGatewayContextRequestSchema.fields.legalEntityId,
      query: Schema.Unknown,
      readName: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u), Schema.isMaxLength(200)),
    });
    const decodePrevious = Schema.decodeEffect(Schema.fromJsonString(previousEnvelope));
    const encodePrevious = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
    const nested = `${'['.repeat(4096)}0${']'.repeat(4096)}`;
    for (const query of ['null', 'true', '3.25', '"text"', '[]', '{"extension":[1,{"value":true}]}', '1e400', nested]) {
      const text = `{"audience":"merchandise","readName":"records","compositionRevision":"ignored","query":${query}}`;
      const previous = yield* decodePrevious(text);
      const current = yield* decodeApiKeyGatewayReadRequest(encodeText(text));
      expect(Struct.omit(current, ['ownerBody'])).toEqual(Struct.omit(previous, ['query']));
      expect(Object.hasOwn(current, 'query')).toBe(false);
      const previousBody = yield* Effect.result(encodePrevious(previous.query));
      const currentBody = yield* Effect.result(current.ownerBody);
      if (Result.isSuccess(previousBody)) {
        expect(Result.isSuccess(currentBody)).toBe(true);
        if (Result.isSuccess(currentBody)) {
          expect(currentBody.success).toBe(previousBody.success);
        }
      } else {
        expect(Result.isFailure(currentBody)).toBe(true);
        if (Result.isFailure(currentBody)) {
          expect(currentBody.failure.message).toBe(previousBody.failure.message);
        }
      }
    }
    const missingQuery = '{"audience":"merchandise","readName":"records"}';
    expect(Schema.isSchemaError(yield* Effect.flip(decodePrevious(missingQuery)))).toBe(true);
    expect(yield* Effect.flip(decodeApiKeyGatewayReadRequest(encodeText(missingQuery)))).toBeInstanceOf(BadRequest);
  }),
);

it.live('preserves the original whole HTTP envelope and exact owner response bytes and admitted headers', () =>
  Effect.gen(function* exactHttpBytes() {
    const server = yield* fixture({ ownerStatus: 206 });
    const body = `{\n "audience":"merchandise", "legalEntityId":"${legalEntityId}", "readName":"records", "query": { "view": { "storefront":true } }\n}`;
    const response = yield* server.request(body);
    expect(server.incomingBodies).toEqual([encodeText(body)]);
    expect(server.ownerBodies).toEqual(['{"view":{"storefront":true}}']);
    expect(response.status).toBe(206);
    expect(new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))).toEqual(exactOwnerBody);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('etag')).toBe('"owner-byte-identity"');
    expect(response.headers.get('retry-after')).toBe('3');
    expect(response.headers.get('www-authenticate')).toBe('Bearer realm="owner"');
    expect(response.headers.get(API_KEY_GATEWAY_CONTEXT_HEADER)).toBe(encodedContext);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('refresh')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('x-unreviewed-owner-header')).toBeNull();
    const ownerHeaders = server.ownerRequests[0]?.headers;
    expect(ownerHeaders?.get('authorization')).toBe('Bearer owner-assertion');
    expect(ownerHeaders?.get('x-correlation-id')).toBe('caller-correlation');
    expect(ownerHeaders?.get('x-ontos-composition-revision')).toBe(compositionRevision);
    expect(ownerHeaders?.get('x-api-key')).toBeNull();
    expect(ownerHeaders?.get('cookie')).toBeNull();
    expect(ownerHeaders?.get('x-unreviewed-header')).toBeNull();
  }),
);

it.live('uses raw bytes for generated clients without JSON quoting or a response wrapper', () =>
  Effect.gen(function* typedByteClient() {
    const server = yield* fixture();
    const bytes = encodeText(encodeEnvelope(envelope));
    const client = makeEffectHttpApiClient(fixtureApi, { baseUrl: origin });
    const result = yield* client.pipe(
      Effect.flatMap((generated) =>
        generated.gatewayContext.readWithApiKeyGatewayContext({
          headers: { 'x-api-key': 'credential' },
          payload: bytes,
        }),
      ),
      Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
        server.server.handler(new Request(input, init), Context.empty()),
      ),
    );
    expect(result).toEqual(exactOwnerBody);
    expect(server.incomingBodies).toEqual([bytes]);
  }),
);

it.live('rejects unauthorized requests before validating or serializing large opaque owner queries', () =>
  Effect.gen(function* authorizationBeforeOwnerQueryWork() {
    const server = yield* fixture();
    // Valid JSON syntax can parse to a non-finite number. Preserve the native post-auth
    // serializer's behavior without traversing this large query before authorization.
    const nested = `${'['.repeat(4096)}0${']'.repeat(4096)}`;
    const body = `{"audience":"merchandise","readName":"records","query":{"number":1e400,"nested":${nested}}}`;
    const response = yield* server.request(body, 'invalid-credential');
    expect(response.status).toBe(401);
    expect(server.phases).toEqual(['authorization']);
    expect(server.ownerBodies).toEqual([]);
    expect(server.ownerRequests).toEqual([]);
    expect(response.headers.get(API_KEY_GATEWAY_CONTEXT_HEADER)).toBeNull();
    const decoded = yield* decodeApiKeyGatewayReadRequest(encodeText(body));
    expect(Object.hasOwn(decoded, 'query')).toBe(false);
    expect(yield* decoded.ownerBody).toBe(`{"number":null,"nested":${nested}}`);
  }),
);

it.live('preserves native query serialization after authorization and leaves DTO validation to the owner', () =>
  Effect.gen(function* authorizedOwnerQueryValidation() {
    const server = yield* fixture();
    const body = '{"audience":"merchandise","readName":"records","query":{"number":1e400}}';
    const response = yield* server.request(body);
    expect(response.status).toBe(400);
    expect(server.phases).toEqual(['authorization', 'query-serialization']);
    expect(server.ownerBodies).toEqual(['{"number":null}']);
    expect(server.ownerRequests).toHaveLength(1);
  }),
);

it.live('keeps native request cancellation interruptible before body decoding and authorization', () =>
  Effect.gen(function* cancelledNativeByteRequest() {
    const server = yield* fixture();
    const body = yield* Effect.acquireRelease(
      Effect.sync(() => new TransformStream<Uint8Array, Uint8Array>()),
      (stream) => Effect.promise(() => stream.writable.abort()),
    );
    const abort = new AbortController();
    const init = {
      body: body.readable,
      duplex: 'half',
      headers: { 'content-type': 'application/json', 'x-api-key': 'credential' },
      method: 'POST',
      signal: abort.signal,
    };
    const pending = server.server.handler(new Request(`${origin}${route}`, init), Context.empty());
    abort.abort();
    const response = yield* Effect.promise(() => pending);
    expect(response.status).toBe(499);
    expect(server.incomingBodies).toEqual([]);
    expect(server.phases).toEqual([]);
    expect(server.ownerRequests).toEqual([]);
  }),
);

it.live('preserves owner error and non-default success statuses without re-encoding their bodies', () =>
  Effect.gen(function* rawOwnerStatuses() {
    for (const ownerStatus of [202, 400, 401, 403, 404, 409, 422, 429, 500, 503]) {
      const server = yield* fixture({ ownerStatus });
      const response = yield* server.request(encodeEnvelope(envelope));
      expect(response.status).toBe(ownerStatus);
      expect(new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))).toEqual(exactOwnerBody);
      expect(response.headers.get(API_KEY_GATEWAY_CONTEXT_HEADER)).toBe(encodedContext);
      expect(response.headers.get('etag')).toBe('"owner-byte-identity"');
    }
  }),
);

const invalidEnvelopes = [
  '',
  '{',
  '{"audience":"merchandise","readName":"records","query":',
  'null',
  '[]',
  '"not an envelope"',
  encodeEnvelope({ ...envelope, audience: 'https://other.test' }),
  encodeEnvelope({ ...envelope, audience: 3 }),
  encodeEnvelope({ ...envelope, legalEntityId: 'not-a-uuid' }),
  encodeEnvelope({ ...envelope, readName: '../actions/order' }),
  encodeEnvelope({ ...envelope, readName: 'https://other.test' }),
  encodeEnvelope({ ...envelope, readName: '%2e%2e' }),
  encodeEnvelope({ ...envelope, readName: 'records/../../actions' }),
  encodeEnvelope({ ...envelope, readName: 'a'.repeat(201) }),
  '{"audience":"merchandise","readName":"records"}',
];

it.live('returns native HTTP 400 before admission or owner dispatch for malformed bodies and metadata', () =>
  Effect.gen(function* nativeMalformedPayloads() {
    const server = yield* fixture();
    for (const body of invalidEnvelopes) {
      const failure = yield* Effect.flip(decodeApiKeyGatewayReadRequest(encodeText(body)));
      expect(failure).toBeInstanceOf(BadRequest);
      const response = yield* server.request(body);
      expect(response.status).toBe(400);
      expect(yield* Effect.promise(() => response.text())).toBe('');
      expect(response.headers.get(API_KEY_GATEWAY_CONTEXT_HEADER)).toBeNull();
    }
    const malformedUtf8 = yield* server.request(new Blob([Uint8Array.of(255)]));
    expect(malformedUtf8.status).toBe(400);
    expect(yield* Effect.promise(() => malformedUtf8.text())).toBe('');
    expect(server.admittedPayloads).toEqual([]);
    expect(server.ownerRequests).toEqual([]);
    expect(server.phases).toEqual([]);
  }),
);

it.live('decodes native empty 400 failures for generated byte clients separately from Gateway Problem Details', () =>
  Effect.gen(function* generatedNativeBadRequest() {
    const server = yield* fixture();
    const client = makeEffectHttpApiClient(fixtureApi, { baseUrl: origin });
    const failure = yield* Effect.flip(
      client.pipe(
        Effect.flatMap((generated) =>
          generated.gatewayContext.readWithApiKeyGatewayContext({
            headers: { 'x-api-key': 'credential' },
            payload: encodeText('{'),
          }),
        ),
        Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
          server.server.handler(new Request(input, init), Context.empty()),
        ),
      ),
    );
    expect(failure).toBeInstanceOf(BadRequest);
    expect(server.ownerRequests).toEqual([]);
  }),
);

it.live('leaves invalid owner DTOs to concrete native owner decoding and retains its status and assertion', () =>
  Effect.gen(function* concreteOwnerValidation() {
    const server = yield* fixture();
    const body = encodeEnvelope({ ...envelope, query: { view: { storefront: 'invalid-owner-value' } } });
    const response = yield* server.request(body);
    expect(response.status).toBe(400);
    expect(yield* Effect.promise(() => response.text())).toBe('');
    expect(response.headers.get(API_KEY_GATEWAY_CONTEXT_HEADER)).toBe(encodedContext);
    expect(server.admittedPayloads).toHaveLength(1);
    expect(server.ownerBodies).toEqual(['{"view":{"storefront":"invalid-owner-value"}}']);
  }),
);

it.live('preserves the complete declared Gateway problem statuses and JSON bodies', () =>
  Effect.gen(function* gatewayProblemTransport() {
    const problems: readonly GatewayContextProblem[] = [
      {
        _tag: 'GatewayAudienceInvalidProblem',
        detail: 'Invalid audience.',
        status: 400,
        title: 'Invalid audience',
        type: 'urn:ontos:test:invalid',
      },
      {
        _tag: 'GatewayAuthenticationRequiredProblem',
        detail: 'API key required.',
        status: 401,
        title: 'Authentication required',
        type: 'urn:ontos:test:authentication',
      },
      {
        _tag: 'GatewayForbiddenProblem',
        detail: 'Forbidden.',
        status: 403,
        title: 'Forbidden',
        type: 'urn:ontos:test:forbidden',
      },
      {
        _tag: 'GatewayReloadRequiredProblem',
        detail: 'Reload.',
        reloadRequired: true,
        status: 409,
        title: 'Reload required',
        type: 'urn:ontos:test:reload',
      },
      {
        _tag: 'GatewayRateLimitedProblem',
        detail: 'Retry later.',
        retryAfterSeconds: 3,
        status: 429,
        title: 'Rate limited',
        type: 'urn:ontos:test:rate-limit',
      },
      {
        _tag: 'GatewayInternalProblem',
        detail: 'Internal error.',
        status: 500,
        title: 'Internal error',
        type: 'urn:ontos:test:internal',
      },
      {
        _tag: 'GatewayUnavailableProblem',
        detail: 'Unavailable.',
        retryable: true,
        status: 503,
        title: 'Unavailable',
        type: 'urn:ontos:test:unavailable',
      },
    ];
    for (const problem of problems) {
      const server = yield* fixture({ gatewayProblem: problem });
      const response = yield* server.request(encodeEnvelope(envelope));
      expect(response.status).toBe(problem.status);
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      expect(yield* Effect.promise(() => response.json())).toEqual(problem);
      expect(server.ownerRequests).toEqual([]);
      const client = makeEffectHttpApiClient(fixtureApi, { baseUrl: origin });
      const failure = yield* Effect.flip(
        client.pipe(
          Effect.flatMap((generated) =>
            generated.gatewayContext.readWithApiKeyGatewayContext({
              headers: { 'x-api-key': 'credential' },
              payload: encodeText(encodeEnvelope(envelope)),
            }),
          ),
          Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
            server.server.handler(new Request(input, init), Context.empty()),
          ),
        ),
      );
      expect(failure).toEqual(problem);
    }
  }),
);
