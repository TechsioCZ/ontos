import {
  ActiveApplicationCompositionService,
  AccessDeclarationSchema,
  AccessActorSchema,
  GatewayScopeGrantRegistrar,
  GatewayAssertionReplayError,
  GatewayAssertionRedemptionUnavailableError,
  defineTenantModuleEntrypoint,
  makeOperationalScopeRepository,
  makeOperationalScopeResolver,
  OutboxRuntime,
  OutboxRuntimeLive,
  OutboxRepositoryLive,
  PrincipalResolver,
  TenantModuleStateService,
  makePrincipalResolver,
  makeTenantModuleStateService,
  defineOutboxWorker,
  extractOutboxWorkerSubscriptions,
  defineRead,
  defineAction,
  defineOntosModuleManifest,
  defineVerticalRuntimeRegistration,
  OntosModuleRequirementsSchema,
  ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY,
  ONTOS_SHELL_CONTRIBUTION_ABI,
  makeDatabaseIdentityEnrollmentLive,
} from '@app/core-runtime';
import type { GatewayAssertionRedemptionInput, OperationalScope } from '@app/core-runtime';
import { defineOutboxWorkerEntry } from '@app/core-runtime/outbox/worker';
import type { OutboxWorkerHandlerContext } from '@app/core-runtime/outbox/worker';
import { CoreDatabase, makeCoreDatabase } from '@app/core-runtime/db/client';
import {
  AccessDecisionGate,
  AccessDecisionLive,
  AccessEnforcementPortsLive,
  TenantIntentLoaderLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { loadSpiceDbConfig } from '@app/core-runtime/access/spicedb-config';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { AuthenticationNamespaceRegistrationSchema } from '@app/core-runtime/auth/external-identity-contracts';
import {
  AuthenticationNamespaceRegistry,
  makeAuthenticationNamespaceRegistry,
} from '@app/core-runtime/auth/external-identity-admission';
import { makeGatewayScopeGrantRegistrar } from '@app/core-runtime/testing/gateway-scope-grant';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { grantTestTenantRoleAccess } from '@app/core-runtime/testing/tenant-access';
import {
  readVerifiedGatewayPrivacyDispatch,
  readVerifiedGatewayWorkload,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import { OperationalScopeResolver } from '@app/core-runtime/operations/context';
import {
  GatewayActorClaimSchema,
  GatewayDelegatedContextRequestSchema,
  GatewayPrivacyDispatchSubjectSchema,
  decodeSupportedGatewayContextClaims,
} from '@app/shared-contracts';
import {
  acquireDelegatedGatewayContext,
  GatewayDelegationSourceError,
} from '@app/shared-contracts/gateway-context-server';
import type { GatewayDelegationSubject } from '@app/shared-contracts/gateway-context-server';
import {
  SymmyJobPrivacyExecutionApi,
  SymmyJobPrivacyExecutionRequestSchema,
} from '@app/symmy-integration/api/symmy-job-privacy-execution';
import { ExecuteSymmyRetentionPayloadSchema } from '@app/symmy-integration/api/execute-symmy-retention-action';
import { OutboxPayloadSchema, outboxTopic } from '@app/privacy/outbox/privacy-measure-dispatched';
import {
  ActionPrincipalInvalidErrorSchema,
  bindGatewayPrincipalVerifier,
} from '@app/gateway-principal-verifier/server';
import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import {
  ConfigProvider,
  Context,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Match,
  Option,
  Redacted,
  Schema,
} from 'effect';
import { Reactivity } from 'effect/reactivity';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from 'jose';

import {
  GatewayIssuer,
  makeGatewayIssuerLayer,
  issuePrivacyDispatchGatewayContextAssertion,
} from '../../api/auth/gateway-issuer.ts';
import { admitPrivacyDispatch, readAdmittedPrivacyDispatch } from '../../api/auth/gateway-privacy-dispatch-evidence.ts';
import { GatewayModuleBindingSchema } from '../../api/auth/gateway-delegation-policy.ts';
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
import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { SHELL_DATABASE_IDENTITY_ENROLLMENT } from '../../api/database-identity-enrollment.ts';

const dispatchAction = 'privacy.core.dispatch-privacy-measure';
const dispatchCapability = 'privacy.core.privacy-measure.dispatch';
const retentionAction = 'integration.symmy.execute-symmy-retention';
const retentionCapability = 'integration.symmy.symmy-retention.execute';
const receiptRead = 'integration.symmy.api.symmy-job-privacy-execution';
const receiptCapability = 'integration.symmy.privacy-measure.read-receipt';
const outcomeAction = 'privacy.core.record-owner-execution-outcome';
const eligibilityRead = 'privacy.core.api.measure-execution-eligibility';
const eligibilityVersion = '2';
const receiptRequirement = 'privacy.core.requirement.symmy-owner-execution-outcome';
const eligibilityRequirement = 'integration.symmy.requirement.retention-privacy-current-authority';
const outcomeRequirement = 'integration.symmy.requirement.privacy-report-owner-outcome';
const workerKey = 'integration.symmy.symmy-job-privacy-dispatch';
const privacyProviderKey = 'privacy-native-module-key';
const symmyProviderKey = 'symmy-native-module-key';
const workerEntrypoint = defineTenantModuleEntrypoint({
  access: 'background',
  authorization: { kind: 'owner_local_background' },
  entrypointKey: workerKey,
  moduleKey: 'integration.symmy',
  role: 'worker',
});
const supportedStates = ['inactive', 'active', 'read_only', 'quarantined'] as const;
const dispatchEntrypoint = defineTenantModuleEntrypoint({
  access: 'write',
  authorization: { kind: 'protected' },
  entrypointKey: dispatchAction,
  moduleKey: 'privacy.core',
  role: 'action',
});
const retentionEntrypoint = defineTenantModuleEntrypoint({
  access: 'write',
  authorization: { kind: 'protected' },
  entrypointKey: retentionAction,
  moduleKey: 'integration.symmy',
  role: 'action',
});
const receiptEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: receiptRead,
  moduleKey: 'integration.symmy',
  role: 'api',
});
const dispatchDeclaration = Schema.decodeUnknownSync(AccessDeclarationSchema)({
  key: dispatchCapability,
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  placement: { group: 'privacy-measures', level: 'manage' },
  risk: 'critical',
  selectors: [],
});
const retentionDeclaration = Schema.decodeUnknownSync(AccessDeclarationSchema)({
  key: retentionCapability,
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  placement: { group: 'symmy-retention', level: 'extended' },
  risk: 'sensitive',
  selectors: [],
});
const receiptDeclaration = Schema.decodeUnknownSync(AccessDeclarationSchema)({
  key: receiptCapability,
  kind: 'read',
  modes: ['run'],
  placement: { group: 'symmy-job-privacy-execution', level: 'manage' },
  risk: 'sensitive',
  selectors: ['all'],
});
const receiptActor = Schema.decodeUnknownSync(AccessActorSchema)({
  callers: ['privacy', 'symmy-integration'],
  reason: 'Exact finite native receipt fixture',
  subject: 'identity',
});
const retentionActor = Schema.decodeUnknownSync(AccessActorSchema)({
  callers: ['symmy-integration'],
  reason: 'Exact finite native retention fixture',
  subject: 'identity',
});
const privacyActor = Schema.decodeUnknownSync(AccessActorSchema)({
  callers: ['symmy-integration'],
  reason: 'Exact finite native Privacy continuation fixture',
  subject: 'identity',
});
const eligibilityDeclaration = Schema.decodeUnknownSync(AccessDeclarationSchema)({
  key: 'privacy.core.measure-execution-eligibility.read',
  kind: 'read',
  modes: ['run'],
  placement: { group: 'measure-execution-eligibility', level: 'basic' },
  risk: 'sensitive',
  selectors: [],
});
const outcomeDeclaration = Schema.decodeUnknownSync(AccessDeclarationSchema)({
  ...dispatchDeclaration,
  key: 'privacy.core.owner-execution-outcome.record',
});
const eligibilityEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: eligibilityRead,
  moduleKey: 'privacy.core',
  role: 'api',
});
const outcomeEntrypoint = defineTenantModuleEntrypoint({
  access: 'write',
  authorization: { kind: 'protected' },
  entrypointKey: outcomeAction,
  moduleKey: 'privacy.core',
  role: 'action',
});
const assertWorkerWire = (
  subject: (typeof GatewayDelegatedContextRequestSchema.Type)['subject'],
  context: OutboxWorkerHandlerContext,
) => {
  const candidate = Match.value(subject).pipe(
    Match.tag('PrivacyDispatch', (dispatch) =>
      Match.value(dispatch.source).pipe(
        Match.tag('Worker', (proof) => proof),
        Match.orElse(() => null),
      ),
    ),
    Match.orElse(() => null),
  );
  const proof = Option.getOrThrow(Option.fromNullishOr(candidate));
  expect(proof.claimId).toBe(context.claimId);
  expect(proof.deliveryId).toBe(context.deliveryId);
  expect(proof.workerKey).toBe(context.workerKey);
  expect(proof.tenantId).toBe(context.tenantId);
};

const contractInputs = () => {
  const privacy = makeModuleContractFixture({
    appId: 'privacy',
    moduleId: 'privacy.core',
    originatorActions: [dispatchAction],
    supportedStates,
  });
  const symmy = makeModuleContractFixture({
    appId: 'symmy-integration',
    moduleId: 'integration.symmy',
    originatorActions: [dispatchAction],
    outboxSubscriptions: [
      {
        consumerModuleKey: 'integration.symmy',
        entrypoint: workerEntrypoint,
        producerModuleKey: 'privacy.core',
        topic: outboxTopic,
        workerKey,
      },
    ],
    supportedStates,
  });
  return [
    {
      ...privacy,
      manifest: {
        ...privacy.manifest,
        publicSurface: {
          ...privacy.manifest.publicSurface,
          actions: [
            {
              accessDeclaration: dispatchDeclaration,
              actionKey: dispatchAction,
              auditProfile: 'standard',
              entrypoint: dispatchEntrypoint,
              idempotency: 'required',
              legalEntityScope: 'required',
              owningModuleId: 'privacy.core',
              schemaVersion: '1',
            },
            {
              accessDeclaration: { ...dispatchDeclaration, key: 'privacy.core.owner-execution-outcome.record' },
              actionKey: outcomeAction,
              auditProfile: 'standard',
              entrypoint: defineTenantModuleEntrypoint({
                access: 'write',
                authorization: { kind: 'protected' },
                entrypointKey: outcomeAction,
                moduleKey: 'privacy.core',
                role: 'action',
              }),
              idempotency: 'required',
              legalEntityScope: 'required',
              owningModuleId: 'privacy.core',
              schemaVersion: '1',
            },
          ],
          api: [
            { key: 'privacy.core.measure-execution-eligibility', operationKeys: ['eligibility.execute'] },
            {
              key: 'privacy.core.record-owner-execution-outcome',
              operationKeys: ['recordOwnerExecutionOutcomeAction.execute'],
            },
          ],
          operationContracts: [
            {
              apiKey: 'privacy.core.record-owner-execution-outcome',
              entrypoint: outcomeEntrypoint,
              operationKey: 'recordOwnerExecutionOutcomeAction.execute',
              schemaVersion: '1',
            },
            {
              apiKey: 'privacy.core.measure-execution-eligibility',
              entrypoint: defineTenantModuleEntrypoint({
                access: 'read',
                authorization: { kind: 'protected' },
                entrypointKey: eligibilityRead,
                moduleKey: 'privacy.core',
                role: 'api',
              }),
              operationKey: 'eligibility.execute',
              schemaVersion: eligibilityVersion,
            },
          ],
        },
        requirements: {
          coreCapabilities: [ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY],
          intrinsic: [],
          operations: [
            {
              condition: 'privacy.core.condition.symmy-owner-execution-outcome',
              entrypointKey: outcomeAction,
              evidence: ['privacy.core.evidence.current-symmy-owner-execution-outcome'],
              key: receiptRequirement,
              provider: { entrypointKey: receiptRead, moduleId: 'integration.symmy', schemaVersion: '1' },
            },
          ],
          schemaVersion: '1',
        },
      },
    },
    {
      ...symmy,
      manifest: {
        ...symmy.manifest,
        publicSurface: {
          ...symmy.manifest.publicSurface,
          actions: [
            {
              accessDeclaration: retentionDeclaration,
              actionKey: retentionAction,
              auditProfile: 'sensitive',
              entrypoint: retentionEntrypoint,
              idempotency: 'required',
              legalEntityScope: 'optional',
              owningModuleId: 'integration.symmy',
              schemaVersion: '1',
            },
          ],
          api: [
            {
              key: 'integration.symmy.symmy-job-privacy-execution',
              operationKeys: ['symmyJobPrivacyExecution.execute'],
            },
          ],
          operationContracts: [
            {
              apiKey: 'integration.symmy.symmy-job-privacy-execution',
              entrypoint: receiptEntrypoint,
              operationKey: 'symmyJobPrivacyExecution.execute',
              schemaVersion: '1',
            },
          ],
        },
        requirements: {
          coreCapabilities: [ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY],
          intrinsic: [],
          operations: [
            {
              condition: 'integration.symmy.condition.current-operational-retention-authority',
              entrypointKey: retentionAction,
              evidence: ['integration.symmy.evidence.current-privacy-measure-authority'],
              key: eligibilityRequirement,
              provider: { entrypointKey: eligibilityRead, moduleId: 'privacy.core', schemaVersion: eligibilityVersion },
            },
            {
              condition: 'integration.symmy.condition.persisted-original-privacy-owner-outcome',
              entrypointKey: workerKey,
              evidence: ['integration.symmy.evidence.privacy.original-owner-outcome'],
              key: outcomeRequirement,
              provider: { entrypointKey: outcomeAction, moduleId: 'privacy.core', schemaVersion: '1' },
            },
          ],
          schemaVersion: '1',
        },
      },
    },
  ];
};

const issuerConnection = (connectionString: string, role: string) => {
  const url = new URL(connectionString);
  url.username = role;
  url.password = role;
  return url.href;
};
const nativeRedemption = (database: Effect.Success<ReturnType<typeof makeCoreDatabase>>) => ({
  consume: Effect.fn('NativePrivacyDispatch.redeem')(function* redeem(input: GatewayAssertionRedemptionInput) {
    const rows = yield* database.executor
      .execute(
        sql`insert into public.privacy_gateway_redemptions(issuer,audience,jti) values(${input.issuer},${input.audience},${input.jti}::uuid) on conflict do nothing returning jti`,
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

it.live('keeps native Privacy governance company authority separate from Symmy Tenant authority', () =>
  Effect.scoped(
    Effect.gen(function* nativePrivacyGatewayAuthority() {
      const crypto = yield* Crypto.Crypto;
      const shellDeployment = { appId: 'shell-super-app' as const, buildMarker: ultramodernDeliveryUnit.buildMarker };
      const inputs = contractInputs();
      const shellRuntime = {
        document: JSON.stringify({
          contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
          coreCapabilities: [ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY],
          deployment: shellDeployment,
          schemaVersion: '2',
        }),
        receiverDeployment: shellDeployment,
      };
      const snapshot = yield* makeCompositionSnapshot(inputs, 600_000, shellRuntime);
      const fixture = yield* makeIsolatedNativeDatabaseFixture({
        compositionSnapshot: snapshot,
        mode: 'schema-only',
        purpose: 'implementation-1096-registered-workload-gateway',
      });
      const admin = yield* makeCoreDatabase(fixture.connections.admin);
      const runtime = yield* makeCoreDatabase(fixture.connections.runtime);
      const tenantId = yield* crypto.randomUUIDv4();
      const legalEntityId = yield* crypto.randomUUIDv4();
      const holders = yield* Effect.forEach(['authorized', 'company-only'], (name) =>
        Effect.gen(function* holder() {
          return { authBindingId: yield* crypto.randomUUIDv4(), name, principalId: yield* crypto.randomUUIDv4() };
        }),
      );
      yield* admin.executor.execute(
        sql`insert into core.tenants(tenant_id,slug,name,status,default_locale) values(${tenantId}::uuid,${tenantId},'Privacy native gateway','active','en')`,
        'objects',
      );
      yield* admin.executor.execute(
        sql`insert into core.legal_entities(legal_entity_id,tenant_id,legal_name,registration_country,registration_number,status) values(${legalEntityId}::uuid,${tenantId}::uuid,'Privacy governance company','CZ','native-privacy','active')`,
        'objects',
      );
      yield* admin.executor.execute(
        sql`insert into core.tenant_module_states(tenant_id,module_key,state) values(${tenantId}::uuid,'privacy.core','active'),(${tenantId}::uuid,'integration.symmy','active')`,
        'objects',
      );
      for (const holder of holders) {
        yield* admin.executor.execute(
          sql`insert into core.principals(principal_id,tenant_id,kind,display_name,status) values(${holder.principalId}::uuid,${tenantId}::uuid,'human',${holder.name},'active')`,
          'objects',
        );
        yield* admin.executor.execute(
          sql`insert into core.principal_auth_bindings(principal_auth_binding_id,tenant_id,principal_id,authentication_namespace_id,provider,subject_type,provider_subject_id,status) values(${holder.authBindingId}::uuid,${tenantId}::uuid,${holder.principalId}::uuid,'privacy.native.staff','better_auth','user',${holder.principalId},'active')`,
          'objects',
        );
        const email = `${holder.principalId}@privacy.test`;
        yield* admin.executor.execute(
          sql`insert into auth."user"(id,name,email,email_verified,banned) values(${holder.principalId},${holder.name},${email},true,false)`,
          'objects',
        );
      }
      for (const providerKey of [privacyProviderKey, symmyProviderKey]) {
        const principalId = yield* crypto.randomUUIDv4();
        yield* admin.executor.execute(
          sql`insert into core.principals(principal_id,tenant_id,kind,display_name,status) values(${principalId}::uuid,${tenantId}::uuid,'service','Finite Privacy module','active')`,
          'objects',
        );
        yield* admin.executor.execute(
          sql`insert into core.principal_auth_bindings(tenant_id,principal_id,authentication_namespace_id,provider,subject_type,provider_subject_id,status) values(${tenantId}::uuid,${principalId}::uuid,'privacy.native.staff','better_auth','api_key',${providerKey},'active')`,
          'objects',
        );
      }
      const spiceDb = yield* loadSpiceDbConfig();
      const target = { spiceDb, writerConnectionString: Redacted.make(fixture.connections.runtime.connectionString) };
      for (const holder of holders) {
        yield* grantTestTenantRoleAccess({
          ...target,
          assignmentScope: 'companies',
          holders: [
            {
              capabilityKeys: [dispatchCapability, eligibilityDeclaration.key, outcomeDeclaration.key],
              principalId: holder.principalId,
            },
          ],
          legalEntityIds: [legalEntityId],
          tenantId,
        });
        yield* grantTestTenantRoleAccess({
          ...target,
          assignmentScope: holder.name === 'authorized' ? 'all' : 'companies',
          holders: [{ capabilityKeys: [retentionCapability, receiptCapability], principalId: holder.principalId }],
          legalEntityIds: [legalEntityId],
          tenantId,
        });
      }
      yield* admin.executor.execute(
        sql`create table public.privacy_gateway_redemptions(issuer text not null,audience text not null,jti uuid not null,primary key(issuer,audience,jti))`,
        'objects',
      );
      yield* admin.executor.execute(
        sql`grant insert,select on public.privacy_gateway_redemptions to ontos_runtime`,
        'objects',
      );
      const reactivity = yield* Reactivity.make;
      const issuerClient = yield* PgClient.make({
        url: Redacted.make(issuerConnection(fixture.connections.runtime.connectionString, 'shell_gateway_issuer')),
      }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity));
      const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519', { extractable: true }));
      const privateJwk = yield* Effect.promise(() => exportJWK(privateKey));
      const publicJwk = yield* Effect.promise(() => exportJWK(publicKey));
      const issuer = 'https://native-privacy-shell.example';
      const signing = yield* parseGatewayIssuerConfig({
        ONTOS_GATEWAY_ISSUER: issuer,
        ONTOS_GATEWAY_PRIVATE_JWK: JSON.stringify({ ...privateJwk, alg: 'EdDSA', kid: 'native-privacy', use: 'sig' }),
      });
      const signer = makeGatewayIssuerLayer({
        currentTimeSeconds: Effect.succeed(Math.floor(DateTime.toEpochMillis(snapshot.observedAt) / 1000)),
        generateJti: crypto.randomUUIDv4().pipe(Effect.orDie),
        loadAdmission: Effect.succeed({
          audiences: new Map([
            ['symmy-integration', 'symmy-integration-build'],
            ['privacy', 'privacy-build'],
          ]),
          revision: snapshot.composition.revision,
        }),
        loadConfig: Effect.succeed(signing),
      }).pipe(
        Layer.provide(
          Layer.succeed(
            GatewayScopeGrantRegistrar,
            makeGatewayScopeGrantRegistrar(issuerClient, SHELL_DATABASE_IDENTITY_ENROLLMENT),
          ),
        ),
      );
      const issuerServices = yield* Layer.build(signer);
      const issuerService = Context.get(issuerServices, GatewayIssuer);
      const gateServices = yield* Layer.build(
        AccessDecisionLive.pipe(
          Layer.provide(AccessEnforcementPortsLive),
          Layer.provide(TenantIntentLoaderLive),
          Layer.provide(Layer.succeed(CoreDatabase, runtime)),
        ),
      );
      const gate = Context.get(gateServices, AccessDecisionGate);
      const scopes = yield* makeOperationalScopeResolver(
        makeOperationalScopeRepository(runtime, SHELL_DATABASE_IDENTITY_ENROLLMENT),
        gate,
      );
      const namespace = yield* Schema.decodeUnknownEffect(AuthenticationNamespaceRegistrationSchema)({
        allowedAudiences: ['privacy', 'symmy-integration'],
        authenticationNamespaceId: 'privacy.native.staff',
        provider: 'better_auth',
        requiresOperationAdmission: false,
        reservationPrincipalKind: 'human',
        subjectTypes: ['user', 'api_key'],
        trustedAttesterPrincipalIds: [],
      });
      const namespaceRegistry = makeAuthenticationNamespaceRegistry([namespace]);
      const installed = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
      const auth = yield* makeAuthDatabase({
        connectionString: fixture.connections.runtime.connectionString,
        expectedRole: fixture.connections.runtime.expectedRole,
      });
      const configuration = ConfigProvider.fromUnknown({
        ONTOS_GATEWAY_ISSUER: issuer,
        ONTOS_GATEWAY_MODULE_BINDINGS: JSON.stringify([
          {
            compositionRevision: snapshot.composition.revision,
            providerKeyId: privacyProviderKey,
            sourceAppId: 'privacy',
            sourceBuildMarker: 'privacy-build',
          },
          {
            compositionRevision: snapshot.composition.revision,
            providerKeyId: symmyProviderKey,
            sourceAppId: 'symmy-integration',
            sourceBuildMarker: 'symmy-integration-build',
          },
        ]),
        ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
          keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'native-privacy', use: 'sig' }],
        }),
      });
      const services = Layer.mergeAll(
        Layer.succeed(CoreDatabase, runtime),
        Layer.succeed(AuthDatabase, auth),
        Layer.succeed(
          PrincipalResolver,
          makePrincipalResolver(runtime, { authenticationNamespaceId: 'privacy.native.staff' }),
        ),
        Layer.succeed(TenantModuleStateService, makeTenantModuleStateService(runtime)),
        Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
        Layer.succeed(GatewayDelegationExchangeLedger, makeGatewayDelegationExchangeLedger(auth.executor)),
        Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
        Layer.succeed(OperationalScopeResolver, scopes),
        Layer.succeed(AccessDecisionGate, gate),
      );
      const issue = (
        subject: (typeof GatewayDelegatedContextRequestSchema.Encoded)['subject'],
        audience = 'symmy-integration',
        providerKey = symmyProviderKey,
      ) =>
        Effect.gen(function* issueFiniteNative() {
          const payload = yield* Schema.decodeUnknownEffect(GatewayDelegatedContextRequestSchema)({
            audience,
            compositionRevision: snapshot.composition.revision,
            exchangeId: yield* crypto.randomUUIDv4(),
            legalEntityScope: 'subject',
            subject,
          });
          return yield* issueDelegatedGatewayContextAssertion({
            payload,
            requestCorrelation: 'native-finite-privacy',
            verifiedProviderKeyId: providerKey,
          });
        }).pipe(
          Effect.provide(signer),
          Effect.provide(GatewayDelegationVerificationLive),
          Effect.provide(GatewayOriginatorEvidenceLive),
          Effect.provide(services),
          Effect.provideService(ConfigProvider.ConfigProvider, configuration),
          Effect.provideService(AuthenticationNamespaceRegistry, namespaceRegistry),
        );
      const receive = (token: string, audience: 'privacy' | 'symmy-integration', selected = snapshot) =>
        bindGatewayPrincipalVerifier(audience, { appId: audience, buildMarker: `${audience}-build` })
          .verifyAndRedeem(Redacted.make(`Bearer ${token}`), {
            environment: {
              ONTOS_GATEWAY_ISSUER: issuer,
              ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
                keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'native-privacy', use: 'sig' }],
              }),
            },
            redemption: nativeRedemption(runtime),
          })
          .pipe(Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(selected) }));
      const runtimeServices = yield* Layer.build(
        OutboxRuntimeLive.pipe(
          Layer.provide(OutboxRepositoryLive),
          Layer.provide(Layer.succeed(CoreDatabase, runtime)),
        ),
      );
      const nativeRuntime = Context.get(runtimeServices, OutboxRuntime);
      const verifier = bindGatewayPrincipalVerifier('privacy', {
        appId: 'privacy',
        buildMarker: 'privacy-build',
      });
      const durableReceipts = new Map<OperationalScope, boolean>();
      for (const holder of holders) {
        const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
          authBindingId: holder.authBindingId,
          authContextRef: 'privacy-native:original-human',
          authenticationNamespaceId: 'privacy.native.staff',
          authMethod: 'session',
          legalEntityId,
          principalId: holder.principalId,
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
        const assertion = yield* issuerService.issue({
          audience: 'privacy',
          compositionRevision: snapshot.composition.revision,
          principal,
        });
        const verified = yield* verifier
          .verifyAndRedeem(Redacted.make(`Bearer ${assertion.token}`), {
            environment: {
              ONTOS_GATEWAY_ISSUER: issuer,
              ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
                keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'native-privacy', use: 'sig' }],
              }),
            },
            redemption: nativeRedemption(runtime),
          })
          .pipe(Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }));
        const scope = yield* scopes
          .resolve({
            audience: 'privacy',
            correlationId: 'native-privacy-authority',
            legalEntityScope: 'optional',
            principal: verified,
          })
          .pipe(Effect.provideService(AuthenticationNamespaceRegistry, namespaceRegistry));
        expect(scope.legalEntityId).toBe(legalEntityId);
        const now = yield* DateTime.nowAsDate;
        const dispatch = yield* gate.decide({
          carrier: { accessDeclaration: dispatchDeclaration, entrypoint: dispatchEntrypoint, schemaVersion: '1' },
          legalEntityScope: 'required',
          now,
          scope,
        });
        expect(dispatch.outcome, JSON.stringify(dispatch.reasons)).toBe('ALLOWED');
        const retention = yield* gate.decide({
          carrier: { accessDeclaration: retentionDeclaration, entrypoint: retentionEntrypoint, schemaVersion: '1' },
          legalEntityScope: 'optional',
          now,
          scope,
        });
        const receipt = yield* gate.list({
          carrier: { accessDeclaration: receiptDeclaration, entrypoint: receiptEntrypoint, schemaVersion: '1' },
          legalEntityScope: 'optional',
          now,
          scope,
        });
        expect(retention.outcome).toBe(holder.name === 'authorized' ? 'ALLOWED' : 'DENIED');
        expect(receipt.decision.outcome, JSON.stringify(receipt.decision.reasons)).toBe(
          holder.name === 'authorized' ? 'ALLOWED' : 'DENIED',
        );
        if (holder.name === 'authorized') {
          expect(receipt.predicate?.groups).toEqual([]);
        }
        expect(scope.legalEntityId).toBe(legalEntityId);
        const dispatchInvocationId = yield* crypto.randomUUIDv4();
        const domainEventId = yield* crypto.randomUUIDv4();
        const messageId = yield* crypto.randomUUIDv4();
        const resourceRef = `integration.symmy.job:${yield* crypto.randomUUIDv4()}`;
        const payload = yield* Schema.decodeUnknownEffect(OutboxPayloadSchema)({
          handoff: {
            contentScopeRefs: [`${resourceRef}#integration.symmy.job-intent`],
            controllerObligationRef: null,
            dispositionDecision: 'DELETE',
            expectedEvidenceRefs: [],
            idempotencyKey: `native-privacy-${dispatchInvocationId}`,
            kind: 'DELETE',
            measureId: `measure-${dispatchInvocationId}`,
            owningCapability: 'integration.symmy',
            preconditionRefs: [],
            requestedAt: DateTime.formatIso(yield* DateTime.now),
            requestedResult: 'Erase exact operational intent',
            resourceRefs: [resourceRef],
            right: 'ERASURE',
            sourceDecisionRef: `decision-${dispatchInvocationId}`,
            sourceDecisionRevision: 1,
            subjectRef: `human-${holder.name}`,
            taskId: `task-${dispatchInvocationId}`,
            tenantId,
          },
        });
        yield* admin.executor.execute(
          sql`insert into core.action_invocations(action_invocation_id,tenant_id,legal_entity_id,principal_id,auth_method,auth_binding_id,auth_context_ref,action_key,status,request_hash,started_at,completed_at) values(${dispatchInvocationId}::uuid,${tenantId}::uuid,${legalEntityId}::uuid,${holder.principalId}::uuid,'session',${holder.authBindingId}::uuid,'privacy-native:original-human',${dispatchAction},'succeeded',${computeCanonicalValueHash(payload)},now()-interval '400 days',now()-interval '400 days')`,
          'objects',
        );
        yield* admin.executor.execute(
          sql`insert into core.domain_events(domain_event_id,tenant_id,legal_entity_id,action_invocation_id,producer_module_key,event_type,subject_module_key,subject_resource_type,subject_resource_id,payload_json) values(${domainEventId}::uuid,${tenantId}::uuid,${legalEntityId}::uuid,${dispatchInvocationId}::uuid,'privacy.core',${outboxTopic},'privacy.core','privacy.core.privacy-measure',${payload.handoff.measureId},${JSON.stringify(payload)}::jsonb)`,
          'objects',
        );
        yield* admin.executor.execute(
          sql`insert into core.outbox_messages(outbox_message_id,tenant_id,domain_event_id,producer_module_key,topic,payload_json) values(${messageId}::uuid,${tenantId}::uuid,${domainEventId}::uuid,'privacy.core',${outboxTopic},${JSON.stringify(payload)}::jsonb)`,
          'objects',
        );
        yield* nativeRuntime.matchMessages({ compositionRevision: snapshot.composition.revision });
        const receiptSubject = {
          _tag: 'PrivacyDispatch' as const,
          operation: { _tag: 'SymmyReceipt' as const },
          operationRequirementKey: receiptRequirement,
          source: { _tag: 'Dispatch' as const, dispatchInvocationId, legalEntityId, tenantId },
        };
        const finiteReceipt = yield* issue(receiptSubject, 'symmy-integration', privacyProviderKey);
        const finitePrincipal = yield* receive(finiteReceipt.token, 'symmy-integration');
        expect(finitePrincipal.principalId).toBe(holder.principalId);
        expect(finitePrincipal.authMethod).toBe('session');
        expect(readVerifiedGatewayWorkload(finitePrincipal)).toBeUndefined();
        const finiteScope = yield* scopes
          .resolve({
            audience: 'symmy-integration',
            correlationId: 'native-finite-receipt',
            legalEntityScope: 'optional',
            principal: finitePrincipal,
          })
          .pipe(Effect.provideService(AuthenticationNamespaceRegistry, namespaceRegistry));
        const finite = readVerifiedGatewayPrivacyDispatch(finiteScope);
        expect(finite?.dispatchInvocationId).toBe(dispatchInvocationId);
        expect(finite?.sourceMode).toBe('dispatch');
        expect(finite?.requestHash).toBe(computeCanonicalValueHash({ idempotencyKey: payload.handoff.idempotencyKey }));
        expect(Object.isFrozen(finite)).toBe(true);
        expect(readVerifiedGatewayPrivacyDispatch({ ...finiteScope })).toBeUndefined();
        const finiteDecision = yield* gate.decide({
          carrier: {
            accessActor: receiptActor,
            accessDeclaration: receiptDeclaration,
            entrypoint: receiptEntrypoint,
            schemaVersion: '1',
          },
          legalEntityScope: 'optional',
          now: yield* DateTime.nowAsDate,
          scope: finiteScope,
        });
        expect(finiteDecision.outcome, JSON.stringify(finiteDecision.reasons)).toBe(
          holder.name === 'authorized' ? 'ALLOWED' : 'DENIED',
        );
        expect(finiteScope.legalEntityId).toBe(legalEntityId);
        durableReceipts.set(finiteScope, holder.name === 'authorized');
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              issue(
                { ...receiptSubject, operation: { _tag: 'SymmyRetention' } },
                'symmy-integration',
                privacyProviderKey,
              ),
            ),
          ),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              issue(
                { ...receiptSubject, operationRequirementKey: 'privacy.core.requirement.wrong' },
                'symmy-integration',
                privacyProviderKey,
              ),
            ),
          ),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              issue(
                { ...receiptSubject, source: { ...receiptSubject.source, dispatchInvocationId: domainEventId } },
                'symmy-integration',
                privacyProviderKey,
              ),
            ),
          ),
        ).toBe(true);
      }
      const completed = yield* Deferred.make<null>();
      const cycleCompleted = yield* Deferred.make<null>();
      const workerResults: Exit.Exit<void>[] = [];
      const workerContexts: OutboxWorkerHandlerContext[] = [];
      const workerScopes: OperationalScope[] = [];
      const wireRequests: Request[] = [];
      const wireFetch: typeof globalThis.fetch = (input, init) => {
        wireRequests.push(new Request(input, init));
        return Promise.resolve(
          Response.json({
            apiBaseUrl: '/symmy-integration-api',
            compositionRevision: snapshot.composition.revision,
            expiresAt: 1_900_000_300,
            token: 'wire-only-response-never-verified-or-used',
          }),
        );
      };
      const wireConfiguration = ConfigProvider.fromUnknown({
        ONTOS_GATEWAY_MODULE_API_KEY: symmyProviderKey,
        ONTOS_SHELL_GATEWAY_BASE_URL: 'https://native-privacy-shell.example/shell-super-app-api',
      });
      const acquireWire = (subject: GatewayDelegationSubject, audience = 'symmy-integration') =>
        acquireDelegatedGatewayContext(
          { audience, legalEntityScope: 'subject', requestCorrelation: 'native-shared-privacy-wire', subject },
          crypto,
        ).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, wireConfiguration),
          Effect.provideService(FetchHttpClient.Fetch, wireFetch),
        );
      const verifyWorker = Effect.fn('NativePrivacyDispatch.actualWorker')(function* verifyActualWorker(
        payload: typeof OutboxPayloadSchema.Type,
        context: OutboxWorkerHandlerContext,
      ) {
        const expected = Option.getOrThrow(
          Option.fromNullishOr(holders.find((holder) => payload.handoff.subjectRef === `human-${holder.name}`)),
        );
        workerContexts.push(context);
        const sharedSubject = {
          _tag: 'PrivacyDispatch' as const,
          operation: { _tag: 'SymmyRetention' as const },
          source: { _tag: 'Worker' as const, context },
        };
        const beforeWire = wireRequests.length;
        yield* acquireWire(sharedSubject);
        expect(wireRequests).toHaveLength(beforeWire + 1);
        const wire = yield* Effect.promise(() =>
          Option.getOrThrow(Option.fromNullishOr(wireRequests.at(-1))).json(),
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(GatewayDelegatedContextRequestSchema)));
        assertWorkerWire(wire.subject, context);
        const copiedFailure = yield* acquireWire({
          ...sharedSubject,
          source: { _tag: 'Worker', context: { ...context } },
        }).pipe(Effect.flip);
        expect(Schema.is(GatewayDelegationSourceError)(copiedFailure)).toBe(true);
        expect(wireRequests).toHaveLength(beforeWire + 1);
        const source = {
          _tag: 'Worker' as const,
          claimId: context.claimId,
          deliveryId: context.deliveryId,
          tenantId: context.tenantId,
          workerKey: context.workerKey,
        };
        const retained = yield* issue({ _tag: 'PrivacyDispatch', operation: { _tag: 'SymmyRetention' }, source });
        const principal = yield* receive(retained.token, 'symmy-integration');
        const scope = yield* scopes
          .resolve({
            audience: 'symmy-integration',
            correlationId: 'native-finite-worker',
            legalEntityScope: 'optional',
            principal,
          })
          .pipe(Effect.provideService(AuthenticationNamespaceRegistry, namespaceRegistry));
        expect(principal.principalId).toBe(expected.principalId);
        expect(principal.authMethod).toBe('session');
        expect(readVerifiedGatewayPrivacyDispatch(scope)?.sourceMode).toBe('worker');
        expect(readVerifiedGatewayPrivacyDispatch(scope)?.claimId).toBe(context.claimId);
        expect(readVerifiedGatewayPrivacyDispatch(scope)?.requestHash).toBe(
          computeCanonicalValueHash({ handoff: payload.handoff }),
        );
        const decision = yield* gate.decide({
          carrier: {
            accessActor: retentionActor,
            accessDeclaration: retentionDeclaration,
            entrypoint: retentionEntrypoint,
            schemaVersion: '1',
          },
          legalEntityScope: 'optional',
          now: yield* DateTime.nowAsDate,
          scope,
        });
        expect(decision.outcome, JSON.stringify(decision.reasons)).toBe(
          expected.name === 'authorized' ? 'ALLOWED' : 'DENIED',
        );
        expect(scope.legalEntityId).toBe(legalEntityId);
        workerScopes.push(scope);
        if (expected.name === 'company-only') {
          return yield* Effect.void;
        }
        const opaqueSubject = yield* Schema.decodeUnknownEffect(GatewayPrivacyDispatchSubjectSchema)({
          _tag: 'PrivacyDispatch',
          operation: { _tag: 'SymmyRetention' },
          source,
        });
        const binding = yield* Schema.decodeUnknownEffect(GatewayModuleBindingSchema)({
          compositionRevision: snapshot.composition.revision,
          providerKeyId: symmyProviderKey,
          sourceAppId: 'symmy-integration',
          sourceBuildMarker: 'symmy-integration-build',
        });
        const opaque = yield* admitPrivacyDispatch({
          audience: 'symmy-integration',
          binding,
          installed,
          subject: opaqueSubject,
        }).pipe(
          Effect.provide(GatewayDelegationVerificationLive),
          Effect.provide(GatewayOriginatorEvidenceLive),
          Effect.provide(services),
          Effect.provideService(ConfigProvider.ConfigProvider, configuration),
          Effect.provideService(AuthenticationNamespaceRegistry, namespaceRegistry),
        );
        expect(readAdmittedPrivacyDispatch(opaque)).toBeDefined();
        const reflectedClone = structuredClone(opaque);
        Object.setPrototypeOf(reflectedClone, Object.getPrototypeOf(opaque));
        expect(readAdmittedPrivacyDispatch(reflectedClone)).toBeUndefined();
        const modulePrincipal = yield* makePrincipalResolver(runtime, {
          authenticationNamespaceId: 'privacy.native.staff',
        }).resolveBetterAuthApiKey(symmyProviderKey);
        const actor = yield* Schema.decodeUnknownEffect(GatewayActorClaimSchema)({
          appId: 'symmy-integration',
          buildMarker: 'symmy-integration-build',
          principalId: modulePrincipal.principalId,
        });
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              issuePrivacyDispatchGatewayContextAssertion(reflectedClone, {
                actor,
                audience: 'symmy-integration',
                compositionRevision: snapshot.composition.revision,
              }).pipe(Effect.provide(signer)),
            ),
          ),
        ).toBe(true);
        const legacy = yield* Effect.exit(issue({ _tag: 'Assertion', sourceAssertion: retained.token }, 'privacy'));
        expect(Exit.isFailure(legacy)).toBe(true);
        const outsideAction = yield* acquireWire(
          {
            _tag: 'PrivacyDispatch',
            operation: { _tag: 'PrivacyEligibility' },
            operationRequirementKey: eligibilityRequirement,
            source: { _tag: 'Assertion', scope },
          },
          'privacy',
        ).pipe(Effect.flip);
        expect(Schema.is(GatewayDelegationSourceError)(outsideAction)).toBe(true);
        expect(wireRequests).toHaveLength(beforeWire + 1);
        const eligibility = yield* issue(
          {
            _tag: 'PrivacyDispatch',
            operation: { _tag: 'PrivacyEligibility' },
            operationRequirementKey: eligibilityRequirement,
            source: { _tag: 'Assertion', sourceAssertion: retained.token },
          },
          'privacy',
        );
        const unsubscribed = yield* makeCompositionSnapshot(
          inputs.map((contract) => ({ ...contract, runtime: { outboxSubscriptions: [] } })),
          600_000,
          shellRuntime,
        );
        const eligibilityClaims = yield* decodeSupportedGatewayContextClaims(decodeJwt(eligibility.token));
        const unsubscribedToken = yield* Effect.promise(() =>
          new SignJWT({ ...eligibilityClaims, compositionRevision: unsubscribed.composition.revision })
            .setProtectedHeader({ alg: 'EdDSA', kid: 'native-privacy', typ: 'JWT' })
            .sign(privateKey),
        );
        const unsubscribedError = yield* receive(unsubscribedToken, 'privacy', unsubscribed).pipe(Effect.flip);
        expect(Schema.is(ActionPrincipalInvalidErrorSchema)(unsubscribedError)).toBe(true);
        const eligibilityPrincipal = yield* receive(eligibility.token, 'privacy');
        expect(readVerifiedGatewayPrivacyDispatch(eligibilityPrincipal)?.operation).toBe('PrivacyEligibility');
        expect(readVerifiedGatewayPrivacyDispatch(eligibilityPrincipal)?.target).toMatchObject({
          entrypointKey: eligibilityRead,
          schemaVersion: eligibilityVersion,
        });
        const eligibilityScope = yield* scopes
          .resolve({
            audience: 'privacy',
            correlationId: 'native-finite-eligibility',
            legalEntityScope: 'required',
            principal: eligibilityPrincipal,
          })
          .pipe(Effect.provideService(AuthenticationNamespaceRegistry, namespaceRegistry));
        const eligibilityDecision = yield* gate.decide({
          carrier: {
            accessActor: privacyActor,
            accessDeclaration: eligibilityDeclaration,
            entrypoint: eligibilityEntrypoint,
            schemaVersion: eligibilityVersion,
          },
          legalEntityScope: 'required',
          now: yield* DateTime.nowAsDate,
          scope: eligibilityScope,
        });
        expect(eligibilityDecision.outcome, JSON.stringify(eligibilityDecision.reasons)).toBe('ALLOWED');
        const wrongEligibilityVersion = yield* gate.decide({
          carrier: {
            accessActor: privacyActor,
            accessDeclaration: eligibilityDeclaration,
            entrypoint: eligibilityEntrypoint,
            schemaVersion: '1',
          },
          legalEntityScope: 'required',
          now: yield* DateTime.nowAsDate,
          scope: eligibilityScope,
        });
        expect(wrongEligibilityVersion.outcome).toBe('DENIED');
        const rechecked = yield* issue(
          {
            _tag: 'PrivacyDispatch',
            operation: { _tag: 'PrivacyEligibility' },
            operationRequirementKey: eligibilityRequirement,
            source: { _tag: 'Assertion', sourceAssertion: retained.token },
          },
          'privacy',
        );
        expect(readVerifiedGatewayPrivacyDispatch(yield* receive(rechecked.token, 'privacy'))?.requestHash).toBe(
          computeCanonicalValueHash({ handoff: payload.handoff }),
        );
        yield* acquireWire(
          {
            _tag: 'PrivacyDispatch',
            operation: { _tag: 'PrivacyOutcome', attempt: 1 },
            operationRequirementKey: outcomeRequirement,
            source: { _tag: 'Worker', context },
          },
          'privacy',
        );
        expect(wireRequests).toHaveLength(beforeWire + 2);
        const report = yield* issue(
          {
            _tag: 'PrivacyDispatch',
            operation: { _tag: 'PrivacyOutcome', attempt: 1 },
            operationRequirementKey: outcomeRequirement,
            source,
          },
          'privacy',
        );
        const reportPrincipal = yield* receive(report.token, 'privacy');
        expect(readVerifiedGatewayPrivacyDispatch(reportPrincipal)?.operation).toBe('PrivacyOutcome');
        const reportScope = yield* scopes
          .resolve({
            audience: 'privacy',
            correlationId: 'native-finite-outcome',
            legalEntityScope: 'required',
            principal: reportPrincipal,
          })
          .pipe(Effect.provideService(AuthenticationNamespaceRegistry, namespaceRegistry));
        const reportDecision = yield* gate.decide({
          carrier: {
            accessActor: privacyActor,
            accessDeclaration: outcomeDeclaration,
            entrypoint: outcomeEntrypoint,
            schemaVersion: '1',
          },
          legalEntityScope: 'required',
          now: yield* DateTime.nowAsDate,
          scope: reportScope,
        });
        expect(reportDecision.outcome, JSON.stringify(reportDecision.reasons)).toBe('ALLOWED');
        const receipt = yield* issue(
          {
            _tag: 'PrivacyDispatch',
            operation: { _tag: 'SymmyReceipt', attempt: 1 },
            operationRequirementKey: receiptRequirement,
            source: { _tag: 'Assertion', sourceAssertion: report.token },
          },
          'symmy-integration',
          privacyProviderKey,
        );
        const receiptPrincipal = yield* receive(receipt.token, 'symmy-integration');
        expect(readVerifiedGatewayPrivacyDispatch(receiptPrincipal)?.operation).toBe('SymmyReceipt');
        const receiptScope = yield* scopes
          .resolve({
            audience: 'symmy-integration',
            correlationId: 'native-finite-attempt-receipt',
            legalEntityScope: 'optional',
            principal: receiptPrincipal,
          })
          .pipe(Effect.provideService(AuthenticationNamespaceRegistry, namespaceRegistry));
        const receiptDecision = yield* gate.decide({
          carrier: {
            accessActor: receiptActor,
            accessDeclaration: receiptDeclaration,
            entrypoint: receiptEntrypoint,
            schemaVersion: '1',
          },
          legalEntityScope: 'optional',
          now: yield* DateTime.nowAsDate,
          scope: receiptScope,
        });
        expect(receiptDecision.outcome, JSON.stringify(receiptDecision.reasons)).toBe('ALLOWED');
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              issue(
                {
                  _tag: 'PrivacyDispatch',
                  operation: { _tag: 'PrivacyEligibility' },
                  operationRequirementKey: eligibilityRequirement,
                  source,
                },
                'privacy',
              ),
            ),
          ),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              issue(
                {
                  _tag: 'PrivacyDispatch',
                  operation: { _tag: 'PrivacyOutcome', attempt: 1 },
                  operationRequirementKey: eligibilityRequirement,
                  source,
                },
                'privacy',
              ),
            ),
          ),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              issue(
                {
                  _tag: 'PrivacyDispatch',
                  operation: { _tag: 'SymmyReceipt' },
                  operationRequirementKey: receiptRequirement,
                  source: { _tag: 'Assertion', sourceAssertion: report.token },
                },
                'symmy-integration',
                privacyProviderKey,
              ),
            ),
          ),
        ).toBe(true);
        const decideRetained = Effect.fn('NativePrivacyDispatch.decideRetained')(function* decideRetained() {
          return yield* gate.decide({
            carrier: {
              accessActor: retentionActor,
              accessDeclaration: retentionDeclaration,
              entrypoint: retentionEntrypoint,
              schemaVersion: '1',
            },
            legalEntityScope: 'optional',
            now: yield* DateTime.nowAsDate,
            scope,
          });
        });
        const staleControls = [
          {
            change: sql`update core.outbox_deliveries set claimed_by='replacement-finite-claim' where outbox_delivery_id=${context.deliveryId}::uuid`,
            restore: sql`update core.outbox_deliveries set claimed_by=${context.claimId} where outbox_delivery_id=${context.deliveryId}::uuid`,
          },
          {
            change: sql`update core.outbox_deliveries set claim_expires_at=now()-interval '1 second' where outbox_delivery_id=${context.deliveryId}::uuid`,
            restore: sql`update core.outbox_deliveries set claim_expires_at=now()+interval '30 seconds' where outbox_delivery_id=${context.deliveryId}::uuid`,
          },
          {
            change: sql`update core.outbox_deliveries set status='done' where outbox_delivery_id=${context.deliveryId}::uuid`,
            restore: sql`update core.outbox_deliveries set status='processing' where outbox_delivery_id=${context.deliveryId}::uuid`,
          },
          {
            change: sql`update core.principals set status='disabled' where principal_id=${expected.principalId}::uuid`,
            restore: sql`update core.principals set status='active' where principal_id=${expected.principalId}::uuid`,
          },
        ];
        for (const control of staleControls) {
          yield* admin.executor.execute(control.change, 'objects');
          expect((yield* decideRetained()).outcome).toBe('DENIED');
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                issue(
                  {
                    _tag: 'PrivacyDispatch',
                    operation: { _tag: 'PrivacyEligibility' },
                    operationRequirementKey: eligibilityRequirement,
                    source: { _tag: 'Assertion', sourceAssertion: retained.token },
                  },
                  'privacy',
                ),
              ),
            ),
          ).toBe(true);
          yield* admin.executor.execute(control.restore, 'objects');
        }
        expect((yield* decideRetained()).outcome).toBe('ALLOWED');
        return yield* Effect.void;
      });
      const worker = defineOutboxWorker(
        {
          consumerModuleKey: 'integration.symmy',
          entrypoint: workerEntrypoint,
          leaseDurationMs: 30_000,
          legalEntityScope: 'required',
          payloadSchema: OutboxPayloadSchema,
          producerModuleKey: 'privacy.core',
          retryPolicy: { initialBackoffMs: 1000, maxAttempts: 8, maxBackoffMs: 4000, multiplier: 2 },
          topic: outboxTopic,
          workerKey,
        },
        (payload, context) =>
          Effect.gen(function* observeNativePrivacyWorker() {
            const result = yield* Effect.exit(verifyWorker(payload, context).pipe(Effect.orDie));
            workerResults.push(result);
            if (Exit.isFailure(result) || workerResults.length === holders.length) {
              yield* Deferred.succeed(completed, null);
            }
          }),
      );
      const fixtureReceipt = defineRead(
        {
          accessDeclaration: receiptDeclaration,
          accessKind: 'detail',
          entrypoint: receiptEntrypoint,
          evidencePolicy: { captureMode: 'metadata_only', policyKey: 'integration.symmy.fixture-receipt.evidence' },
          inputSchema: SymmyJobPrivacyExecutionRequestSchema,
          legalEntityScope: 'optional',
          owningModuleKey: 'integration.symmy',
          policies: [],
          readKey: receiptRead,
          resultSchema: Schema.Null,
          schemaVersion: '1',
        },
        () => Effect.die('The transport fixture never executes a business receipt handler'),
        () => Effect.succeed({}),
      );
      const fixtureRetention = defineAction(
        {
          accessDeclaration: retentionDeclaration,
          accessEvidencePolicy: {
            captureMode: 'metadata_only',
            policyKey: 'integration.symmy.fixture-retention.evidence',
          },
          actionKey: retentionAction,
          auditProfile: 'sensitive',
          domainErrorSchema: GatewayDelegationSourceError,
          domainEvents: {},
          entrypoint: retentionEntrypoint,
          idempotency: 'required',
          legalEntityScope: 'optional',
          owningModuleKey: 'integration.symmy',
          payloadSchema: ExecuteSymmyRetentionPayloadSchema,
          policies: [],
          resultSchema: Schema.Null,
          schemaVersion: '1',
        },
        () => Effect.die('The worker transport fixture never executes a retention business handler'),
      );
      const serializedOwner = Option.getOrThrow(
        Option.fromNullishOr(inputs.find((input) => input.manifest.module.id === 'integration.symmy')),
      );
      const ownerBase = makeModuleContractFixture({
        appId: 'symmy-integration',
        moduleId: 'integration.symmy',
        originatorActions: [dispatchAction],
        supportedStates,
      }).manifest;
      const ownerManifest = defineOntosModuleManifest({
        ...ownerBase,
        publicSurface: {
          ...ownerBase.publicSurface,
          actions: [fixtureRetention],
          api: { 'symmy-job-privacy-execution': SymmyJobPrivacyExecutionApi },
          components: {},
          operationContracts: [
            {
              apiKey: 'symmy-job-privacy-execution',
              operationKey: 'symmyJobPrivacyExecution.execute',
              registration: fixtureReceipt,
            },
          ],
        },
        requirements: Schema.decodeUnknownSync(OntosModuleRequirementsSchema)(serializedOwner.manifest.requirements),
      });
      const ownerRegistration = defineVerticalRuntimeRegistration({
        actions: [fixtureRetention],
        manifest: ownerManifest,
        outboxWorkers: [worker],
        reads: [fixtureReceipt],
      });
      const entry = defineOutboxWorkerEntry({
        claimOwnerPrefix: 'native-privacy-proof',
        expectedDeployment: { appId: 'symmy-integration', buildMarker: 'symmy-integration-build' },
        layer: Layer.mergeAll(
          Layer.succeed(OutboxRuntime, nativeRuntime),
          Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
        ),
        ownerRegistration,
        registrations: [worker],
        subscriptions: extractOutboxWorkerSubscriptions([worker]),
      });
      const running = yield* entry
        .runLoop({
          config: { claimOwner: 'native-privacy-proof', maxDeliveries: 2, pollIntervalMs: 10 },
          health: {
            cycleFailed: Effect.void,
            cycleSucceeded: Effect.suspend(() =>
              workerResults.length === holders.length
                ? Deferred.succeed(cycleCompleted, null).pipe(Effect.asVoid)
                : Effect.void,
            ),
          },
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(completed);
      for (const result of workerResults) {
        if (Exit.isFailure(result)) {
          return yield* Effect.failCause(result.cause);
        }
      }
      yield* Deferred.await(cycleCompleted);
      yield* Fiber.interrupt(running);
      expect(workerResults).toHaveLength(holders.length);
      const nativeStatuses = yield* admin.executor.execute(
        sql`select d.status from core.outbox_deliveries d join core.outbox_messages m on m.outbox_message_id=d.outbox_message_id where m.tenant_id=${tenantId}::uuid and d.worker_key=${workerKey}`,
        'objects',
      );
      expect(nativeStatuses).toHaveLength(holders.length);
      yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ status: Schema.Literal('done') })))(
        nativeStatuses,
      );
      for (const [scope, allowed] of durableReceipts) {
        const decision = yield* gate.decide({
          carrier: {
            accessActor: receiptActor,
            accessDeclaration: receiptDeclaration,
            entrypoint: receiptEntrypoint,
            schemaVersion: '1',
          },
          legalEntityScope: 'optional',
          now: yield* DateTime.nowAsDate,
          scope,
        });
        expect(decision.outcome, JSON.stringify(decision.reasons)).toBe(allowed ? 'ALLOWED' : 'DENIED');
      }
      const beforeClosed = wireRequests.length;
      for (const context of workerContexts) {
        const failure = yield* acquireWire({
          _tag: 'PrivacyDispatch',
          operation: { _tag: 'SymmyRetention' },
          source: { _tag: 'Worker', context },
        }).pipe(Effect.flip);
        expect(Schema.is(GatewayDelegationSourceError)(failure)).toBe(true);
      }
      for (const scope of workerScopes) {
        const failure = yield* acquireWire(
          {
            _tag: 'PrivacyDispatch',
            operation: { _tag: 'PrivacyEligibility' },
            operationRequirementKey: eligibilityRequirement,
            source: { _tag: 'Assertion', scope },
          },
          'privacy',
        ).pipe(Effect.flip);
        expect(Schema.is(GatewayDelegationSourceError)(failure)).toBe(true);
      }
      expect(wireRequests).toHaveLength(beforeClosed);
      return yield* Effect.void;
    }),
  ).pipe(
    Effect.provide(makeDatabaseIdentityEnrollmentLive(SHELL_DATABASE_IDENTITY_ENROLLMENT)),
    Effect.provide(NodeServices.layer),
  ),
);
