import { describe, expect, it } from 'effect-rstest';
import { ConfigProvider, Effect, Exit, Redacted, Schema } from 'effect';

import { commerceCoreIdentityClientOptions } from '../../api/portal-auth/provider/core-identity-client-config.ts';
import {
  CommerceTenantWorkloadCredentialUnavailable,
  commerceTenantGatewayApiKey,
  commerceTenantWorkloadCredentials,
  makeCommerceTenantWorkloadCredentials,
} from '../../api/tenant-workload-credentials.ts';

const demoTenant = '70000000-0000-4000-8000-000000000001';
const akrosTenant = 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9';
const withEnvironment =
  (environment: Readonly<Record<string, string>>) =>
  <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))));
const credentials = JSON.stringify({
  [akrosTenant]: { coreIdentityApiKey: 'akros-core-identity-key', gatewayApiKey: 'akros-gateway-api-key' },
  [demoTenant]: { coreIdentityApiKey: 'demo-core-identity-key-', gatewayApiKey: 'demo-gateway-api-key-01' },
});
const configured = withEnvironment({ COMMERCE_TENANT_CREDENTIALS: credentials });

describe('Commerce tenant workload credentials', () => {
  it.effect('selects the pair of the requested tenant only', () =>
    Effect.gen(function* selectsTenantPair() {
      const gateway = yield* commerceTenantGatewayApiKey(akrosTenant).pipe(configured);
      expect(Redacted.value(gateway)).toBe('akros-gateway-api-key');
      const demo = yield* commerceTenantWorkloadCredentials.pipe(
        Effect.flatMap((map) => map.forTenant(demoTenant)),
        configured,
      );
      expect(Redacted.value(demo.coreIdentityApiKey)).toBe('demo-core-identity-key-');
    }),
  );

  it.effect('fails closed with a typed error for an unconfigured tenant', () =>
    Effect.gen(function* failsClosed() {
      const failure = yield* commerceTenantGatewayApiKey('11111111-1111-4111-8111-111111111111').pipe(
        configured,
        Effect.flip,
      );
      expect(Schema.is(CommerceTenantWorkloadCredentialUnavailable)(failure)).toBe(true);
    }),
  );

  it.effect('rejects a malformed or empty map without quoting the secret', () =>
    Effect.forEach(
      ['{}', '{"not-a-uuid":{"coreIdentityApiKey":"x","gatewayApiKey":"y"}}', 'secret-text'],
      (value) =>
        commerceTenantGatewayApiKey(akrosTenant).pipe(
          withEnvironment({ COMMERCE_TENANT_CREDENTIALS: value }),
          Effect.exit,
          Effect.tap((exit) =>
            Effect.sync(() => {
              expect(Exit.isFailure(exit)).toBe(true);
              expect(JSON.stringify(exit)).not.toContain('secret-text');
            }),
          ),
        ),
      { discard: true },
    ),
  );

  it.effect('builds Core identity transport options only for a configured tenant', () =>
    Effect.gen(function* coreIdentityOptions() {
      const configuration = {
        baseUrl: 'https://shell.invalid/shell-super-app-api',
        credentials: makeCommerceTenantWorkloadCredentials({
          [akrosTenant]: {
            coreIdentityApiKey: Redacted.make('akros-core-identity-key'),
            gatewayApiKey: Redacted.make('akros-gateway-api-key'),
          },
        }),
      };
      const options = yield* commerceCoreIdentityClientOptions(configuration, akrosTenant, 'c-1');
      expect(Redacted.value(options.apiKey)).toBe('akros-core-identity-key');
      const refused = yield* commerceCoreIdentityClientOptions(configuration, demoTenant, 'c-2').pipe(Effect.flip);
      expect(Schema.is(CommerceTenantWorkloadCredentialUnavailable)(refused)).toBe(true);
    }),
  );
});
