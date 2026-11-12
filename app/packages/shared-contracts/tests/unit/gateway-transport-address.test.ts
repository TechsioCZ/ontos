import { Cause, ConfigProvider, Crypto, Effect, Exit, Option, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { claimHostedModuleCredentials } from '../../../core-runtime/src/auth/hosted-module-credential-store.ts';
import { acquireDelegatedGatewayContext, GatewayDelegationSourceError } from '../../src/gateway-context-server.ts';

const compositionRevision = 'b'.repeat(64);
const crypto = Crypto.make({
  digest: () => Effect.succeed(new Uint8Array()),
  randomBytes: (size) => new Uint8Array(size).fill(2),
});

/** The same address over plain HTTP: the transport this test proves is refused for any host but loopback. */
const plainHttp = (address: string) => {
  const url = new URL(address);
  url.protocol = 'http:';
  return url.toString();
};

/** Whether the module's key was presented to `baseUrl`, and why not when it was refused. */
const presentTo = (baseUrl: string) =>
  Effect.gen(function* delegatedCall() {
    const requested: string[] = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      requested.push(new Request(input, init).url);
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
        callingAppId: 'catalog',
        legalEntityScope: 'tenant',
        requestCorrelation: 'transport-address-correlation',
        subject: {
          _tag: 'Originator',
          actionInvocationId: '80000000-0000-4000-8000-000000000002',
          compositionRevision,
          tenantId: '30000000-0000-4000-8000-000000000002',
        },
      },
      crypto,
    ).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnvRecord({ ONTOS_SHELL_GATEWAY_BASE_URL: baseUrl }),
      ),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.exit,
    );
    const failure = Exit.isFailure(outcome) ? Cause.findErrorOption(outcome.cause) : Option.none();
    return {
      reason:
        Option.isSome(failure) && Schema.is(GatewayDelegationSourceError)(failure.value) ? failure.value.reason : null,
      requested,
    };
  });

it.effect('presents a module key over HTTPS or to a loopback host only, never over plain HTTP to another host', () =>
  Effect.gen(function* transportAddress() {
    const copy = yield* claimHostedModuleCredentials(['catalog']);
    yield* copy.accept({ credentials: { catalog: Redacted.make('catalog-module-key-0000') }, schemaVersion: 1 });
    for (const refused of [
      plainHttp('https://shell.internal.example/shell-super-app-api'),
      plainHttp('https://10.0.0.5:3020/shell-super-app-api'),
      'https://user:secret@shell.example.test/shell-super-app-api',
    ]) {
      const answer = yield* presentTo(refused);
      expect(answer.requested).toEqual([]);
      expect(answer.reason).toBe('Gateway delegation transport is unavailable');
    }
    for (const admitted of [
      'https://shell.example.test/shell-super-app-api',
      'http://127.0.0.1:3020/shell-super-app-api',
      'http://localhost:3020/shell-super-app-api',
      'http://[::1]:3020/shell-super-app-api',
    ]) {
      const answer = yield* presentTo(admitted);
      expect(answer.reason).toBeNull();
      expect(answer.requested).toHaveLength(1);
    }
  }),
);
