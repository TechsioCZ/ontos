import { ConfigProvider, Crypto, Effect, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { GatewayRelaySourceError, acquireRelayedGatewayContext } from '../../src/gateway-context-server.ts';
import { expect, it } from 'effect-rstest';
import { GatewayRelayRequestSchema } from '../../src/gateway-context.ts';

it.effect('transports a plain assertion string while keeping decoded issuer input redacted', () =>
  Effect.gen(function* relaySecretCodec() {
    const wire = {
      audience: 'party-registry',
      compositionRevision: 'a'.repeat(64),
      exchangeId: '10000000-0000-4000-8000-000000000001',
      operationKey: 'party.registry.api.party-detail',
      sourceAssertion: 'fixture-signed-source-proof',
    };
    const decoded = yield* Schema.decodeEffect(GatewayRelayRequestSchema)(wire);
    expect(Redacted.isRedacted(decoded.sourceAssertion)).toBe(true);
    expect(Redacted.value(decoded.sourceAssertion)).toBe(wire.sourceAssertion);
    const encoded = yield* Schema.encodeEffect(GatewayRelayRequestSchema)(decoded);
    expect(encoded).toEqual(wire);
    const json = yield* Schema.encodeEffect(Schema.fromJsonString(GatewayRelayRequestSchema))(decoded);
    const received = yield* Schema.decodeEffect(Schema.fromJsonString(GatewayRelayRequestSchema))(json);
    expect(Redacted.value(received.sourceAssertion)).toBe(wire.sourceAssertion);
  }),
);

it.effect('returns complete Bearer authorization and refuses a different issuer revision', () =>
  Effect.gen(function* relayServerCredentialWire() {
    const crypto = Crypto.make({
      digest: () => Effect.succeed(new Uint8Array()),
      randomBytes: (size) => new Uint8Array(size).fill(1),
    });
    const source = {
      assertion: Redacted.make('fixture-signed-source-proof'),
      audience: 'catalog',
      compositionRevision: 'a'.repeat(64),
      requestCorrelation: 'relay-wire-correlation',
    };
    const target = { audience: 'party-registry', operationKey: 'party.registry.api.party-detail' };
    const configuration = ConfigProvider.fromEnvRecord({
      ONTOS_GATEWAY_RELAY_API_KEY: 'fixture-source-credential',
      ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.example.test/shell-super-app-api',
    });
    let revision = source.compositionRevision;
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      requests.push(new Request(input, init));
      return Promise.resolve(
        Response.json({
          apiBaseUrl: '/party-registry-api',
          compositionRevision: revision,
          expiresAt: 1_700_000_300,
          token: 'fixture-destination-assertion',
        }),
      );
    };
    const invoke = acquireRelayedGatewayContext(source, target, crypto).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, configuration),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
    const issued = yield* invoke;
    expect(Redacted.value(issued.authorization)).toBe('Bearer fixture-destination-assertion');
    expect(issued.apiUrl.toString()).toBe('https://shell.example.test/party-registry-api');
    expect(requests[0]?.url).toBe('https://shell.example.test/shell-super-app-api/auth/relay/gateway-context');
    expect(requests[0]?.headers.get('x-correlation-id')).toBe(source.requestCorrelation);
    revision = 'b'.repeat(64);
    const failure = yield* invoke.pipe(Effect.flip);
    expect(Schema.is(GatewayRelaySourceError)(failure)).toBe(true);
  }),
);
