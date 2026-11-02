import { Config, Effect, Schema } from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/http';

/** Task-owned client identity. Remove this route when the AKROS isolation proof is retired. */
export const STAGE_CIMD_FIXTURE_PATH = '/_host/fixtures/akros-isolation-20261102/client-metadata.json';
const STAGE_ORIGIN = 'https://ontos-stage.web-revolution.cz';
export const STAGE_CIMD_FIXTURE_URL = `${STAGE_ORIGIN}${STAGE_CIMD_FIXTURE_PATH}`;

// Fixed public metadata only. Never derive client identity, redirects or scopes from a request.
const ClientMetadata = Schema.Struct({
  client_id: Schema.String,
  client_name: Schema.String,
  grant_types: Schema.Array(Schema.Literal('authorization_code')),
  redirect_uris: Schema.Array(Schema.Literal('http://localhost/callback')),
  response_types: Schema.Array(Schema.Literal('code')),
  scope: Schema.Literal('ontos'),
  token_endpoint_auth_method: Schema.Literal('none'),
});
const metadata: typeof ClientMetadata.Type = {
  client_id: STAGE_CIMD_FIXTURE_URL,
  client_name: 'AKROS isolation proof 20261102',
  grant_types: ['authorization_code'],
  redirect_uris: ['http://localhost/callback'],
  response_types: ['code'],
  scope: 'ontos',
  token_endpoint_auth_method: 'none',
};
const headers = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
};

/** Infrastructure response, not a business API, registration endpoint or authorization exception. */
export const stageCimdFixtureResponse = Effect.gen(function* stageCimdFixtureResponse() {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const environment = yield* Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT').pipe(Config.withDefault(''));
  const origin = yield* Config.String('ONTOS_PUBLIC_ORIGIN').pipe(Config.withDefault(''));
  if (environment !== 'stage' || origin !== STAGE_ORIGIN || request.url !== STAGE_CIMD_FIXTURE_PATH) {
    return HttpServerResponse.empty({ headers: { 'cache-control': 'no-store' }, status: 404 });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return HttpServerResponse.empty({
      headers: { allow: 'GET, HEAD', 'cache-control': 'no-store' },
      status: 405,
    });
  }
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ClientMetadata))(metadata);
  return request.method === 'HEAD'
    ? HttpServerResponse.empty({ headers: { ...headers, 'content-length': String(encoded.length) }, status: 200 })
    : HttpServerResponse.text(encoded, { headers });
});
