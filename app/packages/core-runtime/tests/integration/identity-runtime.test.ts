// @effect-diagnostics asyncFunction:off globalDate:off
/* eslint-disable no-await-in-loop -- Ordered checkpoint commits and the live SpiceDB fixture are deliberate. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { v1 } from '@authzed/authzed-node';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Effect, Predicate, Redacted } from 'effect';
import { Pool } from 'pg';
import { makeActionRepository } from '../../src/actions/repository.ts';
import { makeActionRuntime } from '../../src/actions/runtime.ts';
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
import { managedPrincipalsRead } from '../../src/auth/principal-administration-reads.ts';
import { bindManagedApiKeyAction } from '../../src/modules/actions/bind-managed-api-key.action.ts';
import { bindSelfApiKeyAction } from '../../src/modules/actions/bind-self-api-key.action.ts';
import { changePrincipalStatusAction } from '../../src/modules/actions/change-principal-status.action.ts';
import { createNonHumanPrincipalAction } from '../../src/modules/actions/create-non-human-principal.action.ts';
import { recordSupportImpersonationAction } from '../../src/modules/actions/record-support-impersonation.action.ts';
import { setManagedApiKeyBindingStatusAction } from '../../src/modules/actions/set-managed-api-key-binding-status.action.ts';
import { setSelfApiKeyBindingStatusAction } from '../../src/modules/actions/set-self-api-key-binding-status.action.ts';
import { makeSupportRecoveryPrincipalContextResolver } from '../../src/auth/support-recovery-principal-context.ts';
import {
  makeSystemPrincipalContextResolver,
  registerSystemWorkload,
} from '../../src/auth/system-principal-context.ts';
import {
  makeOperationalScopeRepository,
  makeOperationalScopeResolver,
} from '../../src/operations/context.ts';
import { makeReadRuntime } from '../../src/reads/runtime.ts';
import { openActionRuntimeOptions } from '../support/action-runtime-options.ts';
import { openModuleEntrypointGateway } from '../support/open-module-entrypoint-gateway.ts';
import { makeContextAccess } from '../../src/permissions/context-access.ts';
import {
  SPICEDB_CHECK_TIMEOUT_MS,
  createSpiceDbPermissionClient,
} from '../../src/permissions/client.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import {
  makeActionPermissionService,
  toSpiceDbActionObjectId,
} from '../../src/permissions/service.ts';

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

void test('runs identity mutations and tenant-isolated administration through live Action and Read runtimes', async () => {
  const connections = await Effect.runPromise(loadDatabaseConnectionPair());
  const spiceDbConfiguration = await Effect.runPromise(loadSpiceDbConfig());
  const adminPool = new Pool({
    connectionString: Redacted.value(connections.admin.connectionString),
  });
  const runtimePool = new Pool({
    connectionString: Redacted.value(connections.runtime.connectionString),
  });
  const admin = drizzle({ client: adminPool, relations: coreRelations });
  const runtimeDatabase = drizzle({ client: runtimePool, relations: coreRelations });
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
    Redacted.value(spiceDbConfiguration.preSharedKey),
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
  const cleanup = async () => {
    await admin.delete(dataAccessEvents).where(inArray(dataAccessEvents.tenantId, [tenantId]));
    await admin.delete(auditEvents).where(inArray(auditEvents.tenantId, [tenantId]));
    await admin.delete(actionInvocations).where(inArray(actionInvocations.tenantId, [tenantId]));
    await admin
      .delete(principalAuthBindings)
      .where(inArray(principalAuthBindings.tenantId, [tenantId, foreignTenantId]));
    await admin.delete(principals).where(inArray(principals.tenantId, [tenantId, foreignTenantId]));
    await admin.delete(tenants).where(inArray(tenants.tenantId, [tenantId, foreignTenantId]));
  };

  try {
    await spiceDbClient.promises.writeRelationships(
      v1.WriteRelationshipsRequest.create({
        updates: spiceDbRelationships.map((item) =>
          v1.RelationshipUpdate.create({
            operation: v1.RelationshipUpdate_Operation.TOUCH,
            relationship: item,
          }),
        ),
      }),
    );
    await admin.insert(tenants).values([
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
    await admin.insert(principals).values([
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
    await admin.insert(principalAuthBindings).values([
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

    const created = await Effect.runPromise(
      actionRuntime.runAction({
        payload: { displayName: 'Managed runtime service', kind: 'service' },
        principal,
        registration: createNonHumanPrincipalAction,
        transport: { correlationId: randomUUID(), idempotencyKey: randomUUID() },
      }),
    );
    const binding = await Effect.runPromise(
      actionRuntime.runAction({
        payload: { principalId: created.principalId, providerSubjectId: providerKeyId },
        principal,
        registration: bindManagedApiKeyAction,
        transport: { correlationId: randomUUID(), idempotencyKey: randomUUID() },
      }),
    );
    await Effect.runPromise(
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
    await Effect.runPromise(
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
    await Effect.runPromise(
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
    await Effect.runPromise(
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
    const selfBinding = await Effect.runPromise(
      actionRuntime.runAction({
        payload: { providerSubjectId: selfProviderKeyId },
        principal,
        registration: bindSelfApiKeyAction,
        transport: { correlationId: randomUUID(), idempotencyKey: randomUUID() },
      }),
    );
    await Effect.runPromise(
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
    await Effect.runPromise(
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
    const listed = await Effect.runPromise(
      readRuntime.runRead({
        input: { limit: 100, offset: 0 },
        principal,
        registration: managedPrincipalsRead,
        transport: { correlationId: randomUUID() },
      }),
    );

    assert.equal(binding.status, 'active');
    assert.deepEqual(
      listed.items.map(({ authBindingId, principalId: listedPrincipalId }) => ({
        authBindingId,
        principalId: listedPrincipalId,
      })),
      [{ authBindingId: binding.authBindingId, principalId: created.principalId }],
    );
    await Effect.runPromise(
      readRuntime.runRead({
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
      }),
    );
    const committed = await admin
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
    const [readEvidence] = await admin
      .select({ resultCount: dataAccessEvents.resultCount })
      .from(dataAccessEvents)
      .where(
        and(
          eq(dataAccessEvents.tenantId, tenantId),
          eq(dataAccessEvents.evidencePolicyKey, 'core.identity.managed-principals.access.v1'),
        ),
      );
    assert.equal(readEvidence?.resultCount, 1);
    const [apiKeyReadEvidence] = await admin
      .select({ authBindingId: dataAccessEvents.authBindingId })
      .from(dataAccessEvents)
      .where(
        and(eq(dataAccessEvents.tenantId, tenantId), eq(dataAccessEvents.authMethod, 'api_key')),
      );
    assert.equal(apiKeyReadEvidence?.authBindingId, selfBinding.authBindingId);

    const systemPrincipal = await Effect.runPromise(
      makeSystemPrincipalContextResolver({ executor: runtimeDatabase }).resolve({
        principalId: systemPrincipalId,
        registration: registerSystemWorkload({ jobKey: 'identity-runtime-integration' }),
        runReference: randomUUID(),
        tenantId,
      }),
    );
    const systemDenied = await Effect.runPromise(
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
    await spiceDbClient.promises.writeRelationships(
      v1.WriteRelationshipsRequest.create({
        updates: [systemTenantMember, systemIdentityAdministrator].map((item) =>
          v1.RelationshipUpdate.create({
            operation: v1.RelationshipUpdate_Operation.TOUCH,
            relationship: item,
          }),
        ),
      }),
    );
    const systemCreated = await Effect.runPromise(
      actionRuntime.runAction({
        payload: { displayName: 'System-created integration', kind: 'integration' },
        principal: systemPrincipal,
        registration: createNonHumanPrincipalAction,
        transport: { correlationId: randomUUID(), idempotencyKey: randomUUID() },
      }),
    );
    assert.equal(systemCreated.status, 'active');
    const systemRead = await Effect.runPromise(
      readRuntime.runRead({
        input: { limit: 100, offset: 0 },
        principal: systemPrincipal,
        registration: managedPrincipalsRead,
        transport: { correlationId: randomUUID() },
      }),
    );
    assert.ok(systemRead.items.length >= 2);

    const supportReason = 'Investigate a live support incident';
    const supportSessionRef = `better-auth-session:${randomUUID()}`;
    for (const checkpoint of ['requested', 'started'] as const) {
      await Effect.runPromise(
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
      );
    }
    const supportRelationship = relationship(
      'tenant',
      tenantId,
      'support',
      'principal',
      administratorPrincipalId,
    );
    await spiceDbClient.promises.writeRelationships(
      v1.WriteRelationshipsRequest.create({
        updates: [
          v1.RelationshipUpdate.create({
            operation: v1.RelationshipUpdate_Operation.DELETE,
            relationship: supportRelationship,
          }),
        ],
      }),
    );
    await admin
      .update(principalAuthBindings)
      .set({ revokedAt: new Date('2026-08-09T00:00:00.000Z'), status: 'revoked' })
      .where(eq(principalAuthBindings.principalAuthBindingId, administratorAuthBindingId));
    await admin
      .update(principals)
      .set({ status: 'disabled' })
      .where(inArray(principals.principalId, [administratorPrincipalId, supportTargetPrincipalId]));
    const recoveryPrincipal = await Effect.runPromise(
      makeSupportRecoveryPrincipalContextResolver({
        executor: runtimeDatabase,
      }).resolveStoppedImpersonation({
        originalAuthBindingId: administratorAuthBindingId,
        originalPrincipalId: administratorPrincipalId,
        originalSessionId: randomUUID(),
        tenantId,
      }),
    );
    const stopped = await Effect.runPromise(
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
    const supportAudits = await admin
      .select({ evidence: auditEvents.evidenceJson })
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.eventType, 'action.executed')));
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
    const supportAccess = await admin
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
    const succeededIdentityActions = await admin
      .select({ actionKey: actionInvocations.actionKey })
      .from(actionInvocations)
      .where(
        and(eq(actionInvocations.tenantId, tenantId), eq(actionInvocations.status, 'succeeded')),
      );
    assert.deepEqual(
      [...new Set(succeededIdentityActions.map(({ actionKey }) => actionKey))].toSorted(),
      [...identityActionKeys].toSorted(),
    );
  } finally {
    await cleanup();
    await spiceDbClient.promises.writeRelationships(
      v1.WriteRelationshipsRequest.create({
        updates: spiceDbRelationships.map((item) =>
          v1.RelationshipUpdate.create({
            operation: v1.RelationshipUpdate_Operation.DELETE,
            relationship: item,
          }),
        ),
      }),
    );
    permissionClient.close();
    spiceDbClient.close();
    await Promise.all([adminPool.end(), runtimePool.end()]);
  }
});
