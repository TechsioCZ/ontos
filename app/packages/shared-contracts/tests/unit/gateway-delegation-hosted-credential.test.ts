import { claimHostedModuleCredentials } from '@app/core-runtime/auth/hosted-module-credentials';
import { ConfigProvider, Crypto, Effect, Exit, Redacted } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { acquireDelegatedGatewayContext } from '../../src/gateway-context-server.ts';

const compositionRevision = 'a'.repeat(64);
/** A shared environment that wrongly carries a module key: no owner of a host process may ever present it. */
const environment = ConfigProvider.fromEnvRecord({
  ONTOS_GATEWAY_MODULE_API_KEY: 'shared-environment-module-key',
  ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.example.test/shell-super-app-api',
});
const crypto = Crypto.make({
  digest: () => Effect.succeed(new Uint8Array()),
  randomBytes: (size) => new Uint8Array(size).fill(1),
});

/** The key one delegated call presented, called by `callingAppId` from wherever it runs (no overlay anywhere). */
const presentedKey = (callingAppId: string) =>
  Effect.gen(function* delegatedCall() {
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      requests.push(new Request(input, init));
      return Promise.resolve(
        Response.json({
          apiBaseUrl: '/party-registry-api',
          compositionRevision,
          expiresAt: 1_700_000_300,
          token: 'fixture-destination-assertion',
        }),
      );
    };
    const outcome = yield* acquireDelegatedGatewayContext(
      {
        audience: 'party-registry',
        callingAppId,
        legalEntityScope: 'tenant',
        requestCorrelation: 'hosted-credential-correlation',
        subject: {
          _tag: 'Originator',
          actionInvocationId: '80000000-0000-4000-8000-000000000001',
          compositionRevision,
          tenantId: '30000000-0000-4000-8000-000000000001',
        },
      },
      crypto,
    ).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, environment),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.exit,
    );
    return { outcome, presented: requests.map((request) => request.headers.get('x-api-key')) };
  });

// Declared first: the file's process is a dedicated module process until the next test claims it.
it.effect('presents a dedicated module process its own environment key', () =>
  Effect.gen(function* dedicatedProcess() {
    expect((yield* presentedKey('catalog')).presented).toEqual(['shared-environment-module-key']);
  }),
);

it.effect('presents each owner of a host process only its own handed-over key, from any runtime or fiber', () =>
  Effect.gen(function* hostedProcess() {
    const receiver = yield* claimHostedModuleCredentials(['catalog', 'commerce-customer-context', 'pricing']);
    yield* receiver.accept({
      credentials: {
        catalog: Redacted.make('catalog-module-key-0000'),
        'commerce-customer-context': Redacted.make('commerce-customer-context-module-key'),
      },
      schemaVersion: 1,
    });
    expect((yield* presentedKey('catalog')).presented).toEqual(['catalog-module-key-0000']);
    expect((yield* presentedKey('commerce-customer-context')).presented).toEqual([
      'commerce-customer-context-module-key',
    ]);
    // An owner the host handed no key makes no call at all; it never falls back to the shared environment.
    const withoutKey = yield* presentedKey('pricing');
    expect(withoutKey.presented).toEqual([]);
    expect(Exit.isFailure(withoutKey.outcome)).toBe(true);
  }),
);
