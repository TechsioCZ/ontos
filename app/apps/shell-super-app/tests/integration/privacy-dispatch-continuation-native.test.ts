import {
  AccessActorSchema,
  AccessDeclarationSchema,
  ActiveApplicationCompositionService,
  GatewayAssertionRedemptionUnavailableError,
  GatewayAssertionReplayError,
  GatewayScopeGrantRegistrar,
  ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY,
  ONTOS_SHELL_CONTRIBUTION_ABI,
  OutboxRepositoryLive,
  OutboxRuntime,
  OutboxRuntimeLive,
  PrincipalResolver,
  TenantModuleStateService,
  defineTenantModuleEntrypoint,
  makeActiveApplicationCompositionService,
  makeOperationalScopeRepository,
  makeOperationalScopeResolver,
  makePrincipalResolver,
  makeTenantModuleStateService,
} from '@app/core-runtime';
import type { GatewayAssertionRedemptionInput } from '@app/core-runtime';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import { loadSpiceDbConfig } from '@app/core-runtime/access/spicedb-config';
import {
  AccessDecisionGate,
  AccessDecisionLive,
  AccessEnforcementPortsLive,
  TenantIntentLoaderLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { AuthenticationNamespaceRegistrationSchema } from '@app/core-runtime/auth/external-identity-contracts';
import {
  AuthenticationNamespaceRegistry,
  makeAuthenticationNamespaceRegistry,
} from '@app/core-runtime/auth/external-identity-admission';
import { readVerifiedGatewayPrivacyDispatch } from '@app/core-runtime/auth/system-principal-context-provenance';
import { CoreDatabase, makeCoreDatabase } from '@app/core-runtime/db/client';
import { OperationalScopeResolver } from '@app/core-runtime/operations/context';
import { makeGatewayScopeGrantRegistrar } from '@app/core-runtime/testing/gateway-scope-grant';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { grantTestTenantRoleAccess } from '@app/core-runtime/testing/tenant-access';
import { bindGatewayPrincipalVerifier } from '@app/gateway-principal-verifier/server';
import { OutboxPayloadSchema, outboxTopic } from '@app/privacy/outbox/privacy-measure-dispatched';
import { GatewayDelegatedContextRequestSchema, privacyDispatchConsumers } from '@app/shared-contracts';
import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { ConfigProvider, Context, Crypto, DateTime, Effect, Exit, Layer, Option, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair } from 'jose';

import { AuthDatabase, makeAuthDatabase } from '../../api/auth/db/client.ts';
import { GatewayDelegationError } from '../../api/auth/gateway-delegation-errors.ts';
import { issueDelegatedGatewayContextAssertion } from '../../api/auth/gateway-delegation-issuer.ts';
import {
  GatewayDelegationExchangeLedger,
  makeGatewayDelegationExchangeLedger,
} from '../../api/auth/gateway-delegation-exchanges.service.ts';
import { GatewayDelegationVerificationLive } from '../../api/auth/gateway-delegation-verification.ts';
import { makeGatewayIssuerLayer } from '../../api/auth/gateway-issuer.ts';
import { parseGatewayIssuerConfig } from '../../api/auth/gateway-issuer-config.ts';
import { GatewayOriginatorEvidenceLive } from '../../api/auth/gateway-originator-evidence.service.ts';
import {
  makeInstalledModuleCatalogLoader,
  ShellInstalledModuleCatalog,
} from '../../api/modules/installed-module-catalog.ts';
import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';

/*
 * E19 (#1410): the receipt push of a LATER human-recorded owner execution confirmation, proven against native Core rows
 * of PostgreSQL and the real SpiceDB engine. The original Communications dispatch delivery is settled (no claim), so the
 * only carrier left is Communications' own continuation delivery; Shell admits it only as ONE outcome report joined to
 * the original human dispatch, and never as anything else, for anyone else.
 */

const communications = privacyDispatchConsumers['communications.core'];
const symmyConsumer = privacyDispatchConsumers['integration.symmy'];
const continuation = communications?.continuation;
if (communications === undefined || symmyConsumer === undefined || continuation === undefined) {
  throw new Error('The approved Communications continuation and the frozen Symmy consumer are required');
}
const dispatchAction = 'privacy.core.dispatch-privacy-measure';
const dispatchCapability = 'privacy.core.privacy-measure.dispatch';
const outcomeAction = 'privacy.core.record-owner-execution-outcome';
const receiptRead = 'communications.core.api.privacy-owner-execution-outcome';
const receiptCapability = 'communications.core.privacy-owner-execution-outcome.read';
const evidenceCapability = 'communications.core.owner-execution-evidence.record';
const privacyProviderKey = 'privacy-continuation-module-key';
const communicationsProviderKey = 'communications-continuation-module-key';
const symmyProviderKey = 'symmy-continuation-module-key';
const namespaceId = 'privacy.continuation.staff';
const supportedStates = ['inactive', 'active', 'read_only', 'quarantined'] as const;

const declaration = (key: string) =>
  Schema.decodeUnknownSync(AccessDeclarationSchema)({
    key,
    kind: 'action',
    modes: ['run', 'propose', 'approve'],
    placement: { group: 'privacy-measures', level: 'manage' },
    risk: 'critical',
    selectors: [],
  });
const dispatchDeclaration = declaration(dispatchCapability);
const outcomeDeclaration = declaration('privacy.core.owner-execution-outcome.record');
const evidenceDeclaration = declaration(evidenceCapability);
const outcomeEntrypoint = defineTenantModuleEntrypoint({
  access: 'write',
  authorization: { kind: 'protected' },
  entrypointKey: outcomeAction,
  moduleKey: 'privacy.core',
  role: 'action',
});
const receiptEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: receiptRead,
  moduleKey: 'communications.core',
  role: 'api',
});
const workerEntrypoint = (moduleKey: string, entrypointKey: string) =>
  defineTenantModuleEntrypoint({
    access: 'background',
    authorization: { kind: 'owner_local_background' },
    entrypointKey,
    moduleKey,
    role: 'worker',
  });
const outcomeActor = Schema.decodeUnknownSync(AccessActorSchema)({
  callers: ['communications'],
  reason: 'Exact finite native continuation fixture',
  subject: 'identity',
});

const actionOf = (input: {
  readonly accessDeclaration: typeof dispatchDeclaration;
  readonly actionKey: string;
  readonly legalEntityScope: 'forbidden' | 'required';
  readonly moduleKey: string;
}) => ({
  accessDeclaration: input.accessDeclaration,
  actionKey: input.actionKey,
  auditProfile: 'standard' as const,
  entrypoint: defineTenantModuleEntrypoint({
    access: 'write',
    authorization: { kind: 'protected' },
    entrypointKey: input.actionKey,
    moduleKey: input.moduleKey,
    role: 'action',
  }),
  idempotency: 'required' as const,
  legalEntityScope: input.legalEntityScope,
  owningModuleId: input.moduleKey,
  schemaVersion: '1',
});

const contractInputs = () => {
  const privacy = makeModuleContractFixture({
    appId: 'privacy',
    moduleId: 'privacy.core',
    originatorActions: [dispatchAction],
    supportedStates,
  });
  const owner = makeModuleContractFixture({
    appId: 'communications',
    moduleId: 'communications.core',
    originatorActions: [dispatchAction],
    outboxSubscriptions: [
      {
        consumerModuleKey: 'communications.core',
        entrypoint: workerEntrypoint('communications.core', communications.workerKey),
        producerModuleKey: 'privacy.core',
        topic: outboxTopic,
        workerKey: communications.workerKey,
      },
      {
        consumerModuleKey: 'communications.core',
        entrypoint: workerEntrypoint('communications.core', continuation.workerKey),
        producerModuleKey: 'communications.core',
        topic: continuation.topic,
        workerKey: continuation.workerKey,
      },
    ],
    supportedStates,
  });
  const symmy = makeModuleContractFixture({
    appId: 'symmy-integration',
    moduleId: 'integration.symmy',
    originatorActions: [dispatchAction],
    outboxSubscriptions: [
      {
        consumerModuleKey: 'integration.symmy',
        entrypoint: workerEntrypoint('integration.symmy', symmyConsumer.workerKey),
        producerModuleKey: 'privacy.core',
        topic: outboxTopic,
        workerKey: symmyConsumer.workerKey,
      },
    ],
    supportedStates,
  });
  const outcomeProvider = { entrypointKey: outcomeAction, moduleId: 'privacy.core', schemaVersion: '1' };
  return [
    {
      ...privacy,
      manifest: {
        ...privacy.manifest,
        publicSurface: {
          ...privacy.manifest.publicSurface,
          actions: [
            actionOf({
              accessDeclaration: dispatchDeclaration,
              actionKey: dispatchAction,
              legalEntityScope: 'required',
              moduleKey: 'privacy.core',
            }),
            actionOf({
              accessDeclaration: outcomeDeclaration,
              actionKey: outcomeAction,
              legalEntityScope: 'required',
              moduleKey: 'privacy.core',
            }),
          ],
          api: [{ key: outcomeAction, operationKeys: ['recordOwnerExecutionOutcomeAction.execute'] }],
          operationContracts: [
            {
              apiKey: outcomeAction,
              entrypoint: outcomeEntrypoint,
              operationKey: 'recordOwnerExecutionOutcomeAction.execute',
              schemaVersion: '1',
            },
          ],
        },
        requirements: {
          coreCapabilities: [ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY],
          intrinsic: [],
          operations: [
            {
              condition: 'privacy.core.condition.communications-owner-execution-outcome',
              entrypointKey: outcomeAction,
              evidence: ['privacy.core.evidence.current-communications-owner-execution-outcome'],
              key: communications.receiptRequirementKey,
              provider: { entrypointKey: receiptRead, moduleId: 'communications.core', schemaVersion: '1' },
            },
          ],
          schemaVersion: '1',
        },
      },
    },
    {
      ...owner,
      manifest: {
        ...owner.manifest,
        publicSurface: {
          ...owner.manifest.publicSurface,
          actions: [
            actionOf({
              accessDeclaration: evidenceDeclaration,
              actionKey: continuation.actionKey,
              legalEntityScope: 'forbidden',
              moduleKey: 'communications.core',
            }),
          ],
          api: [{ key: receiptRead, operationKeys: ['privacyOwnerExecutionOutcome.execute'] }],
          operationContracts: [
            {
              apiKey: receiptRead,
              entrypoint: receiptEntrypoint,
              operationKey: 'privacyOwnerExecutionOutcome.execute',
              schemaVersion: '1',
            },
          ],
        },
        requirements: {
          coreCapabilities: [ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY],
          intrinsic: [],
          operations: [
            {
              condition: 'communications.core.condition.persisted-original-privacy-owner-outcome',
              entrypointKey: communications.workerKey,
              evidence: ['communications.core.evidence.privacy.original-owner-outcome'],
              key: 'communications.core.requirement.privacy-report-owner-outcome',
              provider: outcomeProvider,
            },
            {
              condition: 'communications.core.condition.human-recorded-owner-execution-evidence',
              entrypointKey: continuation.workerKey,
              evidence: ['communications.core.evidence.privacy.recorded-owner-execution-evidence'],
              key: continuation.requirementKey,
              provider: outcomeProvider,
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
        requirements: {
          coreCapabilities: [ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY],
          intrinsic: [],
          operations: [
            {
              condition: 'integration.symmy.condition.persisted-original-privacy-owner-outcome',
              entrypointKey: symmyConsumer.workerKey,
              evidence: ['integration.symmy.evidence.privacy.original-owner-outcome'],
              key: 'integration.symmy.requirement.privacy-report-owner-outcome',
              provider: outcomeProvider,
            },
          ],
          schemaVersion: '1',
        },
      },
    },
  ];
};

/** What a continuation fixture message says: the original dispatch it names and the attempt it asks for. */
interface ContinuationFixturePayload {
  readonly attempt: number;
  readonly dispatchInvocationId: string;
  readonly measureId: string;
  readonly taskId: string;
}
const fixtureDeliveryIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('ContinuationFixtureDeliveryId'),
);

const issuerConnection = (connectionString: string, role: string) => {
  const url = new URL(connectionString);
  url.username = role;
  url.password = role;
  return url.href;
};
const nativeRedemption = (database: Effect.Success<ReturnType<typeof makeCoreDatabase>>) => ({
  consume: Effect.fn('NativeContinuation.redeem')(function* redeem(input: GatewayAssertionRedemptionInput) {
    const rows = yield* database.executor
      .execute(
        sql`insert into public.continuation_gateway_redemptions(issuer,audience,jti) values(${input.issuer},${input.audience},${input.jti}::uuid) on conflict do nothing returning jti`,
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
  'admits a later human-recorded Communications outcome only as one report joined to the original human dispatch',
  () =>
    Effect.scoped(
      Effect.gen(function* nativeContinuation() {
        const crypto = yield* Crypto.Crypto;
        const id = () => crypto.randomUUIDv4();
        const shellDeployment = { appId: 'shell-super-app' as const, buildMarker: ultramodernDeliveryUnit.buildMarker };
        const shellRuntime = {
          document: JSON.stringify({
            contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
            coreCapabilities: [ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY],
            deployment: shellDeployment,
            schemaVersion: '2',
          }),
          receiverDeployment: shellDeployment,
        };
        const snapshot = yield* makeCompositionSnapshot(contractInputs(), 600_000, shellRuntime);
        const fixture = yield* makeIsolatedNativeDatabaseFixture({
          compositionSnapshot: snapshot,
          mode: 'schema-only',
          purpose: 'implementation-1096-registered-workload-gateway',
        });
        const admin = yield* makeCoreDatabase(fixture.connections.admin);
        const runtime = yield* makeCoreDatabase(fixture.connections.runtime);
        const exec = (statement: ReturnType<typeof sql>) => admin.executor.execute(statement, 'objects');

        // Two Tenants, each with its governance company, its Privacy dispatcher and a Communications evidence recorder.
        const tenantOf = Effect.fnUntraced(function* tenantOf(label: string) {
          const tenantId = yield* id();
          const legalEntityId = yield* id();
          const tenantName = `FICTIONAL ${label}`;
          const companyName = `FICTIONAL ${label} company`;
          const registration = `fictional-${label}`;
          yield* exec(
            sql`insert into core.tenants(tenant_id,slug,name,status,default_locale) values(${tenantId}::uuid,${tenantId},${tenantName},'active','en')`,
          );
          yield* exec(
            sql`insert into core.legal_entities(legal_entity_id,tenant_id,legal_name,registration_country,registration_number,status) values(${legalEntityId}::uuid,${tenantId}::uuid,${companyName},'CZ',${registration},'active')`,
          );
          yield* exec(
            sql`insert into core.tenant_module_states(tenant_id,module_key,state) values(${tenantId}::uuid,'privacy.core','active'),(${tenantId}::uuid,'communications.core','active'),(${tenantId}::uuid,'integration.symmy','active')`,
          );
          const humanOf = Effect.fnUntraced(function* humanOf(name: string, kind: 'human' | 'service') {
            const principalId = yield* id();
            const authBindingId = yield* id();
            yield* exec(
              sql`insert into core.principals(principal_id,tenant_id,kind,display_name,status) values(${principalId}::uuid,${tenantId}::uuid,${kind},${name},'active')`,
            );
            yield* exec(
              sql`insert into core.principal_auth_bindings(principal_auth_binding_id,tenant_id,principal_id,authentication_namespace_id,provider,subject_type,provider_subject_id,status) values(${authBindingId}::uuid,${tenantId}::uuid,${principalId}::uuid,${namespaceId},'better_auth','user',${principalId},'active')`,
            );
            const email = `${principalId}@continuation.test`;
            yield* exec(
              sql`insert into auth."user"(id,name,email,email_verified,banned) values(${principalId},${name},${email},true,false)`,
            );
            return { authBindingId, principalId };
          });
          const dispatcher = yield* humanOf('FICTIONAL dispatcher', 'human');
          const recorder = yield* humanOf('FICTIONAL recorder', 'human');
          const service = yield* humanOf('FICTIONAL service', 'service');
          return { dispatcher, legalEntityId, recorder, service, tenantId };
        });
        const tenant = yield* tenantOf('tenant');
        const foreign = yield* tenantOf('foreign');
        for (const providerKey of [privacyProviderKey, communicationsProviderKey, symmyProviderKey]) {
          const principalId = yield* id();
          yield* exec(
            sql`insert into core.principals(principal_id,tenant_id,kind,display_name,status) values(${principalId}::uuid,${tenant.tenantId}::uuid,'service','Finite module','active')`,
          );
          yield* exec(
            sql`insert into core.principal_auth_bindings(tenant_id,principal_id,authentication_namespace_id,provider,subject_type,provider_subject_id,status) values(${tenant.tenantId}::uuid,${principalId}::uuid,${namespaceId},'better_auth','api_key',${providerKey},'active')`,
          );
        }
        const spiceDb = yield* loadSpiceDbConfig();
        const target = { adminConnectionString: Redacted.make(fixture.connections.admin.connectionString), spiceDb };
        for (const scope of [tenant, foreign]) {
          // The dispatcher governs the measure in its company and may read the owner receipt Tenant-wide.
          yield* grantTestTenantRoleAccess({
            ...target,
            assignmentScope: 'companies',
            holders: [
              {
                capabilityKeys: [dispatchCapability, outcomeDeclaration.key],
                principalId: scope.dispatcher.principalId,
              },
            ],
            legalEntityIds: [scope.legalEntityId],
            tenantId: scope.tenantId,
          });
          yield* grantTestTenantRoleAccess({
            ...target,
            assignmentScope: 'all',
            holders: [{ capabilityKeys: [receiptCapability], principalId: scope.dispatcher.principalId }],
            legalEntityIds: [scope.legalEntityId],
            tenantId: scope.tenantId,
          });
        }
        yield* exec(
          sql`create table public.continuation_gateway_redemptions(issuer text not null,audience text not null,jti uuid not null,primary key(issuer,audience,jti))`,
        );
        yield* exec(sql`grant insert,select on public.continuation_gateway_redemptions to ontos_runtime`);

        const reactivity = yield* Reactivity.make;
        const issuerClient = yield* PgClient.make({
          url: Redacted.make(issuerConnection(fixture.connections.runtime.connectionString, 'shell_gateway_issuer')),
        }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity));
        const { privateKey, publicKey } = yield* Effect.promise(() =>
          generateKeyPair('Ed25519', { extractable: true }),
        );
        const privateJwk = yield* Effect.promise(() => exportJWK(privateKey));
        const publicJwk = yield* Effect.promise(() => exportJWK(publicKey));
        const issuer = 'https://native-continuation-shell.example';
        const jwks = JSON.stringify({ keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'native-continuation', use: 'sig' }] });
        const signing = yield* parseGatewayIssuerConfig({
          ONTOS_GATEWAY_ISSUER: issuer,
          ONTOS_GATEWAY_PRIVATE_JWK: JSON.stringify({
            ...privateJwk,
            alg: 'EdDSA',
            kid: 'native-continuation',
            use: 'sig',
          }),
        });
        const signer = makeGatewayIssuerLayer({
          currentTimeSeconds: Effect.succeed(Math.floor(DateTime.toEpochMillis(snapshot.observedAt) / 1000)),
          generateJti: crypto.randomUUIDv4().pipe(Effect.orDie),
          loadAdmission: Effect.succeed({
            audiences: new Map([
              ['communications', 'communications-build'],
              ['privacy', 'privacy-build'],
              ['symmy-integration', 'symmy-integration-build'],
            ]),
            revision: snapshot.composition.revision,
          }),
          loadConfig: Effect.succeed(signing),
        }).pipe(Layer.provide(Layer.succeed(GatewayScopeGrantRegistrar, makeGatewayScopeGrantRegistrar(issuerClient))));
        const gateServices = yield* Layer.build(
          AccessDecisionLive.pipe(
            Layer.provide(AccessEnforcementPortsLive),
            Layer.provide(TenantIntentLoaderLive),
            Layer.provide(Layer.succeed(CoreDatabase, runtime)),
          ),
        );
        const gate = Context.get(gateServices, AccessDecisionGate);
        const scopes = yield* makeOperationalScopeResolver(makeOperationalScopeRepository(runtime), gate);
        const namespace = yield* Schema.decodeUnknownEffect(AuthenticationNamespaceRegistrationSchema)({
          allowedAudiences: ['communications', 'privacy', 'symmy-integration'],
          authenticationNamespaceId: namespaceId,
          provider: 'better_auth',
          requiresOperationAdmission: false,
          reservationPrincipalKind: 'human',
          subjectTypes: ['user', 'api_key'],
          trustedAttesterPrincipalIds: [],
        });
        const namespaceRegistry = makeAuthenticationNamespaceRegistry([namespace]);
        const installed = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
        const auth = yield* makeAuthDatabase({ connectionString: fixture.connections.runtime.connectionString });
        const binding = (providerKeyId: string, sourceAppId: string) => ({
          compositionRevision: snapshot.composition.revision,
          providerKeyId,
          sourceAppId,
          sourceBuildMarker: `${sourceAppId}-build`,
        });
        const configuration = ConfigProvider.fromUnknown({
          ONTOS_GATEWAY_ISSUER: issuer,
          ONTOS_GATEWAY_MODULE_BINDINGS: JSON.stringify([
            binding(privacyProviderKey, 'privacy'),
            binding(communicationsProviderKey, 'communications'),
            binding(symmyProviderKey, 'symmy-integration'),
          ]),
          ONTOS_GATEWAY_PUBLIC_JWKS: jwks,
        });
        const services = Layer.mergeAll(
          Layer.succeed(CoreDatabase, runtime),
          Layer.succeed(AuthDatabase, auth),
          Layer.succeed(PrincipalResolver, makePrincipalResolver(runtime, { authenticationNamespaceId: namespaceId })),
          Layer.succeed(TenantModuleStateService, makeTenantModuleStateService(runtime)),
          Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
          Layer.succeed(GatewayDelegationExchangeLedger, makeGatewayDelegationExchangeLedger(auth.executor)),
          Layer.succeed(
            ActiveApplicationCompositionService,
            makeActiveApplicationCompositionService(Effect.succeed(snapshot)),
          ),
          Layer.succeed(OperationalScopeResolver, scopes),
          Layer.succeed(AccessDecisionGate, gate),
        );
        const issue = (
          subject: (typeof GatewayDelegatedContextRequestSchema.Encoded)['subject'],
          audience: string,
          providerKey: string,
        ) =>
          Effect.gen(function* issueFinite() {
            const payload = yield* Schema.decodeUnknownEffect(GatewayDelegatedContextRequestSchema)({
              audience,
              compositionRevision: snapshot.composition.revision,
              exchangeId: yield* id(),
              legalEntityScope: 'subject',
              subject,
            });
            return yield* issueDelegatedGatewayContextAssertion({
              payload,
              requestCorrelation: 'native-continuation',
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
        const refused = (
          subject: (typeof GatewayDelegatedContextRequestSchema.Encoded)['subject'],
          audience = 'privacy',
          providerKey = communicationsProviderKey,
        ) =>
          // refused means exactly the Shell's forbidden delegation answer, never any other failure of the issuance
          Effect.exit(issue(subject, audience, providerKey)).pipe(
            Effect.map((exit) =>
              Exit.findErrorOption(exit).pipe(
                Option.exists((failure) => Schema.is(GatewayDelegationError)(failure) && failure.code === 'forbidden'),
              ),
            ),
          );
        const receive = (token: string, audience: 'communications' | 'privacy') =>
          bindGatewayPrincipalVerifier(audience, { appId: audience, buildMarker: `${audience}-build` })
            .verifyAndRedeem(Redacted.make(`Bearer ${token}`), {
              environment: { ONTOS_GATEWAY_ISSUER: issuer, ONTOS_GATEWAY_PUBLIC_JWKS: jwks },
              redemption: nativeRedemption(runtime),
            })
            .pipe(
              Effect.provideService(
                ActiveApplicationCompositionService,
                makeActiveApplicationCompositionService(Effect.succeed(snapshot)),
              ),
            );
        const scopeOf = (
          principal: Effect.Success<ReturnType<typeof receive>>,
          audience: string,
          legalEntityScope: 'optional' | 'required' = 'required',
        ) =>
          scopes
            .resolve({ audience, correlationId: 'native-continuation-scope', legalEntityScope, principal })
            .pipe(Effect.provideService(AuthenticationNamespaceRegistry, namespaceRegistry));
        const runtimeServices = yield* Layer.build(
          OutboxRuntimeLive.pipe(
            Layer.provide(OutboxRepositoryLive),
            Layer.provide(Layer.succeed(CoreDatabase, runtime)),
          ),
        );
        const outbox = Context.get(runtimeServices, OutboxRuntime);
        const match = outbox.matchMessages({ compositionRevision: snapshot.composition.revision });

        /** One human Privacy dispatch to an owner, delivered to that owner's worker and then SETTLED (claim gone). */
        const dispatchTo = Effect.fnUntraced(function* dispatchTo(
          scope: typeof tenant,
          owningCapability: 'communications.core' | 'integration.symmy',
        ) {
          const dispatchInvocationId = yield* id();
          const domainEventId = yield* id();
          const resource =
            owningCapability === 'communications.core'
              ? `communications.core.intent:${yield* id()}`
              : `integration.symmy.job:${yield* id()}`;
          const handoff = {
            contentScopeRefs:
              owningCapability === 'communications.core'
                ? ['communications.core.history']
                : [`${resource}#integration.symmy.job-intent`],
            controllerObligationRef: null,
            dispositionDecision: 'DELETE',
            expectedEvidenceRefs: [],
            idempotencyKey: `FICTIONAL-idempotency-${dispatchInvocationId}`,
            kind: 'DELETE',
            measureId: `FICTIONAL-measure-${dispatchInvocationId}`,
            owningCapability,
            preconditionRefs: [],
            requestedAt: '2026-11-19T10:00:00.000Z',
            requestedResult: 'FICTIONAL requested result',
            resourceRefs: [resource],
            right: 'ERASURE',
            sourceDecisionRef: `FICTIONAL-decision-${dispatchInvocationId}`,
            sourceDecisionRevision: 1,
            subjectRef: 'FICTIONAL-subject',
            taskId: `FICTIONAL-task-${dispatchInvocationId}`,
            tenantId: scope.tenantId,
          };
          // Communications reads a measure only over an exact owner scope; Symmy's executable handoff carries none.
          const ownerScope = {
            controllerRef: 'FICTIONAL-controller',
            requestedScopePartRefs: ['communications.core.history'],
            requestedScopeRef: 'FICTIONAL-scope',
            trustedLookups: [
              { _tag: 'ACTOR_PRINCIPAL', lookupRef: 'FICTIONAL-lookup', principalId: scope.dispatcher.principalId },
            ],
          };
          const payload = yield* Schema.decodeUnknownEffect(OutboxPayloadSchema)({
            handoff: owningCapability === 'communications.core' ? { ...handoff, ownerScope } : handoff,
          });
          yield* exec(
            sql`insert into core.action_invocations(action_invocation_id,tenant_id,legal_entity_id,principal_id,auth_method,auth_binding_id,auth_context_ref,action_key,status,request_hash,started_at,completed_at) values(${dispatchInvocationId}::uuid,${scope.tenantId}::uuid,${scope.legalEntityId}::uuid,${scope.dispatcher.principalId}::uuid,'session',${scope.dispatcher.authBindingId}::uuid,'continuation:original-human',${dispatchAction},'succeeded',${computeCanonicalValueHash(payload)},now()-interval '2 days',now()-interval '2 days')`,
          );
          yield* exec(
            sql`insert into core.domain_events(domain_event_id,tenant_id,legal_entity_id,action_invocation_id,producer_module_key,event_type,subject_module_key,subject_resource_type,subject_resource_id,payload_json) values(${domainEventId}::uuid,${scope.tenantId}::uuid,${scope.legalEntityId}::uuid,${dispatchInvocationId}::uuid,'privacy.core',${outboxTopic},'privacy.core','privacy.core.privacy-measure',${payload.handoff.measureId},${JSON.stringify(payload)}::jsonb)`,
          );
          yield* exec(
            sql`insert into core.outbox_messages(outbox_message_id,tenant_id,domain_event_id,producer_module_key,topic,payload_json) values(${yield* id()}::uuid,${scope.tenantId}::uuid,${domainEventId}::uuid,'privacy.core',${outboxTopic},${JSON.stringify(payload)}::jsonb)`,
          );
          yield* match;
          // the take-over report happened long ago: the original delivery is settled and holds no claim
          yield* exec(
            sql`update core.outbox_deliveries d set status='done',claimed_by=null,claim_expires_at=null from core.outbox_messages m where m.outbox_message_id=d.outbox_message_id and m.domain_event_id=${domainEventId}::uuid`,
          );
          return { dispatchInvocationId, handoff: payload.handoff };
        });

        /** A later Communications evidence invocation by `principal` and its own continuation delivery, claimed now. */
        const recordEvidence = Effect.fnUntraced(function* recordEvidence(input: {
          readonly actionKey?: string;
          readonly payload: ContinuationFixturePayload;
          readonly principal: { readonly authBindingId: string; readonly principalId: string };
          readonly scope: typeof tenant;
          readonly status?: 'failed' | 'succeeded';
        }) {
          const invocationId = yield* id();
          const domainEventId = yield* id();
          const claimId = `FICTIONAL-claim-${invocationId}`;
          const { scope } = input;
          yield* exec(
            sql`insert into core.action_invocations(action_invocation_id,tenant_id,principal_id,auth_method,auth_binding_id,auth_context_ref,action_key,status,request_hash,started_at,completed_at) values(${invocationId}::uuid,${scope.tenantId}::uuid,${input.principal.principalId}::uuid,'session',${input.principal.authBindingId}::uuid,'continuation:recorder',${input.actionKey ?? continuation.actionKey},${input.status ?? 'succeeded'},${'e'.repeat(64)},now(),now())`,
          );
          yield* exec(
            sql`insert into core.domain_events(domain_event_id,tenant_id,action_invocation_id,producer_module_key,event_type,subject_module_key,subject_resource_type,subject_resource_id,payload_json) values(${domainEventId}::uuid,${scope.tenantId}::uuid,${invocationId}::uuid,'communications.core',${continuation.topic},'communications.core','communications.core.privacy-measure-handoff',${input.payload.measureId},${JSON.stringify(input.payload)}::jsonb)`,
          );
          yield* exec(
            sql`insert into core.outbox_messages(outbox_message_id,tenant_id,domain_event_id,producer_module_key,topic,payload_json) values(${yield* id()}::uuid,${scope.tenantId}::uuid,${domainEventId}::uuid,'communications.core',${continuation.topic},${JSON.stringify(input.payload)}::jsonb)`,
          );
          yield* match;
          const claimed = yield* exec(
            sql`update core.outbox_deliveries d set status='processing',claimed_by=${claimId},claim_expires_at=now()+interval '30 seconds' from core.outbox_messages m where m.outbox_message_id=d.outbox_message_id and m.domain_event_id=${domainEventId}::uuid and d.worker_key=${continuation.workerKey} returning d.outbox_delivery_id::text as "deliveryId"`,
          ).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ deliveryId: fixtureDeliveryIdSchema })])),
            ),
          );
          const [{ deliveryId }] = claimed;
          return {
            claimId,
            deliveryId,
            source: {
              _tag: 'Continuation' as const,
              claimId,
              deliveryId,
              tenantId: scope.tenantId,
              workerKey: continuation.workerKey,
            },
          };
        });
        const report = (source: Effect.Success<ReturnType<typeof recordEvidence>>['source'], attempt = 2) => ({
          _tag: 'PrivacyDispatch' as const,
          operation: { _tag: 'PrivacyOutcome' as const, attempt },
          operationRequirementKey: continuation.requirementKey,
          source,
        });

        const original = yield* dispatchTo(tenant, 'communications.core');
        const continuationPayload = {
          attempt: 2,
          dispatchInvocationId: original.dispatchInvocationId,
          measureId: original.handoff.measureId,
          taskId: original.handoff.taskId,
        };
        const recorded = yield* recordEvidence({
          payload: continuationPayload,
          principal: tenant.recorder,
          scope: tenant,
        });

        // ADMITTED: one outcome report as the ORIGINAL dispatcher, for exactly the original dispatch and attempt.
        const admitted = yield* issue(report(recorded.source), 'privacy', communicationsProviderKey);
        const reportPrincipal = yield* receive(admitted.token, 'privacy');
        expect(reportPrincipal.principalId).toBe(tenant.dispatcher.principalId);
        const reportScope = yield* scopeOf(reportPrincipal, 'privacy');
        const carrier = readVerifiedGatewayPrivacyDispatch(reportScope);
        expect(carrier).toMatchObject({
          claimId: recorded.claimId,
          continuationDeliveryId: recorded.deliveryId,
          dispatchInvocationId: original.dispatchInvocationId,
          measureId: original.handoff.measureId,
          operation: 'PrivacyOutcome',
          sourceMode: 'continuation',
          taskId: original.handoff.taskId,
          workerKey: continuation.workerKey,
          workerModuleKey: 'communications.core',
        });
        expect(carrier?.authority.continuation).toEqual({
          actionKey: continuation.actionKey,
          topic: continuation.topic,
          workerKey: continuation.workerKey,
        });
        expect(carrier?.requestHash).toBe(
          computeCanonicalValueHash({
            request: { attempt: 2, measureId: original.handoff.measureId, taskId: original.handoff.taskId },
          }),
        );
        const decideReport = Effect.fnUntraced(function* decideReport() {
          return yield* gate.decide({
            carrier: {
              accessActor: outcomeActor,
              accessDeclaration: outcomeDeclaration,
              entrypoint: outcomeEntrypoint,
              schemaVersion: '1',
            },
            legalEntityScope: 'required',
            now: yield* DateTime.nowAsDate,
            scope: reportScope,
          });
        });
        const allowed = yield* decideReport();
        expect(allowed.outcome, JSON.stringify(allowed.reasons)).toBe('ALLOWED');

        // Privacy then reads the receipt ITSELF through its durable receipt read of the same dispatch.
        const receipt = yield* issue(
          {
            _tag: 'PrivacyDispatch',
            operation: { _tag: 'CommunicationsReceipt', attempt: 2 },
            operationRequirementKey: communications.receiptRequirementKey,
            source: {
              _tag: 'Dispatch',
              dispatchInvocationId: original.dispatchInvocationId,
              legalEntityId: tenant.legalEntityId,
              tenantId: tenant.tenantId,
            },
          },
          'communications',
          privacyProviderKey,
        );
        const receiptScope = yield* scopeOf(
          yield* receive(receipt.token, 'communications'),
          'communications',
          'optional',
        );
        expect(readVerifiedGatewayPrivacyDispatch(receiptScope)?.sourceMode).toBe('dispatch');
        expect(readVerifiedGatewayPrivacyDispatch(receiptScope)?.requestHash).toBe(
          computeCanonicalValueHash({ attempt: 2, handoff: original.handoff }),
        );

        // NOT CHAINABLE: a continuation report never continues into a receipt or anything else.
        expect(
          yield* refused(
            {
              _tag: 'PrivacyDispatch',
              operation: { _tag: 'CommunicationsReceipt', attempt: 2 },
              operationRequirementKey: communications.receiptRequirementKey,
              source: { _tag: 'Assertion', sourceAssertion: admitted.token },
            },
            'communications',
            privacyProviderKey,
          ),
        ).toBe(true);

        // ONE OPERATION, ITS OWN REQUIREMENT, ITS OWN ATTEMPT: anything else from the continuation is refused.
        expect(yield* refused(report(recorded.source, 3))).toBe(true);
        expect(
          yield* refused({ ...report(recorded.source), operationRequirementKey: communications.receiptRequirementKey }),
        ).toBe(true);
        expect(
          yield* refused({
            ...report(recorded.source),
            operationRequirementKey: 'communications.core.requirement.privacy-report-owner-outcome',
          }),
        ).toBe(true);
        expect(
          yield* refused(
            {
              _tag: 'PrivacyDispatch',
              operation: { _tag: 'CommunicationsReceipt', attempt: 2 },
              operationRequirementKey: continuation.requirementKey,
              source: recorded.source,
            },
            'communications',
          ),
        ).toBe(true);
        expect(
          yield* refused({
            _tag: 'PrivacyDispatch',
            operation: { _tag: 'PrivacyEligibility' },
            operationRequirementKey: continuation.requirementKey,
            source: recorded.source,
          }),
        ).toBe(true);

        // ITS OWN CURRENT CLAIM: a forged claim, another worker key or another Tenant is refused.
        expect(yield* refused(report({ ...recorded.source, claimId: 'FICTIONAL-forged-claim' }))).toBe(true);
        expect(yield* refused(report({ ...recorded.source, workerKey: communications.workerKey }))).toBe(true);
        expect(yield* refused(report({ ...recorded.source, tenantId: foreign.tenantId }))).toBe(true);

        // SYMMY STAYS FROZEN: it has no continuation, neither with its own worker nor with the Communications delivery.
        expect(
          yield* refused(
            report({ ...recorded.source, workerKey: symmyConsumer.workerKey }),
            'privacy',
            symmyProviderKey,
          ),
        ).toBe(true);
        expect(yield* refused(report(recorded.source), 'privacy', symmyProviderKey)).toBe(true);
        // and Privacy itself cannot present the Communications continuation either
        expect(yield* refused(report(recorded.source), 'privacy', privacyProviderKey)).toBe(true);

        // NO HUMAN, NO SUCCESS, NOT THE EVIDENCE ACTION: the message alone never authorizes a report.
        const byService = yield* recordEvidence({
          payload: continuationPayload,
          principal: tenant.service,
          scope: tenant,
        });
        expect(yield* refused(report(byService.source))).toBe(true);
        const failedEvidence = yield* recordEvidence({
          payload: continuationPayload,
          principal: tenant.recorder,
          scope: tenant,
          status: 'failed',
        });
        expect(yield* refused(report(failedEvidence.source))).toBe(true);
        const otherAction = yield* recordEvidence({
          actionKey: 'communications.core.set-language-policy',
          payload: continuationPayload,
          principal: tenant.recorder,
          scope: tenant,
        });
        expect(yield* refused(report(otherAction.source))).toBe(true);

        // FORGED DISPATCH: the message names another measure, another Tenant's dispatch, a Symmy dispatch or nothing real.
        const forgedPayloads = [
          { ...continuationPayload, measureId: 'FICTIONAL-another-measure' },
          { ...continuationPayload, taskId: 'FICTIONAL-another-task' },
          {
            ...continuationPayload,
            dispatchInvocationId: (yield* dispatchTo(foreign, 'communications.core')).dispatchInvocationId,
          },
          {
            ...continuationPayload,
            dispatchInvocationId: (yield* dispatchTo(tenant, 'integration.symmy')).dispatchInvocationId,
          },
          { ...continuationPayload, dispatchInvocationId: yield* id() },
        ];
        for (const payload of forgedPayloads) {
          const forged = yield* recordEvidence({ payload, principal: tenant.recorder, scope: tenant });
          expect(yield* refused(report(forged.source))).toBe(true);
        }

        // DUPLICATE: the same continuation reported again is the same request (Core's idempotency replays the commit).
        const again = yield* issue(report(recorded.source), 'privacy', communicationsProviderKey);
        const againCarrier = readVerifiedGatewayPrivacyDispatch(
          yield* scopeOf(yield* receive(again.token, 'privacy'), 'privacy'),
        );
        expect(againCarrier?.requestHash).toBe(carrier?.requestHash);
        // REPLAY: the very same assertion is redeemed once only
        expect(Exit.isFailure(yield* Effect.exit(receive(admitted.token, 'privacy')))).toBe(true);

        // LIVENESS: the receiving gate re-proves the continuation claim and the original human every time.
        const controls = [
          sql`update core.outbox_deliveries set claimed_by='FICTIONAL-replacement' where outbox_delivery_id=${recorded.deliveryId}::uuid`,
          sql`update core.outbox_deliveries set claim_expires_at=now()-interval '1 second' where outbox_delivery_id=${recorded.deliveryId}::uuid`,
          sql`update core.outbox_deliveries set status='done' where outbox_delivery_id=${recorded.deliveryId}::uuid`,
          sql`update core.principals set status='disabled' where principal_id=${tenant.dispatcher.principalId}::uuid`,
        ];
        const restore = [
          sql`update core.outbox_deliveries set claimed_by=${recorded.claimId},claim_expires_at=now()+interval '30 seconds',status='processing' where outbox_delivery_id=${recorded.deliveryId}::uuid`,
          sql`update core.principals set status='active' where principal_id=${tenant.dispatcher.principalId}::uuid`,
        ];
        for (const control of controls) {
          yield* exec(control);
          expect((yield* decideReport()).outcome).not.toBe('ALLOWED');
          expect(yield* refused(report(recorded.source))).toBe(true);
          for (const statement of restore) {
            yield* exec(statement);
          }
        }
        expect((yield* decideReport()).outcome).toBe('ALLOWED');
        // the durable receipt carrier reads exactly the receipt: it cannot stand in for the outcome Action either
        const widened = yield* gate.decide({
          carrier: {
            accessActor: outcomeActor,
            accessDeclaration: outcomeDeclaration,
            entrypoint: outcomeEntrypoint,
            schemaVersion: '1',
          },
          legalEntityScope: 'required',
          now: yield* DateTime.nowAsDate,
          scope: receiptScope,
        });
        expect(widened.outcome).not.toBe('ALLOWED');
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  180_000,
);
