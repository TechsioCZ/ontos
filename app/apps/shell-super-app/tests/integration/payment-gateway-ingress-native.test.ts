import {
  PAYMENT_GATEWAY_RELAY_PATH_PREFIX,
  PAYMENT_NOTIFICATION_MAXIMUM_BYTES,
  PaymentNotificationNotFoundProblemSchema,
  PaymentNotificationUnavailableProblemSchema,
  PaymentReconciliationAuthenticationProblemSchema,
  PaymentReconciliationIneligibleProblemSchema,
  PaymentReconciliationRecoveryPayloadSchema,
} from '@app/payment/payment-gateway-relay';
import { TenantIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { DEFAULT_DATA_BATCH_ENDPOINT } from '@modern-js/bff-effect/data-platform';
import { Config, Crypto, Effect, Layer, Redacted, Schema } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
import type { HttpClientResponse } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { allocateLoopbackPort, startCompiledSymmyShell } from '../support/server-owner-relay-native-fixture.ts';

/*
 * #1157 / #1159 level 3: the Payment gateway relay through the real Modern server. The compiled Shell
 * (`modern serve` of `dist`, built from the current modern.config.ts) runs as a child process against the
 * shared integration database, Better Auth and SpiceDB. The test proves what only the real server can:
 * the `/api/payment/v1` BFF mount exists on every deployment profile, it is not locale-redirected, the
 * framework batch alias and the OpenAPI document are not reachable under it, the relay is not reachable
 * under the primary Shell mount, and relay replies carry their transport headers (no-store, problem
 * content type, no API key challenge) in a Node environment.
 *
 * Requires a current `dist` (`pnpm exec modern build --deploy-target node`, the runtime contract and the
 * public surface steps of `pnpm run build`).
 */

const SHELL_DIRECTORY = new URL('../../', import.meta.url).pathname;
const routeKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** Shell's relay-local 404 for a path outside the typed relay routes (and the batch alias refusal). */
const PaymentGatewayRouteNotFoundProblemSchema = Schema.TaggedStruct('PaymentGatewayRouteNotFoundProblem', {
  detail: Schema.String,
  status: Schema.Literal(404),
  title: Schema.String,
  type: Schema.String,
});
const ShellOpenApiSchema = Schema.Struct({ paths: Schema.Record(Schema.String, Schema.Unknown) });
const FakeRelayApiKeySchema = Schema.String.pipe(Schema.brand('FakeRelayApiKey'));
const RelayCredentialsSchema = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ apiKey: FakeRelayApiKeySchema, tenantId: TenantIdSchema })),
);
const RecoveryPayloadJsonSchema = Schema.fromJsonString(PaymentReconciliationRecoveryPayloadSchema);

const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);

const startShell = Effect.fn('PaymentGatewayIngressNative.startShell')(function* startShell(
  credentialTenantId: typeof TenantIdSchema.Type,
) {
  const authentication = yield* Config.all({
    connectionString: Config.Redacted('DATABASE_URL'),
    issuerConnectionString: Config.Redacted('SHELL_GATEWAY_ISSUER_DATABASE_URL'),
    secret: Config.Redacted('BETTER_AUTH_SECRET'),
    spice: Config.all({
      caCertificate: Config.String('SPICEDB_CA_CERT'),
      endpoint: Config.String('SPICEDB_ENDPOINT'),
      preSharedKey: Config.Redacted('SPICEDB_PRESHARED_KEY'),
    }),
  });
  const gateway = yield* Config.all({
    issuer: Config.String('ONTOS_GATEWAY_ISSUER'),
    privateJwk: Config.Redacted('ONTOS_GATEWAY_PRIVATE_JWK'),
    publicJwks: Config.String('ONTOS_GATEWAY_PUBLIC_JWKS'),
  });
  const port = yield* allocateLoopbackPort();
  // An obviously fake key: Shell must verify it fresh and refuse it, never trust its presence.
  const credentials = yield* Schema.encodeEffect(RelayCredentialsSchema)([
    { apiKey: FakeRelayApiKeySchema.make('fake-relay-key-for-native-test'), tenantId: credentialTenantId },
  ]);
  return yield* startCompiledSymmyShell({
    appId: 'shell-super-app',
    authentication: { ...authentication, baseUrl: `http://localhost:${port}`, port },
    gateway,
    internalSymmyIngress: false,
    paymentNotificationRelayCredentials: Redacted.make(credentials),
    relativeDirectory: SHELL_DIRECTORY,
  });
});

/** Decodes the reply as exactly the expected problem; any other problem fails the test. */
const readProblem = <Problem>(
  response: HttpClientResponse.HttpClientResponse,
  schema: Schema.Codec<Problem, unknown>,
) => response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)));

/** Transport headers every relay refusal carries, observed on the real Node response. */
const expectRelayRefusalHeaders = (response: HttpClientResponse.HttpClientResponse) => {
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['content-type']).toContain('application/problem+json');
  expect(response.headers['www-authenticate']).toBeUndefined();
  expect(response.headers['location']).toBeUndefined();
};

it.live(
  '#1157 the real Modern server mounts the Payment relay prefix with its transport headers and no aliases',
  () =>
    Effect.scoped(
      Effect.gen(function* realModernPaymentRelayMount() {
        const crypto = yield* Crypto.Crypto;
        const credentialTenantId = TenantIdSchema.make(yield* crypto.randomUUIDv4());
        const uncredentialedTenantId = TenantIdSchema.make(yield* crypto.randomUUIDv4());
        const shell = yield* startShell(credentialTenantId);
        expect(shell.apiPrefix).toBe('/shell-super-app-api');
        const client = yield* HttpClient.HttpClient;
        const notification = (family: 'comgate' | 'gopay' | 'stripe', tenantId: string) =>
          `${shell.origin}${PAYMENT_GATEWAY_RELAY_PATH_PREFIX}/notifications/${family}/${tenantId}/${routeKey}`;
        const stripeEvent = HttpClientRequest.bodyText(
          '{"id":"evt_fake","type":"payment_intent.succeeded"}',
          'application/json',
        );

        // A tenant without a relay credential: the same 404 as an unknown route; authorization never runs.
        const unknownTenant = yield* client.execute(
          HttpClientRequest.post(notification('stripe', uncredentialedTenantId)).pipe(
            stripeEvent,
            HttpClientRequest.setHeader('stripe-signature', 't=1,v1=fake'),
          ),
        );
        expect(unknownTenant.status).toBe(404);
        expectRelayRefusalHeaders(unknownTenant);
        yield* readProblem(unknownTenant, PaymentNotificationNotFoundProblemSchema);

        // A credential Shell cannot verify (revoked, rotated or fake) is an operator fault: no ACK, PSP retries,
        // and the reply never names the authentication scheme.
        for (const request of [
          HttpClientRequest.post(notification('stripe', credentialTenantId)).pipe(stripeEvent),
          HttpClientRequest.get(notification('gopay', credentialTenantId)).pipe(
            HttpClientRequest.setUrlParam('id', '3000000001'),
          ),
          HttpClientRequest.post(notification('comgate', credentialTenantId)).pipe(
            HttpClientRequest.bodyText(
              'merchant=fake&test=true&transId=FAKE-0000-0000&secret=not-a-secret&status=PAID',
              'application/x-www-form-urlencoded',
            ),
          ),
        ]) {
          const refused = yield* client.execute(request);
          expect(refused.status).toBe(503);
          expectRelayRefusalHeaders(refused);
          yield* readProblem(refused, PaymentNotificationUnavailableProblemSchema);
        }

        // A notification body above the captured limit never reaches authorization.
        const tooLarge = yield* client.execute(
          HttpClientRequest.post(notification('stripe', credentialTenantId)).pipe(
            HttpClientRequest.bodyText(
              `{"padding":"${'x'.repeat(PAYMENT_NOTIFICATION_MAXIMUM_BYTES)}"}`,
              'application/json',
            ),
          ),
        );
        expect(tooLarge.status).toBe(413);
        // The Modern host parses every JSON body before routing: unparsable JSON gets the host's own 400 and
        // never reaches the relay or capture (recorded in the P2-SHELL handoff).
        const unparsable = yield* client.execute(
          HttpClientRequest.post(notification('stripe', credentialTenantId)).pipe(
            HttpClientRequest.bodyText('{"id":', 'application/json'),
          ),
        );
        expect(unparsable.status).toBe(400);

        // Typed 405 and 404 inside the relay prefix; the prefix is not locale-redirected.
        const wrongMethod = yield* client.execute(HttpClientRequest.get(notification('stripe', credentialTenantId)));
        expect(wrongMethod.status).toBe(405);
        expect(wrongMethod.headers['allow']).toBe('POST');
        expectRelayRefusalHeaders(wrongMethod);
        const unknownPath = yield* client.execute(
          HttpClientRequest.get(`${shell.origin}${PAYMENT_GATEWAY_RELAY_PATH_PREFIX}/unknown`),
        );
        expect(unknownPath.status).toBe(404);
        expectRelayRefusalHeaders(unknownPath);
        yield* readProblem(unknownPath, PaymentGatewayRouteNotFoundProblemSchema);

        // The framework batch envelope and the Shell OpenAPI document are not reachable under the relay prefix.
        const batch = yield* client.execute(
          HttpClientRequest.post(
            `${shell.origin}${PAYMENT_GATEWAY_RELAY_PATH_PREFIX}${DEFAULT_DATA_BATCH_ENDPOINT}`,
          ).pipe(
            HttpClientRequest.bodyText(
              '{"batchId":"alias","items":[{"id":"session","method":"GET","path":"/auth/session"}],"protocolVersion":2,"sentAt":0}',
              'application/json',
            ),
          ),
        );
        expect(batch.status).toBe(404);
        expectRelayRefusalHeaders(batch);
        yield* readProblem(batch, PaymentGatewayRouteNotFoundProblemSchema);
        const aliasOpenApi = yield* client.execute(
          HttpClientRequest.get(`${shell.origin}${PAYMENT_GATEWAY_RELAY_PATH_PREFIX}/openapi.json`),
        );
        expect(aliasOpenApi.status).toBe(404);
        const shellOpenApi = yield* client.execute(
          HttpClientRequest.get(`${shell.origin}${shell.apiPrefix}/openapi.json`),
        );
        expect(shellOpenApi.status).toBe(200);
        const document = yield* shellOpenApi.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(ShellOpenApiSchema)));
        expect(Object.keys(document.paths).length).toBeGreaterThan(0);
        expect(Object.keys(document.paths).filter((path) => path.includes(PAYMENT_GATEWAY_RELAY_PATH_PREFIX))).toEqual(
          [],
        );

        // The relay is reachable only at its own mount, never below the primary Shell mount.
        const crossMounted = yield* client.execute(
          HttpClientRequest.post(
            `${shell.origin}${shell.apiPrefix}${notification('stripe', credentialTenantId).slice(shell.origin.length)}`,
          ).pipe(stripeEvent),
        );
        expect(crossMounted.status).toBe(404);
        expectRelayRefusalHeaders(crossMounted);

        // Reconciliation: a contract violation is request_invalid before any authority; a key Shell cannot verify
        // is 401 for the driver.
        const reconciliation = `${shell.origin}${PAYMENT_GATEWAY_RELAY_PATH_PREFIX}/reconciliation/${routeKey}/recoveries`;
        const malformed = yield* client.execute(
          HttpClientRequest.post(reconciliation).pipe(HttpClientRequest.bodyText('{"a":1}', 'application/json')),
        );
        expect(malformed.status).toBe(422);
        expect(malformed.headers['cache-control']).toBe('no-store');
        expect(
          yield* malformed.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(PaymentReconciliationIneligibleProblemSchema)),
          ),
        ).toMatchObject({
          code: 'request_invalid',
        });
        const recoveryPayload = yield* Schema.decodeUnknownEffect(PaymentReconciliationRecoveryPayloadSchema)({
          operationId: yield* crypto.randomUUIDv4(),
          paymentId: yield* crypto.randomUUIDv4(),
          reason: 'Gateway reconciliation round 1',
          trigger: 'OUTCOME_OVERDUE',
        }).pipe(Effect.flatMap(Schema.encodeEffect(RecoveryPayloadJsonSchema)));
        const unauthenticated = yield* client.execute(
          HttpClientRequest.post(reconciliation).pipe(
            HttpClientRequest.bodyText(recoveryPayload, 'application/json'),
            HttpClientRequest.setHeaders({
              'idempotency-key': 'payment.gateway-reconciliation:native-test:r1',
              'x-api-key': 'fake-reconciliation-key-for-native-test',
            }),
          ),
        );
        expect(unauthenticated.status).toBe(401);
        expect(unauthenticated.headers['cache-control']).toBe('no-store');
        yield* readProblem(unauthenticated, PaymentReconciliationAuthenticationProblemSchema);
      }),
    ).pipe(Effect.provide(services)),
  180_000,
);
