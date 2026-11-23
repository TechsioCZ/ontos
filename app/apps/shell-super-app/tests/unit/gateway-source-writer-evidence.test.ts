import { buildApplicationCompositionCatalog, defineTenantModuleEntrypoint } from '@app/core-runtime';
import { internalWorkloadPrincipalId } from '@app/core-runtime/auth/module-credentials';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { CoreDatabase, testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { GatewayRegisteredWorkloadSubjectSchema } from '@app/shared-contracts';
import { Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { GatewayModuleBindingSchema } from '../../api/auth/gateway-delegation-policy.ts';
import { admitRegisteredGatewayWorkload } from '../../api/auth/gateway-workload-evidence.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '10000000-0000-4000-8000-000000000002';
const legacyId = '10000000-0000-4000-8000-000000000003';
const incarnation = '10000000-0000-4000-8000-000000000004';
const invocationId = '10000000-0000-4000-8000-000000000005';
const workerKey = 'integration.symmy.execute-symmy-job';
const actionKey = 'integration.symmy.admit-symmy-job';
const entrypointKey = 'party.registry.api.source-write';
const declarationKey = 'party.registry.source-write';
const run = Effect.fn('SourceWriterEvidenceTest.run')(function* run(input: {
  workloadKey: string;
  systems?: number;
  company?: boolean;
  expectedPrincipalId?: string;
  claim?: boolean;
  originalCompany?: string;
  service?: boolean;
}) {
  const source = makeModuleContractFixture({
    appId: 'symmy-integration',
    moduleId: 'integration.symmy',
    originatorActions: [actionKey],
  });
  const receiver = makeModuleContractFixture({ appId: 'party-registry', moduleId: 'party.registry' });
  const snapshot = yield* makeCompositionSnapshot([
    {
      ...source,
      manifest: {
        ...source.manifest,
        requirements: {
          schemaVersion: '1',
          coreCapabilities: [],
          operations: [],
          intrinsic: [{ moduleId: 'party.registry', requiredOperations: [{ entrypointKey, schemaVersion: '1' }] }],
        },
        publicSurface: {
          ...source.manifest.publicSurface,
          actions: [
            {
              actionKey,
              auditProfile: 'standard',
              idempotency: 'required',
              legalEntityScope: 'optional',
              owningModuleId: 'integration.symmy',
              schemaVersion: '1',
              accessWorkload: { reason: 'Exact integration admission', workloads: ['integration.symmy-admit'] },
              entrypoint: defineTenantModuleEntrypoint({
                access: 'write',
                authorization: { kind: 'protected' },
                entrypointKey: actionKey,
                moduleKey: 'integration.symmy',
                role: 'action',
              }),
            },
          ],
        },
      },
    },
    {
      ...receiver,
      manifest: {
        ...receiver.manifest,
        publicSurface: {
          ...receiver.manifest.publicSurface,
          api: [{ key: 'party.registry.api.source', operationKeys: ['write.execute'] }],
          operationContracts: [
            {
              apiKey: 'party.registry.api.source',
              operationKey: 'write.execute',
              schemaVersion: '1',
              entrypoint: defineTenantModuleEntrypoint({
                access: 'read',
                authorization: { kind: 'protected' },
                entrypointKey,
                moduleKey: 'party.registry',
                role: 'api',
              }),
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
    sourceAppId: 'symmy-integration',
    sourceBuildMarker: 'symmy-integration-build',
    registeredWorkloads: [
      {
        audience: 'party-registry',
        declarationKey,
        entrypointKey,
        jobKey: workerKey,
        workerKey,
        legalEntityScope: 'optional',
        schemaVersion: '1',
        workloadKey: input.workloadKey,
      },
    ],
  });
  const subject = Schema.decodeUnknownSync(GatewayRegisteredWorkloadSubjectSchema)({
    _tag: 'RegisteredWorkload',
    claimId: 'claim-source-writer',
    deliveryId: invocationId,
    declarationKey,
    tenantId,
    workerKey,
    ...(input.company === false ? {} : { legalEntityId }),
    ...(input.expectedPrincipalId === undefined ? {} : { expectedPrincipalId: input.expectedPrincipalId }),
  });
  const principalId = internalWorkloadPrincipalId({ tenantId, legalEntityId, workloadKey: input.workloadKey });
  const queries: { sql: string; params: readonly unknown[] }[] = [];
  const database = Layer.effect(CoreDatabase, testCoreDatabase.pipe(Effect.map((executor) => ({ executor })))).pipe(
    Layer.provide(
      scriptedPgClientLayer(
        Effect.succeed(
          testSqlConnection((sql, params) => {
            queries.push({ sql, params });
            if (sql.includes('core.outbox_deliveries'))
              return Effect.succeed(
                input.claim === false
                  ? []
                  : [
                      {
                        actionInvocationId: invocationId,
                        workerKey,
                        consumerModuleKey: 'integration.symmy',
                        producerModuleKey: 'integration.symmy',
                        topic: 'integration.symmy.job-admitted',
                      },
                    ],
              );
            if (sql.includes('core.action_invocations'))
              return Effect.succeed([
                {
                  actionKey,
                  principalId: legacyId,
                  legalEntityId: input.originalCompany ?? (input.company === false ? null : legalEntityId),
                  workloadKey: 'integration.symmy-admit',
                  bindingIncarnation: incarnation,
                  ownerBindingIncarnation: incarnation,
                },
              ]);
            if (sql.includes('core.access_workload_bindings'))
              return Effect.succeed(
                sql.includes("p.kind = 'service'")
                  ? input.service === false
                    ? []
                    : [{ principalId, bindingIncarnation: incarnation, actionInvocationId: invocationId }]
                  : Array.from({ length: input.systems ?? 0 }, () => ({
                      principalId: legacyId,
                      bindingIncarnation: incarnation,
                      actionInvocationId: invocationId,
                    })),
              );
            if (sql.includes('from core.legal_entities')) return Effect.succeed([{ legal_entity_id: legalEntityId }]);
            return Effect.succeed([]);
          }),
        ),
      ).pipe(Layer.provide(Reactivity.layer)),
    ),
  );
  const result = yield* admitRegisteredGatewayWorkload({
    audience: 'party-registry',
    binding,
    installed: { ...catalog, composition: snapshot.composition },
    subject,
  }).pipe(Effect.provide(database), Effect.result);
  return { result, queries, principalId };
});

it.effect('executes durable worker admission for both canonical company source SERVICE writers', () =>
  Effect.gen(function* () {
    for (const workloadKey of ['party.registry.source-write', 'commerce.customer-context.source-write']) {
      const { result, queries, principalId } = yield* run({ workloadKey });
      expect(result._tag).toBe('Success');
      if (result._tag === 'Success') {
        expect(result.success.principal.principalId).toBe(principalId);
        expect(result.success.workload).toMatchObject({
          bindingIncarnation: incarnation,
          legalEntityId,
          claimId: 'claim-source-writer',
          originalPrincipalId: legacyId,
        });
      }
      const service = queries.find((q) => q.sql.includes("p.kind = 'service'"));
      expect(service?.params).toContain(principalId);
      expect(service?.params).toContain(tenantId);
      expect(service?.params).toContain(legalEntityId);
      for (const fence of [
        "p.platform_role = 'internal_workload'",
        'cb.workload_binding_id = b.binding_id',
        "cb.status = 'active'",
        "le.status = 'active'",
        'le.tenant_id = cb.tenant_id',
      ])
        expect(service?.sql).toContain(fence);
    }
  }),
);

it.effect('preserves SYSTEM precedence and refuses ambiguity, unrelated jobs, tenant-only and stale evidence', () =>
  Effect.gen(function* () {
    const legacy = yield* run({ workloadKey: 'party.registry.source-write', systems: 1 });
    expect(legacy.result._tag).toBe('Success');
    if (legacy.result._tag === 'Success') expect(legacy.result.success.principal.principalId).toBe(legacyId);
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
      expect(actual.result._tag).toBe('Failure');
      if ('systems' in input || 'company' in input || 'workloadKey' in input || 'claim' in input)
        expect(actual.queries.some((q) => q.sql.includes("p.kind = 'service'"))).toBe(false);
    }
  }),
);
