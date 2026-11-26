import { GatewayNativeEvidence } from '../../api/auth/gateway-native-evidence.ts';
import { GatewayNativeEvidenceLive } from '../../api/auth/gateway-native-evidence.service.ts';
import { buildApplicationCompositionCatalog, defineTenantModuleEntrypoint } from '@app/core-runtime';
import { internalWorkloadPrincipalId } from '@app/core-runtime/auth/module-credentials';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { CoreDatabase, testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { GatewayRegisteredWorkloadSubjectSchema } from '@app/shared-contracts';
import { Effect, Layer, Result, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { GatewayModuleBindingSchema } from '../../api/auth/gateway-delegation-policy.ts';
import { admitRegisteredGatewayWorkload } from '../../api/auth/gateway-workload-evidence.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '10000000-0000-4000-8000-000000000002';
const legacyId = '10000000-0000-4000-8000-000000000003';
const incarnation = '10000000-0000-4000-8000-000000000004';
const receiverIncarnation = '10000000-0000-4000-8000-000000000006';
const invocationId = '10000000-0000-4000-8000-000000000005';
const workerKey = 'integration.symmy.execute-symmy-job';
const actionKey = 'integration.symmy.admit-symmy-job';
const run = Effect.fn('SourceWriterEvidenceTest.run')(function* run(input: {
  claim?: boolean;
  company?: boolean;
  expectedPrincipalId?: string;
  originalCompany?: string;
  receiverOperation?: 'ambiguous' | 'mismatched';
  service?: boolean;
  systems?: number;
  workloadKey: string;
}) {
  const receiverModule =
    input.workloadKey === 'commerce.customer-context.source-write' ? 'commerce.customer-context' : 'party.registry';
  const receiverApp = receiverModule === 'party.registry' ? 'party-registry' : 'commerce-customer-context';
  const entrypointKey = `${receiverModule}.api.source-write`;
  const declarationKey = `${receiverModule}.source-write`;
  const source = makeModuleContractFixture({
    appId: 'symmy-integration',
    moduleId: 'integration.symmy',
    originatorActions: [actionKey],
  });
  const receiver = makeModuleContractFixture({ appId: receiverApp, moduleId: receiverModule });
  const snapshot = yield* makeCompositionSnapshot([
    {
      ...source,
      manifest: {
        ...source.manifest,
        publicSurface: {
          ...source.manifest.publicSurface,
          actions: [
            {
              accessWorkload: { reason: 'Exact integration admission', workloads: ['integration.symmy-admit'] },
              actionKey,
              auditProfile: 'standard',
              entrypoint: defineTenantModuleEntrypoint({
                access: 'write',
                authorization: { kind: 'protected' },
                entrypointKey: actionKey,
                moduleKey: 'integration.symmy',
                role: 'action',
              }),
              idempotency: 'required',
              legalEntityScope: 'optional',
              owningModuleId: 'integration.symmy',
              schemaVersion: '1',
            },
          ],
        },
        requirements: {
          coreCapabilities: [],
          intrinsic: [{ moduleId: receiverModule, requiredOperations: [{ entrypointKey, schemaVersion: '1' }] }],
          operations: [],
          schemaVersion: '1',
        },
      },
    },
    {
      ...receiver,
      manifest: {
        ...receiver.manifest,
        executorEnrollments:
          input.workloadKey === declarationKey
            ? [{ uses: ['admission', 'assertion', 'recovery'], workloadKey: input.workloadKey }]
            : [],
        publicSurface: {
          ...receiver.manifest.publicSurface,
          api: [{ key: `${receiverModule}.api.source`, operationKeys: ['write.execute'] }],
          operationContracts: [
            {
              apiKey: `${receiverModule}.api.source`,
              entrypoint: defineTenantModuleEntrypoint({
                access: 'read',
                authorization: { kind: 'protected' },
                entrypointKey,
                moduleKey: receiverModule,
                role: 'api',
              }),
              operationKey: 'write.execute',
              schemaVersion: '1',
              workloadCarrier: { declarationKey, workloads: [input.workloadKey] },
            },
          ],
        },
      },
    },
  ]);
  const catalog = yield* buildApplicationCompositionCatalog(snapshot.composition);
  const binding = Schema.decodeUnknownSync(GatewayModuleBindingSchema)({
    compositionRevision: snapshot.composition.revision,
    providerKeyId: 'symmy-test-key',
    registeredWorkloads: [
      {
        audience: receiverApp,
        declarationKey,
        entrypointKey,
        jobKey: workerKey,
        legalEntityScope: 'optional',
        schemaVersion: '1',
        workerKey,
        workloadKey: input.workloadKey,
      },
    ],
    sourceAppId: 'symmy-integration',
    sourceBuildMarker: 'symmy-integration-build',
  });
  const subjectInput = {
    _tag: 'RegisteredWorkload',
    claimId: 'claim-source-writer',
    declarationKey,
    deliveryId: invocationId,
    tenantId,
    workerKey,
  };
  if (input.company !== false) {
    Object.assign(subjectInput, { legalEntityId });
  }
  if (input.expectedPrincipalId !== undefined) {
    Object.assign(subjectInput, { expectedPrincipalId: input.expectedPrincipalId });
  }
  const subject = Schema.decodeUnknownSync(GatewayRegisteredWorkloadSubjectSchema)(subjectInput);
  const principalId = internalWorkloadPrincipalId({ legalEntityId, tenantId, workloadKey: input.workloadKey });
  const queries: { params: readonly unknown[]; sql: string }[] = [];
  const database = Layer.effect(CoreDatabase, testCoreDatabase.pipe(Effect.map((executor) => ({ executor })))).pipe(
    Layer.provide(
      scriptedPgClientLayer(
        Effect.succeed(
          testSqlConnection((sql, params) => {
            queries.push({ params, sql });
            if (sql.includes('core.outbox_deliveries')) {
              return Effect.succeed(
                input.claim === false
                  ? []
                  : [
                      {
                        actionInvocationId: invocationId,
                        consumerModuleKey: 'integration.symmy',
                        producerModuleKey: 'integration.symmy',
                        topic: 'integration.symmy.job-admitted',
                        workerKey,
                      },
                    ],
              );
            }
            if (sql.includes('core.action_invocations')) {
              return Effect.succeed([
                {
                  actionKey,
                  bindingIncarnation: incarnation,
                  legalEntityId: input.originalCompany ?? (input.company === false ? null : legalEntityId),
                  ownerBindingIncarnation: receiverIncarnation,
                  principalId: legacyId,
                  workloadKey: 'integration.symmy-admit',
                },
              ]);
            }
            if (sql.includes('core.access_workload_bindings')) {
              return Effect.succeed(
                sql.includes("p.kind = 'service'")
                  ? Array.from({ length: input.service === false ? 0 : 1 }, () => ({
                      actionInvocationId: invocationId,
                      bindingIncarnation: receiverIncarnation,
                      principalId,
                    }))
                  : Array.from({ length: input.systems ?? 0 }, () => ({
                      actionInvocationId: invocationId,
                      bindingIncarnation: receiverIncarnation,
                      principalId: legacyId,
                    })),
              );
            }
            if (sql.includes('from core.legal_entities')) {
              return Effect.succeed([{ legal_entity_id: legalEntityId }]);
            }
            return Effect.succeed([]);
          }),
        ),
      ).pipe(Layer.provide(Reactivity.layer)),
    ),
  );
  const admit = Effect.gen(function* admitFromCatalog() {
    if (input.receiverOperation === undefined) {
      return yield* admitRegisteredGatewayWorkload({
        audience: receiverApp,
        binding,
        installed: { ...catalog, composition: snapshot.composition },
        subject,
      });
    }
    const destination = catalog.contracts.find((contract) => contract.deployment.appId === receiverApp);
    const sourceContract = catalog.contracts.find((contract) => contract.deployment.appId === binding.sourceAppId);
    const rule = binding.registeredWorkloads?.[0];
    const operation = destination?.manifest.publicSurface.operationContracts?.[0];
    if (destination === undefined || sourceContract === undefined || rule === undefined || operation === undefined) {
      return yield* Effect.die('Expected exact contracts for the source and receiver');
    }
    return yield* (yield* GatewayNativeEvidence).admitWorkload({
      binding,
      destination:
        input.receiverOperation === 'ambiguous'
          ? {
              ...destination,
              manifest: {
                ...destination.manifest,
                publicSurface: { ...destination.manifest.publicSurface, operationContracts: [operation, operation] },
              },
            }
          : destination,
      rule: input.receiverOperation === 'mismatched' ? { ...rule, schemaVersion: '2' } : rule,
      source: sourceContract,
      subject,
    });
  });
  const result = yield* admit.pipe(
    Effect.provide(GatewayNativeEvidenceLive.pipe(Layer.provide(database))),
    Effect.result,
  );
  return { principalId, queries, result };
});

it.effect('executes durable worker admission for both canonical company source SERVICE writers', () =>
  Effect.gen(function* canonicalSourceWriter() {
    for (const workloadKey of ['party.registry.source-write', 'commerce.customer-context.source-write']) {
      const { principalId, queries, result } = yield* run({ workloadKey });
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isSuccess(result)) {
        expect(result.success.principal.principalId).toBe(principalId);
        expect(result.success.workload).toMatchObject({
          bindingIncarnation: receiverIncarnation,
          claimId: 'claim-source-writer',
          legalEntityId,
          originalOwnerBindingIncarnation: receiverIncarnation,
          originalPrincipalId: legacyId,
          originalWorkloadBindingIncarnation: incarnation,
        });
      }
      const service = queries.find((q) => q.sql.includes("p.kind = 'service'"));
      const original = queries.find((q) => q.sql.includes('core.action_invocations'));
      const originalSql = original?.sql;
      const originalParameters = original?.params;
      expect(originalSql).not.toContain('ob.principal_id = p.principal_id');
      expect(originalSql).toContain('ob.principal_id = $');
      expect(originalSql).toContain('ob.incarnation = $');
      expect(originalParameters).toContain(principalId);
      expect(originalParameters).toContain(receiverIncarnation);
      expect(originalSql).toContain("p.kind = 'integration' and p.status = 'active'");
      expect(originalSql).toContain("i.status = 'succeeded'");
      expect(originalSql).toMatch(/b\.workload_key not in \(\$\d+, \$\d+\) or exists/u);
      expect(originalSql).toContain('original_payment_source.tenant_id=p.tenant_id');
      expect(originalSql).toContain('original_payment_source.principal_id=p.principal_id');
      expect(originalSql).toMatch(/original_payment_source.workload_key=\$\d+/u);
      expect(originalSql).toContain("original_payment_source.status='active'");
      expect(originalParameters).toEqual([
        principalId,
        receiverIncarnation,
        workloadKey,
        tenantId,
        invocationId,
        'payment.provider-notification-ingress',
        'payment.provider-reconciliation',
        'payment.source-ingress',
      ]);
      expect(service?.params).toContain(principalId);
      expect(service?.params).toContain(tenantId);
      expect(service?.params).toContain(legalEntityId);
      for (const fence of [
        "p.platform_role = 'internal_workload'",
        'cb.workload_binding_id = b.binding_id',
        "cb.status = 'active'",
        "le.status = 'active'",
        'le.tenant_id = cb.tenant_id',
      ]) {
        expect(service?.sql).toContain(fence);
      }
    }
  }),
);

it.effect('preserves SYSTEM precedence and refuses ambiguity, unrelated jobs, tenant-only and stale evidence', () =>
  Effect.gen(function* refusedSourceEvidence() {
    const legacy = yield* run({ systems: 1, workloadKey: 'party.registry.source-write' });
    expect(Result.isSuccess(legacy.result)).toBe(true);
    if (Result.isSuccess(legacy.result)) {
      expect(legacy.result.success.principal.principalId).toBe(legacyId);
    }
    expect(legacy.queries.some((q) => q.sql.includes("p.kind = 'service'"))).toBe(false);
    for (const input of [
      { systems: 2 },
      { company: false },
      { workloadKey: 'party.registry.source-read' },
      { claim: false },
      { expectedPrincipalId: legacyId },
      { originalCompany: legacyId },
      { service: false },
    ]) {
      const actual = yield* run({ workloadKey: 'party.registry.source-write', ...input });
      expect(Result.isFailure(actual.result)).toBe(true);
      if ('systems' in input || 'company' in input || 'workloadKey' in input || 'claim' in input) {
        expect(actual.queries.some((q) => q.sql.includes("p.kind = 'service'"))).toBe(false);
      }
    }
  }),
);

it.effect('refuses mismatched or ambiguous receiving operations even with an active SYSTEM', () =>
  Effect.gen(function* refuseInvalidReceiver() {
    for (const receiverOperation of ['mismatched', 'ambiguous'] as const) {
      const { queries, result } = yield* run({
        receiverOperation,
        systems: 1,
        workloadKey: 'party.registry.source-write',
      });
      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { code: 'forbidden', reason: 'registered_operation_refused' },
      });
      expect(queries.some((query) => query.sql.includes('core.access_workload_bindings'))).toBe(false);
    }
  }),
);
