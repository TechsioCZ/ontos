import {
  ActionTrustedContextValidationError,
  ActiveApplicationCompositionService,
  AccessActorSchema,
  GatewayScopeGrantRegistrar,
  GatewayAssertionReplayError,
  GatewayAssertionRedemptionUnavailableError,
  PrincipalResolver,
  TenantModuleStateService,
  defineAction,
  defineRead,
  defineOntosModuleManifest,
  defineVerticalRuntimeRegistration,
  defineTenantModuleEntrypoint,
  extractVerticalRuntimeSafeDescriptors,
  makePrincipalResolver,
  makeTenantModuleStateService,
  makeOperationalScopeRepository,
  makeOperationalScopeResolver,
  ContextAccessLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OwnerAuthorizationOverlayAllowLive,
  ReadRuntime,
  ActionRuntime,
  makeReadRuntimeLive,
  makeActionRuntimeLive,
} from '@app/core-runtime';
import type { GatewayAssertionRedemptionInput } from '@app/core-runtime';
import { CoreDatabase, makeCoreDatabase } from '@app/core-runtime/db/client';
import {
  AccessDecisionGate,
  AccessDecisionLive,
  AccessEnforcementPortsLive,
  TenantIntentLoaderLive,
  ActionPermissionLive,
  ActionRepositoryLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { computeCanonicalValueHash, computeActionRequestHash } from '@app/core-runtime/access/enforcement';
import { loadSpiceDbConfig } from '@app/core-runtime/access/spicedb-config';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import {
  readVerifiedGatewayOrganizationGovernanceRead,
  readVerifiedGatewayWorkload,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { AuthenticationNamespaceRegistrationSchema } from '@app/core-runtime/auth/external-identity-contracts';
import {
  AuthenticationNamespaceRegistry,
  makeAuthenticationNamespaceRegistry,
} from '@app/core-runtime/auth/external-identity-admission';
import { OperationalScopeResolver } from '@app/core-runtime/operations/context';
import { makeGatewayScopeGrantRegistrar } from '@app/core-runtime/testing/gateway-scope-grant';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { grantTestTenantRoleAccess } from '@app/core-runtime/testing/tenant-access';
import {
  GatewayDelegatedContextRequestSchema,
  GatewayActorClaimSchema,
  decodeSupportedGatewayContextClaims,
} from '@app/shared-contracts';
import {
  acquireDelegatedGatewayContext,
  GatewayDelegationSourceError,
} from '@app/shared-contracts/gateway-context-server';
import { bindGatewayPrincipalVerifier } from '@app/gateway-principal-verifier/server';
import {
  SymmySourceOrganizationFactsApi,
  SymmySourceOrganizationFactsRequestSchema,
  SymmySourceOrganizationFactsResponseSchema,
} from '@app/symmy-integration/api/symmy-source-organization-facts';
import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { ConfigProvider, Context, Crypto, DateTime, Effect, Exit, Layer, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';

import { GatewayIssuer, makeGatewayIssuerLayer } from '../../api/auth/gateway-issuer.ts';
import { parseGatewayIssuerConfig } from '../../api/auth/gateway-issuer-config.ts';
import { makeAuthDatabase, AuthDatabase } from '../../api/auth/db/client.ts';
import { issueDelegatedGatewayContextAssertion } from '../../api/auth/gateway-delegation-issuer.ts';
import { GatewayDelegationVerificationLive } from '../../api/auth/gateway-delegation-verification.ts';
import { GatewayOriginatorEvidenceLive } from '../../api/auth/gateway-originator-evidence.service.ts';
import {
  GatewayDelegationExchangeLedger,
  makeGatewayDelegationExchangeLedger,
} from '../../api/auth/gateway-delegation-exchanges.service.ts';
import {
  makeInstalledModuleCatalogLoader,
  ShellInstalledModuleCatalog,
} from '../../api/modules/installed-module-catalog.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';

const namespaceId = 'native.organization.staff';
const privacyKey = 'native-organization-privacy-module';
const symmyKey = 'native-organization-symmy-module';
const readKey = 'integration.symmy.api.symmy-source-organization-facts';
const capability = 'integration.symmy.symmy-source-organization-facts.read';
const actionKey = 'integration.symmy.native-readonly-probe';
const supportedStates = ['inactive', 'active', 'read_only', 'quarantined'] as const;
const sourceEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: readKey,
  moduleKey: 'integration.symmy',
  role: 'api',
});
const actor = Schema.decodeUnknownSync(AccessActorSchema)({
  callers: ['privacy'],
  reason: 'Exact organization governance native proof',
  subject: 'identity',
  subjectWorkloads: ['integration.symmy.source-organization-facts.read'],
});
const receiverDeployment = { appId: 'symmy-integration', buildMarker: 'symmy-integration-build' };

const definitions = (calls: { actions: number; reads: number }) => {
  const read = defineRead(
    {
      accessActor: actor,
      accessDeclaration: {
        key: capability,
        kind: 'read',
        modes: ['run'],
        placement: { group: 'symmy-source-organization-facts', level: 'basic' },
        risk: 'sensitive',
        selectors: [],
      },
      accessKind: 'detail',
      accessWorkload: {
        reason: 'Exact processing workload declaration remains unchanged',
        workloads: ['integration.symmy.source-organization-facts.read'],
      },
      entrypoint: sourceEntrypoint,
      evidencePolicy: { captureMode: 'metadata_only', policyKey: 'integration.symmy.native-organization.evidence' },
      inputSchema: SymmySourceOrganizationFactsRequestSchema,
      legalEntityScope: 'required',
      owningModuleKey: 'integration.symmy',
      policies: [],
      readKey,
      resultSchema: SymmySourceOrganizationFactsResponseSchema,
      schemaVersion: '1',
    },
    () =>
      Effect.sync(() => {
        calls.reads += 1;
        return { evidence: { resultCount: 0 }, result: { outcome: 'NOT_CURRENT' as const } };
      }),
    () => Effect.succeed({}),
  );
  const action = defineAction(
    {
      accessDeclaration: {
        key: 'integration.symmy.native-readonly-probe.execute',
        kind: 'action',
        modes: ['run'],
        placement: { group: 'native-probe', level: 'basic' },
        risk: 'routine',
        selectors: [],
      },
      accessEvidencePolicy: {
        captureMode: 'metadata_only',
        policyKey: 'integration.symmy.native-readonly-probe.evidence',
      },
      actionKey,
      auditProfile: 'standard',
      domainErrorSchema: GatewayDelegationSourceError,
      domainEvents: {},
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'protected' },
        entrypointKey: actionKey,
        moduleKey: 'integration.symmy',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'required',
      owningModuleKey: 'integration.symmy',
      payloadSchema: Schema.Struct({}),
      policies: [],
      resultSchema: Schema.Struct({ value: Schema.String }),
      schemaVersion: '1',
    },
    () =>
      Effect.sync(() => {
        calls.actions += 1;
        return { value: 'must-never-execute' };
      }),
  );
  const base = makeModuleContractFixture({
    appId: receiverDeployment.appId,
    moduleId: 'integration.symmy',
    supportedStates,
  });
  const manifest = defineOntosModuleManifest({
    ...base.manifest,
    publicSurface: {
      ...base.manifest.publicSurface,
      actions: [action],
      api: { 'symmy-source-organization-facts': SymmySourceOrganizationFactsApi },
      components: {},
      operationContracts: [
        {
          apiKey: 'symmy-source-organization-facts',
          operationKey: 'symmySourceOrganizationFacts.execute',
          registration: read,
        },
      ],
    },
  });
  const owner = defineVerticalRuntimeRegistration({ actions: [action], manifest, outboxWorkers: [], reads: [read] });
  const projected = extractVerticalRuntimeSafeDescriptors(owner);
  const contract = {
    ...base,
    manifest: {
      ...base.manifest,
      publicSurface: {
        ...base.manifest.publicSurface,
        actions: projected.actions,
        api: [
          {
            key: 'integration.symmy.symmy-source-organization-facts',
            operationKeys: ['symmySourceOrganizationFacts.execute'],
          },
        ],
        operationContracts: projected.operationContracts,
      },
    },
  };
  return { action, contract, owner, read };
};
const issuerConnection = (connectionString: string, role: string) => {
  const url = new URL(connectionString);
  url.username = role;
  url.password = role;
  return url.href;
};
const redemption = (database: Effect.Success<ReturnType<typeof makeCoreDatabase>>) => ({
  consume: Effect.fn('OrganizationNative.redeem')(function* redeem(input: GatewayAssertionRedemptionInput) {
    const rows = yield* database.executor
      .execute(
        sql`insert into public.organization_gateway_redemptions(issuer,audience,jti) values(${input.issuer},${input.audience},${input.jti}::uuid) on conflict do nothing returning jti`,
        'objects',
      )
      .pipe(
        Effect.mapError(() => new GatewayAssertionRedemptionUnavailableError({ reason: 'Native redemption failed' })),
      );
    if (rows.length !== 1) {
      return yield* new GatewayAssertionReplayError({ reason: 'Already redeemed' });
    }
    return yield* Effect.void;
  }),
});

it.live(
  'binds the organization governance read to its actual human permission, source bearer lifetime and exact input',
  () =>
    Effect.scoped(
      Effect.gen(function* nativeOrganizationGovernance() {
        const crypto = yield* Crypto.Crypto;
        const calls = { actions: 0, reads: 0 };
        const owner = definitions(calls);
        const privacy = makeModuleContractFixture({ appId: 'privacy', moduleId: 'privacy.core', supportedStates });
        const snapshot = yield* makeCompositionSnapshot([privacy, owner.contract], 600_000);
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          compositionSnapshot: snapshot,
          mode: 'schema-only',
          purpose: 'implementation-1096-registered-workload-gateway',
        });
        const admin = yield* makeCoreDatabase(isolated.connections.admin);
        const runtime = yield* makeCoreDatabase(isolated.connections.runtime);
        const auth = yield* makeAuthDatabase({ connectionString: isolated.connections.runtime.connectionString });
        const tenantId = yield* crypto.randomUUIDv4();
        const legalEntityId = yield* crypto.randomUUIDv4();
        const humans = yield* Effect.forEach(['granted', 'ungranted'], (name) =>
          Effect.gen(function* human() {
            return {
              authBindingId: yield* crypto.randomUUIDv4(),
              name,
              principalId: yield* crypto.randomUUIDv4(),
              sessionId: yield* crypto.randomUUIDv4(),
            };
          }),
        );
        const moduleIds = new Map<string, string>();
        yield* admin.executor.execute(
          sql`insert into core.tenants(tenant_id,slug,name,status,default_locale) values(${tenantId}::uuid,${tenantId},'Organization gateway native','active','en')`,
          'objects',
        );
        yield* admin.executor.execute(
          sql`insert into core.legal_entities(legal_entity_id,tenant_id,legal_name,registration_country,registration_number,status) values(${legalEntityId}::uuid,${tenantId}::uuid,'Organization governance','CZ','native-organization','active')`,
          'objects',
        );
        yield* admin.executor.execute(
          sql`insert into core.tenant_module_states(tenant_id,module_key,state) values(${tenantId}::uuid,'privacy.core','active'),(${tenantId}::uuid,'integration.symmy','active')`,
          'objects',
        );
        for (const human of humans) {
          yield* admin.executor.execute(
            sql`insert into core.principals(principal_id,tenant_id,kind,display_name,status) values(${human.principalId}::uuid,${tenantId}::uuid,'human',${human.name},'active')`,
            'objects',
          );
          yield* admin.executor.execute(
            sql`insert into core.principal_auth_bindings(principal_auth_binding_id,tenant_id,principal_id,authentication_namespace_id,provider,subject_type,provider_subject_id,status) values(${human.authBindingId}::uuid,${tenantId}::uuid,${human.principalId}::uuid,${namespaceId},'better_auth','user',${human.principalId},'active')`,
            'objects',
          );
          const email = `${human.principalId}@organization.test`;
          yield* admin.executor.execute(
            sql`insert into auth."user"(id,name,email,email_verified,banned) values(${human.principalId},${human.name},${email},true,false)`,
            'objects',
          );
          yield* admin.executor.execute(
            sql`insert into auth."session"(id,expires_at,token,updated_at,user_id,active_tenant_id,active_legal_entity_id) values(${human.sessionId},now()+interval '1 hour',${human.sessionId},now(),${human.principalId},${tenantId}::uuid,${legalEntityId}::uuid)`,
            'objects',
          );
        }
        for (const providerKey of [privacyKey, symmyKey]) {
          const principalId = yield* crypto.randomUUIDv4();
          moduleIds.set(providerKey, principalId);
          yield* admin.executor.execute(
            sql`insert into core.principals(principal_id,tenant_id,kind,display_name,status) values(${principalId}::uuid,${tenantId}::uuid,'service','Organization native module','active')`,
            'objects',
          );
          yield* admin.executor.execute(
            sql`insert into core.principal_auth_bindings(tenant_id,principal_id,authentication_namespace_id,provider,subject_type,provider_subject_id,status) values(${tenantId}::uuid,${principalId}::uuid,${namespaceId},'better_auth','api_key',${providerKey},'active')`,
            'objects',
          );
        }
        const spiceDb = yield* loadSpiceDbConfig();
        for (const human of humans) {
          yield* grantTestTenantRoleAccess({
            adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
            assignmentScope: 'companies',
            holders: [{ capabilityKeys: human.name === 'granted' ? [capability] : [], principalId: human.principalId }],
            legalEntityIds: [legalEntityId],
            spiceDb,
            tenantId,
          });
        }
        yield* admin.executor.execute(
          sql`create table public.organization_gateway_redemptions(issuer text not null,audience text not null,jti uuid not null,primary key(issuer,audience,jti));`,
          'objects',
        );
        yield* admin.executor.execute(
          sql`grant insert,select on public.organization_gateway_redemptions to ontos_runtime`,
          'objects',
        );
        const reactivity = yield* Reactivity.make;
        const issuerClient = yield* PgClient.make({
          url: Redacted.make(issuerConnection(isolated.connections.runtime.connectionString, 'shell_gateway_issuer')),
        }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity));
        const keyPair = yield* Effect.promise(() => generateKeyPair('Ed25519', { extractable: true }));
        const privateJwk = yield* Effect.promise(() => exportJWK(keyPair.privateKey));
        const publicJwk = yield* Effect.promise(() => exportJWK(keyPair.publicKey));
        const issuer = 'https://native-organization-shell.example';
        const publicKeys = JSON.stringify({
          keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'native-organization', use: 'sig' }],
        });
        const signing = yield* parseGatewayIssuerConfig({
          ONTOS_GATEWAY_ISSUER: issuer,
          ONTOS_GATEWAY_PRIVATE_JWK: JSON.stringify({
            ...privateJwk,
            alg: 'EdDSA',
            kid: 'native-organization',
            use: 'sig',
          }),
        });
        const signer = makeGatewayIssuerLayer({
          currentTimeSeconds: DateTime.nowAsDate.pipe(Effect.map((now) => Math.floor(now.getTime() / 1000))),
          generateJti: crypto.randomUUIDv4().pipe(Effect.orDie),
          loadAdmission: Effect.succeed({
            audiences: new Map([
              ['privacy', 'privacy-build'],
              ['symmy-integration', 'symmy-integration-build'],
            ]),
            revision: snapshot.composition.revision,
          }),
          loadConfig: Effect.succeed(signing),
        }).pipe(Layer.provide(Layer.succeed(GatewayScopeGrantRegistrar, makeGatewayScopeGrantRegistrar(issuerClient))));
        const issuerService = Context.get(yield* Layer.build(signer), GatewayIssuer);
        const enforcement = AccessDecisionLive.pipe(
          Layer.provideMerge(AccessEnforcementPortsLive),
          Layer.provideMerge(TenantIntentLoaderLive),
          Layer.provide(Layer.succeed(CoreDatabase, runtime)),
        );
        const gateServices = yield* Layer.build(enforcement);
        const gate = Context.get(gateServices, AccessDecisionGate);
        const scopes = yield* makeOperationalScopeResolver(makeOperationalScopeRepository(runtime), gate);
        const namespace = yield* Schema.decodeUnknownEffect(AuthenticationNamespaceRegistrationSchema)({
          allowedAudiences: ['privacy', 'symmy-integration'],
          authenticationNamespaceId: namespaceId,
          provider: 'better_auth',
          requiresOperationAdmission: false,
          reservationPrincipalKind: 'human',
          subjectTypes: ['user', 'api_key'],
          trustedAttesterPrincipalIds: [],
        });
        const registry = makeAuthenticationNamespaceRegistry([namespace]);
        const installed = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
        const config = ConfigProvider.fromUnknown({
          ONTOS_GATEWAY_ISSUER: issuer,
          ONTOS_GATEWAY_MODULE_BINDINGS: JSON.stringify([
            {
              compositionRevision: snapshot.composition.revision,
              providerKeyId: privacyKey,
              sourceAppId: 'privacy',
              sourceBuildMarker: 'privacy-build',
            },
            {
              compositionRevision: snapshot.composition.revision,
              providerKeyId: symmyKey,
              sourceAppId: 'symmy-integration',
              sourceBuildMarker: 'symmy-integration-build',
            },
          ]),
          ONTOS_GATEWAY_PUBLIC_JWKS: publicKeys,
        });
        const services = Layer.mergeAll(
          Layer.succeed(CoreDatabase, runtime),
          Layer.succeed(AuthDatabase, auth),
          Layer.succeed(PrincipalResolver, makePrincipalResolver(runtime, { authenticationNamespaceId: namespaceId })),
          Layer.succeed(TenantModuleStateService, makeTenantModuleStateService(runtime)),
          Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
          Layer.succeed(GatewayDelegationExchangeLedger, makeGatewayDelegationExchangeLedger(auth.executor)),
          Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
          Layer.succeed(OperationalScopeResolver, scopes),
          Layer.succeed(AccessDecisionGate, gate),
        );
        const receive = (token: string, audience: 'privacy' | 'symmy-integration') =>
          bindGatewayPrincipalVerifier(audience, { appId: audience, buildMarker: `${audience}-build` })
            .verifyAndRedeem(Redacted.make(`Bearer ${token}`), {
              environment: { ONTOS_GATEWAY_ISSUER: issuer, ONTOS_GATEWAY_PUBLIC_JWKS: publicKeys },
              redemption: redemption(runtime),
            })
            .pipe(Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }));
        const issue = (
          subject: (typeof GatewayDelegatedContextRequestSchema.Encoded)['subject'],
          audience = 'symmy-integration',
          providerKey = privacyKey,
        ) =>
          Effect.gen(function* issueNativeOrganizationRead() {
            const payload = yield* Schema.decodeUnknownEffect(GatewayDelegatedContextRequestSchema)({
              audience,
              compositionRevision: snapshot.composition.revision,
              exchangeId: yield* crypto.randomUUIDv4(),
              legalEntityScope: 'subject',
              subject,
            });
            return yield* issueDelegatedGatewayContextAssertion({
              payload,
              requestCorrelation: 'native-organization-proof',
              verifiedProviderKeyId: providerKey,
            });
          }).pipe(
            Effect.provide(signer),
            Effect.provide(GatewayDelegationVerificationLive),
            Effect.provide(GatewayOriginatorEvidenceLive),
            Effect.provide(services),
            Effect.provideService(ConfigProvider.ConfigProvider, config),
            Effect.provideService(AuthenticationNamespaceRegistry, registry),
          );
        const runtimeServices = Layer.mergeAll(
          services,
          Layer.succeedContext(gateServices),
          OwnerAuthorizationOverlayAllowLive,
          ContextAccessLive,
          ActionPermissionLive,
          ActionRepositoryLive.pipe(Layer.provide(services)),
          ModuleEntrypointGatewayLive.pipe(Layer.provideMerge(ModuleStateGateLive), Layer.provide(services)),
        );
        const runtimes = yield* Layer.build(
          Layer.mergeAll(
            makeReadRuntimeLive(receiverDeployment, owner.owner),
            makeActionRuntimeLive(receiverDeployment, owner.owner),
          ).pipe(Layer.provide(runtimeServices)),
        );
        const readRuntime = Context.get(runtimes, ReadRuntime);
        const actionRuntime = Context.get(runtimes, ActionRuntime);
        const request = yield* Schema.decodeUnknownEffect(SymmySourceOrganizationFactsRequestSchema)({
          effectKey: 'native.organization.source',
          execution: { jobId: yield* crypto.randomUUIDv4(), kind: 'JOB' },
          purpose: 'GOVERNANCE',
          sourceReference: {
            occurrenceId: 'native-occurrence',
            recordId: 'native-record',
            source: { issuer: 'native', namespace: 'organization', recordType: 'company', routeRef: 'native-route' },
          },
        });
        const requestHash = computeCanonicalValueHash(request);
        for (const human of humans) {
          const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
            authBindingId: human.authBindingId,
            authContextRef: `better-auth-session:${human.sessionId}`,
            authenticationNamespaceId: namespaceId,
            authMethod: 'session',
            legalEntityId,
            principalId: human.principalId,
            tenantId,
          });
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                issuerService.issue({
                  audience: 'symmy-integration',
                  compositionRevision: snapshot.composition.revision,
                  principal,
                }),
              ),
            ),
          ).toBe(true);
          const incoming = yield* issuerService.issue({
            audience: 'privacy',
            compositionRevision: snapshot.composition.revision,
            principal,
          });
          const incomingPrincipal = yield* receive(incoming.token, 'privacy');
          const sourceScope = yield* scopes
            .resolve({
              audience: 'privacy',
              correlationId: 'native-organization-source',
              legalEntityScope: 'required',
              principal: incomingPrincipal,
            })
            .pipe(Effect.provideService(AuthenticationNamespaceRegistry, registry));
          const nativeDecision = yield* gate.decide({
            carrier: owner.read.descriptor,
            legalEntityScope: 'required',
            now: yield* DateTime.nowAsDate,
            scope: sourceScope,
          });
          expect(nativeDecision.outcome, JSON.stringify(nativeDecision.reasons)).toBe(
            human.name === 'granted' ? 'ALLOWED' : 'DENIED',
          );
          expect(sourceScope.legalEntityId).toBe(legalEntityId);
          const subject = { _tag: 'OrganizationGovernanceRead' as const, requestHash, sourceAssertion: incoming.token };
          if (human.name === 'ungranted') {
            expect(Exit.isFailure(yield* Effect.exit(issue(subject)))).toBe(true);
            continue;
          }
          const { authenticationNamespaceId: _namespace, ...legacyPrincipal } = principal;
          const legacy = yield* issuerService.issue({
            audience: 'privacy',
            compositionRevision: snapshot.composition.revision,
            principal: legacyPrincipal,
          });
          expect((yield* decodeSupportedGatewayContextClaims(decodeJwt(legacy.token))).ver).toBe(1);
          expect(Exit.isFailure(yield* Effect.exit(issue({ ...subject, sourceAssertion: legacy.token })))).toBe(true);
          const privacyActor = yield* Schema.decodeUnknownEffect(GatewayActorClaimSchema)({
            appId: 'privacy',
            buildMarker: 'privacy-build',
            principalId: moduleIds.get(privacyKey),
          });
          const v3Source = yield* issuerService.issue({
            actor: privacyActor,
            audience: 'privacy',
            compositionRevision: snapshot.composition.revision,
            principal,
          });
          expect((yield* decodeSupportedGatewayContextClaims(decodeJwt(v3Source.token))).ver).toBe(3);
          const v3Delegated = yield* issue({ ...subject, sourceAssertion: v3Source.token });
          const v3Receiver = yield* receive(v3Delegated.token, 'symmy-integration');
          expect(readVerifiedGatewayOrganizationGovernanceRead(v3Receiver)?.requestHash).toBe(requestHash);
          const wireRequests: Request[] = [];
          const wireFetch: typeof globalThis.fetch = (input, init) => {
            wireRequests.push(new Request(input, init));
            return Promise.resolve(
              Response.json({
                apiBaseUrl: '/symmy-integration-api',
                compositionRevision: snapshot.composition.revision,
                expiresAt: incoming.expiresAt,
                token: 'wire-only-response-never-verified-or-used',
              }),
            );
          };
          const wireConfiguration = ConfigProvider.fromUnknown({
            ONTOS_GATEWAY_MODULE_API_KEY: privacyKey,
            ONTOS_SHELL_GATEWAY_BASE_URL: 'https://native-organization-shell.example/shell-super-app-api',
          });
          const acquireRead = (scope: typeof sourceScope) =>
            acquireDelegatedGatewayContext(
              {
                audience: 'symmy-integration',
                legalEntityScope: 'subject',
                requestCorrelation: 'native-v6-shared',
                subject: { _tag: 'OrganizationGovernanceRead', requestHash, scope },
              },
              crypto,
            ).pipe(
              Effect.provideService(ConfigProvider.ConfigProvider, wireConfiguration),
              Effect.provideService(FetchHttpClient.Fetch, wireFetch),
            );
          yield* acquireRead(sourceScope);
          const delegated = yield* issue(subject);
          expect(wireRequests).toHaveLength(1);
          const sent = yield* Effect.promise(
            () => wireRequests.at(0)?.clone().json() ?? Promise.reject(new Error('Missing captured request')),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(GatewayDelegatedContextRequestSchema)));
          expect(sent.subject).toEqual({ ...subject, sourceAssertion: Redacted.make(incoming.token) });
          const clonedFailure = yield* acquireRead({ ...sourceScope }).pipe(Effect.flip);
          expect(Schema.is(GatewayDelegationSourceError)(clonedFailure)).toBe(true);
          expect(wireRequests).toHaveLength(1);
          const sourceClaims = yield* decodeSupportedGatewayContextClaims(decodeJwt(incoming.token));
          const claims = yield* decodeSupportedGatewayContextClaims(decodeJwt(delegated.token));
          expect(claims.ver).toBe(6);
          expect(claims.iat).toBe(sourceClaims.iat);
          expect(claims.exp).toBe(sourceClaims.exp);
          expect(claims.jti).not.toBe(sourceClaims.jti);
          const receiver = yield* receive(delegated.token, 'symmy-integration');
          expect(readVerifiedGatewayWorkload(receiver)).toBeUndefined();
          expect(readVerifiedGatewayOrganizationGovernanceRead(receiver)).toEqual({
            governanceLegalEntityId: legalEntityId,
            principalId: human.principalId,
            requestHash,
            tenantId,
          });
          expect(readVerifiedGatewayOrganizationGovernanceRead({ ...receiver })).toBeUndefined();
          expect(Exit.isFailure(yield* Effect.exit(receive(delegated.token, 'symmy-integration')))).toBe(true);
          const runRead = (input: typeof SymmySourceOrganizationFactsRequestSchema.Type) =>
            readRuntime
              .runRead({
                audience: 'symmy-integration',
                input,
                principal: receiver,
                registration: owner.read,
                transport: { correlationId: 'native-organization-read' },
              })
              .pipe(Effect.provideService(AuthenticationNamespaceRegistry, registry));
          expect(yield* runRead(request)).toEqual({ outcome: 'NOT_CURRENT' });
          expect(calls.reads).toBe(1);
          const differentRequest = yield* Schema.decodeUnknownEffect(SymmySourceOrganizationFactsRequestSchema)({
            ...request,
            effectKey: 'different',
          });
          const wrongInput = yield* Effect.exit(runRead(differentRequest));
          expect(Exit.isFailure(wrongInput)).toBe(true);
          expect(calls.reads).toBe(1);
          const receiverScope = yield* scopes
            .resolve({
              audience: 'symmy-integration',
              correlationId: 'native-v6-operation',
              legalEntityScope: 'required',
              principal: receiver,
            })
            .pipe(Effect.provideService(AuthenticationNamespaceRegistry, registry));
          for (const carrier of [
            { ...owner.read.descriptor, schemaVersion: '2' },
            {
              ...owner.read.descriptor,
              entrypoint: { ...owner.read.descriptor.entrypoint, entrypointKey: `${readKey}.unrelated` },
            },
          ]) {
            expect(
              (yield* gate.decide({
                carrier,
                legalEntityScope: 'required',
                now: yield* DateTime.nowAsDate,
                scope: receiverScope,
              })).outcome,
            ).toBe('DENIED');
          }
          yield* admin.executor.execute(
            sql`update core.principals set status='disabled' where principal_id=${human.principalId}::uuid`,
            'objects',
          );
          expect(Exit.isFailure(yield* Effect.exit(runRead(request)))).toBe(true);
          expect(calls.reads).toBe(1);
          yield* admin.executor.execute(
            sql`update core.principals set status='active' where principal_id=${human.principalId}::uuid`,
            'objects',
          );
          const cachedKey = 'native-v6-cached-action';
          const cachedHash = computeActionRequestHash({
            actionKey,
            normalizedPayload: {},
            owningModuleKey: 'integration.symmy',
            principal: receiver,
            schemaVersion: '1',
            target: {},
          });
          yield* admin.executor.execute(
            sql`insert into core.action_invocations(action_invocation_id,tenant_id,legal_entity_id,principal_id,auth_method,auth_binding_id,auth_context_ref,action_key,idempotency_key,request_hash,status,completed_at) values(${yield* crypto.randomUUIDv4()}::uuid,${tenantId}::uuid,${legalEntityId}::uuid,${human.principalId}::uuid,'session',${human.authBindingId}::uuid,${principal.authContextRef},${actionKey},${cachedKey},${cachedHash},'succeeded',now())`,
            'objects',
          );
          const write = yield* actionRuntime
            .runAction({
              audience: 'symmy-integration',
              payload: {},
              principal: receiver,
              registration: owner.action,
              transport: { correlationId: 'native-v6-readonly', idempotencyKey: cachedKey },
            })
            .pipe(Effect.provideService(AuthenticationNamespaceRegistry, registry), Effect.flip);
          expect(Schema.is(ActionTrustedContextValidationError)(write)).toBe(true);
          expect(calls.actions).toBe(0);
          const integrationId = yield* crypto.randomUUIDv4();
          const integrationBinding = yield* crypto.randomUUIDv4();
          const integrationKey = yield* crypto.randomUUIDv4();
          yield* admin.executor.execute(
            sql`insert into core.principals(principal_id,tenant_id,kind,display_name,status) values(${integrationId}::uuid,${tenantId}::uuid,'integration','Not a human','active')`,
            'objects',
          );
          yield* admin.executor.execute(
            sql`insert into core.principal_auth_bindings(principal_auth_binding_id,tenant_id,principal_id,authentication_namespace_id,provider,subject_type,provider_subject_id,status) values(${integrationBinding}::uuid,${tenantId}::uuid,${integrationId}::uuid,${namespaceId},'better_auth','api_key',${integrationKey},'active')`,
            'objects',
          );
          yield* admin.executor.execute(
            sql`insert into auth.apikey(id,reference_id,key,created_at,updated_at) values(${integrationKey},${human.principalId},${integrationKey},now(),now())`,
            'objects',
          );
          const nonhumanPrincipal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
            authBindingId: integrationBinding,
            authContextRef: `better-auth-api-key:${integrationKey}`,
            authenticationNamespaceId: namespaceId,
            authMethod: 'api_key',
            legalEntityId,
            principalId: integrationId,
            tenantId,
          });
          const nonhumanSource = yield* issuerService.issue({
            audience: 'privacy',
            compositionRevision: snapshot.composition.revision,
            principal: nonhumanPrincipal,
          });
          expect(Exit.isFailure(yield* Effect.exit(issue({ ...subject, sourceAssertion: nonhumanSource.token })))).toBe(
            true,
          );

          yield* admin.executor.execute(
            sql`update core.principal_auth_bindings set status='revoked',revoked_at=now() where provider_subject_id=${privacyKey}`,
            'objects',
          );
          expect(Exit.isFailure(yield* Effect.exit(issue(subject)))).toBe(true);
          yield* admin.executor.execute(
            sql`update core.principal_auth_bindings set status='active',revoked_at=null where provider_subject_id=${privacyKey}`,
            'objects',
          );
          const otherTenant = yield* crypto.randomUUIDv4();
          const otherLegalEntity = yield* crypto.randomUUIDv4();
          yield* admin.executor.execute(
            sql`insert into core.tenants(tenant_id,slug,name,status,default_locale) values(${otherTenant}::uuid,${otherTenant},'Foreign tenant','active','en')`,
            'objects',
          );
          yield* admin.executor.execute(
            sql`insert into core.legal_entities(legal_entity_id,tenant_id,legal_name,registration_country,registration_number,status) values(${otherLegalEntity}::uuid,${otherTenant}::uuid,'Foreign governance','CZ','native-foreign','active')`,
            'objects',
          );
          yield* admin.executor.execute(
            sql`update auth.session set active_tenant_id=${otherTenant}::uuid,active_legal_entity_id=${otherLegalEntity}::uuid where id=${human.sessionId}`,
            'objects',
          );
          expect(Exit.isFailure(yield* Effect.exit(issue(subject)))).toBe(true);
          yield* admin.executor.execute(
            sql`update auth.session set active_tenant_id=${tenantId}::uuid,active_legal_entity_id=${legalEntityId}::uuid where id=${human.sessionId}`,
            'objects',
          );
          yield* admin.executor.execute(
            sql`update auth.session set active_legal_entity_id=null where id=${human.sessionId}`,
            'objects',
          );
          expect(Exit.isFailure(yield* Effect.exit(issue(subject)))).toBe(true);
          yield* admin.executor.execute(
            sql`update auth.session set active_legal_entity_id=${legalEntityId} where id=${human.sessionId}`,
            'objects',
          );

          expect(Exit.isFailure(yield* Effect.exit(issue(subject, 'privacy')))).toBe(true);
          expect(
            Exit.isFailure(
              yield* Effect.exit(issue({ _tag: 'Assertion', sourceAssertion: delegated.token }, 'privacy', symmyKey)),
            ),
          ).toBe(true);
          expect(
            Exit.isFailure(
              yield* Effect.exit(issue({ ...subject, sourceAssertion: delegated.token }, 'privacy', symmyKey)),
            ),
          ).toBe(true);
          yield* admin.executor.execute(
            sql`update auth.session set expires_at=now()-interval '1 second' where id=${human.sessionId}`,
            'objects',
          );
          expect(Exit.isFailure(yield* Effect.exit(issue(subject)))).toBe(true);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
