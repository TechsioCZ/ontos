import {
  AccessWorkloadSchema,
  AccessDeclarationSchema,
  buildApplicationCompositionCatalog,
  makeActiveApplicationCompositionLayer,
  defineTenantModuleEntrypoint,
  LegalEntityContext,
  PrincipalResolver,
} from '@app/core-runtime';
import { makeAccessDecisionService } from '@app/core-runtime/access/enforcement';
import {
  preserveSystemPrincipalContextTrust,
  readVerifiedGatewayRouteScope,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { inertAccessEnforcementPorts } from '@app/core-runtime/testing/access-gate';
import { internalWorkloadPrincipalId } from '@app/core-runtime/auth/module-credentials';
import { NodeCrypto } from '@effect/platform-node';
import { bindGatewayPrincipalVerifier } from '@app/gateway-principal-verifier/server';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { makeEffectDrizzleAuthAdapter } from '@app/better-auth-effect-drizzle/server';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { CoreDatabase, testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { DateTime, Effect, Layer, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { createLocalJWKSet, decodeJwt, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import {
  decodeSupportedGatewayContextClaims, NATIVE_ROUTE_READ_GATEWAY_ASSERTION_VERSION,
  DELEGATED_NATIVE_ROUTE_READ_GATEWAY_ASSERTION_VERSION, GatewayActorClaimSchema,
} from '@app/shared-contracts';

import {
  issueGatewayContextAssertion,
  issueRouteScopedGatewayContextAssertion,
  issueNativeReadRouteScopedGatewayContextAssertion,
  issueNativeRouteReadGatewayContextAssertion,
  makeGatewayIssuerLayer,
} from '../../api/auth/gateway-issuer.ts';
import {
  acquireSymmyRouteScopeProof,
  issueSymmyRouteScopeAssertion,
  projectSymmyRouteScopePrincipal,
  readSymmyRouteScope,
  readAdmittedSymmyNativeRead,
} from '../../api/auth/gateway-symmy-route-scope.ts';
import { capturingScopeGrantRegistrar, scopeGrantRegistrarLayer } from '../support/gateway-issuer-layer.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { AuthDatabase } from '../../api/auth/db/client.ts';
import { authDatabaseSchema, authRelations } from '../../api/auth/db/schema.ts';
import { admitAssertionSubject } from '../../api/auth/gateway-assertion-evidence.ts';
import { GatewayDelegationVerification } from '../../api/auth/gateway-delegation-verification.ts';
import { GatewayModuleBindingSchema } from '../../api/auth/gateway-delegation-policy.ts';
import { admitNativeRouteRead, readAdmittedNativeRouteRead } from '../../api/auth/gateway-native-route-read.ts';
import { partyRegistryRegisteredWorkloadCalls } from '../../../../verticals/party-registry/src/registered-workload-calls.ts';
import { commerceCustomerContextRegisteredWorkloadCalls } from '../../../../verticals/commerce-customer-context/src/registered-workload-calls.ts';
import { makePrincipalResolverDouble } from '../support/identity-service-doubles.ts';
import type { ShellInstalledCatalog } from '../../api/modules/installed-module-catalog.ts';
import {
  ShellInstalledModuleCatalog,
  InstalledModuleCatalogUnavailableError,
} from '../../api/modules/installed-module-catalog.ts';

const compositionRevision = 'a'.repeat(64);
const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-api-key:native-route-key',
  authenticationNamespaceId: 'test.integration.better-auth.v1',
  authMethod: 'api_key' as const,
  principalId: '40000000-0000-4000-8000-000000000001',
  tenantId: '50000000-0000-4000-8000-000000000001',
};
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const nativePrincipalId = '90000000-0000-4000-8000-000000000001';
const nativeBindingIncarnation = '90000000-0000-4000-8000-000000000002';
const originalReadIncarnation = '90000000-0000-4000-8000-000000000003';
const response = {
  allowedOwnerOperations: [
    { entrypointKey: 'party.registry.api.source-profile-export', moduleId: 'party.registry', schemaVersion: '1' },
  ],
  issuerId: 'route-test',
  legalEntityId,
  mappingVersion: 'mapping-1',
  routeId: '70000000-0000-4000-8000-000000000001',
  routeRevision: 'route-1',
  sourceMappingVersion: 'source-mapping-1',
  sourceNamespace: 'native-route-test',
  sourceRouteId: '80000000-0000-4000-8000-000000000001',
  sourceRouteRevision: 'source-1',
  tenantId: principal.tenantId,
};
const request = {
  compositionRevision,
  principal,
  requestCorrelation: 'route-proof-transport-test',
  routeRequest: { routeKey: 'adminCustomers' as const },
  sourcePurpose: 'read' as const,
};

const fixture = Effect.fn('RouteScopeTest.fixture')(function* fixture(options: {
  readonly activeBinding?: boolean;
  readonly allowedOwnerOperations?: typeof response.allowedOwnerOperations;
  readonly catalog?: ShellInstalledCatalog;
  /** The owner answers a route enrolled for no company. */
  readonly companyless?: boolean;
  readonly replayIdempotencyDigest?: string;
  readonly responseTenant?: string;
  readonly receiver?: 'system' | 'service' | 'missing' | 'ambiguous';
  readonly originalReadActive?: boolean;
  readonly onwardSourceActive?: boolean;
  readonly originalReadWorkload?: 'integration.symmy-admit' | 'integration.symmy-poll';
}) {
  const { privateKey, publicKey } = yield* Effect.promise(() =>
    generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }),
  );
  const jwk = yield* Effect.promise(() => exportJWK(privateKey));
  const calls: { readonly authorization: string | null; readonly body: string; readonly url: string }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const incoming = new Request(input, init);
    calls.push({
      authorization: incoming.headers.get('authorization'),
      body: await incoming.text(),
      url: incoming.url,
    });
    const { legalEntityId: _company, ...companylessRoute } = response;
    const ownerResponse = {
      ...(options.companyless === true ? companylessRoute : response),
      allowedOwnerOperations: options.allowedOwnerOperations ?? response.allowedOwnerOperations,
      tenantId: options.responseTenant ?? response.tenantId,
    };
    if (options.replayIdempotencyDigest !== undefined) {
      Object.assign(ownerResponse, {
        allowedOwnerOperations: [],
        replayIdempotencyDigest: options.replayIdempotencyDigest,
      });
    }
    return Response.json(ownerResponse);
  };
  const nativeQueries: { statement: string; parameters: readonly unknown[] }[] = [];
  const connection = testSqlConnection((statement, parameters) => {
    if (statement.includes('join core.access_workload_bindings current_source')) {
      nativeQueries.push({ statement, parameters });
      if (options.originalReadActive === false || options.onwardSourceActive === false || options.receiver === 'missing') {
        return Effect.succeed([]);
      }
      const workloadKey = parameters.find((value) => typeof value === 'string' &&
        ['party.registry.source-read', 'privacy.core.source-processing-check', 'privacy.core.organization-business-check'].includes(value));
      if (typeof workloadKey !== 'string') return Effect.succeed([]);
      return Effect.succeed(Array.from({ length: options.receiver === 'ambiguous' ? 2 : 1 }, () => ({
        principalId: options.receiver === 'service'
          ? internalWorkloadPrincipalId({ tenantId: principal.tenantId, legalEntityId, workloadKey }) : nativePrincipalId,
        bindingIncarnation: nativeBindingIncarnation,
      })));
    }
    if (statement.includes('as "originalWorkloadKey"')) {
      nativeQueries.push({ statement, parameters });
      const workloadKey = parameters.find((parameter) => typeof parameter === 'string' &&
        ['party.registry.source-read', 'commerce.customer-context.source-read', 'pricing.price-group-catalog.source-read',
          'commerce.pricing.source-read', 'commerce.catalog.symmy-product-read', 'commerce.inventory.source-read',
          'privacy.core.source-processing-check'].includes(parameter));
      if (typeof workloadKey !== 'string' || options.receiver === 'missing' || options.originalReadActive === false) {
        return Effect.succeed([]);
      }
      const principalId = options.receiver === 'service'
        ? internalWorkloadPrincipalId({ tenantId: principal.tenantId, legalEntityId, workloadKey })
        : nativePrincipalId;
      return Effect.succeed(Array.from({ length: options.receiver === 'ambiguous' ? 2 : 1 }, () => ({
        principalId, bindingIncarnation: nativeBindingIncarnation,
        originalWorkloadKey: options.originalReadWorkload ?? 'integration.symmy-admit',
        originalWorkloadBindingIncarnation: originalReadIncarnation,
      })));
    }
    return Effect.succeed(
      statement.includes('from core.principals p') &&
        options.activeBinding !== false &&
        parameters.includes(principal.authBindingId) &&
        parameters.includes('native-route-key') &&
        parameters.includes(principal.authenticationNamespaceId)
        ? [{ principal_id: principal.principalId }]
        : [],
    );
  });
  const database = Layer.effect(CoreDatabase, testCoreDatabase.pipe(Effect.map((executor) => ({ executor })))).pipe(
    Layer.provide(scriptedPgClientLayer(Effect.succeed(connection)).pipe(Layer.provide(Reactivity.layer))),
  );
  const grants = capturingScopeGrantRegistrar();
  const issuer = makeGatewayIssuerLayer({
    currentTimeSeconds: Effect.succeed(1_700_000_000),
    generateJti: Effect.succeed('60000000-0000-4000-8000-000000000001'),
    loadAdmission: Effect.succeed({
      audiences: new Map([
        ['commerce-customer-context', 'native-route-build'],
        ['symmy-integration', 'native-route-build'],
        ['inventory', 'native-route-build'],
        ['merchandise', 'native-route-build'],
        ['party-registry', 'native-route-build'],
        ['price-group-catalog', 'native-route-build'],
        ['pricing', 'native-route-build'],
        ['catalog', 'native-route-build'],
        ['privacy', 'native-route-build'],
      ]),
      revision: options.catalog?.composition.revision ?? compositionRevision,
    }),
    loadConfig: Effect.succeed({
      issuer: 'https://shell.test',
      privateJwk: {
        alg: 'EdDSA',
        crv: 'Ed25519',
        d: jwk.d ?? '',
        kid: 'route-test',
        kty: 'OKP',
        use: 'sig',
        x: jwk.x ?? '',
      },
    }),
  }).pipe(Layer.provide(scopeGrantRegistrarLayer(grants.registrar)));
  const company = Layer.succeed(LegalEntityContext, {
    listActiveForTenant: () => Effect.succeed([{ legalEntityId, legalName: 'Route company' }]),
    validateSelection: (tenant, companyId) => {
      expect(tenant).toBe(principal.tenantId);
      expect(companyId).toBe(legalEntityId);
      return Effect.succeed({ legalEntityId, legalName: 'Route company' });
    },
  });
  const catalog = Layer.succeed(ShellInstalledModuleCatalog, {
    load:
      options.catalog === undefined
        ? Effect.fail(new InstalledModuleCatalogUnavailableError({ reason: 'Projection must reject before catalog' }))
        : Effect.succeed(options.catalog),
  });
  return {
    calls,
    nativeQueries,
    grantInputs: grants.inputs,
    layer: Layer.mergeAll(database, issuer, company, catalog, NodeCrypto.layer, Layer.succeed(FetchHttpClient.Fetch, fakeFetch)),
    publicKey,
  };
});

it.effect('hands the signed uncommitted intake route to exact native Privacy with its actual Symmy actor and source lifetime', () =>
  Effect.gen(function* nativeIntakeHandoff() {
    const intakeAction = 'integration.symmy.admit-symmy-job';
    const requirementKey = 'integration.symmy.requirement.customer-intake-privacy';
    const privacyRead = 'privacy.core.api.source-processing-eligibility';
    const symmy = makeModuleContractFixture({ appId: 'symmy-integration', buildMarker: 'native-route-build', moduleId: 'integration.symmy' });
    const privacy = makeModuleContractFixture({ appId: 'privacy', buildMarker: 'native-route-build', moduleId: 'privacy.core' });
    const snapshot = yield* makeCompositionSnapshot([{
      ...symmy,
      manifest: {
        ...symmy.manifest,
        requirements: {
          schemaVersion: '1', coreCapabilities: [], intrinsic: [],
          operations: [{
            key: requirementKey, condition: 'integration.symmy.condition.personal-customer-source-intake',
            evidence: ['integration.symmy.evidence.qualified-customer-source'], entrypointKey: intakeAction,
            provider: { moduleId: 'privacy.core', entrypointKey: privacyRead, schemaVersion: '1' },
          }],
        },
        publicSurface: {
          ...symmy.manifest.publicSurface,
          actions: [{
            actionKey: intakeAction, auditProfile: 'standard', idempotency: 'required', legalEntityScope: 'optional',
            owningModuleId: 'integration.symmy', schemaVersion: '1',
            accessWorkload: { reason: 'Current intake admission', workloads: ['integration.symmy-admit'] },
            entrypoint: defineTenantModuleEntrypoint({
              access: 'write', authorization: { kind: 'protected' }, entrypointKey: intakeAction,
              moduleKey: 'integration.symmy', role: 'action',
            }),
          }],
        },
      },
    }, {
      ...privacy,
      manifest: {
        ...privacy.manifest,
        publicSurface: {
          ...privacy.manifest.publicSurface,
          api: [{ key: 'privacy.core.api.processing', operationKeys: ['eligibility.execute'] }],
          operationContracts: [{
            apiKey: 'privacy.core.api.processing', operationKey: 'eligibility.execute', schemaVersion: '1',
            entrypoint: defineTenantModuleEntrypoint({
              access: 'read', authorization: { kind: 'protected' }, entrypointKey: privacyRead,
              moduleKey: 'privacy.core', role: 'api',
            }),
          }],
        },
      },
    }]);
    const installed = { ...(yield* buildApplicationCompositionCatalog(snapshot.composition)), composition: snapshot.composition };
    const binding = Schema.decodeUnknownSync(GatewayModuleBindingSchema)({
      compositionRevision: snapshot.composition.revision, providerKeyId: 'symmy-module-key',
      sourceAppId: 'symmy-integration', sourceBuildMarker: 'native-route-build',
    });
    const actor = Schema.decodeUnknownSync(GatewayActorClaimSchema)({
      appId: 'symmy-integration', buildMarker: 'native-route-build',
      principalId: '60000000-0000-4000-8000-000000000004',
    });
    const auth = Layer.effect(AuthDatabase, Effect.gen(function* currentKeyDatabase() {
      const executor = yield* makeWithDefaults({ relations: authRelations });
      return { executor, adapter: yield* makeEffectDrizzleAuthAdapter(executor, authDatabaseSchema) };
    })).pipe(Layer.provide(scriptedPgClientLayer(Effect.succeed(testSqlConnection((sql) =>
      Effect.succeed(sql.includes('apikey') ? [{ enabled: true, expiresAt: null }] : []),
    ))).pipe(Layer.provide(Reactivity.layer))));
    const resolver = Layer.succeed(PrincipalResolver, makePrincipalResolverDouble({
      resolveBetterAuthApiKey: () => Effect.succeed({
        authBindingId: principal.authBindingId, displayName: 'Synthetic integration',
        principalId: principal.principalId, principalKind: 'integration', tenantId: principal.tenantId,
      }),
    }));
    for (const [receiver, routeKey] of [
      ['system', 'customersBatch'], ['service', 'customersBatch'],
      ['system', 'customerGroupCustomersBatch'], ['service', 'customerGroupCustomersBatch'],
    ] as const) {
      const current = yield* fixture({ catalog: installed, receiver });
      const publicJwk = yield* Effect.promise(() => exportJWK(current.publicKey));
      const verification = Layer.succeed(GatewayDelegationVerification, {
        load: Effect.succeed({
          issuer: 'https://shell.test',
          keys: createLocalJWKSet({ keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'route-test', use: 'sig' }] }),
        }),
      });
      yield* Effect.gen(function* exactNativeIntake() {
        const routeProof = yield* acquireSymmyRouteScopeProof({
          ...request, compositionRevision: snapshot.composition.revision,
          routeRequest: { routeKey }, sourcePurpose: 'admit',
        });
        const original = yield* issueSymmyRouteScopeAssertion(routeProof, {
          audience: 'symmy-integration', principal, legalEntityId,
        });
        const verifiedSource = yield* admitAssertionSubject({
          assertion: Redacted.make(original.token), binding, currentDate: new Date(1_700_000_001_000),
          now: 1_700_000_001, requestedCompositionRevision: snapshot.composition.revision,
        });
        const input = {
          actor, audience: 'privacy', binding, installed, operationRequirementKey: requirementKey,
          requestCorrelation: 'actual-native-intake', requestHash: 'b'.repeat(64), source: verifiedSource.verifiedAssertion,
        };
        const witness = yield* admitNativeRouteRead(input);
        expect(Object.isFrozen(readAdmittedNativeRouteRead(witness)?.routeScope)).toBe(true);
        const issued = yield* issueNativeRouteReadGatewayContextAssertion(witness);
        const jwt = yield* Effect.promise(() => jwtVerify(issued.token, current.publicKey, {
          algorithms: ['EdDSA'], audience: 'privacy', issuer: 'https://shell.test', currentDate: new Date(1_700_000_001_000),
        }));
        const claims = yield* decodeSupportedGatewayContextClaims(jwt.payload);
        expect(claims.ver).toBe(DELEGATED_NATIVE_ROUTE_READ_GATEWAY_ASSERTION_VERSION);
        expect(jwt.payload['act']).toEqual(actor);
        expect(jwt.payload['iat']).toBe(decodeJwt(original.token).iat);
        expect(jwt.payload['exp']).toBe(decodeJwt(original.token).exp);
        expect('workload' in claims).toBe(false);
        expect(jwt.payload['routeScope']).toMatchObject({
          routeKey, legalEntityId,
          operations: [{ entrypointKey: privacyRead, schemaVersion: '1' }],
          nativeReadReceiver: { requestHash: 'b'.repeat(64), workloadKey: 'privacy.core.source-processing-check', originalPrincipalId: principal.principalId },
        });
        const redeemed = yield* bindGatewayPrincipalVerifier('privacy', privacy.deployment).verifyAndRedeem(
          Redacted.make(`Bearer ${issued.token}`), {
            currentTimeSeconds: Effect.succeed(1_700_000_001),
            environment: {
              ONTOS_GATEWAY_ISSUER: 'https://shell.test',
              ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'route-test', use: 'sig' }] }),
            },
            redemption: { consume: () => Effect.void },
          },
        ).pipe(Effect.provide(makeActiveApplicationCompositionLayer(Effect.succeed(snapshot))));
        expect(readVerifiedGatewayRouteScope(redeemed)?.nativeReadReceiver?.originalWorkloadKey).toBe('integration.symmy-admit');
        expect(yield* issueNativeRouteReadGatewayContextAssertion(witness).pipe(Effect.flip)).toMatchObject({ stage: 'principal' });
        for (const invalid of [
          { ...input, operationRequirementKey: 'integration.symmy.requirement.unregistered' },
          { ...input, audience: 'party-registry' },
          { ...input, actor: { ...actor, appId: 'party-registry' } },
          { ...input, binding: { ...binding, sourceBuildMarker: 'stale-source-build' } },
        ]) {
          expect(yield* admitNativeRouteRead(invalid).pipe(Effect.flip)).toMatchObject({ code: 'forbidden' });
        }
        const copied = Object.assign(Object.create(Object.getPrototypeOf(witness)), witness);
        expect(readAdmittedNativeRouteRead(copied)).toBeUndefined();
        expect(yield* issueNativeRouteReadGatewayContextAssertion(copied).pipe(Effect.flip)).toMatchObject({ stage: 'principal' });
      }).pipe(Effect.provide(Layer.mergeAll(current.layer, auth, resolver, verification)));
    }
  }),
);

it.effect('follows only installed finite native Read edges across V9 and V10 with current bindings and fresh body hashes', () =>
  Effect.gen(function* customerPageHandoff() {
    for (const sourceKind of ['customer-profile-source-page', 'customer-profile-source'] as const) {
    const sourcePage = `commerce.customer-context.api.${sourceKind}`;
    const sourceModule = 'commerce.customer-context';
    const targets = [
      ['party', 'party-registry', 'party.registry', 'party.registry.api.source-person-admission', 'party.registry.source-read'],
      ['counterparty', 'party-registry', 'party.registry', 'party.registry.api.source-counterparty-admission', 'party.registry.source-read'],
      ['counterparty-person', 'party-registry', 'party.registry', 'party.registry.api.source-person-admission', 'party.registry.source-read'],
      ['privacy', 'privacy', 'privacy.core', 'privacy.core.api.source-processing-eligibility', 'privacy.core.source-processing-check'],
      ['organization', 'privacy', 'privacy.core', 'privacy.core.api.organization-business-applicability', 'privacy.core.organization-business-check'],
    ] as const;
    for (const [suffix, audience, moduleId, entrypointKey, workloadKey] of targets) {
      const requirementKey = `commerce.customer-context.requirement.${sourceKind}-${suffix}`;
      const sourceBase = makeModuleContractFixture({
        appId: 'commerce-customer-context', buildMarker: 'native-route-build', moduleId: sourceModule,
      });
      const targetBase = makeModuleContractFixture({ appId: audience, buildMarker: 'native-route-build', moduleId });
      const privacyBase = makeModuleContractFixture({ appId: 'privacy', buildMarker: 'native-route-build', moduleId: 'privacy.core' });
      const onwardRequirement = `party.registry.requirement.${entrypointKey.slice('party.registry.'.length)}-source-privacy`;
      const onwardRead = 'privacy.core.api.source-processing-eligibility';
      const publicRead = (key: string, owner: string) => ({
        apiKey: `${owner}.api.source`, operationKey: 'source.execute', schemaVersion: '1',
        entrypoint: defineTenantModuleEntrypoint({
          access: 'read', authorization: { kind: 'protected' }, entrypointKey: key, moduleKey: owner, role: 'api',
        }),
      });
      const snapshot = yield* makeCompositionSnapshot([{
        ...sourceBase,
        manifest: {
          ...sourceBase.manifest,
          requirements: {
            schemaVersion: '1', coreCapabilities: [], intrinsic: [],
            operations: [{
              key: requirementKey, condition: 'commerce.customer-context.condition.current-source-profile',
              evidence: ['commerce.customer-context.evidence.exact-source-profile-authority'], entrypointKey: sourcePage,
              provider: { moduleId, entrypointKey, schemaVersion: '1' },
            }],
          },
          publicSurface: {
            ...sourceBase.manifest.publicSurface,
            api: [{ key: `${sourceModule}.api.source`, operationKeys: ['source.execute'] }],
            operationContracts: [publicRead(sourcePage, sourceModule)],
          },
        },
      }, {
        ...targetBase,
        manifest: {
          ...targetBase.manifest,
          ...(audience === 'party-registry' ? {
            requirements: {
              schemaVersion: '1' as const, coreCapabilities: [], intrinsic: [],
              operations: [{ key: onwardRequirement, entrypointKey,
                condition: 'party.registry.condition.client-source-processing',
                evidence: ['party.registry.evidence.current-qualified-source'],
                provider: { moduleId: 'privacy.core', entrypointKey: onwardRead, schemaVersion: '1' } }],
            },
          } : {}),
          publicSurface: {
            ...targetBase.manifest.publicSurface,
            api: [{ key: `${moduleId}.api.source`, operationKeys: ['source.execute'] }],
            operationContracts: [publicRead(entrypointKey, moduleId)],
          },
        },
      }, ...(audience === 'party-registry' ? [{
        ...privacyBase, manifest: { ...privacyBase.manifest, publicSurface: {
          ...privacyBase.manifest.publicSurface,
          api: [{ key: 'privacy.core.api.source', operationKeys: ['source.execute'] }],
          operationContracts: [publicRead(onwardRead, 'privacy.core')],
        } },
      }] : [])]);
      const installed = { ...(yield* buildApplicationCompositionCatalog(snapshot.composition)), composition: snapshot.composition };
      const binding = Schema.decodeUnknownSync(GatewayModuleBindingSchema)({
        compositionRevision: snapshot.composition.revision, providerKeyId: 'commerce-module-key',
        sourceAppId: 'commerce-customer-context', sourceBuildMarker: 'native-route-build',
        registeredWorkloads: commerceCustomerContextRegisteredWorkloadCalls,
      });
      const actor = Schema.decodeUnknownSync(GatewayActorClaimSchema)({
        appId: 'commerce-customer-context', buildMarker: 'native-route-build',
        principalId: '60000000-0000-4000-8000-000000000004',
      });
      for (const receiver of ['system', 'service'] as const) {
        const current = yield* fixture({
          catalog: installed, receiver, originalReadWorkload: 'integration.symmy-poll',
          allowedOwnerOperations: [{ moduleId: sourceModule, entrypointKey: sourcePage, schemaVersion: '1' }],
        });
        const publicJwk = yield* Effect.promise(() => exportJWK(current.publicKey));
        const verification = Layer.succeed(GatewayDelegationVerification, {
          load: Effect.succeed({ issuer: 'https://shell.test',
            keys: createLocalJWKSet({ keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'route-test', use: 'sig' }] }) }),
        });
        yield* Effect.gen(function* actualNativePageSource() {
          const proof = yield* acquireSymmyRouteScopeProof({ ...request, compositionRevision: snapshot.composition.revision });
          const original = yield* issueSymmyRouteScopeAssertion(proof, {
            audience: 'commerce-customer-context', principal, legalEntityId,
          });
          const subjectInput = {
            assertion: Redacted.make(original.token), binding, currentDate: new Date(1_700_000_001_000),
            now: 1_700_000_001, requestedCompositionRevision: snapshot.composition.revision,
          };
          expect(yield* admitAssertionSubject(subjectInput).pipe(Effect.flip)).toMatchObject({ code: 'forbidden' });
          const source = yield* admitAssertionSubject({ ...subjectInput, nativeRouteRead: true });
          const input = { actor, audience, binding, installed, operationRequirementKey: requirementKey,
            requestCorrelation: 'actual-native-page', requestHash: 'b'.repeat(64), source: source.verifiedAssertion };
          const witness = yield* admitNativeRouteRead(input);
          const evidence = readAdmittedNativeRouteRead(witness);
          expect(evidence?.moduleAccess).toEqual([
            { access: 'read', moduleKey: sourceModule }, { access: 'read', moduleKey: moduleId },
          ]);
          const issued = yield* issueNativeRouteReadGatewayContextAssertion(witness);
          const claims = yield* decodeSupportedGatewayContextClaims((yield* Effect.promise(() =>
            jwtVerify(issued.token, current.publicKey, { audience, issuer: 'https://shell.test',
              currentDate: new Date(1_700_000_001_000) }))).payload);
          expect(claims.ver).toBe(DELEGATED_NATIVE_ROUTE_READ_GATEWAY_ASSERTION_VERSION);
          expect(claims.iat).toBe(decodeJwt(original.token).iat);
          expect(claims.exp).toBe(decodeJwt(original.token).exp);
          const redeemed = yield* bindGatewayPrincipalVerifier(audience, targetBase.deployment).verifyAndRedeem(
            Redacted.make(`Bearer ${issued.token}`), {
              currentTimeSeconds: Effect.succeed(1_700_000_001),
              environment: { ONTOS_GATEWAY_ISSUER: 'https://shell.test',
                ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'route-test', use: 'sig' }] }) },
              redemption: { consume: () => Effect.void },
            },
          ).pipe(Effect.provide(makeActiveApplicationCompositionLayer(Effect.succeed(snapshot))));
          expect(readVerifiedGatewayRouteScope(redeemed)).toMatchObject({
            routeKey: 'adminCustomers', legalEntityId,
            operations: [{ entrypointKey, schemaVersion: '1' }],
            nativeReadReceiver: { requestHash: 'b'.repeat(64), workloadKey, originalPrincipalId: principal.principalId,
              originalWorkloadKey: 'integration.symmy-poll', originalWorkloadBindingIncarnation: originalReadIncarnation },
          });
          if (audience === 'party-registry') {
            const partyBinding = Schema.decodeUnknownSync(GatewayModuleBindingSchema)({
              ...binding, providerKeyId: 'party-module-key', sourceAppId: 'party-registry',
              registeredWorkloads: partyRegistryRegisteredWorkloadCalls,
            });
            const onwardSourceInput = {
              assertion: Redacted.make(issued.token), binding: partyBinding,
              now: 1_700_000_001, currentDate: new Date(1_700_000_001_000),
              requestedCompositionRevision: snapshot.composition.revision,
            };
            expect(yield* admitAssertionSubject(onwardSourceInput).pipe(Effect.flip)).toMatchObject({ code: 'forbidden' });
            const onwardSource = yield* admitAssertionSubject({ ...onwardSourceInput, nativeRouteRead: true });
            const onwardInput = {
              ...input, audience: 'privacy', binding: partyBinding,
              source: onwardSource.verifiedAssertion, operationRequirementKey: onwardRequirement, requestHash: 'c'.repeat(64),
              actor: { ...actor, appId: 'party-registry', principalId: '60000000-0000-4000-8000-000000000005' },
            };
            const onward = yield* issueNativeRouteReadGatewayContextAssertion(yield* admitNativeRouteRead(onwardInput));
            const onwardClaims = yield* decodeSupportedGatewayContextClaims((yield* Effect.promise(() =>
              jwtVerify(onward.token, current.publicKey, { audience: 'privacy', issuer: 'https://shell.test',
                currentDate: new Date(1_700_000_001_000) }))).payload);
            expect(onwardClaims.ver).toBe(DELEGATED_NATIVE_ROUTE_READ_GATEWAY_ASSERTION_VERSION);
            expect(onwardClaims.iat).toBe(claims.iat);
            expect(onwardClaims.exp).toBe(claims.exp);
            const onwardRedeemed = yield* bindGatewayPrincipalVerifier('privacy', privacyBase.deployment).verifyAndRedeem(
              Redacted.make(`Bearer ${onward.token}`), {
                currentTimeSeconds: Effect.succeed(1_700_000_001),
                environment: { ONTOS_GATEWAY_ISSUER: 'https://shell.test',
                  ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'route-test', use: 'sig' }] }) },
                redemption: { consume: () => Effect.void },
              },
            ).pipe(Effect.provide(makeActiveApplicationCompositionLayer(Effect.succeed(snapshot))));
            expect(readVerifiedGatewayRouteScope(onwardRedeemed)).toMatchObject({
              operations: [{ entrypointKey: onwardRead, schemaVersion: '1' }],
              nativeReadReceiver: { workloadKey: 'privacy.core.source-processing-check', requestHash: 'c'.repeat(64),
                originalPrincipalId: principal.principalId, originalWorkloadBindingIncarnation: originalReadIncarnation },
            });
            // A valid native signature never substitutes for a current installed requirement/receiver edge.
            expect(yield* admitNativeRouteRead({ ...onwardInput, binding: { ...partyBinding, registeredWorkloads: [] } })
              .pipe(Effect.flip)).toMatchObject({ code: 'forbidden' });
          }
          const queriesBeforeRecoveryRefusal = current.nativeQueries.length;
          for (const recoveryBinding of [
            { ...binding, registeredWorkloads: (binding.registeredWorkloads ?? []).filter((rule) => rule.allowRecoverySource === true) },
            { ...binding, registeredWorkloads: (binding.registeredWorkloads ?? []).map((rule) => ({ ...rule, allowHistoricalDeliveryRecovery: true })) },
          ]) {
            expect(yield* admitNativeRouteRead({ ...input, binding: recoveryBinding }).pipe(Effect.flip))
              .toMatchObject({ code: 'forbidden', reason: 'conditional_requirement_refused' });
          }
          expect(current.nativeQueries.length).toBe(queriesBeforeRecoveryRefusal);
          for (const invalid of [
            { ...input, operationRequirementKey: `${requirementKey}-unregistered` },
            { ...input, audience: 'inventory' },
            { ...input, requestHash: 'not-a-request-hash' },
            { ...input, binding: { ...binding, registeredWorkloads: [] } },
            { ...input, binding: { ...binding, sourceBuildMarker: 'stale-build' } },
            { ...input, actor: { ...actor, appId: 'symmy-integration' } },
          ]) {
            expect(yield* admitNativeRouteRead(invalid).pipe(Effect.flip)).toMatchObject({ code: 'forbidden' });
          }
          for (const unavailable of [
            { originalReadActive: false }, { onwardSourceActive: false },
            { receiver: 'missing' as const }, { receiver: 'ambiguous' as const },
          ]) {
            const revoked = yield* fixture({ catalog: installed, ...unavailable });
            expect(yield* admitNativeRouteRead(input).pipe(Effect.flip, Effect.provide(revoked.layer)))
              .toMatchObject({ code: 'forbidden', reason: 'workload_binding_not_active' });
          }
        }).pipe(Effect.provide(Layer.mergeAll(current.layer, verification)));
        const query = current.nativeQueries.find((query) => query.statement.includes('current_source'));
        expect(query?.parameters).toContain(nativeBindingIncarnation);
        expect(query?.parameters).toContain(originalReadIncarnation);
        expect(query?.parameters).toContain(workloadKey);
        expect(query?.statement).toContain("original.kind='integration' and original.status='active'");
        expect(query?.statement).toContain('current_source.incarnation=');
        expect(query?.statement).toContain("cb.status='active'");
      }
    }
    }
  }),
);

it.effect('issues and redeems V9 only after current canonical source-read selection, never from copied issuer input', () =>
  Effect.gen(function* nativeSourceReads() {
    const cases = [
      ['party-registry', 'party.registry', 'party.registry.api.source-profile-export', 'party.registry.source-read'],
      ['commerce-customer-context', 'commerce.customer-context', 'commerce.customer-context.api.customer-profile-source-page', 'commerce.customer-context.source-read'],
      ['price-group-catalog', 'pricing.price-group-catalog', 'pricing.price-group-catalog.api.price-group-source-associations', 'pricing.price-group-catalog.source-read'],
      ['pricing', 'commerce.pricing', 'commerce.pricing.api.price-group-source-prices', 'commerce.pricing.source-read'],
      ['catalog', 'commerce.catalog', 'commerce.catalog.api.catalog-source-product-page', 'commerce.catalog.symmy-product-read'],
    ] as const;
    for (const [audience, moduleId, entrypointKey, workloadKey] of cases) {
      const base = makeModuleContractFixture({ appId: audience, buildMarker: 'native-route-build', moduleId });
      const unrelatedKey = `${moduleId}.api.unrelated`;
      const snapshot = yield* makeCompositionSnapshot([{
        ...base,
        manifest: {
          ...base.manifest,
          publicSurface: {
            ...base.manifest.publicSurface,
            api: [{ key: `${moduleId}.api.source`, operationKeys: ['source.execute', 'unrelated.execute'] }],
            operationContracts: [entrypointKey, unrelatedKey].map((key, index) => ({
              apiKey: `${moduleId}.api.source`, operationKey: index === 0 ? 'source.execute' : 'unrelated.execute',
              schemaVersion: '1',
              entrypoint: defineTenantModuleEntrypoint({
                access: 'read', authorization: { kind: 'protected' }, entrypointKey: key, moduleKey: moduleId, role: 'api',
              }),
            })),
          },
        },
      }]);
      const catalog = { ...(yield* buildApplicationCompositionCatalog(snapshot.composition)), composition: snapshot.composition };
      const tenantOnly = audience === 'price-group-catalog' || audience === 'catalog';
      const sourceRequest = {
        ...request, compositionRevision: snapshot.composition.revision,
        routeRequest: audience === 'price-group-catalog' || audience === 'pricing'
          ? { routeKey: 'priceLists' as const } : request.routeRequest,
      };
      for (const receiver of ['system', 'service'] as const) {
        const current = yield* fixture({
          catalog, receiver, originalReadWorkload: 'integration.symmy-poll',
          allowedOwnerOperations: [entrypointKey, unrelatedKey].map((key) => ({ moduleId, entrypointKey: key, schemaVersion: '1' })),
        });
        yield* Effect.gen(function* issueNativeRead() {
          const proof = yield* acquireSymmyRouteScopeProof(sourceRequest);
          const signed = yield* issueSymmyRouteScopeAssertion(proof,
            tenantOnly ? { audience, principal } : { audience, principal, legalEntityId });
          const verified = yield* Effect.promise(() => jwtVerify(signed.token, current.publicKey, {
            algorithms: ['EdDSA'], audience, issuer: 'https://shell.test', currentDate: new Date(1_700_000_001_000),
          }));
          const claims = yield* decodeSupportedGatewayContextClaims(verified.payload);
          expect(claims.ver).toBe(NATIVE_ROUTE_READ_GATEWAY_ASSERTION_VERSION);
          if (claims.ver !== NATIVE_ROUTE_READ_GATEWAY_ASSERTION_VERSION) return yield* Effect.die('Expected native Read V9');
          const expectedPrincipal = receiver === 'system' ? nativePrincipalId :
            internalWorkloadPrincipalId({ tenantId: principal.tenantId, legalEntityId, workloadKey });
          expect(claims.principal).toMatchObject({ authMethod: 'system', principalId: expectedPrincipal, tenantId: principal.tenantId });
          expect(claims.principal.legalEntityId).toBeUndefined();
          expect(claims.principal.authenticationNamespaceId).toBeUndefined();
          expect(claims.principal.authContextRef).toMatch(/^job:integration\.symmy\.route-read:run:[0-9a-f-]{36}$/u);
          expect(claims.routeScope).toMatchObject({
            routeKey: sourceRequest.routeRequest.routeKey,
            operations: [{ entrypointKey, schemaVersion: '1' }],
            nativeReadReceiver: {
              workloadKey, bindingIncarnation: nativeBindingIncarnation, enrollmentLegalEntityId: legalEntityId,
              originalPrincipalId: principal.principalId, originalWorkloadKey: 'integration.symmy-poll',
              originalWorkloadBindingIncarnation: originalReadIncarnation,
            },
          });
          expect(claims.routeScope.legalEntityId).toBe(tenantOnly ? undefined : legalEntityId);
          expect('workload' in claims).toBe(false);
          const publicJwk = yield* Effect.promise(() => exportJWK(current.publicKey));
          const redeemed = yield* bindGatewayPrincipalVerifier(audience, base.deployment).verifyAndRedeem(
            Redacted.make(`Bearer ${signed.token}`), {
              currentTimeSeconds: Effect.succeed(1_700_000_001),
              environment: {
                ONTOS_GATEWAY_ISSUER: 'https://shell.test',
                ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'route-test', use: 'sig' }] }),
              },
              redemption: { consume: () => Effect.void },
            },
          ).pipe(Effect.provide(makeActiveApplicationCompositionLayer(Effect.succeed(snapshot))));
          expect(readVerifiedGatewayRouteScope(redeemed)?.nativeReadReceiver?.workloadKey).toBe(workloadKey);
          const raw = { audience, compositionRevision: snapshot.composition.revision, principal: claims.principal, routeScope: claims.routeScope };
          expect(yield* issueGatewayContextAssertion(raw).pipe(Effect.flip)).toMatchObject({ stage: 'principal' });
          expect(yield* issueRouteScopedGatewayContextAssertion(raw).pipe(Effect.flip)).toMatchObject({ stage: 'principal' });
          const copied = Object.assign(Object.create(null), raw);
          expect(readAdmittedSymmyNativeRead(copied)).toBeUndefined();
          expect(yield* issueNativeReadRouteScopedGatewayContextAssertion(copied).pipe(Effect.flip)).toMatchObject({ stage: 'principal' });
        }).pipe(Effect.provide(current.layer));
        expect(current.grantInputs.at(-1)?.legalEntityId).toBe(tenantOnly ? undefined : legalEntityId);
        expect(JSON.parse(current.calls[0]?.body ?? '{}')).toEqual(sourceRequest.routeRequest);
        const query = current.nativeQueries[0];
        expect(query?.parameters).toContain(workloadKey);
        expect(query?.parameters).toContain(legalEntityId);
        expect(query?.statement).toContain("receiver.platform_role='internal_workload'");
        expect(query?.statement).toContain("cb.status='active'");
        expect(query?.statement).toContain("original.kind='integration' and original.status='active'");
      }
      for (const options of [
        { receiver: 'missing' as const }, { receiver: 'ambiguous' as const }, { originalReadActive: false },
      ]) {
        const current = yield* fixture({ catalog, ...options, allowedOwnerOperations: [{ entrypointKey, moduleId, schemaVersion: '1' }] });
        const failure = yield* Effect.gen(function* rejectedNativeRead() {
          const proof = yield* acquireSymmyRouteScopeProof(sourceRequest);
          return yield* issueSymmyRouteScopeAssertion(proof,
            tenantOnly ? { audience, principal } : { audience, principal, legalEntityId });
        }).pipe(Effect.flip, Effect.provide(current.layer));
        expect(failure).toMatchObject({ code: 'forbidden', reason: 'symmy_route_not_admitted' });
      }
    }
  }),
);

it.effect('signs only the exact enrolled company catalog import and revision operations on productsBatch', () =>
  Effect.gen(function* demoCatalogAdmission() {
    const moduleId = 'demo.merchandise';
    const importKey = 'demo.merchandise.import-source-catalog';
    const revisionKey = 'demo.merchandise.api.demo-catalog-revision';
    const otherKey = 'demo.merchandise.unrelated-write';
    const base = makeModuleContractFixture({ appId: 'merchandise', buildMarker: 'native-route-build', moduleId });
    const publish = (revisionAccess: 'read' | 'historical_read' = 'read', importVersion = '1') =>
      Effect.gen(function* publishCatalog() {
        const snapshot = yield* makeCompositionSnapshot([{
          ...base,
          manifest: {
            ...base.manifest,
            publicSurface: {
              ...base.manifest.publicSurface,
              actions: [importKey, otherKey].map((actionKey) => ({
                actionKey, auditProfile: 'standard' as const, idempotency: 'required' as const,
                legalEntityScope: 'required' as const, owningModuleId: moduleId,
                schemaVersion: actionKey === importKey ? importVersion : '1',
                accessWorkload: { reason: 'Enrolled catalog import', workloads: ['demo.merchandise.symmy-catalog-import'] },
                entrypoint: defineTenantModuleEntrypoint({
                  access: 'write', authorization: { kind: 'protected' }, entrypointKey: actionKey,
                  moduleKey: moduleId, role: 'action',
                }),
              })),
              api: [{ key: 'demo.merchandise.api.revision', operationKeys: ['revision.execute'] }],
              operationContracts: [{
                apiKey: 'demo.merchandise.api.revision', operationKey: 'revision.execute', schemaVersion: '1',
                entrypoint: defineTenantModuleEntrypoint({
                  access: revisionAccess, authorization: { kind: 'protected' }, entrypointKey: revisionKey,
                  moduleKey: moduleId, role: 'api',
                }),
              }],
            },
          },
        }]);
        return { ...(yield* buildApplicationCompositionCatalog(snapshot.composition)), composition: snapshot.composition };
      });
    const issue = (input: {
      readonly catalog: ShellInstalledCatalog;
      readonly operations: typeof response.allowedOwnerOperations;
      readonly routeKey?: 'productsBatch' | 'customersBatch';
      readonly companyless?: boolean;
      readonly company?: string;
    }) => Effect.gen(function* signCatalogRoute() {
      const current = yield* fixture({
        catalog: input.catalog, allowedOwnerOperations: input.operations,
        companyless: input.companyless === true,
      });
      const signed = yield* Effect.gen(function* exactCatalogProof() {
        const proof = yield* acquireSymmyRouteScopeProof({
          ...request, compositionRevision: input.catalog.composition.revision,
          routeRequest: { routeKey: input.routeKey ?? 'productsBatch' }, sourcePurpose: 'admit',
        });
        const target = { audience: 'merchandise', principal };
        return yield* issueSymmyRouteScopeAssertion(proof,
          input.companyless === true ? target : { ...target, legalEntityId: input.company ?? legalEntityId });
      }).pipe(Effect.provide(current.layer));
      return yield* Effect.promise(() => jwtVerify(signed.token, current.publicKey, {
        algorithms: ['EdDSA'], audience: 'merchandise', issuer: 'https://shell.test',
        currentDate: new Date(1_700_000_001_000),
      }));
    });
    const enrolled = (key: string, schemaVersion = '1') => ({ moduleId, entrypointKey: key, schemaVersion });
    const catalog = yield* publish();
    const operations = [enrolled(importKey), enrolled(revisionKey), enrolled(otherKey), enrolled(revisionKey)];
    const signed = yield* issue({ catalog, operations });
    expect(signed.payload['routeScope']).toMatchObject({
      routeKey: 'productsBatch', legalEntityId, tenantId: principal.tenantId, principalId: principal.principalId,
      operations: [
        { entrypointKey: importKey, schemaVersion: '1' },
        { entrypointKey: revisionKey, schemaVersion: '1' },
      ],
    });
    const revisionOnly = yield* issue({ catalog, operations: [enrolled(revisionKey)] });
    expect(revisionOnly.payload['routeScope']).toMatchObject({
      operations: [{ entrypointKey: revisionKey, schemaVersion: '1' }],
    });
    const importOnly = yield* issue({ catalog, operations: [enrolled(importKey)] });
    expect(importOnly.payload['routeScope']).toMatchObject({
      operations: [{ entrypointKey: importKey, schemaVersion: '1' }],
    });
    for (const input of [
      { catalog, operations, routeKey: 'customersBatch' as const },
      { catalog, operations: [enrolled(otherKey)] },
      { catalog, operations: [{ ...enrolled(importKey), moduleId: 'unrelated.owner' }] },
      { catalog, operations: [enrolled(importKey, '2'), enrolled(revisionKey, '2')] },
      { catalog, operations, companyless: true },
      { catalog, operations, company: '90000000-0000-4000-8000-000000000001' },
      { catalog: yield* publish('historical_read'), operations: [enrolled(revisionKey)] },
      { catalog: yield* publish('read', '2'), operations: [enrolled(importKey)] },
    ]) {
      expect(yield* issue(input).pipe(Effect.flip)).toMatchObject({ code: 'forbidden' });
    }
  }),
);

it.effect('obtains route scope from the protected generated owner Read and refuses reflective or copied proofs', () =>
  Effect.gen(function* actualRouteRead() {
    const current = yield* fixture({});
    yield* Effect.gen(function* inspectRouteProof() {
      const proof = yield* acquireSymmyRouteScopeProof(request);
      const route = yield* readSymmyRouteScope(proof);
      expect(route.legalEntityId).toBe(legalEntityId);
      Object.defineProperty(route, 'legalEntityId', { value: '90000000-0000-4000-8000-000000000001' });
      expect((yield* readSymmyRouteScope(proof)).legalEntityId).toBe(legalEntityId);
      const reflected = Reflect.construct(proof.constructor, [{}, { routeJson: JSON.stringify(response) }]);
      const reflectedFailure = yield* Effect.flip(readSymmyRouteScope(reflected));
      expect(reflectedFailure).toMatchObject({ code: 'forbidden', reason: 'symmy_route_not_admitted' });
      const copied = Object.assign(Object.create(Object.getPrototypeOf(proof)), proof);
      const copiedFailure = yield* Effect.flip(readSymmyRouteScope(copied));
      expect(copiedFailure).toMatchObject({ code: 'forbidden', reason: 'symmy_route_not_admitted' });
      const wrongCompany = yield* Effect.flip(
        projectSymmyRouteScopePrincipal(proof, {
          audience: 'party-registry',
          legalEntityId: '90000000-0000-4000-8000-000000000001',
          principal,
        }),
      );
      expect(wrongCompany).toMatchObject({ code: 'forbidden', reason: 'symmy_route_not_admitted' });
    }).pipe(Effect.provide(current.layer));
    expect(current.calls).toHaveLength(1);
    expect(current.calls[0]?.url).toBe(
      'https://symmy-owner-relay.invalid/module-api/symmy-integration/native-route-build/symmy-integration-api/reads/symmy-route-context',
    );
    expect(JSON.parse(current.calls[0]?.body ?? '{}')).toEqual({ routeKey: 'adminCustomers' });
    const authorization = current.calls[0]?.authorization ?? '';
    expect(decodeJwt(authorization.slice('Bearer '.length)).aud).toBe('symmy-integration');
  }),
);

it.effect('rejects a different tenant returned by the owner and a revoked authentication binding', () =>
  Effect.gen(function* tenantAndBindingControls() {
    const wrongTenant = yield* fixture({ responseTenant: '90000000-0000-4000-8000-000000000001' });
    const tenantFailure = yield* acquireSymmyRouteScopeProof(request).pipe(
      Effect.flip,
      Effect.provide(wrongTenant.layer),
    );
    expect(tenantFailure).toMatchObject({ code: 'forbidden', reason: 'symmy_route_not_admitted' });
    const revoked = yield* fixture({ activeBinding: false });
    const bindingFailure = yield* acquireSymmyRouteScopeProof(request).pipe(Effect.flip, Effect.provide(revoked.layer));
    expect(bindingFailure).toMatchObject({ code: 'forbidden', reason: 'symmy_route_not_admitted' });
    expect(revoked.calls).toHaveLength(0);
  }),
);

it.effect('refuses an admit-purpose claim for a read route before requesting owner authority', () =>
  Effect.gen(function* sourcePurposeControl() {
    const current = yield* fixture({});
    const failure = yield* acquireSymmyRouteScopeProof({ ...request, sourcePurpose: 'admit' }).pipe(
      Effect.flip,
      Effect.provide(current.layer),
    );
    expect(failure).toMatchObject({ code: 'forbidden', reason: 'symmy_route_not_admitted' });
    expect(current.calls).toHaveLength(0);
  }),
);

it.effect('refuses route metadata that names an owner operation absent from the published read contract', () =>
  Effect.gen(function* publishedReadControl() {
    const snapshot = yield* makeCompositionSnapshot([
      makeModuleContractFixture({ appId: 'party-registry', moduleId: 'party.registry' }),
    ]);
    const catalog = yield* buildApplicationCompositionCatalog(snapshot.composition);
    const current = yield* fixture({ catalog: { ...catalog, composition: snapshot.composition } });
    const failure = yield* Effect.gen(function* exactPublishedRead() {
      const proof = yield* acquireSymmyRouteScopeProof({
        ...request,
        compositionRevision: snapshot.composition.revision,
      });
      return yield* Effect.flip(
        projectSymmyRouteScopePrincipal(proof, {
          audience: 'party-registry',
          legalEntityId,
          principal,
        }),
      );
    }).pipe(Effect.provide(current.layer));
    expect(failure).toMatchObject({ code: 'forbidden', reason: 'symmy_route_not_admitted' });
    expect(current.calls).toHaveLength(1);
  }),
);

it.effect('signs only exact admission Actions and the approved v1 sync lookup for an admit-purpose route', () =>
  Effect.gen(function* signedSyncAdmissionRoute() {
    const moduleId = 'integration.symmy';
    const fixtureContract = makeModuleContractFixture({
      appId: 'symmy-integration',
      buildMarker: 'native-route-build',
      moduleId,
    });
    const admissionKeys = ['integration.symmy.admit-symmy-job', 'integration.symmy.admit-symmy-sync'];
    const readKeys = [
      'integration.symmy.api.symmy-sync-admission',
      'integration.symmy.api.symmy-route-context',
      'integration.symmy.api.unrelated-read',
    ];
    const snapshot = yield* makeCompositionSnapshot([
      {
        ...fixtureContract,
        manifest: {
          ...fixtureContract.manifest,
          publicSurface: {
            ...fixtureContract.manifest.publicSurface,
            actions: admissionKeys.map((actionKey) => ({
              accessWorkload: { reason: 'Exact integration admission', workloads: ['integration.symmy-admit'] },
              actionKey,
              auditProfile: 'standard',
              entrypoint: defineTenantModuleEntrypoint({
                access: 'write',
                authorization: { kind: 'protected' },
                entrypointKey: actionKey,
                moduleKey: moduleId,
                role: 'action',
              }),
              idempotency: 'required',
              legalEntityScope: 'optional',
              owningModuleId: moduleId,
              schemaVersion: '1',
            })),
            api: [
              {
                key: 'integration.symmy.api.route-reads',
                operationKeys: readKeys.map((_, index) => `read${index}.execute`),
              },
            ],
            operationContracts: readKeys.map((entrypointKey, index) => ({
              apiKey: 'integration.symmy.api.route-reads',
              entrypoint: defineTenantModuleEntrypoint({
                access: 'read',
                authorization: { kind: 'protected' },
                entrypointKey,
                moduleKey: moduleId,
                role: 'api',
              }),
              operationKey: `read${index}.execute`,
              schemaVersion: '1',
            })),
          },
        },
      },
    ]);
    const catalog = yield* buildApplicationCompositionCatalog(snapshot.composition);
    const current = yield* fixture({ catalog: { ...catalog, composition: snapshot.composition } });
    const assertion = yield* Effect.gen(function* issueExactAdmissionLookup() {
      const proof = yield* acquireSymmyRouteScopeProof({
        ...request,
        compositionRevision: snapshot.composition.revision,
        routeRequest: { routeKey: 'customersBatch' },
        sourcePurpose: 'admit',
      });
      return yield* issueSymmyRouteScopeAssertion(proof, { audience: 'symmy-integration', legalEntityId, principal });
    }).pipe(Effect.provide(current.layer));
    const verified = yield* Effect.promise(() =>
      jwtVerify(assertion.token, current.publicKey, {
        algorithms: ['EdDSA'],
        audience: 'symmy-integration',
        currentDate: DateTime.toDateUtc(DateTime.makeUnsafe(1_700_000_001_000)),
        issuer: 'https://shell.test',
      }),
    );
    expect(verified.payload['routeScope']).toEqual({
      legalEntityId,
      mappingVersion: response.mappingVersion,
      operations: [
        ...admissionKeys.map((entrypointKey) => ({ entrypointKey, schemaVersion: '1' })),
        { entrypointKey: 'integration.symmy.api.symmy-sync-admission', schemaVersion: '1' },
      ],
      principalId: principal.principalId,
      routeId: response.routeId,
      routeKey: 'customersBatch',
      routeRevision: response.routeRevision,
      sourceMappingVersion: response.sourceMappingVersion,
      sourceRouteId: response.sourceRouteId,
      sourceRouteRevision: response.sourceRouteRevision,
      tenantId: principal.tenantId,
    });
    const replayIdempotencyDigest = 'c'.repeat(64);
    const retained = yield* fixture({
      catalog: { ...catalog, composition: snapshot.composition },
      replayIdempotencyDigest,
    });
    const cases = [
      {
        operations: [
          { entrypointKey: 'integration.symmy.admit-symmy-sync', schemaVersion: '1' },
          { entrypointKey: 'integration.symmy.api.symmy-sync-admission', schemaVersion: '1' },
        ],
        routeKey: 'inventoryStockBatch',
      },
      {
        operations: [{ entrypointKey: 'integration.symmy.admit-symmy-job', schemaVersion: '1' }],
        routeKey: 'customersBatch',
      },
    ] as const;
    for (const { operations, routeKey } of cases) {
      const replay = yield* Effect.gen(function* issueRetainedAdmissionLookup() {
        const proof = yield* acquireSymmyRouteScopeProof({
          ...request,
          compositionRevision: snapshot.composition.revision,
          routeRequest: { replayIdempotencyKey: 'retained-receipt-key', routeKey },
          sourcePurpose: 'admit',
        });
        return yield* issueSymmyRouteScopeAssertion(proof, { audience: 'symmy-integration', legalEntityId, principal });
      }).pipe(Effect.provide(retained.layer));
      const retainedToken = yield* Effect.promise(() =>
        jwtVerify(replay.token, retained.publicKey, {
          algorithms: ['EdDSA'],
          audience: 'symmy-integration',
          currentDate: DateTime.toDateUtc(DateTime.makeUnsafe(1_700_000_001_000)),
          issuer: 'https://shell.test',
        }),
      );
      expect(retainedToken.payload['routeScope']).toMatchObject({ operations, replayIdempotencyDigest, routeKey });
    }
  }),
);

it.effect('signs on the customer groups admission route only its enrolled Commerce definition read', () =>
  Effect.gen(function* admissionDefinitionRead() {
    const moduleId = 'commerce.customer-context';
    const definitionRead = 'commerce.customer-context.api.customer-group-definition-source';
    const otherRead = 'commerce.customer-context.api.customer-profile-source-page';
    const groupCreate = 'commerce.customer-context.create-customer-group';
    const commerce = makeModuleContractFixture({ appId: 'commerce-customer-context', moduleId });
    // The catalog publishes the group create as a write and the definition read with the access under test.
    const publish = (definitionAccess: 'historical_read' | 'read') =>
      Effect.gen(function* publishedCommerce() {
        const snapshot = yield* makeCompositionSnapshot([
          {
            ...commerce,
            manifest: {
              ...commerce.manifest,
              publicSurface: {
                ...commerce.manifest.publicSurface,
                actions: [
                  {
                    accessWorkload: {
                      reason: 'Exact source group write',
                      workloads: ['commerce.customer-context.source-write'],
                    },
                    actionKey: groupCreate,
                    auditProfile: 'standard',
                    entrypoint: defineTenantModuleEntrypoint({
                      access: 'write',
                      authorization: { kind: 'protected' },
                      entrypointKey: groupCreate,
                      moduleKey: moduleId,
                      role: 'action',
                    }),
                    idempotency: 'required',
                    legalEntityScope: 'required',
                    owningModuleId: moduleId,
                    schemaVersion: '1',
                  },
                ],
                api: [
                  { key: 'commerce.customer-context.api.reads', operationKeys: ['read0.execute', 'read1.execute'] },
                ],
                operationContracts: [
                  { access: definitionAccess, entrypointKey: definitionRead },
                  { access: 'read' as const, entrypointKey: otherRead },
                ].map(({ access, entrypointKey }, index) => ({
                  apiKey: 'commerce.customer-context.api.reads',
                  entrypoint: defineTenantModuleEntrypoint({
                    access,
                    authorization: { kind: 'protected' },
                    entrypointKey,
                    moduleKey: moduleId,
                    role: 'api',
                  }),
                  operationKey: `read${index}.execute`,
                  schemaVersion: '1',
                })),
              },
            },
          },
        ]);
        const catalog = yield* buildApplicationCompositionCatalog(snapshot.composition);
        return { ...catalog, composition: snapshot.composition };
      });
    const enrolled = (entrypointKeys: readonly string[]) =>
      entrypointKeys.map((entrypointKey) => ({ entrypointKey, moduleId, schemaVersion: '1' }));
    const issue = (input: {
      readonly catalog: ShellInstalledCatalog;
      readonly company?: string;
      readonly companyless?: boolean;
      readonly entrypointKeys: readonly string[];
      readonly routeKey: 'customerGroupsBatch' | 'customersBatch';
    }) =>
      Effect.gen(function* issueCommerceRead() {
        const current = yield* fixture({
          allowedOwnerOperations: enrolled(input.entrypointKeys),
          catalog: input.catalog,
          companyless: input.companyless === true,
        });
        const assertion = yield* Effect.gen(function* admissionRoute() {
          const proof = yield* acquireSymmyRouteScopeProof({
            ...request,
            compositionRevision: input.catalog.composition.revision,
            routeRequest: { routeKey: input.routeKey },
            sourcePurpose: 'admit',
          });
          const target = { audience: 'commerce-customer-context', principal };
          return yield* issueSymmyRouteScopeAssertion(
            proof,
            input.companyless === true ? target : { ...target, legalEntityId: input.company ?? legalEntityId },
          );
        }).pipe(Effect.provide(current.layer));
        return yield* Effect.promise(() =>
          jwtVerify(assertion.token, current.publicKey, {
            algorithms: ['EdDSA'],
            audience: 'commerce-customer-context',
            currentDate: DateTime.toDateUtc(DateTime.makeUnsafe(1_700_000_001_000)),
            issuer: 'https://shell.test',
          }),
        );
      });
    const catalog = yield* publish('read');
    const groupRoute = [groupCreate, 'commerce.customer-context.update-customer-group', definitionRead, otherRead];
    // Two enrollment items name the definition read; the assertion names it once.
    const signed = yield* issue({
      catalog,
      entrypointKeys: [...groupRoute, definitionRead],
      routeKey: 'customerGroupsBatch',
    });
    expect(signed.payload['routeScope']).toMatchObject({
      legalEntityId,
      operations: [{ entrypointKey: definitionRead, schemaVersion: '1' }],
      principalId: nativePrincipalId,
      routeKey: 'customerGroupsBatch',
      tenantId: principal.tenantId,
    });
    // Another admission route; the group route without the definition read, though it enrolls a published write;
    // another company on the group route; a group route enrolled for no company, whose assertion would carry no route
    // scope; and a definition read published only for historical reads.
    for (const refusedInput of [
      { catalog, entrypointKeys: groupRoute, routeKey: 'customersBatch' },
      {
        catalog,
        entrypointKeys: groupRoute.filter((entrypointKey) => entrypointKey !== definitionRead),
        routeKey: 'customerGroupsBatch',
      },
      {
        catalog,
        company: '90000000-0000-4000-8000-000000000001',
        entrypointKeys: groupRoute,
        routeKey: 'customerGroupsBatch',
      },
      { catalog, companyless: true, entrypointKeys: groupRoute, routeKey: 'customerGroupsBatch' },
      { catalog: yield* publish('historical_read'), entrypointKeys: groupRoute, routeKey: 'customerGroupsBatch' },
    ] as const) {
      const refused = yield* Effect.flip(issue(refusedInput));
      expect(refused).toMatchObject({ code: 'forbidden', reason: 'symmy_route_not_admitted' });
    }
  }),
);

it.effect(
  'restricts the redeemed tenant-only Inventory assertion to the enrolled position read and version, even from a company route',
  () =>
    Effect.gen(function* inventoryReadProjection() {
      const moduleId = 'commerce.inventory';
      const entrypointKey = 'commerce.inventory.api.source-stock-position-resolution';
      const otherRead = 'commerce.inventory.api.inventory-source-import-receipt';
      const base = makeModuleContractFixture({ appId: 'inventory', buildMarker: 'native-route-build', moduleId });
      const snapshot = yield* makeCompositionSnapshot([
        {
          ...base,
          manifest: {
            ...base.manifest,
            publicSurface: {
              ...base.manifest.publicSurface,
              api: [{ key: 'commerce.inventory.api.reads', operationKeys: ['read0.execute', 'read1.execute'] }],
              operationContracts: [entrypointKey, otherRead].map((key, index) => ({
                apiKey: 'commerce.inventory.api.reads',
                entrypoint: defineTenantModuleEntrypoint({
                  access: 'read',
                  authorization: { kind: 'protected' },
                  entrypointKey: key,
                  moduleKey: moduleId,
                  role: 'api',
                }),
                operationKey: `read${index}.execute`,
                schemaVersion: '1',
              })),
            },
          },
        },
      ]);
      const catalog = yield* buildApplicationCompositionCatalog(snapshot.composition);
      const installed = { ...catalog, composition: snapshot.composition };
      const ports = inertAccessEnforcementPorts();
      const workload = 'commerce.inventory.source-read';
      const accessWorkload = yield* Schema.decodeUnknownEffect(AccessWorkloadSchema)({
        reason: 'Inventory source reads',
        workloads: [workload],
      });
      const accessDeclaration = yield* Schema.decodeUnknownEffect(AccessDeclarationSchema)({
        key: 'commerce.inventory.source-position.read', kind: 'read', modes: ['run'],
        placement: { group: 'source', level: 'basic' }, risk: 'routine', selectors: [],
      });
      const gate = makeAccessDecisionService({
        authorityFor: ports.intent.authorityFor,
        check: ports.check,
        decisionLog: ports.decisionLog,
        legalEntities: ports.candidates,
        principalKinds: { readKind: () => Effect.succeedSome('system') },
        workloadBindings: {
          readWorkloadAuthority: () => Effect.succeed({ activeCompanyIds: new Set(), workloadKeys: new Set([workload]) }),
        },
      });
      yield* Effect.forEach(
        [true, false],
        (companyless) =>
          Effect.gen(function* tenantAndCompany() {
            const current = yield* fixture({
              allowedOwnerOperations: [{ entrypointKey, moduleId, schemaVersion: '1' }],
              catalog: installed,
              companyless,
            });
            const assertion = yield* Effect.gen(function* issueRead() {
              const proof = yield* acquireSymmyRouteScopeProof({
                ...request,
                compositionRevision: snapshot.composition.revision,
                routeRequest: { routeKey: 'inventoryStockBatch' },
                sourcePurpose: 'admit',
              });
              const target = { audience: 'inventory', principal };
              const denied = yield* issueSymmyRouteScopeAssertion(proof, { ...target, legalEntityId }).pipe(
                Effect.flip,
              );
              expect(denied).toMatchObject({ code: 'forbidden' });
              return yield* issueSymmyRouteScopeAssertion(proof, target);
            }).pipe(Effect.provide(current.layer));
            const publicJwk = yield* Effect.promise(() => exportJWK(current.publicKey));
            const redeemed = yield* bindGatewayPrincipalVerifier('inventory', base.deployment)
              .verifyAndRedeem(Redacted.make(`Bearer ${assertion.token}`), {
                currentTimeSeconds: Effect.succeed(1_700_000_001),
                environment: {
                  ONTOS_GATEWAY_ISSUER: 'https://shell.test',
                  ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
                    keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'route-test', use: 'sig' }],
                  }),
                },
                redemption: { consume: () => Effect.void },
              })
              .pipe(Effect.provide(makeActiveApplicationCompositionLayer(Effect.succeed(snapshot))));
            const scope = preserveSystemPrincipalContextTrust(redeemed, {
              ...redeemed,
              correlationId: request.requestCorrelation,
            });
            expect(scope.legalEntityId).toBeUndefined();
            const decide = (key: string, schemaVersion: string) =>
              gate.decide({
                carrier: {
                  accessDeclaration,
                  accessWorkload, entrypoint: { entrypointKey: key }, schemaVersion,
                },
                legalEntityScope: 'forbidden',
                now: DateTime.toDateUtc(DateTime.makeUnsafe(1_700_000_001_000)),
                scope,
              });
            expect((yield* decide(entrypointKey, '1')).outcome).toBe('ALLOWED');
            expect((yield* decide(otherRead, '1')).outcome).toBe('DENIED');
            expect((yield* decide(entrypointKey, '2')).outcome).toBe('DENIED');
            expect(readVerifiedGatewayRouteScope(redeemed)?.operations).toEqual([
              { entrypointKey, schemaVersion: '1' },
            ]);
          }),
        { concurrency: 1 },
      );
      yield* Effect.forEach(
        ['customersBatch', 'inventoryStockBatch'] as const,
        (routeKey) =>
          Effect.gen(function* deniedRead() {
            const current = yield* fixture({
              allowedOwnerOperations: [
                {
                  entrypointKey: 'commerce.inventory.api.inventory-source-import-receipt',
                  moduleId,
                  schemaVersion: '1',
                },
              ],
              catalog: installed,
              companyless: true,
            });
            const failure = yield* Effect.gen(function* readWithoutEnrollment() {
              const proof = yield* acquireSymmyRouteScopeProof({
                ...request,
                compositionRevision: snapshot.composition.revision,
                routeRequest: { routeKey },
                sourcePurpose: 'admit',
              });
              return yield* projectSymmyRouteScopePrincipal(proof, { audience: 'inventory', principal });
            }).pipe(Effect.provide(current.layer), Effect.flip);
            expect(failure).toMatchObject({ code: 'forbidden' });
          }),
        { concurrency: 1 },
      );
    }),
);
