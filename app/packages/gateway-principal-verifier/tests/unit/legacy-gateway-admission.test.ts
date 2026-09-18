// @effect-diagnostics strictEffectProvide:off -- Test-owned verifier layer is the application entrypoint for this integration proof; expires: 2026-12-31.
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import {
  AuthenticationNamespaceIdSchema,
  AuthenticationNamespaceRegistrationSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import {
  AuthenticationNamespaceRegistry,
  makeAuthenticationNamespaceRegistry,
} from '@app/core-runtime/auth/external-identity-admission';
import { makeOperationalScopeResolver } from '@app/core-runtime/operations/context';
import { OperationAuthenticationRequired } from '@app/core-runtime';
import { ConfigProvider, Effect, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

import {
  ActionPrincipalConfigurationErrorSchema,
  ActionPrincipalInvalidErrorSchema,
  ActionPrincipalScopeErrorSchema,
  bindGatewayPrincipalVerifier,
  makeGatewayPrincipalVerifierLayer,
} from '../../src/server.ts';
import type { LegacyGatewayNamespaceMapping } from '../../src/server.ts';

type FixturePrincipal = TrustedPrincipalContext & {
  readonly permissions?: readonly string[];
  readonly providerSubjectId?: string;
};

const currentTimeSeconds = 1_700_000_001;
const issuer = 'https://shell.ontos.test';
const staffNamespace = Schema.decodeSync(AuthenticationNamespaceIdSchema)('ontos.staff.better-auth.v1');
const externalNamespace = Schema.decodeSync(AuthenticationNamespaceIdSchema)('third-party.identity.v1');
const principalId = '40000000-0000-4000-8000-000000000001';
const authBindingId = '30000000-0000-4000-8000-000000000001';
const tenantId = '50000000-0000-4000-8000-000000000001';

const legacyPrincipal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId,
  authContextRef: 'gateway-session-ref',
  authMethod: 'session',
  principalId,
  tenantId,
});

const staffRegistration = Schema.decodeSync(AuthenticationNamespaceRegistrationSchema)({
  allowedAudiences: ['party-registry'],
  authenticationNamespaceId: staffNamespace,
  provider: 'better-auth',
  requiresOperationAdmission: false,
  reservationPrincipalKind: 'human',
  subjectTypes: ['user'],
  trustedAttesterPrincipalIds: [],
});

const activeStaffBinding = {
  bindingAuthenticationNamespaceId: staffNamespace,
  bindingPrincipalId: principalId,
  bindingRevision: 1,
  bindingRevokedAt: null,
  bindingStatus: 'active' as const,
  bindingSubjectType: 'user' as const,
  bindingTenantId: tenantId,
  impersonatorStatus: null,
  impersonatorTenantId: null,
  legalEntityStatus: null,
  legalEntityTenantId: null,
  principalStatus: 'active' as const,
  principalTenantId: tenantId,
  tenantStatus: 'active' as const,
};

const makeAssertion = (options?: {
  readonly issuerInToken?: string;
  readonly principal?: FixturePrincipal;
  readonly version?: 1 | 2;
}) =>
  Effect.gen(function* createAssertion() {
    const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
    const publicJwk = {
      ...(yield* Effect.promise(() => exportJWK(publicKey))),
      alg: 'EdDSA',
      kid: 'legacy-gateway-admission-test',
      use: 'sig',
    };
    const token = yield* Effect.promise(() =>
      new SignJWT({
        principal: options?.principal ?? legacyPrincipal,
        ver: options?.version ?? 1,
      })
        .setProtectedHeader({
          alg: 'EdDSA',
          kid: 'legacy-gateway-admission-test',
          typ: 'JWT',
        })
        .setIssuer(options?.issuerInToken ?? issuer)
        .setAudience('party-registry')
        .setSubject(principalId)
        .setIssuedAt(1_700_000_000)
        .setExpirationTime(1_700_000_300)
        .setJti('60000000-0000-4000-8000-000000000001')
        .sign(privateKey),
    );
    return {
      environment: {
        ONTOS_GATEWAY_ISSUER: issuer,
        ONTOS_GATEWAY_PUBLIC_JWKS: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          keys: [publicJwk],
        }),
      },
      token,
    };
  });

const legacyNamespaceMapping: LegacyGatewayNamespaceMapping = {
  authenticationNamespaceId: 'ontos.staff.better-auth.v1',
  issuer,
};

const verifyWithMapping = (
  token: string,
  environment: { readonly ONTOS_GATEWAY_ISSUER: string; readonly ONTOS_GATEWAY_PUBLIC_JWKS: string },
  mapping: LegacyGatewayNamespaceMapping = legacyNamespaceMapping,
) =>
  bindGatewayPrincipalVerifier('party-registry')
    .verify(Redacted.make(`Bearer ${token}`), {
      currentTimeSeconds: Effect.succeed(currentTimeSeconds),
    })
    .pipe(
      Effect.provide(
        makeGatewayPrincipalVerifierLayer(ConfigProvider.fromUnknown(environment), {
          legacyNamespaceMapping: mapping,
        }),
      ),
    );

const verifyWithoutMapping = (
  token: string,
  environment: { readonly ONTOS_GATEWAY_ISSUER: string; readonly ONTOS_GATEWAY_PUBLIC_JWKS: string },
) =>
  bindGatewayPrincipalVerifier('party-registry')
    .verify(Redacted.make(`Bearer ${token}`), {
      currentTimeSeconds: Effect.succeed(currentTimeSeconds),
    })
    .pipe(Effect.provide(makeGatewayPrincipalVerifierLayer(ConfigProvider.fromUnknown(environment))));

it.effect('maps a verified staff v1 assertion before Core resolves a migrated non-null binding', () =>
  Effect.gen(function* legacyStaffResolution() {
    const fixture = yield* makeAssertion();
    const principal = yield* verifyWithMapping(fixture.token, fixture.environment);
    expect(principal.authenticationNamespaceId).toBe(staffNamespace);

    const resolver = makeOperationalScopeResolver(
      { load: () => Effect.succeed(activeStaffBinding) },
      { legalEntities: () => Effect.succeed([]) },
    );
    const scope = yield* resolver
      .resolve({
        audience: 'party-registry',
        correlationId: 'legacy-staff-resolution',
        legalEntityScope: 'forbidden',
        principal,
      })
      .pipe(
        Effect.provideService(
          AuthenticationNamespaceRegistry,
          makeAuthenticationNamespaceRegistry([staffRegistration]),
        ),
      );

    expect(scope.authenticationNamespaceId).toBe(staffNamespace);
    expect(scope.principalId).toBe(principalId);
  }),
);

it.effect('rejects a mapped v1 assertion whose binding IDs belong to another namespace', () =>
  Effect.gen(function* externalBindingIds() {
    const fixture = yield* makeAssertion();
    const principal = yield* verifyWithMapping(fixture.token, fixture.environment);
    const resolver = makeOperationalScopeResolver(
      {
        load: () =>
          Effect.succeed({
            ...activeStaffBinding,
            bindingAuthenticationNamespaceId: externalNamespace,
          }),
      },
      { legalEntities: () => Effect.succeed([]) },
    );
    const failure = yield* resolver
      .resolve({
        audience: 'party-registry',
        correlationId: 'legacy-external-binding',
        legalEntityScope: 'forbidden',
        principal,
      })
      .pipe(
        Effect.provideService(
          AuthenticationNamespaceRegistry,
          makeAuthenticationNamespaceRegistry([staffRegistration]),
        ),
        Effect.flip,
      );

    expect(failure).toBeInstanceOf(OperationAuthenticationRequired);
  }),
);

it.effect('does not fall back to a namespace-less v1 context for a migrated staff binding', () =>
  Effect.gen(function* missingMapping() {
    const fixture = yield* makeAssertion();
    const principal = yield* verifyWithoutMapping(fixture.token, fixture.environment);
    const resolver = makeOperationalScopeResolver(
      { load: () => Effect.succeed(activeStaffBinding) },
      { legalEntities: () => Effect.succeed([]) },
    );
    const failure = yield* resolver
      .resolve({
        audience: 'party-registry',
        correlationId: 'legacy-missing-mapping',
        legalEntityScope: 'forbidden',
        principal,
      })
      .pipe(
        Effect.provideService(
          AuthenticationNamespaceRegistry,
          makeAuthenticationNamespaceRegistry([staffRegistration]),
        ),
        Effect.flip,
      );

    expect(failure).toBeInstanceOf(OperationAuthenticationRequired);
  }),
);

it.effect('keeps issuer and namespace mismatches fail closed', () =>
  Effect.gen(function* mismatchFailures() {
    const wrongIssuer = yield* makeAssertion({ issuerInToken: 'https://attacker.ontos.test' });
    const issuerFailure = yield* verifyWithMapping(wrongIssuer.token, wrongIssuer.environment).pipe(Effect.flip);
    expect(Schema.is(ActionPrincipalScopeErrorSchema)(issuerFailure)).toBe(true);

    const fixture = yield* makeAssertion();
    const mismatchFailure = yield* verifyWithMapping(fixture.token, fixture.environment, {
      authenticationNamespaceId: 'ontos.staff.better-auth.v1',
      issuer: 'https://other-shell.ontos.test',
    }).pipe(Effect.flip);
    expect(Schema.is(ActionPrincipalConfigurationErrorSchema)(mismatchFailure)).toBe(true);
  }),
);

it.effect('does not let the v1 JWT choose a namespace and leaves v2 namespace claims unchanged', () =>
  Effect.gen(function* versionBoundaries() {
    const forgedV1Namespace = yield* makeAssertion({
      principal: { ...legacyPrincipal, authenticationNamespaceId: externalNamespace },
    });
    const forgedFailure = yield* verifyWithMapping(forgedV1Namespace.token, forgedV1Namespace.environment).pipe(
      Effect.flip,
    );
    expect(Schema.is(ActionPrincipalInvalidErrorSchema)(forgedFailure)).toBe(true);

    const v2Principal = { ...legacyPrincipal, authenticationNamespaceId: externalNamespace };
    const v2 = yield* makeAssertion({ principal: v2Principal, version: 2 });
    const verifiedV2 = yield* verifyWithMapping(v2.token, v2.environment);
    expect(verifiedV2.authenticationNamespaceId).toBe(externalNamespace);
  }),
);
