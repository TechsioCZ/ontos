import {
  makeEffectTestCallback as nativeTestCallback,
  makeEffectTestCallback,
} from '@app/core-runtime/testing/effect-runtime';

import { v1 } from '@authzed/authzed-node';
import { and, eq, inArray } from 'drizzle-orm';
import {
  DateTime,
  Effect,
  Exit as NativeExit,
  Scope as NativeScope,
  Option,
  Predicate,
} from 'effect';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after as afterNativeDatabase } from 'node:test';
import { Pool } from 'pg';
import { makeActionRepository } from '../../src/actions/repository.ts';
import { makeActionRuntime } from '../../src/actions/runtime.ts';
import { managedPrincipalsRead } from '../../src/auth/principal-administration-reads.ts';
import {
  PrincipalManagementRepository,
  principalManagementRepositoryFromTransaction,
} from '../../src/auth/principal-management.ts';
import { makeSupportRecoveryPrincipalContextResolver } from '../../src/auth/support-recovery-principal-context.ts';
import {
  makeSystemPrincipalContextResolver,
  registerSystemWorkload,
} from '../../src/auth/system-principal-context.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import {
  actionInvocations,
  auditEvents,
  coreRelations,
  dataAccessEvents,
  principalAuthBindings,
  principals,
  tenants,
} from '../../src/db/schema.ts';
import { bindManagedApiKeyAction } from '../../src/modules/actions/bind-managed-api-key.action.ts';
import { bindSelfApiKeyAction } from '../../src/modules/actions/bind-self-api-key.action.ts';
import { changePrincipalStatusAction } from '../../src/modules/actions/change-principal-status.action.ts';
import { createNonHumanPrincipalAction } from '../../src/modules/actions/create-non-human-principal.action.ts';
import { recordSupportImpersonationAction } from '../../src/modules/actions/record-support-impersonation.action.ts';
import { setManagedApiKeyBindingStatusAction } from '../../src/modules/actions/set-managed-api-key-binding-status.action.ts';
import { setSelfApiKeyBindingStatusAction } from '../../src/modules/actions/set-self-api-key-binding-status.action.ts';
import {
  makeOperationalScopeRepository,
  makeOperationalScopeResolver,
} from '../../src/operations/context.ts';
import {
  SPICEDB_CHECK_TIMEOUT_MS,
  createSpiceDbPermissionClient,
} from '../../src/permissions/client.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import { makeContextAccess } from '../../src/permissions/context-access.ts';
import {
  makeActionPermissionService,
  toSpiceDbActionObjectId,
} from '../../src/permissions/service.ts';
import { makeReadRuntime } from '../../src/reads/runtime.ts';
import { openActionRuntimeOptions } from '../support/action-runtime-options.ts';
import { makeTestDatabaseFromPool } from '../support/database.ts';
import { runEffectTestSync as runNativeSync } from '../support/effect-runtime.ts';
import { openModuleEntrypointGateway } from '../support/open-module-entrypoint-gateway.ts';

const nativeDatabaseScope = runNativeSync(NativeScope.make());
afterNativeDatabase(
  NativeScope.close(nativeDatabaseScope, NativeExit.void).pipe(nativeTestCallback),
);

const withOptionalProperty = <
  Base extends object,
  Key extends PropertyKey,
  Value,
  Trailing extends object,
>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

const relationship = (
  resourceType: string,
  resourceId: string,
  relation: string,
  subjectType: string,
  subjectId: string,
) =>
  v1.Relationship.create({
    relation,
    resource: v1.ObjectReference.create({ objectId: resourceId, objectType: resourceType }),
    subject: v1.SubjectReference.create({
      object: v1.ObjectReference.create({ objectId: subjectId, objectType: subjectType }),
    }),
  });

const promiseEffect = <Value>(operation: () => PromiseLike<Value>) =>
  Effect.promise(() => operation());
const effectTest = <Value, Failure>(name: string, effect: Effect.Effect<Value, Failure>): void => {
  test(name, makeEffectTestCallback(effect));
};

effectTest(
  'runs identity mutations and tenant-isolated administration through live Action and Read runtimes',
  Effect.gen(function* identityRuntimeIntegration() {
    const connections = yield* loadDatabaseConnectionPair();
    const spiceDbConfiguration = yield* loadSpiceDbConfig();
    const adminPool = new Pool({ connectionString: connections.admin.connectionString });
    const runtimePool = new Pool({ connectionString: connections.runtime.connectionString });
    const admin = yield* makeTestDatabaseFromPool(adminPool, coreRelations).pipe(
      NativeScope.provide(nativeDatabaseScope),
    );
    const runtimeDatabase = yield* makeTestDatabaseFromPool(runtimePool, coreRelations).pipe(
      NativeScope.provide(nativeDatabaseScope),
    );
    const principalManagementRepository =
      principalManagementRepositoryFromTransaction(runtimeDatabase);
    const runIdentityAction = <Value, Failure>(
      action: Effect.Effect<Value, Failure, PrincipalManagementRepository>,
    ) =>
      action.pipe(
        Effect.provideService(PrincipalManagementRepository, principalManagementRepository),
      );
    const tenantId = randomUUID();
    const foreignTenantId = randomUUID();
    const administratorPrincipalId = randomUUID();
    const administratorAuthBindingId = randomUUID();
    const foreignPrincipalId = randomUUID();
    const supportTargetPrincipalId = randomUUID();
    const supportTargetAuthBindingId = randomUUID();
    const systemPrincipalId = randomUUID();
    const providerUserId = `identity-runtime-user-${randomUUID()}`;
    const providerKeyId = `identity-runtime-key-${randomUUID()}`;
    const selfProviderKeyId = `identity-runtime-self-key-${randomUUID()}`;
    const supportTargetUserId = `identity-runtime-target-${randomUUID()}`;
    const spiceDbClient = v1.NewClient(
      spiceDbConfiguration.preSharedKey,
      spiceDbConfiguration.endpoint,
      spiceDbConfiguration.insecureLocal
        ? v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED
        : v1.ClientSecurity.SECURE,
    );
    const permissionClient = createSpiceDbPermissionClient(
      spiceDbConfiguration,
      SPICEDB_CHECK_TIMEOUT_MS,
    );
    const contextAccess = makeContextAccess(permissionClient);
    const actionPermission = makeActionPermissionService(permissionClient);
    const operationalScope = makeOperationalScopeResolver(
      makeOperationalScopeRepository({ executor: runtimeDatabase }),
      contextAccess,
    );
    const actionRuntime = makeActionRuntime(
      { executor: runtimeDatabase },
      makeActionRepository(),
      actionPermission,
      operationalScope,
      { ...openActionRuntimeOptions, contextAccess },
    );
    const readRuntime = makeReadRuntime(
      { executor: runtimeDatabase },
      openModuleEntrypointGateway,
      operationalScope,
      contextAccess,
    );
    const principal = {
      authBindingId: administratorAuthBindingId,
      authContextRef: `better-auth-session:${randomUUID()}`,
      authMethod: 'session' as const,
      principalId: administratorPrincipalId,
      tenantId,
    };
    const identityActionKeys = [
      'core.identity.bind-managed-api-key',
      'core.identity.bind-self-api-key',
      'core.identity.change-principal-status',
      'core.identity.create-non-human-principal',
      'core.identity.record-support-impersonation',
      'core.identity.set-managed-api-key-binding-status',
      'core.identity.set-self-api-key-binding-status',
    ] as const;
    const spiceDbRelationships = [
      relationship('tenant', tenantId, 'member', 'principal', administratorPrincipalId),
      relationship('tenant', tenantId, 'identity_admin', 'principal', administratorPrincipalId),
      relationship('tenant', tenantId, 'support', 'principal', administratorPrincipalId),
      ...identityActionKeys.flatMap((actionKey) => {
        const objectId = toSpiceDbActionObjectId(actionKey);
        return [
          relationship('action', objectId, 'executor', 'principal', administratorPrincipalId),
          relationship('action', objectId, 'executor', 'principal', systemPrincipalId),
        ];
      }),
    ];
    const cleanup = Effect.gen(function* cleanIdentityRuntimeFixtures() {
      yield* admin.delete(dataAccessEvents).where(inArray(dataAccessEvents.tenantId, [tenantId]));
      yield* admin.delete(auditEvents).where(inArray(auditEvents.tenantId, [tenantId]));
      yield* admin.delete(actionInvocations).where(inArray(actionInvocations.tenantId, [tenantId]));
      yield* admin
        .delete(principalAuthBindings)
        .where(inArray(principalAuthBindings.tenantId, [tenantId, foreignTenantId]));
      yield* admin
        .delete(principals)
        .where(inArray(principals.tenantId, [tenantId, foreignTenantId]));
      yield* admin.delete(tenants).where(inArray(tenants.tenantId, [tenantId, foreignTenantId]));
    });

    const exercise = Effect.gen(function* exerciseIdentityRuntime() {
      const initialRelationshipsRequest = v1.WriteRelationshipsRequest.create({
        updates: spiceDbRelationships.map((item) =>
          v1.RelationshipUpdate.create({
            operation: v1.RelationshipUpdate_Operation.TOUCH,
            relationship: item,
          }),
        ),
      });
      yield* promiseEffect(
        spiceDbClient.promises.writeRelationships.bind(
          spiceDbClient.promises,
          initialRelationshipsRequest,
        ),
      );
      yield* admin.insert(tenants).values([
        {
          defaultLocale: 'en',
          name: 'Identity runtime tenant',
          slug: `identity-runtime-${tenantId}`,
          status: 'active',
          tenantId,
        },
        {
          defaultLocale: 'en',
          name: 'Foreign identity runtime tenant',
          slug: `identity-runtime-${foreignTenantId}`,
          status: 'active',
          tenantId: foreignTenantId,
        },
      ]);
      yield* admin.insert(principals).values([
        {
          displayName: 'Identity administrator',
          kind: 'human',
          principalId: administratorPrincipalId,
          status: 'active',
          tenantId,
        },
        {
          displayName: 'Foreign managed service',
          kind: 'service',
          principalId: foreignPrincipalId,
          status: 'active',
          tenantId: foreignTenantId,
        },
        {
          displayName: 'Support target',
          kind: 'human',
          principalId: supportTargetPrincipalId,
          status: 'active',
          tenantId,
        },
        {
          displayName: 'Identity runtime system',
          kind: 'system',
          principalId: systemPrincipalId,
          status: 'active',
          tenantId,
        },
      ]);
      yield* admin.insert(principalAuthBindings).values([
        {
          principalAuthBindingId: administratorAuthBindingId,
          principalId: administratorPrincipalId,
          provider: 'better_auth',
          providerSubjectId: providerUserId,
          status: 'active',
          subjectType: 'user',
          tenantId,
        },
        {
          principalAuthBindingId: supportTargetAuthBindingId,
          principalId: supportTargetPrincipalId,
          provider: 'better_auth',
          providerSubjectId: supportTargetUserId,
          status: 'active',
          subjectType: 'user',
          tenantId,
        },
      ]);

      const created = yield* runIdentityAction(
        actionRuntime.runAction({
          payload: { displayName: 'Managed runtime service', kind: 'service' },
          principal,
          registration: createNonHumanPrincipalAction,
          transport: { correlationId: randomUUID(), idempotencyKey: randomUUID() },
        }),
      );
      const binding = yield* runIdentityAction(
        actionRuntime.runAction({
          payload: { principalId: created.principalId, providerSubjectId: providerKeyId },
          principal,
          registration: bindManagedApiKeyAction,
          transport: { correlationId: randomUUID(), idempotencyKey: randomUUID() },
        }),
      );
      yield* runIdentityAction(
        actionRuntime.runAction({
          payload: {
            authBindingId: binding.authBindingId,
            expectedStatus: 'active',
            newStatus: 'disabled',
            principalId: created.principalId,
          },
          principal,
          registration: setManagedApiKeyBindingStatusAction,
          transport: { correlationId: randomUUID(), idempotencyKey: randomUUID() },
        }),
      );
      yield* runIdentityAction(
        actionRuntime.runAction({
          payload: {
            authBindingId: binding.authBindingId,
            expectedStatus: 'disabled',
            newStatus: 'active',
            principalId: created.principalId,
          },
          principal,
          registration: setManagedApiKeyBindingStatusAction,
          transport: { correlationId: randomUUID(), idempotencyKey: randomUUID() },
        }),
      );
      yield* runIdentityAction(
        actionRuntime.runAction({
          payload: {
            expectedStatus: 'active',
            newStatus: 'disabled',
            principalId: created.principalId,
            reason: 'Exercise disabled managed-principal state',
          },
          principal,
          registration: changePrincipalStatusAction,
          transport: { correlationId: randomUUID(), idempotencyKey: randomUUID() },
        }),
      );
      yield* runIdentityAction(
        actionRuntime.runAction({
          payload: {
            expectedStatus: 'disabled',
            newStatus: 'active',
            principalId: created.principalId,
          },
          principal,
          registration: changePrincipalStatusAction,
          transport: { correlationId: randomUUID(), idempotencyKey: randomUUID() },
        }),
      );
      const selfBinding = yield* runIdentityAction(
        actionRuntime.runAction({
          payload: { providerSubjectId: selfProviderKeyId },
          principal,
          registration: bindSelfApiKeyAction,
          transport: { correlationId: randomUUID(), idempotencyKey: randomUUID() },
        }),
      );
      yield* runIdentityAction(
        actionRuntime.runAction({
          payload: {
            authBindingId: selfBinding.authBindingId,
            expectedStatus: 'active',
            newStatus: 'disabled',
          },
          principal,
          registration: setSelfApiKeyBindingStatusAction,
          transport: { correlationId: randomUUID(), idempotencyKey: randomUUID() },
        }),
      );
      yield* runIdentityAction(
        actionRuntime.runAction({
          payload: {
            authBindingId: selfBinding.authBindingId,
            expectedStatus: 'disabled',
            newStatus: 'active',
          },
          principal,
          registration: setSelfApiKeyBindingStatusAction,
          transport: { correlationId: randomUUID(), idempotencyKey: randomUUID() },
        }),
      );
      const listed = yield* readRuntime.runRead({
        input: { limit: 100, offset: 0 },
        principal,
        registration: managedPrincipalsRead,
        transport: { correlationId: randomUUID() },
      });

      assert.equal(binding.status, 'active');
      assert.deepEqual(
        listed.items.map(({ authBindingId, principalId: listedPrincipalId }) => ({
          authBindingId: Option.getOrThrow(authBindingId),
          principalId: listedPrincipalId,
        })),
        [{ authBindingId: binding.authBindingId, principalId: created.principalId }],
      );
      yield* readRuntime.runRead({
        input: { limit: 100, offset: 0 },
        principal: {
          authBindingId: selfBinding.authBindingId,
          authContextRef: `better-auth-api-key:${selfProviderKeyId}`,
          authMethod: 'api_key',
          principalId: administratorPrincipalId,
          tenantId,
        },
        registration: managedPrincipalsRead,
        transport: { correlationId: randomUUID() },
      });
      const committed = yield* admin
        .select({ actionKey: actionInvocations.actionKey, status: actionInvocations.status })
        .from(actionInvocations)
        .where(eq(actionInvocations.tenantId, tenantId));
      assert.deepEqual(
        [
          ...new Set(
            committed
              .filter(({ status }) => status === 'succeeded')
              .map(({ actionKey }) => actionKey),
          ),
        ].toSorted(),
        identityActionKeys.filter((actionKey) => !actionKey.includes('support')).toSorted(),
      );
      const [readEvidence] = yield* admin
        .select({ resultCount: dataAccessEvents.resultCount })
        .from(dataAccessEvents)
        .where(
          and(
            eq(dataAccessEvents.tenantId, tenantId),
            eq(dataAccessEvents.evidencePolicyKey, 'core.identity.managed-principals.access.v1'),
          ),
        );
      assert.equal(readEvidence?.resultCount, 1);
      const [apiKeyReadEvidence] = yield* admin
        .select({ authBindingId: dataAccessEvents.authBindingId })
        .from(dataAccessEvents)
        .where(
          and(eq(dataAccessEvents.tenantId, tenantId), eq(dataAccessEvents.authMethod, 'api_key')),
        );
      assert.equal(apiKeyReadEvidence?.authBindingId, selfBinding.authBindingId);

      const systemPrincipal = yield* makeSystemPrincipalContextResolver({
        executor: runtimeDatabase,
      }).resolve({
        principalId: systemPrincipalId,
        registration: registerSystemWorkload({ jobKey: 'identity-runtime-integration' }),
        runReference: randomUUID(),
        tenantId,
      });
      const systemDenied = yield* runIdentityAction(
        Effect.flip(
          actionRuntime.runAction({
            payload: { displayName: 'Executor-only system integration', kind: 'integration' },
            principal: systemPrincipal,
            registration: createNonHumanPrincipalAction,
            transport: { correlationId: randomUUID(), idempotencyKey: randomUUID() },
          }),
        ),
      );
      assert.equal(systemDenied._tag, 'ActionPermissionDenied');
      const systemTenantMember = relationship(
        'tenant',
        tenantId,
        'member',
        'principal',
        systemPrincipalId,
      );
      const systemIdentityAdministrator = relationship(
        'tenant',
        tenantId,
        'identity_admin',
        'principal',
        systemPrincipalId,
      );
      spiceDbRelationships.push(systemTenantMember, systemIdentityAdministrator);
      const systemRelationshipsRequest = v1.WriteRelationshipsRequest.create({
        updates: [systemTenantMember, systemIdentityAdministrator].map((item) =>
          v1.RelationshipUpdate.create({
            operation: v1.RelationshipUpdate_Operation.TOUCH,
            relationship: item,
          }),
        ),
      });
      yield* promiseEffect(
        spiceDbClient.promises.writeRelationships.bind(
          spiceDbClient.promises,
          systemRelationshipsRequest,
        ),
      );
      const systemCreated = yield* runIdentityAction(
        actionRuntime.runAction({
          payload: { displayName: 'System-created integration', kind: 'integration' },
          principal: systemPrincipal,
          registration: createNonHumanPrincipalAction,
          transport: { correlationId: randomUUID(), idempotencyKey: randomUUID() },
        }),
      );
      assert.equal(systemCreated.status, 'active');
      const systemRead = yield* readRuntime.runRead({
        input: { limit: 100, offset: 0 },
        principal: systemPrincipal,
        registration: managedPrincipalsRead,
        transport: { correlationId: randomUUID() },
      });
      assert.ok(systemRead.items.length >= 2);

      const supportReason = 'Investigate a live support incident';
      const supportSessionRef = `better-auth-session:${randomUUID()}`;
      yield* runIdentityAction(
        Effect.forEach(
          ['requested', 'started'] as const,
          (checkpoint) =>
            actionRuntime.runAction({
              payload: withOptionalProperty(
                {
                  checkpoint,
                  originalPrincipalId: administratorPrincipalId,
                  reason: supportReason,
                },
                checkpoint === 'started',
                'sessionRef',
                supportSessionRef,
                {
                  targetPrincipalId: supportTargetPrincipalId,
                },
              ),
              principal,
              registration: recordSupportImpersonationAction,
              transport: {
                correlationId: randomUUID(),
                idempotencyKey: `support-live-${checkpoint}-${randomUUID()}`,
              },
            }),
          { concurrency: 1, discard: true },
        ),
      );
      const supportRelationship = relationship(
        'tenant',
        tenantId,
        'support',
        'principal',
        administratorPrincipalId,
      );
      const removeSupportRelationshipRequest = v1.WriteRelationshipsRequest.create({
        updates: [
          v1.RelationshipUpdate.create({
            operation: v1.RelationshipUpdate_Operation.DELETE,
            relationship: supportRelationship,
          }),
        ],
      });
      yield* promiseEffect(
        spiceDbClient.promises.writeRelationships.bind(
          spiceDbClient.promises,
          removeSupportRelationshipRequest,
        ),
      );
      yield* admin
        .update(principalAuthBindings)
        .set({
          revokedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-08-09T00:00:00.000Z')),
          status: 'revoked',
        })
        .where(eq(principalAuthBindings.principalAuthBindingId, administratorAuthBindingId));
      yield* admin
        .update(principals)
        .set({ status: 'disabled' })
        .where(
          inArray(principals.principalId, [administratorPrincipalId, supportTargetPrincipalId]),
        );
      const recoveryPrincipal = yield* makeSupportRecoveryPrincipalContextResolver({
        executor: runtimeDatabase,
      }).resolveStoppedImpersonation({
        originalAuthBindingId: administratorAuthBindingId,
        originalPrincipalId: administratorPrincipalId,
        originalSessionId: randomUUID(),
        tenantId,
      });
      const stopped = yield* runIdentityAction(
        actionRuntime.runAction({
          payload: {
            checkpoint: 'stopped',
            originalPrincipalId: administratorPrincipalId,
            reason: supportReason,
            sessionRef: supportSessionRef,
            targetPrincipalId: supportTargetPrincipalId,
          },
          principal: recoveryPrincipal,
          registration: recordSupportImpersonationAction,
          transport: {
            correlationId: randomUUID(),
            idempotencyKey: `support-live-stopped-${randomUUID()}`,
          },
        }),
      );
      assert.deepEqual(stopped, { checkpoint: 'stopped', recorded: true });
      const supportAudits = yield* admin
        .select({ evidence: auditEvents.evidenceJson })
        .from(auditEvents)
        .where(
          and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.eventType, 'action.executed')),
        );
      assert.deepEqual(
        supportAudits
          .map(({ evidence }) =>
            Predicate.isObjectKeyword(evidence) && evidence !== null && 'checkpoint' in evidence
              ? evidence.checkpoint
              : undefined,
          )
          .filter((checkpoint): checkpoint is string => Predicate.isString(checkpoint))
          .toSorted(),
        ['requested', 'started', 'stopped'],
      );
      const supportAccess = yield* admin
        .select({ count: dataAccessEvents.resultCount })
        .from(dataAccessEvents)
        .where(
          and(
            eq(dataAccessEvents.tenantId, tenantId),
            eq(
              dataAccessEvents.evidencePolicyKey,
              'core.identity.record-support-impersonation.access.v1',
            ),
          ),
        );
      assert.equal(supportAccess.length, 6);
      const succeededIdentityActions = yield* admin
        .select({ actionKey: actionInvocations.actionKey })
        .from(actionInvocations)
        .where(
          and(eq(actionInvocations.tenantId, tenantId), eq(actionInvocations.status, 'succeeded')),
        );
      assert.deepEqual(
        [...new Set(succeededIdentityActions.map(({ actionKey }) => actionKey))].toSorted(),
        [...identityActionKeys].toSorted(),
      );
    });
    const cleanupRelationships = Effect.suspend(() => {
      const request = v1.WriteRelationshipsRequest.create({
        updates: spiceDbRelationships.map((item) =>
          v1.RelationshipUpdate.create({
            operation: v1.RelationshipUpdate_Operation.DELETE,
            relationship: item,
          }),
        ),
      });
      return promiseEffect(
        spiceDbClient.promises.writeRelationships.bind(spiceDbClient.promises, request),
      );
    });
    const release = cleanup.pipe(
      Effect.ensuring(cleanupRelationships.pipe(Effect.orDie)),
      Effect.ensuring(
        Effect.sync(() => {
          permissionClient.close();
          spiceDbClient.close();
        }),
      ),
      Effect.ensuring(
        Effect.all(
          [
            promiseEffect(adminPool.end.bind(adminPool)),
            promiseEffect(runtimePool.end.bind(runtimePool)),
          ],
          { concurrency: 'unbounded' },
        ).pipe(Effect.orDie),
      ),
    );
    yield* exercise.pipe(Effect.ensuring(release.pipe(Effect.orDie)));
  }),
);
