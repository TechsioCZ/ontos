import { expect, it, rs } from 'effect-rstest';
import { ConfigProvider, Effect, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { akrosPlaygroundCommercePortal } from '../demo/akros-playground-policy.mts';
import {
  commercePortalExternalIdentityDeployment,
  commercePortalTenantBundle,
  commercePortalWorkloads,
  validateN1CommercePortalEnvironment,
  verifyN1CommercePortalKey,
} from '../demo/commerce-portal.mts';
import { n1CommercePortal } from '../demo/n1-stage-grants.mts';
import { demoCommercePortalWorkload } from '../demo/permissions.mts';
import { ExternalIdentityProviderConfigurationSchema } from '../../apps/shell-super-app/api/auth/external-identity-provider.ts';
import { CommercePortalAuthVerificationWorkloadGrantsSchema } from '../../verticals/commerce-customer-context/api/portal-auth/verification-http/workload-grants.ts';

const ownerKey = 'test-n1-owner-key';
const credentialsVariable = 'COMMERCE_TENANT_CREDENTIALS';
const WorkloadKey = Schema.String.pipe(Schema.brand('CommerceWorkloadKey'));
const n1Name = 'n1-commerce-portal';
const gatewayOperation = 'gateway-context';
const partyAudience = 'party-registry';
const commerceAudience = 'commerce-customer-context';
const credentialsJson = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Struct({ coreIdentityApiKey: WorkloadKey, gatewayApiKey: WorkloadKey })),
);
const deploymentJson = Schema.fromJsonString(ExternalIdentityProviderConfigurationSchema);
const verificationJson = Schema.fromJsonString(CommercePortalAuthVerificationWorkloadGrantsSchema);

const workloads = [demoCommercePortalWorkload, akrosPlaygroundCommercePortal] as const;
const existingCredentials = Object.fromEntries(
  workloads.map(({ tenantId }, index) => [
    tenantId,
    { coreIdentityApiKey: `test-core-${index}`, gatewayApiKey: `test-gateway-${index}` },
  ]),
);

it.effect('requires an explicit Stage target before privileged N1 service acquisition', () =>
  Effect.gen(function* validateTarget() {
    const valid = {
      ONTOS_SHELL_URL: 'https://ontos-stage.web-revolution.cz',
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
    };
    yield* validateN1CommercePortalEnvironment.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(valid))),
    );
    for (const environment of [
      {},
      { ...valid, ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'production' },
      { ...valid, ONTOS_SHELL_URL: 'http://localhost:3020' },
    ]) {
      const error = yield* Effect.flip(
        validateN1CommercePortalEnvironment.pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))),
        ),
      );
      expect(error.reason).toContain('explicit Stage environment');
    }
  }),
);

const compositionRevision = 'a'.repeat(64);
const gatewayClaims = (audience: string) => ({
  aud: audience,
  compositionRevision,
  exp: 300,
  iat: 0,
  iss: 'https://stage.test/shell-super-app-api',
  jti: '10000000-0000-4000-8000-000000000011',
  principal: {
    authBindingId: '10000000-0000-4000-8000-000000000012',
    authContextRef: 'api-key:test-reference',
    authMethod: 'api_key',
    legalEntityId: n1CommercePortal.legalEntityId,
    principalId: n1CommercePortal.principalId,
    tenantId: n1CommercePortal.tenantId,
  },
  sub: n1CommercePortal.principalId,
  targetBuildMarker: 'test-marker',
  ver: 1,
});

const gatewayClient = (
  transform: (claims: ReturnType<typeof gatewayClaims>) => ReturnType<typeof gatewayClaims> = (claims) => claims,
) => {
  const fetch = rs.fn<typeof globalThis.fetch>();
  for (const audience of [partyAudience, commerceAudience]) {
    const token = [
      Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify(transform(gatewayClaims(audience)))).toString('base64url'),
      'test-signature',
    ].join('.');
    fetch.mockResolvedValueOnce(
      Response.json({ apiBaseUrl: `/${audience}-api`, compositionRevision, expiresAt: 300, token }),
    );
  }
  return fetch;
};

it.effect('verifies the N1 owner identity for both gateway audiences before reusing its credential', () =>
  Effect.gen(function* verifyOwnKey() {
    const fetch = gatewayClient();
    yield* verifyN1CommercePortalKey(Redacted.make('test-key'), 'https://stage.test', compositionRevision).pipe(
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
    const audiences: string[] = [];
    for (const [input, init] of fetch.mock.calls) {
      const request = new Request(input, init);
      expect(request.url).toBe('https://stage.test/shell-super-app-api/auth/api-key/gateway-context');
      const payload = yield* Schema.decodeUnknownEffect(Schema.Struct({ audience: Schema.String }))(
        yield* Effect.promise(() => request.json()),
      );
      audiences.push(payload.audience);
    }
    expect(audiences).toEqual([partyAudience, commerceAudience]);
  }),
);

it.effect('rejects a valid gateway response for the wrong principal, tenant, company, audience or release', () =>
  Effect.gen(function* rejectOtherKey() {
    const foreignId = '10000000-0000-4000-8000-000000000099';
    const transforms = [
      (claims: ReturnType<typeof gatewayClaims>) => ({
        ...claims,
        principal: { ...claims.principal, principalId: foreignId },
        sub: foreignId,
      }),
      (claims: ReturnType<typeof gatewayClaims>) => ({
        ...claims,
        principal: { ...claims.principal, tenantId: foreignId },
      }),
      (claims: ReturnType<typeof gatewayClaims>) => ({
        ...claims,
        principal: { ...claims.principal, legalEntityId: foreignId },
      }),
      (claims: ReturnType<typeof gatewayClaims>) => ({ ...claims, aud: 'privacy' }),
      (claims: ReturnType<typeof gatewayClaims>) => ({ ...claims, compositionRevision: 'b'.repeat(64) }),
    ];
    for (const transform of transforms) {
      const fetch = gatewayClient(transform);
      const error = yield* Effect.flip(
        verifyN1CommercePortalKey(Redacted.make('test-key'), 'https://stage.test', compositionRevision).pipe(
          Effect.provideService(FetchHttpClient.Fetch, fetch),
        ),
      );
      expect(error.reason).toContain('identity or scope mismatch');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(error.reason).not.toContain('test-key');
    }
  }),
);
const originalDeployment = commercePortalExternalIdentityDeployment(workloads);
const originalBundle = {
  'commerce-customer-context': {
    [credentialsVariable]: JSON.stringify(existingCredentials),
    UNRELATED: 'keep-commerce',
  },
  'shell-super-app': {
    ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT: JSON.stringify(originalDeployment),
    UNRELATED: 'keep-shell',
  },
  'unrelated-owner': { VALUE: 'keep-owner' },
};

it('declares an independent N1 owner workload rather than reusing the storefront or another tenant', () => {
  expect(commercePortalWorkloads.n1).toEqual({ operatorEmail: 'admin@n1.ontos.demo', workload: n1CommercePortal });
  expect(n1CommercePortal.apiKeyName).toBe(n1Name);
  for (const workload of workloads) {
    expect(n1CommercePortal.principalId).not.toBe(workload.principalId);
    expect(n1CommercePortal.tenantId).not.toBe(workload.tenantId);
  }
});

it.effect('adds N1 credentials while retaining both existing tenants, their grants and the provider attester', () =>
  Effect.gen(function* addN1() {
    const result = yield* commercePortalTenantBundle(originalBundle, 'n1', Redacted.make(ownerKey));
    const credentials = yield* Schema.decodeUnknownEffect(credentialsJson)(
      result['commerce-customer-context']?.[credentialsVariable] ?? 'null',
    );
    expect(credentials).toEqual({
      ...existingCredentials,
      [n1CommercePortal.tenantId]: {
        coreIdentityApiKey: ownerKey,
        gatewayApiKey: ownerKey,
      },
    });
    const deployment = yield* Schema.decodeUnknownEffect(deploymentJson)(
      result['shell-super-app']?.ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT ?? 'null',
    );
    expect(deployment.attesterPrincipalId).toBe(originalDeployment.attesterPrincipalId);
    expect(
      deployment.grants.filter((grant: { tenantId: string }) => grant.tenantId !== n1CommercePortal.tenantId),
    ).toEqual(originalDeployment.grants);
    expect(result['commerce-customer-context']?.UNRELATED).toBe('keep-commerce');
    expect(result['shell-super-app']?.UNRELATED).toBe('keep-shell');
    expect(result['unrelated-owner']).toEqual(originalBundle['unrelated-owner']);
    expect(originalBundle['commerce-customer-context'][credentialsVariable]).toBe(JSON.stringify(existingCredentials));
    const verification = yield* Schema.decodeUnknownEffect(verificationJson)(
      result['commerce-customer-context']?.COMMERCE_PORTAL_AUTH_VERIFICATION_WORKLOAD_GRANTS ?? 'null',
    );
    expect(verification.grants).toContainEqual({
      commerceAuthenticationNamespaceId: 'ontos.commerce.portal.better-auth.v1',
      operation: 'commerce-portal-authentication.verify-external-authentication.v1',
      receivingAudience: 'shell-super-app',
      tenantId: n1CommercePortal.tenantId,
      workloadAuthenticationNamespaceId: 'ontos.staff.better-auth.v1',
      workloadPrincipalId: n1CommercePortal.principalId,
    });
    expect(yield* commercePortalTenantBundle(result, 'n1', Redacted.make(ownerKey))).toEqual(result);
  }),
);

it('limits N1 external identity operations and audiences without changing AKROS or demo', () => {
  const deployment = commercePortalExternalIdentityDeployment([...workloads, n1CommercePortal]);
  const grants = deployment.grants.filter(({ tenantId }) => tenantId === n1CommercePortal.tenantId);
  expect(grants.map(({ operation }) => operation)).toEqual([
    'activate',
    'read',
    'reserve',
    'resolve',
    gatewayOperation,
    gatewayOperation,
  ]);
  expect(grants.filter((grant) => grant.operation === gatewayOperation).map((grant) => grant.targetAudience)).toEqual([
    commerceAudience,
    partyAudience,
  ]);
  expect(grants.every(({ workloadPrincipalId }) => workloadPrincipalId === n1CommercePortal.principalId)).toBe(true);
  expect(deployment.grants.filter(({ tenantId }) => tenantId !== n1CommercePortal.tenantId)).toEqual(
    originalDeployment.grants,
  );
});

it.effect('refuses an unknown tenant rather than retaining credentials with guessed authority', () =>
  Effect.gen(function* refuseUnknownTenant() {
    const error = yield* Effect.flip(
      commercePortalTenantBundle(
        {
          ...originalBundle,
          'commerce-customer-context': {
            [credentialsVariable]: JSON.stringify({
              ...existingCredentials,
              '10000000-0000-4000-8000-000000000099': { coreIdentityApiKey: 'foreign', gatewayApiKey: 'foreign' },
            }),
          },
        },
        'n1',
        Redacted.make(ownerKey),
      ),
    );
    expect(error.reason).toContain('without a provisioned workload');
  }),
);
