import { randomUUID } from 'node:crypto';
import { v1 } from '@authzed/authzed-node';
import { and, eq, sql } from 'drizzle-orm';
import { Context, DateTime, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { expect, it } from 'effect-rstest';

import { ActionAlreadyCommitted, ActionPermissionDenied } from '../../src/actions/errors.ts';
import { makeActionRepository } from '../../src/actions/repository.ts';
import { makeActionCompositionRevisionResolver, makeActionRuntime } from '../../src/actions/runtime.ts';
import {
  IdentityLifecycleConflictError,
  IdentityTargetInvalidError,
} from '../../src/auth/principal-management-errors.ts';
import {
  AuthenticationNamespaceRegistry,
  makeAuthenticationNamespaceRegistry,
} from '../../src/auth/external-identity/verifier.ts';
import { staffAuthenticationNamespaceRegistration } from '../../src/auth/staff-authentication-namespace.ts';
import { CoreDatabase, makeCoreDatabase } from '../../src/db/client.ts';
import { DatabaseConfig, loadDatabaseConnectionPair } from '../../src/db/config.ts';
import {
  applicationCompositionAuthority,
  auditEvents,
  legalEntities,
  principalAuthBindings,
  principalCompanyMemberships,
  principals,
  tenants,
  tenantModuleStates,
} from '../../src/db/schema.ts';
import { buildActionAuthorizationRelationships } from '../../src/install/action-authorization-provisioning.ts';
import {
  configureAgentAction,
  ConfigureAgentAuditEvidenceSchema,
} from '../../src/modules/actions/configure-agent.action.ts';
import type { ConfigureAgentPayload } from '../../src/modules/actions/configure-agent.action.ts';
import { manageDemoAccountAction } from '../../src/modules/actions/manage-demo-account.action.ts';
import { makeModuleEntrypointGateway } from '../../src/modules/module-entrypoint-gateway.ts';
import { makeModuleStateGate } from '../../src/modules/module-state-gate.ts';
import { makeTenantModuleStateService } from '../../src/modules/tenant-module-state-service.ts';
import { makeOperationalScopeRepository, makeOperationalScopeResolver } from '../../src/operations/context.ts';
import {
  corePrincipalLifecycleSubscription,
  CORE_SYSTEM_OUTBOX_SUBSCRIPTIONS,
} from '../../src/outbox/core-system-subscriptions.ts';
import { createSpiceDbPermissionClient } from '../../src/permissions/client.ts';
import { SpiceDbConfig, loadSpiceDbConfig } from '../../src/permissions/config.ts';
import {
  makeContextAccess,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '../../src/permissions/context-access.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';
import { agentScopedRoleObjectId, toScopedRoleObjectId } from '../../src/permissions/scoped-role.ts';
import {
  makeActionPermissionService,
  toSpiceDbActionObjectId,
  toSpiceDbActionGrantObjectId,
} from '../../src/permissions/service.ts';
import { ActiveApplicationCompositionService } from '../../src/modules/active-application-composition.ts';
import {
  ActionAuthorizationLifecycle,
  ActionAuthorizationLifecycleLive,
} from '../../src/permissions/action-authorization-lifecycle.ts';
import { ScopedRoleMembershipLifecycleLive } from '../../src/permissions/scoped-role-membership-lifecycle.ts';
import { coreSystemOutboxWorkers } from '../../src/outbox/core-system-worker-entry.ts';
import { makeOutboxRuntime } from '../../src/outbox/runtime.ts';
import { makeOutboxRepository } from '../../src/outbox/repository.ts';
import { newSpiceDbGrpcClient } from '../../src/permissions/spicedb-grpc-rpc.ts';
import {
  freshOutboxWorkerCompositionSnapshot,
  makeOutboxWorkerComposition,
} from '../support/outbox-worker-composition.ts';

const relationship = (
  type: string,
  id: string,
  relation: string,
  subjectType: string,
  subjectId: string,
  optionalRelation = '',
) =>
  v1.Relationship.create({
    relation,
    resource: { objectId: id, objectType: type },
    subject: { object: { objectId: subjectId, objectType: subjectType }, optionalRelation },
  });

it.layer(Reactivity.layer, { excludeTestServices: true })('native agent profile lifecycle', (suite) => {
  suite.effect(
    'governs stable agent creation/configuration with exact membership, revisions, audit, idempotence and no inferred grants',
    () =>
      Effect.gen(function* nativeAgentProfileProof() {
        const pair = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
        expect(pair.runtime.database).toMatch(/^people_model_scratch_20261023_[0-9a-f]+$/u);
        expect(pair.admin.database).toBe(pair.runtime.database);
        const config = yield* loadSpiceDbConfig();
        expect(config.endpoint).toMatch(/^localhost:\d+$/u);
        const database = yield* makeCoreDatabase(pair.runtime);
        const admin = yield* makeCoreDatabase(pair.admin);
        const graph = yield* Effect.acquireRelease(
          Effect.sync(() => newSpiceDbGrpcClient(config)),
          (rpc) => Effect.sync(() => rpc.close()),
        );
        yield* Effect.promise(() =>
          graph.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })),
        );
        const composition = makeOutboxWorkerComposition([{ appId: 'work-tasks', moduleId: 'work.tasks' }]);
        const authority = { load: freshOutboxWorkerCompositionSnapshot(composition) };
        const snapshot = yield* authority.load;
        yield* admin.executor
          .insert(applicationCompositionAuthority)
          .values({
            authorityKey: 'active',
            phase: 'active',
            revision: composition.revision,
            subscriptionsJson: CORE_SYSTEM_OUTBOX_SUBSCRIPTIONS,
            validUntil: DateTime.toDateUtc(snapshot.validUntil),
          })
          .onConflictDoUpdate({
            set: { revision: composition.revision, validUntil: DateTime.toDateUtc(snapshot.validUntil) },
            target: applicationCompositionAuthority.authorityKey,
          });
        const tenantId = randomUUID();
        const legalEntityId = randomUUID();
        const otherCompany = randomUUID();
        const actorId = randomUUID();
        const ordinaryId = randomUUID();
        const stableAgentId = randomUUID();
        const orphanAgentId = randomUUID();
        const bindingId = randomUUID();
        const registration = yield* staffAuthenticationNamespaceRegistration(['core-runtime-test']);
        const registry = makeAuthenticationNamespaceRegistry([registration]);
        yield* admin.executor.insert(tenants).values({
          defaultLocale: 'cs',
          name: 'Owned agent profile proof',
          slug: `agent-${tenantId}`,
          status: 'active',
          tenantId,
        });
        yield* admin.executor.insert(legalEntities).values(
          [legalEntityId, otherCompany].map((id) => ({
            legalEntityId: id,
            legalName: 'Owned profile company',
            registrationCountry: 'CZ',
            registrationNumber: id,
            status: 'active' as const,
            tenantId,
          })),
        );
        yield* admin.executor.insert(principals).values([
          ...[actorId, ordinaryId].map((principalId) => ({
            displayName: 'Owned operator',
            kind: 'human' as const,
            principalId,
            status: 'active' as const,
            tenantId,
          })),
          { displayName: 'Unaffiliated agent', kind: 'agent', principalId: orphanAgentId, status: 'active', tenantId },
        ]);
        yield* admin.executor
          .insert(principalCompanyMemberships)
          .values({ affiliation: 'external', legalEntityId, principalId: actorId, status: 'active', tenantId });
        yield* admin.executor.insert(principalAuthBindings).values(
          [actorId, ordinaryId].map((id) => ({
            authenticationNamespaceId: registration.authenticationNamespaceId,
            principalAuthBindingId: id === actorId ? bindingId : ordinaryId,
            principalId: id,
            provider: 'better_auth',
            providerSubjectId: randomUUID(),
            status: 'active' as const,
            subjectType: 'user' as const,
            tenantId,
          })),
        );
        const companyObject = (id: string) =>
          toLegalEntityAccessObjectId(tenantId, id) ?? expect.unreachable('Invalid owned company');
        const role = toScopedRoleObjectId({ roleKey: 'tenant-superadmin', tenantId });
        const rows = [
          ...[actorId, ordinaryId].map((id) => relationship('tenant', tenantId, 'member', 'principal', id)),
          ...[legalEntityId, otherCompany].map((id) =>
            relationship('legal_entity', companyObject(id), 'tenant', 'tenant', tenantId),
          ),
          ...[actorId, ordinaryId].map((id) =>
            relationship('legal_entity', companyObject(legalEntityId), 'member', 'principal', id),
          ),
          relationship('scoped_role', role, 'member', 'principal', actorId),
          relationship('tenant', tenantId, 'superadmin', 'scoped_role', role, 'member'),
          ...buildActionAuthorizationRelationships(
            [legalEntityId, otherCompany].map((id) => ({
              actionKey: configureAgentAction.descriptor.actionKey,
              legalEntityId: id,
              tenantId,
            })),
          ),
        ];
        yield* Effect.promise(() =>
          graph.promises.writeRelationships(
            v1.WriteRelationshipsRequest.create({
              updates: rows.map((row) => ({ operation: v1.RelationshipUpdate_Operation.TOUCH, relationship: row })),
            }),
          ),
        );
        const permissions = createSpiceDbPermissionClient(config, 5000);
        const access = makeContextAccess(permissions);
        const gate = makeModuleStateGate(makeTenantModuleStateService(database));
        const runtime = makeActionRuntime(
          database,
          makeActionRepository(),
          makeActionPermissionService(permissions),
          makeOperationalScopeResolver(makeOperationalScopeRepository(database), access),
          {
            contextAccess: access,
            moduleEntrypointGateway: makeModuleEntrypointGateway(gate),
            moduleStateGate: gate,
            resolveCompositionRevision: makeActionCompositionRevisionResolver(authority, composition.shell.deployment),
          },
        );
        const invoke = (
          payload: ConfigureAgentPayload,
          key = randomUUID(),
          company = legalEntityId,
          operator = actorId,
        ) =>
          runtime
            .runAction({
              payload,
              principal: {
                authBindingId: operator === actorId ? bindingId : ordinaryId,
                authContextRef: `session:${randomUUID()}`,
                authenticationNamespaceId: registration.authenticationNamespaceId,
                authMethod: 'session',
                legalEntityId: company,
                principalId: operator,
                tenantId,
              },
              registration: configureAgentAction,
              transport: { correlationId: randomUUID(), idempotencyKey: key },
            })
            .pipe(Effect.provideService(AuthenticationNamespaceRegistry, registry));
        const payload: ConfigureAgentPayload = {
          description: null,
          displayName: 'Explicit native agent',
          modules: [{ access: 'write', moduleId: 'work.tasks' }],
          operation: 'create-agent',
          ownerPrincipalId: actorId,
          principalId: stableAgentId,
          writePolicy: 'approval',
        };
        const idempotencyKey = randomUUID();
        const created = yield* invoke(payload, idempotencyKey);
        expect(created).toMatchObject({
          operation: 'create-agent',
          principalId: stableAgentId,
          revision: 1,
          status: 'active',
        });
        const [membership] = yield* admin.executor
          .select()
          .from(principalCompanyMemberships)
          .where(
            and(
              eq(principalCompanyMemberships.tenantId, tenantId),
              eq(principalCompanyMemberships.principalId, stableAgentId),
            ),
          );
        expect(membership).toMatchObject({ affiliation: null, legalEntityId, status: 'active' });
        expect(yield* invoke(payload, idempotencyKey).pipe(Effect.flip)).toBeInstanceOf(ActionAlreadyCommitted);
        expect(yield* invoke(payload).pipe(Effect.flip)).toBeInstanceOf(IdentityLifecycleConflictError);
        const configure = {
          ...payload,
          description: 'Explicit administrator configuration',
          operation: 'configure-agent' as const,
          writePolicy: 'direct' as const,
        };
        const configured = yield* invoke(configure);
        expect(configured.revision).toBe(2);
        expect(yield* invoke(configure, randomUUID(), otherCompany).pipe(Effect.flip)).toBeInstanceOf(
          IdentityTargetInvalidError,
        );
        expect(yield* invoke({ ...configure, principalId: orphanAgentId }).pipe(Effect.flip)).toBeInstanceOf(
          IdentityTargetInvalidError,
        );
        expect(yield* invoke({ ...configure, ownerPrincipalId: ordinaryId }).pipe(Effect.flip)).toBeInstanceOf(
          IdentityTargetInvalidError,
        );
        expect(
          yield* invoke({ ...configure, modules: [...configure.modules, ...configure.modules] }).pipe(Effect.flip),
        ).toBeInstanceOf(IdentityTargetInvalidError);
        expect(yield* invoke(configure, randomUUID(), legalEntityId, ordinaryId).pipe(Effect.flip)).toBeInstanceOf(
          ActionPermissionDenied,
        );
        const events = yield* admin.executor
          .select({ evidence: auditEvents.evidenceJson })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.tenantId, tenantId),
              eq(auditEvents.eventType, 'action.executed'),
              eq(auditEvents.outcome, 'succeeded'),
            ),
          );
        const evidence = yield* Effect.forEach(events, (row) =>
          Schema.decodeUnknownEffect(ConfigureAgentAuditEvidenceSchema)(row.evidence),
        );
        expect(evidence).toHaveLength(2);
        const second = evidence.find((row) => row.revision === 2);
        expect(second).toMatchObject({
          legalEntityId,
          previousProfile: { description: null, writePolicy: 'approval' },
          targetPrincipalId: stableAgentId,
          writePolicy: 'direct',
        });
        expect(Schema.is(manageDemoAccountAction.descriptor.payloadSchema)(payload)).toBe(false);
        yield* admin.executor.insert(tenantModuleStates).values({ moduleKey: 'work.tasks', state: 'active', tenantId });
        const moduleId = toModuleAccessObjectId(tenantId, legalEntityId, 'work.tasks') ?? '';
        yield* Effect.promise(() =>
          graph.promises.writeRelationships(
            v1.WriteRelationshipsRequest.create({
              updates: [
                {
                  operation: v1.RelationshipUpdate_Operation.TOUCH,
                  relationship: relationship(
                    'module_access',
                    moduleId,
                    'legal_entity',
                    'legal_entity',
                    companyObject(legalEntityId),
                  ),
                },
              ],
            }),
          ),
        );
        const lifecycleAt = (endpoint: string) =>
          Layer.build(
            ActionAuthorizationLifecycleLive.pipe(
              Layer.provide(ScopedRoleMembershipLifecycleLive),
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(CoreDatabase, database),
                  Layer.succeed(DatabaseConfig, pair.runtime),
                  Layer.succeed(SpiceDbConfig, { ...config, endpoint }),
                  Layer.succeed(ActiveApplicationCompositionService, authority),
                ),
              ),
            ),
          ).pipe(Effect.map((context) => Context.get(context, ActionAuthorizationLifecycle)));
        const lifecycle = yield* lifecycleAt(config.endpoint);
        const unavailableLifecycle = yield* lifecycleAt('localhost:1');
        const outbox = makeOutboxRuntime(makeOutboxRepository(database.executor));
        const drain = (service = lifecycle, advanceMs = 1) =>
          Effect.gen(function* drainProfileWakeups() {
            yield* outbox.matchMessages({ compositionRevision: composition.revision });
            const [clock] = yield* admin.executor.execute<{ now: Date }>(
              sql`select clock_timestamp() + ${advanceMs} * interval '1 millisecond' as now`,
              'objects',
            );
            if (clock === undefined) {
              return expect.unreachable('Missing database clock');
            }
            return yield* outbox
              .runCycle({
                claimOwner: 'owned-agent-profile',
                compositionRevision: composition.revision,
                maxDeliveries: 20,
                now: clock.now,
                registrations: coreSystemOutboxWorkers.filter(
                  (worker) => worker.descriptor.workerKey === corePrincipalLifecycleSubscription.workerKey,
                ),
                subscriptions: [corePrincipalLifecycleSubscription],
              })
              .pipe(Effect.provideService(ActionAuthorizationLifecycle, service));
          });
        const canWrite = () =>
          Effect.promise(() =>
            graph.promises.checkPermission(
              v1.CheckPermissionRequest.create({
                consistency: { requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } },
                permission: 'write_all',
                resource: { objectId: moduleId, objectType: 'module_access' },
                subject: { object: { objectId: stableAgentId, objectType: 'principal' } },
              }),
            ),
          ).pipe(
            Effect.map((answer) => answer.permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION),
          );
        expect((yield* drain()).failed).toBe(0);
        expect(yield* canWrite()).toBe(true);
        const ownRole = agentScopedRoleObjectId({ legalEntityId, principalId: stableAgentId, tenantId });
        const obsoleteAction = { actionKey: 'work.tasks.obsolete-direct', legalEntityId, tenantId };
        yield* Effect.promise(() =>
          graph.promises.writeRelationships(
            v1.WriteRelationshipsRequest.create({
              updates: [
                ...buildActionAuthorizationRelationships([obsoleteAction]),
                relationship(
                  'action_grant',
                  toSpiceDbActionGrantObjectId(obsoleteAction),
                  'role',
                  'scoped_role',
                  ownRole,
                  'member',
                ),
              ].map((row) => ({ operation: v1.RelationshipUpdate_Operation.TOUCH, relationship: row })),
            }),
          ),
        );
        const canExecuteObsolete = () =>
          Effect.promise(() =>
            graph.promises.checkPermission(
              v1.CheckPermissionRequest.create({
                consistency: { requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } },
                permission: 'execute',
                resource: { objectId: toSpiceDbActionObjectId(obsoleteAction), objectType: 'action' },
                subject: { object: { objectId: stableAgentId, objectType: 'principal' } },
              }),
            ),
          ).pipe(
            Effect.map((answer) => answer.permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION),
          );
        expect(yield* canExecuteObsolete()).toBe(true);
        // Commit a downgrade without the Shell graph write, then fail its actual outbox delivery.
        yield* invoke({ ...configure, writePolicy: 'read_only' });
        expect(yield* canWrite()).toBe(true);
        const failedDelivery = yield* drain(unavailableLifecycle);
        expect(failedDelivery.retried).toBe(1);
        expect(failedDelivery.succeeded).toBe(0);
        expect((yield* drain(lifecycle, 2000)).succeeded).toBe(1);
        expect(yield* canWrite()).toBe(false);
        expect(yield* canExecuteObsolete()).toBe(false);
        // A stale downgrade wake-up must reload a newer audited upgrade, not replay old profile state.
        yield* invoke({ ...configure, writePolicy: 'read_only' });
        yield* invoke(configure);
        expect((yield* drain()).succeeded).toBe(2);
        expect(yield* canWrite()).toBe(true);
        yield* lifecycle.reconcilePrincipal(tenantId, stableAgentId, composition.revision);
        expect(yield* canWrite()).toBe(true);
        const actualAgentGraph = yield* Effect.promise(() =>
          graph.promises.readRelationships(
            v1.ReadRelationshipsRequest.create({
              relationshipFilter: {
                optionalSubjectFilter: { optionalSubjectId: stableAgentId, subjectType: 'principal' },
                resourceType: 'action',
              },
            }),
          ),
        );
        expect(actualAgentGraph).toHaveLength(0);
      }).pipe(Effect.scoped),
    120_000,
  );
});
