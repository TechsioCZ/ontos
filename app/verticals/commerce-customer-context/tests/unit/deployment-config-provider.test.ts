import { ConfigProvider, Effect, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CommercePortalAuthConfig,
  CommercePortalAuthConfigError,
  CommercePortalAuthConfigLive,
  optionalCommercePortalAuthConfig,
} from '../../api/portal-auth/provider/config.ts';
import {
  CommerceCoreIdentityClientConfig,
  CommerceCoreIdentityClientConfigError,
  CommerceCoreIdentityClientConfigLive,
  optionalCommerceCoreIdentityClientConfig,
} from '../../api/portal-auth/provider/core-identity-client-config.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const coreIdentity = {
  COMMERCE_CORE_IDENTITY_BASE_URL: 'https://core-identity.deployment-config.test/',
  COMMERCE_TENANT_CREDENTIALS: JSON.stringify({
    [tenantId]: {
      coreIdentityApiKey: 'deployment-config-core-identity-key',
      gatewayApiKey: 'deployment-config-gateway-key',
    },
  }),
};
const portalRealm = {
  COMMERCE_PORTAL_AUTH_DATABASE_URL: 'postgres://portal@database.deployment-config.test/portal',
  COMMERCE_PORTAL_AUTH_SECRET: 's'.repeat(32),
  COMMERCE_PORTAL_AUTH_URL: 'https://portal.deployment-config.test',
  DATABASE_URL: 'postgres://runtime@database.deployment-config.test/ontos',
};
const supplied = (values: Readonly<Record<string, string>>) => ConfigProvider.layer(ConfigProvider.fromUnknown(values));

it.effect('reads the Core identity transport from the ConfigProvider the deployment supplies', () =>
  Effect.gen(function* suppliedCoreIdentity() {
    const optional = yield* optionalCommerceCoreIdentityClientConfig.pipe(Effect.provide(supplied(coreIdentity)));
    expect(optional.pipe(Option.map(({ baseUrl }) => baseUrl))).toEqual(
      Option.some('https://core-identity.deployment-config.test'),
    );
    const configured = yield* CommerceCoreIdentityClientConfig.pipe(
      Effect.provide(CommerceCoreIdentityClientConfigLive.pipe(Layer.provide(supplied(coreIdentity)))),
    );
    expect(configured.baseUrl).toBe('https://core-identity.deployment-config.test');
    expect(configured.credentials.tenantIds).toEqual([tenantId]);
  }),
);

it.effect('keeps a half-named Core identity transport a misconfiguration', () =>
  Effect.gen(function* missingCredentials() {
    const onlyBaseUrl = supplied({ COMMERCE_CORE_IDENTITY_BASE_URL: coreIdentity.COMMERCE_CORE_IDENTITY_BASE_URL });
    const optional = yield* Effect.flip(optionalCommerceCoreIdentityClientConfig.pipe(Effect.provide(onlyBaseUrl)));
    const configured = yield* Effect.flip(
      CommerceCoreIdentityClientConfig.pipe(
        Effect.provide(CommerceCoreIdentityClientConfigLive.pipe(Layer.provide(onlyBaseUrl))),
      ),
    );
    for (const failure of [optional, configured]) {
      expect(Schema.is(CommerceCoreIdentityClientConfigError)(failure)).toBe(true);
      expect(failure.reason).toBe('Commerce Core identity client configuration is missing or malformed');
    }
  }),
);

it.effect('reads the portal realm from the ConfigProvider the deployment supplies', () =>
  Effect.gen(function* suppliedRealm() {
    const optional = yield* optionalCommercePortalAuthConfig.pipe(Effect.provide(supplied(portalRealm)));
    expect(optional.pipe(Option.map(({ baseUrl }) => baseUrl))).toEqual(
      Option.some('https://portal.deployment-config.test'),
    );
    const configured = yield* CommercePortalAuthConfig.pipe(
      Effect.provide(CommercePortalAuthConfigLive.pipe(Layer.provide(supplied(portalRealm)))),
    );
    expect(configured.trustedOrigins).toEqual(['https://portal.deployment-config.test']);
  }),
);

it.effect('keeps a realm that names its URL but no secret a misconfiguration', () =>
  Effect.gen(function* missingSecret() {
    const { COMMERCE_PORTAL_AUTH_SECRET: _secret, ...withoutSecret } = portalRealm;
    const optional = yield* Effect.flip(optionalCommercePortalAuthConfig.pipe(Effect.provide(supplied(withoutSecret))));
    const configured = yield* Effect.flip(
      CommercePortalAuthConfig.pipe(
        Effect.provide(CommercePortalAuthConfigLive.pipe(Layer.provide(supplied(withoutSecret)))),
      ),
    );
    for (const failure of [optional, configured]) {
      expect(Schema.is(CommercePortalAuthConfigError)(failure)).toBe(true);
      expect(failure.reason).toBe('Commerce portal authentication configuration is missing or malformed');
    }
  }),
);
