import { ConfigProvider, Effect, Option, Ref } from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/http';
import { describe, expect, it } from 'effect-rstest';

import { hostApplication } from '../zerops/app-host.mts';
import {
  STAGE_CIMD_FIXTURE_PATH,
  STAGE_CIMD_FIXTURE_URL,
  stageCimdFixtureResponse,
} from '../zerops/stage-cimd-fixture.mts';

const stage = {
  ONTOS_PUBLIC_ORIGIN: 'https://ontos-stage.web-revolution.cz',
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
};
const responseFor = (
  environment: Record<string, string>,
  method = 'GET',
  suffix = '',
  headers: Record<string, string> = {},
) =>
  stageCimdFixtureResponse.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request(`${STAGE_CIMD_FIXTURE_URL}${suffix}`, { headers, method })),
    ),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))),
  );

describe('task-owned stage CIMD fixture', () => {
  it.effect('serves fixed public client metadata without cookies, credentials or registration', () =>
    Effect.gen(function* publicMetadata() {
      const response = yield* responseFor(stage);
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(response.headers['set-cookie']).toBeUndefined();
      const body: unknown = yield* Effect.promise(() => HttpServerResponse.toWeb(response).json());
      expect(body).toEqual({
        client_id: STAGE_CIMD_FIXTURE_URL,
        client_name: 'AKROS isolation proof 20261102',
        grant_types: ['authorization_code'],
        redirect_uris: ['http://localhost/callback'],
        response_types: ['code'],
        scope: 'ontos',
        token_endpoint_auth_method: 'none',
      });
      const text = yield* Effect.promise(() => HttpServerResponse.toWeb(response).text());
      expect(text.length).toBeLessThan(5 * 1024);
      expect(text).not.toMatch(/client_secret|refresh_token|registration_access_token/u);
    }),
  );

  it.effect('serves HEAD without a body or a redirect', () =>
    Effect.gen(function* headMetadata() {
      const response = yield* responseFor(stage, 'HEAD');
      expect(response.status).toBe(200);
      expect(response.body).toEqual(HttpServerResponse.empty().body);
      expect(Number(response.headers['content-length'])).toBeGreaterThan(0);
      expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(response.headers.location).toBeUndefined();
    }),
  );

  it.effect('refuses production, development, preview and missing deployment configuration', () =>
    Effect.gen(function* refuseOtherEnvironments() {
      for (const environment of ['production', 'development', 'preview', '', 'STAGE']) {
        const response = yield* responseFor({ ...stage, ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: environment });
        expect(response.status).toBe(404);
        expect(response.body).toEqual(HttpServerResponse.empty().body);
      }
      expect((yield* responseFor({ ONTOS_PUBLIC_ORIGIN: stage.ONTOS_PUBLIC_ORIGIN })).status).toBe(404);
      expect((yield* responseFor({})).status).toBe(404);
    }),
  );

  it.effect('refuses noncanonical origins even when stage is selected', () =>
    Effect.gen(function* refuseOtherOrigins() {
      const insecureStage = new URL(stage.ONTOS_PUBLIC_ORIGIN);
      insecureStage.protocol = 'http:';
      for (const origin of [
        '',
        insecureStage.origin,
        'https://ontos.example.com',
        'https://ontos-stage.web-revolution.cz.evil.example',
        'https://ontos-stage.web-revolution.cz/',
      ]) {
        expect((yield* responseFor({ ...stage, ONTOS_PUBLIC_ORIGIN: origin })).status).toBe(404);
      }
      expect((yield* responseFor({ ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage' })).status).toBe(404);
    }),
  );

  it.effect('never turns request input into client metadata or a configuration override', () =>
    Effect.gen(function* fixedMetadata() {
      const original = yield* responseFor(stage);
      const attackerHeaders = {
        authorization: 'Bearer not-a-real-token',
        cookie: 'session=not-a-real-session',
        host: 'evil.example',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'http',
      };
      const altered = yield* responseFor(stage, 'GET', '', attackerHeaders);
      expect(altered).toEqual(original);
      for (const suffix of ['?redirect_uri=https://evil.example/callback', '?run=another', '/other']) {
        expect((yield* responseFor(stage, 'GET', suffix)).status).toBe(404);
      }
      const production = yield* responseFor({ ...stage, ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'production' }, 'GET', '', {
        'x-forwarded-host': 'ontos-stage.web-revolution.cz',
        'x-forwarded-proto': 'https',
      });
      expect(production.status).toBe(404);
    }),
  );

  it.effect('rejects every write method rather than registering or modifying a client', () =>
    Effect.gen(function* refuseWrites() {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const response = yield* responseFor(stage, method);
        expect(response.status).toBe(405);
        expect(response.headers.allow).toBe('GET, HEAD');
        expect(response.body).toEqual(HttpServerResponse.empty().body);
      }
    }),
  );

  it.effect('uses the dedicated public host route without an owner, composition, or staff session', () =>
    Effect.gen(function* publicHostRoute() {
      const published = yield* Ref.make(false);
      for (const environment of ['stage', 'production']) {
        const response = yield* hostApplication(new Map(), published, Effect.succeed(Option.none())).pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(new Request(STAGE_CIMD_FIXTURE_URL)),
          ),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ ...stage, ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: environment }),
            ),
          ),
        );
        expect(response.status).toBe(environment === 'stage' ? 200 : 404);
      }
      expect(STAGE_CIMD_FIXTURE_URL).toBe(`${stage.ONTOS_PUBLIC_ORIGIN}${STAGE_CIMD_FIXTURE_PATH}`);
    }),
  );
});
