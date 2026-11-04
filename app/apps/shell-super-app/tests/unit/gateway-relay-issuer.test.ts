import type { GatewayContextV2ClaimsSchema, GatewayTrustedPrincipalContextSchema } from '@app/shared-contracts';
import { GatewayRelayRequestSchema } from '@app/shared-contracts';
import {
  OperationContextDenied,
  OperationContextUnavailable,
  PrincipalResolver,
  PrincipalBindingMissingError,
  TenantModuleStateReadUnavailableError,
  TenantModuleStateService,
  TenantModuleStateRecordSchema,
} from '@app/core-runtime';
import { OperationalScopeResolver } from '@app/core-runtime/operations/context';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { makeEffectDrizzleAuthAdapter } from '@app/better-auth-effect-drizzle/server';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Cause, ConfigProvider, Effect, Exit, Layer, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { Reactivity } from 'effect/reactivity';
import { SqlClient } from 'effect/sql';
import { expect, it } from 'effect-rstest';
import { SignJWT, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { AuthDatabase } from '../../api/auth/db/client.ts';
import { authDatabaseSchema, authRelations } from '../../api/auth/db/schema.ts';
import { GatewayIssuerError, makeGatewayIssuerLayer } from '../../api/auth/gateway-issuer.ts';
import { parseGatewayIssuerConfig } from '../../api/auth/gateway-issuer-config.ts';
import { GatewayRelayError } from '../../api/auth/gateway-relay-errors.ts';
import { issueRelayedGatewayContextAssertion } from '../../api/auth/gateway-relay-issuer.ts';
import { GatewayRelayVerificationLive } from '../../api/auth/gateway-relay-verification.ts';
import { GatewayRelayExchangeLedger } from '../../api/auth/gateway-relay-exchanges.service.ts';
import { GatewayRelayExchangeReplay } from '../../api/auth/gateway-relay-exchange-replay.ts';
import { GatewayRelayExchangeUnavailable } from '../../api/auth/gateway-relay-exchange-unavailable.ts';
import {
  ShellInstalledModuleCatalog,
  InstalledModuleCatalogUnavailableError,
  makeInstalledModuleCatalogLoader,
} from '../../api/modules/installed-module-catalog.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { capturingScopeGrantRegistrar, scopeGrantRegistrarLayer } from '../support/gateway-issuer-layer.ts';
import { makePrincipalResolverDouble } from '../support/identity-service-doubles.ts';
import {
  controlledAuthConnection,
  controlledPgClient,
  relayUnitIdentity,
  relayUnitNow,
  relayUnitPrincipal,
} from '../support/gateway-relay-test.ts';
import type { RelayUnitRows } from '../support/gateway-relay-test.ts';

const issuer = 'https://relay-unit.example.test';
const relayRoutes = {
  catalogParty: {
    operationKey: 'party.registry.api.party-detail',
    sourceAppId: 'catalog',
    sourceModuleId: 'commerce.catalog',
    targetAppId: 'party-registry',
    targetModuleId: 'party.registry',
  },
  customerParty: {
    operationKey: 'party.registry.api.party-detail',
    sourceAppId: 'commerce-customer-context',
    sourceModuleId: 'commerce.customer-context',
    targetAppId: 'party-registry',
    targetModuleId: 'party.registry',
  },
  customerPriceGroup: {
    operationKey: 'pricing.price-group-catalog.api.validate-price-group-compatibility',
    sourceAppId: 'commerce-customer-context',
    sourceModuleId: 'commerce.customer-context',
    targetAppId: 'price-group-catalog',
    targetModuleId: 'pricing.price-group-catalog',
  },
  marketSubject: {
    operationKey: 'commerce.customer-context.api.market-subject-restrictions-current',
    sourceAppId: 'commerce-market-catalog',
    sourceModuleId: 'commerce.market-catalog',
    targetAppId: 'commerce-customer-context',
    targetModuleId: 'commerce.customer-context',
  },
};

interface RelayCase {
  readonly authRows?: RelayUnitRows;
  readonly authUnavailable?: boolean;
  readonly catalogRevision?: string;
  readonly catalogUnavailable?: boolean;
  readonly contextFailure?: 'denied' | 'unavailable';
  readonly header?: Partial<Parameters<SignJWT['setProtectedHeader']>[0]>;
  readonly ledgerFailure?: 'replay' | 'unavailable';
  readonly malformed?: boolean;
  readonly missingDeployment?: 'catalog' | 'party-registry' | 'commerce-customer-context' | 'price-group-catalog';
  readonly moduleState?: 'suspended' | 'quarantined' | 'missing' | 'unavailable';
  readonly originalBindingRevoked?: boolean;
  readonly principal?: Partial<typeof GatewayTrustedPrincipalContextSchema.Type>;
  readonly providerKeyId?: string;
  readonly route?: keyof typeof relayRoutes;
  readonly signerUnavailable?: boolean;
  readonly source?: Partial<typeof GatewayContextV2ClaimsSchema.Encoded>;
  readonly tamper?: boolean;
  readonly target?: Partial<typeof GatewayRelayRequestSchema.Encoded>;
  readonly verificationUnavailable?: boolean;
  readonly wrongKey?: boolean;
}

/** Controlled authority collaborators are unit fixtures; native tests establish actual Current admission. */
const relayCase = Effect.fn('RelayIssuerTest.case')(function* relayCase(input: RelayCase = {}) {
  yield* TestClock.setTime(relayUnitNow * 1000);
  const route = relayRoutes[input.route ?? 'catalogParty'];
  const snapshot = yield* makeCompositionSnapshot([
    makeModuleContractFixture({ appId: route.sourceAppId, moduleId: route.sourceModuleId }),
    makeModuleContractFixture({ appId: route.targetAppId, moduleId: route.targetModuleId }),
  ]);
  const { revision } = snapshot.composition;
  const { privateKey, publicKey } = yield* Effect.promise(() =>
    generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }),
  );
  const privateJwk = yield* Effect.promise(() => exportJWK(privateKey));
  const publicJwk = yield* Effect.promise(() => exportJWK(publicKey));
  const publicJwks = JSON.stringify({ keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'relay-unit', use: 'sig' }] });
  const source = {
    aud: route.sourceAppId,
    compositionRevision: revision,
    exp: relayUnitNow + 280,
    iat: relayUnitNow - 20,
    iss: issuer,
    jti: '80000000-0000-4000-8000-000000000001',
    principal: { ...relayUnitPrincipal, ...input.principal },
    sub: input.principal?.principalId ?? relayUnitPrincipal.principalId,
    targetBuildMarker: `${route.sourceAppId}-build`,
    ver: 2,
    ...input.source,
  };
  const signingKey =
    input.wrongKey === true ? (yield* Effect.promise(() => generateKeyPair('EdDSA'))).privateKey : privateKey;
  let token = yield* Effect.promise(() =>
    new SignJWT(source)
      .setProtectedHeader({ alg: 'EdDSA', kid: 'relay-unit', typ: 'JWT', ...input.header })
      .sign(signingKey),
  );
  if (input.tamper === true) {
    const parts = token.split('.');
    token = `${parts[0]}.${parts[1]}.${parts[2]?.startsWith('a') === true ? 'b' : 'a'}${parts[2]?.slice(1)}`;
  }
  if (input.malformed === true) {
    token = 'not-a-jwt';
  }
  const payload = yield* Schema.decodeUnknownEffect(GatewayRelayRequestSchema)({
    audience: route.targetAppId,
    compositionRevision: revision,
    exchangeId: '90000000-0000-4000-8000-000000000001',
    operationKey: route.operationKey,
    sourceAssertion: token,
    ...input.target,
  });
  const controlled = controlledAuthConnection(input.authRows ?? [[[true, null]]], input.authUnavailable === true);
  const sql = yield* SqlClient.make({
    acquirer: Effect.succeed(controlled.connection),
    compiler: PgClient.makeCompiler(),
    driver: 'controlled-relay-unit',
    spanAttributes: [],
  }).pipe(Effect.provide(Reactivity.layer));
  const executor = yield* makeWithDefaults({ relations: authRelations }).pipe(
    Effect.provideService(PgClient.PgClient, controlledPgClient(sql)),
  );
  const adapter = yield* makeEffectDrizzleAuthAdapter(executor, authDatabaseSchema);
  let ledgerAttempts = 0;
  let ledgerClaims = 0;
  let signingAttempts = 0;
  const ledgerFingerprints: string[] = [];
  const resolvedSourceScopes: {
    legalEntityId: string | undefined;
    legalEntityScope: string;
    principalId: string;
    tenantId: string;
  }[] = [];
  const registrar = capturingScopeGrantRegistrar();
  const installed = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
  const selectedCatalog = {
    ...installed,
    composition: { ...installed.composition, revision: input.catalogRevision ?? revision },
    contracts: installed.contracts.filter((contract) => contract.deployment.appId !== input.missingDeployment),
  };
  const configuration = yield* parseGatewayIssuerConfig({
    ONTOS_GATEWAY_ISSUER: issuer,
    ONTOS_GATEWAY_PRIVATE_JWK: JSON.stringify({ ...privateJwk, alg: 'EdDSA', kid: 'relay-unit', use: 'sig' }),
  });
  const signer = makeGatewayIssuerLayer({
    currentTimeSeconds: Effect.succeed(relayUnitNow),
    generateJti: Effect.sync(() => {
      signingAttempts += 1;
      return 'a0000000-0000-4000-8000-000000000001';
    }),
    loadAdmission: Effect.succeed({
      audiences: new Map([[route.targetAppId, `${route.targetAppId}-build`]]),
      revision,
    }),
    loadConfig: input.signerUnavailable === true ? parseGatewayIssuerConfig({}) : Effect.succeed(configuration),
  }).pipe(Layer.provide(scopeGrantRegistrarLayer(registrar.registrar)));
  const moduleStates = snapshot.composition.modules.map((module) =>
    Schema.decodeUnknownSync(TenantModuleStateRecordSchema)({
      moduleKey: module.moduleId,
      state:
        input.moduleState === 'missing' || input.moduleState === 'unavailable'
          ? 'active'
          : (input.moduleState ?? 'active'),
    }),
  );
  const provider = ConfigProvider.fromUnknown({
    ONTOS_GATEWAY_ISSUER: issuer,
    ONTOS_GATEWAY_PUBLIC_JWKS: input.verificationUnavailable === true ? '{"keys":[]}' : publicJwks,
    ONTOS_GATEWAY_RELAY_SOURCE_BINDINGS: JSON.stringify([
      {
        compositionRevision: revision,
        providerKeyId: 'source-workload-key',
        sourceAppId: route.sourceAppId,
        sourceBuildMarker: `${route.sourceAppId}-build`,
      },
    ]),
  });
  const result = yield* Effect.exit(
    issueRelayedGatewayContextAssertion({
      payload,
      requestCorrelation: 'unit-correlation',
      verifiedProviderKeyId: input.providerKeyId ?? 'source-workload-key',
    }).pipe(
      Effect.provide(signer),
      Effect.provide(GatewayRelayVerificationLive),
      Effect.provideService(ConfigProvider.ConfigProvider, provider),
      Effect.provideService(ShellInstalledModuleCatalog, {
        load:
          input.catalogUnavailable === true
            ? Effect.fail(
                new InstalledModuleCatalogUnavailableError({ reason: 'Controlled current catalog unavailable' }),
              )
            : Effect.succeed(selectedCatalog),
      }),
      Effect.provideService(AuthDatabase, { adapter, executor }),
      Effect.provideService(
        PrincipalResolver,
        makePrincipalResolverDouble({
          resolveBetterAuthApiKey: () =>
            input.originalBindingRevoked === true
              ? Effect.fail(new PrincipalBindingMissingError())
              : Effect.succeed(relayUnitIdentity),
        }),
      ),
      Effect.provideService(OperationalScopeResolver, {
        resolve: (request) => {
          resolvedSourceScopes.push({
            legalEntityId: request.principal.legalEntityId,
            legalEntityScope: request.legalEntityScope,
            principalId: request.principal.principalId,
            tenantId: request.principal.tenantId,
          });
          if (input.contextFailure === 'unavailable') {
            return Effect.fail(
              new OperationContextUnavailable({
                code: 'operation_context_unavailable',
                reason: 'Controlled unavailable Current context',
              }),
            );
          }
          if (input.contextFailure === 'denied') {
            return Effect.fail(
              new OperationContextDenied({
                code: 'operation_context_denied',
                reason: 'Controlled denied Current context',
              }),
            );
          }
          return Effect.succeed({ ...request.principal, correlationId: request.correlationId });
        },
      }),
      Effect.provide(
        Layer.mock(TenantModuleStateService, {
          getTenantModuleStates: () =>
            input.moduleState === 'unavailable'
              ? Effect.fail(
                  new TenantModuleStateReadUnavailableError({
                    code: 'tenant_module_state_read_unavailable',
                    reason: 'Controlled unavailable module state',
                  }),
                )
              : Effect.succeed(input.moduleState === 'missing' ? [] : moduleStates),
        }),
      ),
      Effect.provideService(GatewayRelayExchangeLedger, {
        reserve: (request) => {
          ledgerAttempts += 1;
          ledgerFingerprints.push(request.requestFingerprint);
          if (input.ledgerFailure === 'replay') {
            return Effect.fail(new GatewayRelayExchangeReplay({ reason: 'Controlled replay' }));
          }
          if (input.ledgerFailure === 'unavailable') {
            return Effect.fail(
              new GatewayRelayExchangeUnavailable({
                cause: 'Controlled connection failure',
                reason: 'Controlled unavailable ledger',
              }),
            );
          }
          ledgerClaims += 1;
          return Effect.void;
        },
      }),
    ),
  );
  return {
    ledgerAttempts,
    ledgerClaims,
    ledgerFingerprints,
    publicKey,
    registrarInputs: registrar.inputs,
    resolvedSourceScopes,
    result,
    revision,
    signingAttempts,
  };
});

const assertDenied = (
  result: Effect.Success<ReturnType<typeof relayCase>>,
  code: GatewayRelayError['code'],
  ledgerAttempts = 0,
) => {
  expect(Exit.isFailure(result.result)).toBe(true);
  if (Exit.isFailure(result.result)) {
    const failure = Cause.squash(result.result.cause);
    expect(Schema.is(GatewayRelayError)(failure)).toBe(true);
    if (Schema.is(GatewayRelayError)(failure)) {
      expect(failure.code).toBe(code);
    }
  }
  expect(result.ledgerAttempts).toBe(ledgerAttempts);
  expect(result.ledgerClaims).toBe(0);
  expect(result.signingAttempts).toBe(0);
  expect(result.registrarInputs).toHaveLength(0);
};

it.effect('runs the real relay, Auth SQL, live verification and signer while retaining actor and original expiry', () =>
  Effect.gen(function* validRelay() {
    const result = yield* relayCase();
    expect(Exit.isSuccess(result.result)).toBe(true);
    if (!Exit.isSuccess(result.result)) {
      return;
    }
    const issued = result.result.value;
    const verified = yield* Effect.promise(() =>
      jwtVerify(issued.token, result.publicKey, {
        audience: 'party-registry',
        currentDate: new Date(relayUnitNow * 1000),
        issuer,
      }),
    );
    expect(verified.payload['principal']).toEqual(relayUnitPrincipal);
    expect(verified.payload.exp).toBe(relayUnitNow + 280);
    expect(verified.payload.iat).toBe(relayUnitNow - 20);
    expect(result.ledgerClaims).toBe(1);
    expect(result.signingAttempts).toBe(1);
    expect(result.registrarInputs).toHaveLength(1);
  }),
);

const cryptoNegatives: readonly (readonly [string, RelayCase, GatewayRelayError['code']])[] = [
  ['malformed', { malformed: true }, 'authentication_required'],
  ['tampered', { tamper: true }, 'authentication_required'],
  ['wrong-signing-key', { wrongKey: true }, 'authentication_required'],
  ['wrong-issuer', { source: { iss: 'https://other.example.test' } }, 'authentication_required'],
  ['wrong-audience', { source: { aud: 'party-registry' } }, 'authentication_required'],
  ['expired', { source: { exp: relayUnitNow, iat: relayUnitNow - 300 } }, 'authentication_required'],
  ['future-issued', { source: { exp: relayUnitNow + 301, iat: relayUnitNow + 1 } }, 'forbidden'],
  ['unknown-signing-kid', { header: { kid: 'unknown-unit-key' } }, 'authentication_required'],
  ['invalid-source-jti', { source: { jti: 'not-a-uuid' } }, 'forbidden'],
  ['wrong-destination', { target: { audience: 'commerce-market-catalog' } }, 'forbidden'],
  ['missing-current-source', { missingDeployment: 'catalog' }, 'forbidden'],
  ['missing-current-destination', { missingDeployment: 'party-registry' }, 'forbidden'],
  ['wrong-header', { header: { typ: 'other' } }, 'forbidden'],
  ['invalid-subject', { source: { sub: '40000000-0000-4000-8000-000000000002' } }, 'forbidden'],
  ['extended-trust-interval', { source: { exp: relayUnitNow + 281 } }, 'forbidden'],
  ['wrong-source-build', { source: { targetBuildMarker: 'old-build' } }, 'forbidden'],
  ['wrong-source-revision', { source: { compositionRevision: 'b'.repeat(64) } }, 'forbidden'],
  ['wrong-target-revision', { target: { compositionRevision: 'b'.repeat(64) } }, 'forbidden'],
  ['wrong-operation', { target: { operationKey: 'party.registry.api.guest-party-resolution' } }, 'forbidden'],
  ['unbound-workload-key', { providerKeyId: 'unbound-key' }, 'forbidden'],
  ['changed-principal', { principal: { principalId: '40000000-0000-4000-8000-000000000002' } }, 'forbidden'],
  ['changed-tenant', { principal: { tenantId: '50000000-0000-4000-8000-000000000002' } }, 'forbidden'],
  ['changed-binding', { principal: { authBindingId: '10000000-0000-4000-8000-000000000002' } }, 'forbidden'],
  ['changed-auth-reference', { principal: { authContextRef: 'foreign:original-key' } }, 'forbidden'],
  ['expired-original-key', { authRows: [[[true, new Date(relayUnitNow * 1000)]]] }, 'forbidden'],
  ['revoked-original-binding', { originalBindingRevoked: true }, 'forbidden'],
  ['unavailable-module-state', { moduleState: 'unavailable' }, 'unavailable'],
  ['unavailable-auth-database', { authUnavailable: true }, 'unavailable'],
  ['disabled-original-key', { authRows: [[[false, null]]] }, 'forbidden'],
  ['unavailable-verification', { verificationUnavailable: true }, 'unavailable'],
  ['unavailable-current-catalog', { catalogUnavailable: true }, 'unavailable'],
  ['stale-current-composition', { catalogRevision: 'b'.repeat(64) }, 'reload_required'],
  [
    'changed-current-legal-entity',
    { contextFailure: 'denied', principal: { legalEntityId: '30000000-0000-4000-8000-000000000002' } },
    'forbidden',
  ],
  ['denied-current-context', { contextFailure: 'denied' }, 'forbidden'],
  ['unavailable-current-context', { contextFailure: 'unavailable' }, 'unavailable'],
  ['suspended-module', { moduleState: 'suspended' }, 'forbidden'],
  ['quarantined-module', { moduleState: 'quarantined' }, 'forbidden'],
  ['missing-module-state', { moduleState: 'missing' }, 'forbidden'],
];
for (const [label, input, code] of cryptoNegatives) {
  it.effect(`rejects ${label} before ledger claim or signing through the actual relay`, () =>
    Effect.gen(function* deniedRelay() {
      assertDenied(yield* relayCase(input), code);
    }),
  );
}
for (const failure of ['replay', 'unavailable'] as const) {
  it.effect(`does not sign when the late ledger rejects with ${failure}`, () =>
    Effect.gen(function* ledgerFailure() {
      assertDenied(yield* relayCase({ ledgerFailure: failure }), failure === 'replay' ? 'forbidden' : 'unavailable', 1);
    }),
  );
}

it.effect('fails closed in the real destination issuer configuration after reserving the exchange', () =>
  Effect.gen(function* unavailableDestinationSigner() {
    const result = yield* relayCase({ signerUnavailable: true });
    expect(Exit.isFailure(result.result)).toBe(true);
    if (Exit.isFailure(result.result)) {
      const failure = Cause.squash(result.result.cause);
      expect(Schema.is(GatewayIssuerError)(failure)).toBe(true);
      if (Schema.is(GatewayIssuerError)(failure)) {
        expect(failure.code).toBe('gateway_issuer_unavailable');
        expect(failure.stage).toBe('configuration');
      }
    }
    // Reservation precedes destination issuance; failed signing must not make the slot reusable.
    expect(result.ledgerAttempts).toBe(1);
    expect(result.ledgerClaims).toBe(1);
    expect(result.signingAttempts).toBe(0);
    expect(result.registrarInputs).toHaveLength(0);
  }),
);

it.effect('validates original CCC Legal Entity and projects only its compatibility assertion to tenant scope', () =>
  Effect.gen(function* tenantOnlyPriceGroupAssertion() {
    const result = yield* relayCase({ route: 'customerPriceGroup' });
    expect(Exit.isSuccess(result.result)).toBe(true);
    if (!Exit.isSuccess(result.result)) {
      return;
    }
    const issued = result.result.value;
    const verified = yield* Effect.promise(() =>
      jwtVerify(issued.token, result.publicKey, {
        audience: 'price-group-catalog',
        currentDate: new Date(relayUnitNow * 1000),
        issuer,
      }),
    );
    const { legalEntityId, ...tenantPrincipal } = relayUnitPrincipal;
    expect(verified.payload['principal']).toEqual(tenantPrincipal);
    expect(verified.payload['compositionRevision']).toBe(result.revision);
    expect(verified.payload.exp).toBe(relayUnitNow + 280);
    expect(verified.payload.iat).toBe(relayUnitNow - 20);
    expect(result.resolvedSourceScopes).toEqual([
      {
        legalEntityId,
        legalEntityScope: 'required',
        principalId: relayUnitPrincipal.principalId,
        tenantId: relayUnitPrincipal.tenantId,
      },
    ]);
    expect(result.ledgerClaims).toBe(1);
  }),
);

it.effect('rejects a tenant-only CCC source before context resolution, exchange reservation or target signing', () =>
  Effect.gen(function* requiredSourceLegalEntityCannotBeOmitted() {
    const { legalEntityId, ...tenantPrincipal } = relayUnitPrincipal;
    expect(legalEntityId).toBeDefined();
    const result = yield* relayCase({ route: 'customerPriceGroup', source: { principal: tenantPrincipal } });
    assertDenied(result, 'forbidden');
    expect(result.resolvedSourceScopes).toEqual([]);
  }),
);

it.effect('fingerprints the full CCC source Legal Entity even though both target assertions omit it', () =>
  Effect.gen(function* sourceLegalEntityFingerprintRemainsDistinct() {
    const first = yield* relayCase({ route: 'customerPriceGroup' });
    const second = yield* relayCase({
      principal: { legalEntityId: '30000000-0000-4000-8000-000000000002' },
      route: 'customerPriceGroup',
    });
    expect(Exit.isSuccess(first.result)).toBe(true);
    expect(Exit.isSuccess(second.result)).toBe(true);
    expect(first.ledgerFingerprints).toHaveLength(1);
    expect(second.ledgerFingerprints).toHaveLength(1);
    expect(first.ledgerFingerprints[0]).not.toBe(second.ledgerFingerprints[0]);
    for (const result of [first, second]) {
      if (!Exit.isSuccess(result.result)) {
        return;
      }
      const issued = result.result.value;
      const verified = yield* Effect.promise(() =>
        jwtVerify(issued.token, result.publicKey, {
          audience: 'price-group-catalog',
          currentDate: new Date(relayUnitNow * 1000),
          issuer,
        }),
      );
      expect(verified.payload['principal']).not.toHaveProperty('legalEntityId');
    }
  }),
);

it.effect('adds Market subject restrictions with the complete original Principal and no scope projection', () =>
  Effect.gen(function* marketSubjectRetainsOriginalScope() {
    const result = yield* relayCase({ route: 'marketSubject' });
    expect(Exit.isSuccess(result.result)).toBe(true);
    if (!Exit.isSuccess(result.result)) {
      return;
    }
    const issued = result.result.value;
    const verified = yield* Effect.promise(() =>
      jwtVerify(issued.token, result.publicKey, {
        audience: 'commerce-customer-context',
        currentDate: new Date(relayUnitNow * 1000),
        issuer,
      }),
    );
    expect(verified.payload['principal']).toEqual(relayUnitPrincipal);
    expect(verified.payload.exp).toBe(relayUnitNow + 280);
    expect(result.resolvedSourceScopes[0]?.legalEntityScope).toBe('required');
  }),
);

for (const [label, input, code] of [
  ['source-current-denied', { contextFailure: 'denied' }, 'forbidden'],
  ['source-current-unavailable', { contextFailure: 'unavailable' }, 'unavailable'],
  ['source-binding-revoked', { originalBindingRevoked: true }, 'forbidden'],
  ['provider-missing', { missingDeployment: 'price-group-catalog' }, 'forbidden'],
  ['source-build-mismatch', { source: { targetBuildMarker: 'other-build' } }, 'forbidden'],
  ['source-revision-mismatch', { source: { compositionRevision: 'b'.repeat(64) } }, 'forbidden'],
  [
    'wrong-target-operation',
    { target: { operationKey: 'pricing.price-group-catalog.api.price-group-current' } },
    'forbidden',
  ],
  ['source-expired', { source: { exp: relayUnitNow } }, 'authentication_required'],
] satisfies readonly (readonly [string, RelayCase, GatewayRelayError['code']])[]) {
  it.effect(`keeps CCC projection closed for ${label}`, () =>
    Effect.gen(function* projectedRelayFailure() {
      assertDenied(yield* relayCase({ ...input, route: 'customerPriceGroup' }), code);
    }),
  );
}

it.effect('retains CCC Legal Entity on its previously approved Party relationship', () =>
  Effect.gen(function* customerPartyScopeIsUnchanged() {
    const result = yield* relayCase({ route: 'customerParty' });
    expect(Exit.isSuccess(result.result)).toBe(true);
    if (!Exit.isSuccess(result.result)) {
      return;
    }
    const issued = result.result.value;
    const verified = yield* Effect.promise(() =>
      jwtVerify(issued.token, result.publicKey, {
        audience: 'party-registry',
        currentDate: new Date(relayUnitNow * 1000),
        issuer,
      }),
    );
    expect(verified.payload['principal']).toEqual(relayUnitPrincipal);
  }),
);
