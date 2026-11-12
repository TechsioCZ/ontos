import {
  AccessDeclarationSchema,
  AccessWorkloadSchema,
  ActiveApplicationCompositionService,
  GatewayAssertionRedemptionUnavailableError,
  GatewayAssertionReplayError,
  GatewayScopeGrantRegistrar,
  ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY,
  ONTOS_SHELL_CONTRIBUTION_ABI,
  OperationalScopeResolver,
  PrincipalResolver,
  SystemPrincipalContextResolver,
  SystemPrincipalContextResolverLive,
  TenantModuleStateService,
  defineTenantModuleEntrypoint,
  makeOperationalScopeRepository,
  makeOperationalScopeResolver,
  makePrincipalResolver,
  makeTenantModuleStateService,
  registerSystemWorkload,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import type { GatewayAssertionRedemptionInput } from '@app/core-runtime';
import {
  AccessDecisionGate,
  makeAccessDecisionService,
  makeDrizzleAccessPrincipalKinds,
  makeDrizzleAccessWorkloadBindings,
} from '@app/core-runtime/access/enforcement';
import { CoreDatabase, makeCoreDatabase } from '@app/core-runtime/db/client';
import { makeTestOperationalScopeAccess } from '@app/core-runtime/testing/access-gate';
import { makeGatewayScopeGrantRegistrar } from '@app/core-runtime/testing/gateway-scope-grant';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { bindGatewayPrincipalVerifier } from '@app/gateway-principal-verifier/server';
import { GatewayDelegatedContextRequestSchema } from '@app/shared-contracts';
import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { ConfigProvider, Crypto, DateTime, Effect, Exit, Layer, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair } from 'jose';

import { AuthDatabase, makeAuthDatabase } from '../../api/auth/db/client.ts';
import {
  GatewayDelegationExchangeLedger,
  makeGatewayDelegationExchangeLedger,
} from '../../api/auth/gateway-delegation-exchanges.service.ts';
import { issueDelegatedGatewayContextAssertion } from '../../api/auth/gateway-delegation-issuer.ts';
import type { GatewayRegisteredWorkloadRule } from '../../api/auth/gateway-delegation-policy.ts';
import { GatewayDelegationVerificationLive } from '../../api/auth/gateway-delegation-verification.ts';
import { makeGatewayIssuerLayer } from '../../api/auth/gateway-issuer.ts';
import { parseGatewayIssuerConfig } from '../../api/auth/gateway-issuer-config.ts';
import { GatewayOriginatorEvidenceLive } from '../../api/auth/gateway-originator-evidence.service.ts';
import {
  ShellInstalledModuleCatalog,
  makeInstalledModuleCatalogLoader,
} from '../../api/modules/installed-module-catalog.ts';
import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';

/*
 * C17 (#1146) L-DELEGATION-PROBE. A payment.core worker submits provider evidence to the public Payment A8
 * `accept-payment-observation` through the Shell gateway as a RegisteredWorkload. Source and destination are the
 * same module (`payment`). The Payment contract below mirrors the W0-SCAFFOLD manifest
 * (`verticals/payment/vertical.manifest.ts`): originatorActions, the two conditional `requirements.operations`
 * entries, the A8/A10/capture descriptors and the worker subscriptions. It adds the one binding the probe found
 * missing: A8 published as a public operation contract (`accept-payment-observation-action`), without which the
 * worker-side lease check `readWorkerModuleOperationRequirement` cannot resolve the self provider.
 */
const paymentApp = 'payment';
const paymentModule = 'payment.core';
const paymentBuild = `${paymentApp}-build`;
const shellProviderKey = 'payment-module-credential';
const authenticationNamespaceId = 'test.staff.better-auth.v1';

const a8Key = 'payment.core.accept-payment-observation';
const a8Declaration = 'payment.core.observation.accept';
const a10Key = 'payment.core.request-payment-operation-recovery';
const captureKey = 'payment.core.capture-provider-notification';
const notifyWorker = 'payment.core.process-provider-notification';
const recoverWorker = 'payment.core.recover-gateway-operation';
const notifyTopic = 'payment.core.provider-notification-captured.v1';
const recoveryTopic = 'payment.core.operation-recovery-requested.v1';
const notifyRequirement = 'payment.core.requirement.gateway-evidence-notification';
const recoveryRequirement = 'payment.core.requirement.gateway-evidence-recovery';
const sourceIngress = 'payment.source-ingress';
const notificationIngress = 'payment.provider-notification-ingress';
const reconciliation = 'payment.provider-reconciliation';
const a8ApiKey = 'payment.core.accept-payment-observation-action';
const a8OperationKey = 'acceptPaymentObservationAction.execute';

const actionEntrypoint = (entrypointKey: string) =>
  defineTenantModuleEntrypoint({
    access: 'write',
    authorization: { kind: 'protected' },
    entrypointKey,
    moduleKey: paymentModule,
    role: 'action',
  });
const workerEntrypoint = (entrypointKey: string) =>
  defineTenantModuleEntrypoint({
    access: 'background',
    authorization: { kind: 'owner_local_background' },
    entrypointKey,
    moduleKey: paymentModule,
    role: 'worker',
  });
const a8AccessDeclaration = Schema.decodeUnknownSync(AccessDeclarationSchema)({
  key: a8Declaration,
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  placement: { group: 'payments', level: 'extended' },
  risk: 'sensitive',
  selectors: [],
});
const a8AccessWorkload = Schema.decodeUnknownSync(AccessWorkloadSchema)({
  reason: 'Configured integrations submit source statements without a human session',
  workloads: [sourceIngress],
});
const a8Provider = { entrypointKey: a8Key, moduleId: paymentModule, schemaVersion: '1' } as const;

interface PaymentActionCarriers {
  readonly accessDeclaration?: typeof AccessDeclarationSchema.Encoded;
  readonly accessWorkload: typeof AccessWorkloadSchema.Encoded;
}
const actionContract = (actionKey: string, carriers: PaymentActionCarriers) => ({
  ...carriers,
  actionKey,
  auditProfile: 'standard',
  entrypoint: actionEntrypoint(actionKey),
  idempotency: 'required',
  legalEntityScope: 'required',
  owningModuleId: paymentModule,
  schemaVersion: '1',
});

const paymentContract = (options: { readonly a8Operation: boolean; readonly selfIntrinsic?: boolean }) => {
  const base = makeModuleContractFixture({
    appId: paymentApp,
    moduleId: paymentModule,
    originatorActions: [captureKey, a10Key],
    outboxSubscriptions: [
      [notifyWorker, notifyTopic],
      [recoverWorker, recoveryTopic],
    ].map(([workerKey = '', topic = '']) => ({
      consumerModuleKey: paymentModule,
      entrypoint: workerEntrypoint(workerKey),
      producerModuleKey: paymentModule,
      topic,
      workerKey,
    })),
    supportedStates: ['inactive', 'active', 'read_only', 'suspended', 'quarantined', 'deprecated', 'archived'],
  });
  return {
    ...base,
    manifest: {
      ...base.manifest,
      publicSurface: {
        ...base.manifest.publicSurface,
        actions: [
          actionContract(a8Key, { accessDeclaration: a8AccessDeclaration, accessWorkload: a8AccessWorkload }),
          actionContract(captureKey, {
            accessWorkload: { reason: 'Provider notification relay', workloads: [notificationIngress] },
          }),
          actionContract(a10Key, {
            accessDeclaration: {
              key: 'payment.core.operation-recovery.request',
              kind: 'action',
              modes: ['run', 'propose', 'approve'],
              placement: { group: 'payments', level: 'extended' },
              risk: 'sensitive',
              selectors: [],
            },
            accessWorkload: { reason: 'Provider reconciliation driver', workloads: [reconciliation] },
          }),
        ],
        api: options.a8Operation ? [{ key: a8ApiKey, operationKeys: [a8OperationKey] }] : [],
        operationContracts: options.a8Operation
          ? [
              {
                apiKey: a8ApiKey,
                entrypoint: actionEntrypoint(a8Key),
                operationKey: a8OperationKey,
                schemaVersion: '1',
              },
            ]
          : [],
      },
      requirements: {
        coreCapabilities: [ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY],
        intrinsic:
          options.selfIntrinsic === true ? [{ moduleId: paymentModule, requiredOperations: [a8Provider] }] : [],
        operations: [
          {
            condition: 'payment.core.condition.gateway-evidence-notification',
            entrypointKey: notifyWorker,
            evidence: ['payment.core.evidence.gateway-provider-notification'],
            key: notifyRequirement,
            provider: a8Provider,
          },
          {
            condition: 'payment.core.condition.gateway-evidence-recovery',
            entrypointKey: recoverWorker,
            evidence: ['payment.core.evidence.gateway-provider-recovery'],
            key: recoveryRequirement,
            provider: a8Provider,
          },
        ],
        schemaVersion: '1',
      },
    },
  };
};

/** The exact issuer rules (ONTOS_GATEWAY_MODULE_BINDINGS `registeredWorkloads`) the Payment credential needs. */
const paymentRegisteredWorkloads: readonly GatewayRegisteredWorkloadRule[] = [notifyWorker, recoverWorker].map(
  (workerKey) => ({
    audience: paymentApp,
    declarationKey: a8Declaration,
    entrypointKey: a8Key,
    jobKey: workerKey,
    legalEntityScope: 'required',
    schemaVersion: '1',
    workerKey,
    workloadKey: sourceIngress,
  }),
);

const replaceIdentity = (connectionString: string, role: string) => {
  const url = new URL(connectionString);
  url.username = role;
  url.password = role;
  return url.href;
};
/** The worker-side lease check: the provider must publish A8 schema 1 as an operation contract. */
const providesA8 = (operations: readonly { entrypoint: { entrypointKey: string }; schemaVersion: string }[]) =>
  operations.some(
    ({ entrypoint, schemaVersion }) =>
      entrypoint.entrypointKey === a8Provider.entrypointKey && schemaVersion === a8Provider.schemaVersion,
  );
const unavailableHumanPort = () => Effect.die('A workload decision must not ask human intent or the tuple engine');

it.live('admits payment-to-payment RegisteredWorkload calls into A8 only for workload-admitted originals', () =>
  Effect.scoped(
    Effect.gen(function* paymentSelfRegisteredWorkloadProbe() {
      const crypto = yield* Crypto.Crypto;
      const shellDeployment = { appId: 'shell-super-app', buildMarker: ultramodernDeliveryUnit.buildMarker } as const;
      const shellRuntime = {
        document: JSON.stringify({
          contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
          coreCapabilities: [ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY],
          deployment: shellDeployment,
          schemaVersion: '2',
        }),
        receiverDeployment: shellDeployment,
      };
      const snapshot = yield* makeCompositionSnapshot([paymentContract({ a8Operation: true })], 600_000, shellRuntime);

      // (d) Composition cycle checks accept the self-conditional branch. The full snapshot validation runs the
      // acyclic dependency check; conditional requirements never become composition dependencies.
      const validated = yield* validateActiveApplicationCompositionSnapshot(snapshot);
      expect(validated.composition.modules.map((module) => [module.moduleId, module.dependencies])).toEqual([
        [paymentModule, []],
      ]);
      // A self intrinsic requirement is still refused by the contract checks (control for the branch above).
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            makeCompositionSnapshot(
              [paymentContract({ a8Operation: true, selfIntrinsic: true })],
              600_000,
              shellRuntime,
            ),
          ),
        ),
      ).toBe(true);

      const fixture = yield* makeIsolatedNativeDatabaseFixture({
        compositionSnapshot: snapshot,
        mode: 'schema-only',
        purpose: 'implementation-1096-registered-workload-gateway',
      });
      const admin = yield* makeCoreDatabase(fixture.connections.admin);
      const runtime = yield* makeCoreDatabase(fixture.connections.runtime);
      const reactivity = yield* Reactivity.make;
      const issuerClient = yield* PgClient.make({
        url: Redacted.make(replaceIdentity(fixture.connections.runtime.connectionString, 'shell_gateway_issuer')),
      }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity));
      const installed = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));

      // Worker-side lease precondition (`resolveExecutingRequirement` -> `providesRequiredOperationContracts`): the
      // provider's published operation contracts must carry A8 schema 1. Payment's derived contract lacks it today.
      const installedPayment = installed.contracts.find((contract) => contract.deployment.appId === paymentApp);
      expect(providesA8(installedPayment?.manifest.publicSurface.operationContracts ?? [])).toBe(true);
      expect(providesA8(paymentContract({ a8Operation: false }).manifest.publicSurface.operationContracts)).toBe(false);

      const tenantId = yield* crypto.randomUUIDv4();
      const legalEntityId = yield* crypto.randomUUIDv4();
      const notificationPrincipal = yield* crypto.randomUUIDv4();
      const reconciliationPrincipal = yield* crypto.randomUUIDv4();
      const humanPrincipal = yield* crypto.randomUUIDv4();
      const receiverPrincipal = yield* crypto.randomUUIDv4();
      const modulePrincipal = yield* crypto.randomUUIDv4();
      const receiverIncarnation = yield* crypto.randomUUIDv4();
      const insert = (statement: Parameters<typeof admin.executor.execute>[0]) =>
        admin.executor.execute(statement, 'objects');
      const bind = (principalId: string, workloadKey: string, incarnation?: string) =>
        Effect.gen(function* bindWorkload() {
          const bindingId = yield* crypto.randomUUIDv4();
          yield* insert(
            sql`insert into core.access_workload_bindings(binding_id,tenant_id,principal_id,workload_key,incarnation,status) values(${bindingId}::uuid,${tenantId}::uuid,${principalId}::uuid,${workloadKey},${incarnation ?? (yield* crypto.randomUUIDv4())}::uuid,'active')`,
          );
          return bindingId;
        });
      const revoke = (bindingId: string) =>
        insert(
          sql`update core.access_workload_bindings set status='revoked',revoked_at=now() where binding_id=${bindingId}::uuid`,
        );
      yield* insert(
        sql`insert into core.tenants(tenant_id,slug,name,status,default_locale) values(${tenantId}::uuid,${tenantId},'Payment probe','active','en')`,
      );
      yield* insert(
        sql`insert into core.legal_entities(legal_entity_id,tenant_id,legal_name,registration_country,registration_number,status) values(${legalEntityId}::uuid,${tenantId}::uuid,'Probe company','CZ','1','active')`,
      );
      yield* insert(
        sql`insert into core.principals(principal_id,tenant_id,kind,display_name,status) values
          (${notificationPrincipal}::uuid,${tenantId}::uuid,'integration','Provider notification relay','active'),
          (${reconciliationPrincipal}::uuid,${tenantId}::uuid,'integration','Provider reconciliation driver','active'),
          (${humanPrincipal}::uuid,${tenantId}::uuid,'human','Operator','active'),
          (${receiverPrincipal}::uuid,${tenantId}::uuid,'system','Payment evidence receiver','active'),
          (${modulePrincipal}::uuid,${tenantId}::uuid,'service','Payment deployment','active')`,
      );
      yield* insert(
        sql`insert into core.principal_auth_bindings(tenant_id,principal_id,authentication_namespace_id,provider,subject_type,provider_subject_id,status) values(${tenantId}::uuid,${modulePrincipal}::uuid,${authenticationNamespaceId},'better_auth','api_key',${shellProviderKey},'active')`,
      );
      // Required bindings: each original integration principal holds its source workload plus payment.source-ingress;
      // exactly one receiving system principal holds payment.source-ingress.
      yield* bind(notificationPrincipal, notificationIngress);
      const notificationSourceIngress = yield* bind(notificationPrincipal, sourceIngress);
      yield* bind(reconciliationPrincipal, reconciliation);
      yield* bind(reconciliationPrincipal, sourceIngress);
      yield* bind(receiverPrincipal, sourceIngress, receiverIncarnation);
      yield* insert(
        sql`insert into core.tenant_module_states(tenant_id,module_key,state) values(${tenantId}::uuid,${paymentModule},'active')`,
      );
      yield* insert(
        sql`create table public.registered_gateway_redemptions (issuer text not null, audience text not null, jti uuid not null, primary key(issuer,audience,jti))`,
      );
      yield* insert(sql`grant insert,select on public.registered_gateway_redemptions to ontos_runtime`);

      /** One succeeded original Action invocation, its domain event, outbox message and a live claimed delivery. */
      const deliver = (input: {
        readonly actionKey: string;
        readonly authMethod: 'api_key' | 'session';
        readonly principalId: string;
        readonly topic: string;
        readonly workerKey: string;
      }) =>
        Effect.gen(function* deliverOriginal() {
          const invocationId = yield* crypto.randomUUIDv4();
          const eventId = yield* crypto.randomUUIDv4();
          const messageId = yield* crypto.randomUUIDv4();
          const deliveryId = yield* crypto.randomUUIDv4();
          const claimId = `claim-${deliveryId}`;
          const resourceId = yield* crypto.randomUUIDv4();
          yield* insert(
            sql`insert into core.action_invocations(action_invocation_id,tenant_id,legal_entity_id,principal_id,auth_method,action_key,status,request_hash,started_at,completed_at) values(${invocationId}::uuid,${tenantId}::uuid,${legalEntityId}::uuid,${input.principalId}::uuid,${input.authMethod},${input.actionKey},'succeeded',${'a'.repeat(64)},now(),now())`,
          );
          yield* insert(
            sql`insert into core.domain_events(domain_event_id,tenant_id,legal_entity_id,action_invocation_id,producer_module_key,event_type,subject_module_key,subject_resource_type,subject_resource_id,payload_json) values(${eventId}::uuid,${tenantId}::uuid,${legalEntityId}::uuid,${invocationId}::uuid,${paymentModule},${input.topic},${paymentModule},'payment.core.payment',${resourceId},'{}'::jsonb)`,
          );
          yield* insert(
            sql`insert into core.outbox_messages(outbox_message_id,tenant_id,domain_event_id,producer_module_key,topic,payload_json) values(${messageId}::uuid,${tenantId}::uuid,${eventId}::uuid,${paymentModule},${input.topic},'{}'::jsonb)`,
          );
          yield* insert(
            sql`insert into core.outbox_deliveries(outbox_delivery_id,outbox_message_id,worker_key,consumer_module_key,status,claimed_by,claimed_at,claim_expires_at) values(${deliveryId}::uuid,${messageId}::uuid,${input.workerKey},${paymentModule},'processing',${claimId},now(),now()+interval '5 minutes')`,
          );
          return { claimId, deliveryId };
        });

      const auth = yield* makeAuthDatabase({ connectionString: fixture.connections.runtime.connectionString });
      const scopeResolver = yield* makeOperationalScopeResolver(
        makeOperationalScopeRepository(runtime),
        makeTestOperationalScopeAccess({ decision: 'denied' }),
      );
      const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519', { extractable: true }));
      const privateJwk = yield* Effect.promise(() => exportJWK(privateKey));
      const publicJwk = yield* Effect.promise(() => exportJWK(publicKey));
      const issuer = 'https://payment-probe-shell.example';
      const jwks = JSON.stringify({ keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'payment-probe', use: 'sig' }] });
      const signing = yield* parseGatewayIssuerConfig({
        ONTOS_GATEWAY_ISSUER: issuer,
        ONTOS_GATEWAY_PRIVATE_JWK: JSON.stringify({ ...privateJwk, alg: 'EdDSA', kid: 'payment-probe', use: 'sig' }),
      });
      const paymentBinding = {
        compositionRevision: snapshot.composition.revision,
        providerKeyId: shellProviderKey,
        registeredWorkloads: paymentRegisteredWorkloads,
        sourceAppId: paymentApp,
        sourceBuildMarker: paymentBuild,
      };
      const configuration = ConfigProvider.fromUnknown({
        ONTOS_GATEWAY_ISSUER: issuer,
        ONTOS_GATEWAY_MODULE_BINDINGS: JSON.stringify([paymentBinding]),
        ONTOS_GATEWAY_PUBLIC_JWKS: jwks,
      });
      const signer = makeGatewayIssuerLayer({
        currentTimeSeconds: Effect.succeed(Math.floor(DateTime.toEpochMillis(snapshot.observedAt) / 1000)),
        generateJti: crypto.randomUUIDv4().pipe(Effect.orDie),
        loadAdmission: Effect.succeed({
          audiences: new Map([[paymentApp, paymentBuild]]),
          revision: snapshot.composition.revision,
        }),
        loadConfig: Effect.succeed(signing),
      }).pipe(Layer.provide(Layer.succeed(GatewayScopeGrantRegistrar, makeGatewayScopeGrantRegistrar(issuerClient))));
      const gate = makeAccessDecisionService({
        authorityFor: () => ({
          readCells: unavailableHumanPort,
          readConnection: unavailableHumanPort,
          readScope: unavailableHumanPort,
          readTeamIds: unavailableHumanPort,
        }),
        check: { checkBulk: unavailableHumanPort },
        decisionLog: { record: unavailableHumanPort },
        legalEntities: { listCandidateIds: unavailableHumanPort },
        principalKinds: makeDrizzleAccessPrincipalKinds(runtime),
        workloadBindings: makeDrizzleAccessWorkloadBindings(runtime),
      });
      const services = Layer.mergeAll(
        Layer.succeed(CoreDatabase, runtime),
        Layer.succeed(AccessDecisionGate, gate),
        Layer.succeed(AuthDatabase, auth),
        Layer.succeed(PrincipalResolver, makePrincipalResolver(runtime, { authenticationNamespaceId })),
        Layer.succeed(TenantModuleStateService, makeTenantModuleStateService(runtime)),
        Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
        Layer.succeed(GatewayDelegationExchangeLedger, makeGatewayDelegationExchangeLedger(auth.executor)),
        Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
      );
      const issue = (subject: (typeof GatewayDelegatedContextRequestSchema.Encoded)['subject']) =>
        Effect.gen(function* issueProbe() {
          const payload = yield* Schema.decodeUnknownEffect(GatewayDelegatedContextRequestSchema)({
            audience: paymentApp,
            compositionRevision: snapshot.composition.revision,
            exchangeId: yield* crypto.randomUUIDv4(),
            legalEntityScope: 'subject',
            subject,
          });
          return yield* issueDelegatedGatewayContextAssertion({
            payload,
            requestCorrelation: 'payment-self-probe',
            verifiedProviderKeyId: shellProviderKey,
          });
        }).pipe(
          Effect.provide(signer),
          Effect.provide(GatewayDelegationVerificationLive),
          Effect.provide(GatewayOriginatorEvidenceLive),
          Effect.provideService(OperationalScopeResolver, scopeResolver),
          Effect.provide(services),
          Effect.provideService(ConfigProvider.ConfigProvider, configuration),
        );
      const workerSubject = (
        delivery: { readonly claimId: string; readonly deliveryId: string },
        workerKey: string,
        operationRequirementKey: string,
      ) => ({
        _tag: 'RegisteredWorkload' as const,
        claimId: delivery.claimId,
        declarationKey: a8Declaration,
        deliveryId: delivery.deliveryId,
        expectedPrincipalId: receiverPrincipal,
        legalEntityId,
        operationRequirementKey,
        tenantId,
        workerKey,
      });
      const deniedIssue = (subject: Parameters<typeof issue>[0]) =>
        Effect.exit(issue(subject)).pipe(Effect.map(Exit.isFailure));

      // The receiving Payment API: verify and redeem the assertion, resolve its scope, decide A8 with the native gate.
      const verifier = bindGatewayPrincipalVerifier(paymentApp, { appId: paymentApp, buildMarker: paymentBuild });
      const redemption = {
        consume: Effect.fn('PaymentProbe.redeem')(function* redeem(input: GatewayAssertionRedemptionInput) {
          const rows = yield* runtime.executor
            .execute(
              sql`insert into public.registered_gateway_redemptions(issuer,audience,jti) values(${input.issuer},${input.audience},${input.jti}::uuid) on conflict do nothing returning jti`,
              'objects',
            )
            .pipe(
              Effect.mapError(
                () => new GatewayAssertionRedemptionUnavailableError({ reason: 'Probe redemption is unavailable' }),
              ),
            );
          if (rows.length !== 1) {
            return yield* new GatewayAssertionReplayError({ reason: 'Probe assertion already redeemed' });
          }
          return yield* Effect.void;
        }),
      };
      const admitA8 = (token: string) =>
        Effect.gen(function* admitAtReceiver() {
          const verified = yield* verifier
            .verifyAndRedeem(Redacted.make(`Bearer ${token}`), {
              environment: { ONTOS_GATEWAY_ISSUER: issuer, ONTOS_GATEWAY_PUBLIC_JWKS: jwks },
              redemption,
            })
            .pipe(Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }));
          const scope = yield* scopeResolver.resolve({
            audience: paymentApp,
            correlationId: 'payment-self-probe',
            legalEntityScope: 'required',
            principal: verified,
          });
          expect(scope.legalEntityId).toBe(legalEntityId);
          const decision = yield* gate.decide({
            carrier: {
              accessDeclaration: a8AccessDeclaration,
              accessWorkload: a8AccessWorkload,
              entrypoint: actionEntrypoint(a8Key),
              schemaVersion: '1',
            },
            legalEntityScope: 'required',
            now: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
            scope,
          });
          return decision.outcome;
        });

      // (a) capture-provider-notification origin -> process-provider-notification -> A8: admitted.
      const captured = yield* deliver({
        actionKey: captureKey,
        authMethod: 'api_key',
        principalId: notificationPrincipal,
        topic: notifyTopic,
        workerKey: notifyWorker,
      });
      const notified = yield* issue(workerSubject(captured, notifyWorker, notifyRequirement));
      expect(notified.machineContext).toEqual({
        authContextRef: `job:${notifyWorker}:run:${captured.deliveryId}`,
        bindingIncarnation: receiverIncarnation,
        principalId: receiverPrincipal,
      });
      expect(yield* admitA8(notified.token)).toBe('ALLOWED');
      // The worker's branch is exact: the recovery requirement does not cover the notification worker.
      expect(yield* deniedIssue(workerSubject(captured, notifyWorker, recoveryRequirement))).toBe(true);
      // The original integration principal must also hold payment.source-ingress.
      yield* revoke(notificationSourceIngress);
      expect(yield* deniedIssue(workerSubject(captured, notifyWorker, notifyRequirement))).toBe(true);
      yield* bind(notificationPrincipal, sourceIngress);
      yield* issue(workerSubject(captured, notifyWorker, notifyRequirement));

      // (b) A10 workload origin (reconciliation driver) -> recover-gateway-operation -> A8: admitted.
      const workloadRecovery = yield* deliver({
        actionKey: a10Key,
        authMethod: 'api_key',
        principalId: reconciliationPrincipal,
        topic: recoveryTopic,
        workerKey: recoverWorker,
      });
      const recovered = yield* issue(workerSubject(workloadRecovery, recoverWorker, recoveryRequirement));
      expect(recovered.machineContext?.principalId).toBe(receiverPrincipal);
      expect(yield* admitA8(recovered.token)).toBe('ALLOWED');

      // (c) A10 human origin -> recover-gateway-operation -> A8: denied.
      const humanRecovery = yield* deliver({
        actionKey: a10Key,
        authMethod: 'session',
        principalId: humanPrincipal,
        topic: recoveryTopic,
        workerKey: recoverWorker,
      });
      expect(yield* deniedIssue(workerSubject(humanRecovery, recoverWorker, recoveryRequirement))).toBe(true);
      // Granting the human the source workload does not change that: only integration originals qualify.
      yield* bind(humanPrincipal, sourceIngress);
      expect(yield* deniedIssue(workerSubject(humanRecovery, recoverWorker, recoveryRequirement))).toBe(true);

      // The payment worker host can resolve the receiving system principal (`SystemPrincipalContextResolverLive`
      // keyed by the workload `payment.source-ingress`) as the Core runtime role.
      const resolved = yield* Effect.gen(function* resolveReceiver() {
        const resolver = yield* SystemPrincipalContextResolver;
        return yield* resolver.resolveEnrolled({
          registration: registerSystemWorkload({ jobKey: sourceIngress }),
          runReference: captured.deliveryId,
          tenantId,
        });
      }).pipe(Effect.provide(SystemPrincipalContextResolverLive), Effect.provideService(CoreDatabase, runtime));
      expect(resolved.principalId).toBe(receiverPrincipal);
      // A second receiving system principal makes the receiver ambiguous: issuance fails closed.
      const secondReceiver = yield* crypto.randomUUIDv4();
      yield* insert(
        sql`insert into core.principals(principal_id,tenant_id,kind,display_name,status) values(${secondReceiver}::uuid,${tenantId}::uuid,'system','Second receiver','active')`,
      );
      yield* bind(secondReceiver, sourceIngress);
      expect(yield* deniedIssue(workerSubject(workloadRecovery, recoverWorker, recoveryRequirement))).toBe(true);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
