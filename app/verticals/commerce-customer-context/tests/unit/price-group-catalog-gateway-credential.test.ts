import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { ConfigProvider, Crypto, Effect, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { PriceGroupCatalogGatewayCredentialService } from '../../shared/domain/price-group-catalog-gateway-credential.ts';
import {
  makePriceGroupCatalogGatewayCredentialIssuer,
  makePriceGroupCatalogGatewayCredentialLayer,
} from '../../api/price-group-catalog-gateway-credential.ts';
import { CustomerPriceGroupCatalogUnavailable } from '../../shared/domain/price-group-errors.ts';

const requestCorrelation = 'price-group-catalog-credential-correlation';
const configuration = {
  apiKey: Redacted.make('dedicated-customer-context-key'),
  baseUrl: new URL('https://shell.example.test/shell-super-app-api'),
};
// Structurally valid codec-only input: deliberately has no receiving provenance.
const unverifiedScope: OperationalScope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '30000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:unverified-price-group-unit',
    authMethod: 'session',
    legalEntityId: '20000000-0000-4000-8000-000000000001',
    principalId: '40000000-0000-4000-8000-000000000001',
    tenantId: '10000000-0000-4000-8000-000000000001',
  }),
  correlationId: requestCorrelation,
};

it.effect('fails closed when the server-owned issuance configuration is absent', () =>
  Effect.gen(function* missingConfigurationTest() {
    const issuer = yield* PriceGroupCatalogGatewayCredentialService;
    const failure = yield* issuer
      .issue({
        audience: 'price-group-catalog',
        compositionRevision: 'a'.repeat(64),
        requestCorrelation,
        scope: unverifiedScope,
      })
      .pipe(Effect.flip);
    expect(Schema.is(CustomerPriceGroupCatalogUnavailable)(failure)).toBe(true);
    expect(failure.reason).toContain('No server-owned Price Group Catalog');
  }).pipe(
    Effect.provide(makePriceGroupCatalogGatewayCredentialLayer()),
    Effect.provide(NodeCrypto.layer),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}, { preserveEmptyStrings: true }))),
  ),
);

it.layer(NodeCrypto.layer)('PriceGroup relay source admission', (suite) => {
  suite.effect('rejects a caller-shaped scope before any workload-key transport can replace its actor', () =>
    Effect.gen(function* rejectUnverifiedActor() {
      const crypto = yield* Crypto.Crypto;
      let transports = 0;
      const unexpectedFetch: typeof fetch = () => {
        transports += 1;
        return Promise.resolve(Response.error());
      };
      const issuer = makePriceGroupCatalogGatewayCredentialIssuer(configuration, crypto);
      const failure = yield* issuer
        .issue({
          audience: 'price-group-catalog',
          compositionRevision: 'a'.repeat(64),
          requestCorrelation,
          scope: unverifiedScope,
        })
        .pipe(Effect.flip, Effect.provideService(FetchHttpClient.Fetch, unexpectedFetch));
      expect(Schema.is(CustomerPriceGroupCatalogUnavailable)(failure)).toBe(true);
      expect(transports).toBe(0);
      expect(JSON.stringify(failure)).not.toContain('dedicated-customer-context-key');
      expect(JSON.stringify(failure)).not.toContain(unverifiedScope.principalId);
    }),
  );
  suite.effect('does not accept a cloned tenant-only scope as verified source provenance', () =>
    Effect.gen(function* rejectClonedTenantScope() {
      const crypto = yield* Crypto.Crypto;
      let transports = 0;
      const unexpectedFetch: typeof fetch = () => {
        transports += 1;
        return Promise.resolve(Response.error());
      };
      const issuer = makePriceGroupCatalogGatewayCredentialIssuer(configuration, crypto);
      const { legalEntityId: omittedSourceScope, ...tenantOnly } = unverifiedScope;
      expect(omittedSourceScope).toBeDefined();
      const failure = yield* issuer
        .issue({
          audience: 'price-group-catalog',
          compositionRevision: 'a'.repeat(64),
          requestCorrelation,
          scope: tenantOnly,
        })
        .pipe(Effect.flip, Effect.provideService(FetchHttpClient.Fetch, unexpectedFetch));
      expect(Schema.is(CustomerPriceGroupCatalogUnavailable)(failure)).toBe(true);
      expect(transports).toBe(0);
    }),
  );
});
