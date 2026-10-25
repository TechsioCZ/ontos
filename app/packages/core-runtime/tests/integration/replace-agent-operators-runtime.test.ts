import { randomUUID } from 'node:crypto';
import { v1 } from '@authzed/authzed-node';
import { and, eq } from 'drizzle-orm';
import { Context, DateTime, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { expect, it } from 'effect-rstest';

import { ActionAlreadyCommitted, ActionPermissionDenied } from '../../src/actions/errors.ts';
import { makeActionRepository } from '../../src/actions/repository.ts';
import { makeActionCompositionRevisionResolver, makeActionRuntime } from '../../src/actions/runtime.ts';
import {
  AuthenticationNamespaceRegistry,
  makeAuthenticationNamespaceRegistry,
} from '../../src/auth/external-identity/verifier.ts';
import {
  IdentityLifecycleConflictError,
  IdentityTargetInvalidError,
} from '../../src/auth/principal-management-errors.ts';
import { staffAuthenticationNamespaceRegistration } from '../../src/auth/staff-authentication-namespace.ts';
import { CoreDatabase, makeCoreDatabase } from '../../src/db/client.ts';
import { DatabaseConfig, loadDatabaseConnectionPair } from '../../src/db/config.ts';
import {
  applicationCompositionAuthority,
  auditEvents,
  domainEvents,
  legalEntities,
  outboxMessages,
  principalAuthBindings,
  principalCompanyMemberships,
  principals,
  tenants,
} from '../../src/db/schema.ts';
import { buildActionAuthorizationRelationships } from '../../src/install/action-authorization-provisioning.ts';
import { ActiveApplicationCompositionService } from '../../src/modules/active-application-composition.ts';
import {
  readLatestAgentOperatorCommand,
  ReplaceAgentOperatorsAuditEvidenceSchema,
} from '../../src/modules/actions/agent-operator-command.ts';
import type { ReplaceAgentOperatorsPayload } from '../../src/modules/actions/agent-operator-command.ts';
import { manageAgentStatusAction } from '../../src/modules/actions/manage-agent-status.action.ts';
import { replaceAgentOperatorsAction } from '../../src/modules/actions/replace-agent-operators.action.ts';
import { makeModuleEntrypointGateway } from '../../src/modules/module-entrypoint-gateway.ts';
import { makeModuleStateGate } from '../../src/modules/module-state-gate.ts';
import { makeTenantModuleStateService } from '../../src/modules/tenant-module-state-service.ts';
import { makeOperationalScopeRepository, makeOperationalScopeResolver } from '../../src/operations/context.ts';
import { CORE_SYSTEM_OUTBOX_SUBSCRIPTIONS } from '../../src/outbox/core-system-subscriptions.ts';
import {
  ActionAuthorizationLifecycle,
  ActionAuthorizationLifecycleLive,
} from '../../src/permissions/action-authorization-lifecycle.ts';
import { createSpiceDbPermissionClient, fullyConsistent } from '../../src/permissions/client.ts';
import { SpiceDbConfig, loadSpiceDbConfig } from '../../src/permissions/config.ts';
import { makeContextAccess, toLegalEntityAccessObjectId } from '../../src/permissions/context-access.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';
import { ScopedRoleMembershipLifecycleLive } from '../../src/permissions/scoped-role-membership-lifecycle.ts';
import { toScopedRoleObjectId } from '../../src/permissions/scoped-role.ts';
import { makeActionPermissionService } from '../../src/permissions/service.ts';
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

const operatorIds = (answers: readonly v1.ReadRelationshipsResponse[]) =>
  answers
    .flatMap(({ relationship: row }) => (row?.subject?.object === undefined ? [] : [row.subject.object.objectId]))
    .toSorted();

// Root runs this only against the same explicitly isolated native-services harness as configure-agent-runtime.
it.layer(Reactivity.layer, { excludeTestServices: true })('native agent operator lifecycle', (suite) => {
  suite.effect(
    'commits tenant-agent-global optimistic commands with trusted audit and projects only latest live members outside SQL',
    () =>
      Effect.gen(function* nativeOperatorProof() {
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
        const composition = makeOutboxWorkerComposition([]);
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
        const foreignTenantId = randomUUID();
        const legalEntityId = randomUUID();
        const secondCompanyId = randomUUID();
        const actorId = randomUUID();
        const bindingId = randomUUID();
        const agentId = randomUUID();
        const legacyAgentId = randomUUID();
        const firstHumanId = randomUUID();
        const secondHumanId = randomUUID();
        const disabledHumanId = randomUUID();
        const foreignHumanId = randomUUID();
        const foreignAgentId = randomUUID();
        const registration = yield* staffAuthenticationNamespaceRegistration(['core-runtime-test']);
        const registry = makeAuthenticationNamespaceRegistry([registration]);
        yield* admin.executor.insert(tenants).values(
          [tenantId, foreignTenantId].map((id) => ({
            defaultLocale: 'cs',
            name: 'Owned operator proof',
            slug: `operators-${id}`,
            status: 'active' as const,
            tenantId: id,
          })),
        );
        yield* admin.executor.insert(legalEntities).values(
          [legalEntityId, secondCompanyId].map((id) => ({
            legalEntityId: id,
            legalName: 'Owned operator company',
            registrationCountry: 'CZ',
            registrationNumber: id,
            status: 'active' as const,
            tenantId,
          })),
        );
        yield* admin.executor.insert(principals).values([
          ...[actorId, firstHumanId, secondHumanId, disabledHumanId].map((id) => ({
            displayName: 'Owned human',
            kind: 'human' as const,
            principalId: id,
            status: id === disabledHumanId ? ('disabled' as const) : ('active' as const),
            tenantId,
          })),
          ...[agentId, legacyAgentId].map((id) => ({
            displayName: 'Owned agent',
            kind: 'agent' as const,
            principalId: id,
            status: 'active' as const,
            tenantId,
          })),
          {
            displayName: 'Foreign human',
            kind: 'human',
            principalId: foreignHumanId,
            status: 'active',
            tenantId: foreignTenantId,
          },
          {
            displayName: 'Foreign agent',
            kind: 'agent',
            principalId: foreignAgentId,
            status: 'active',
            tenantId: foreignTenantId,
          },
        ]);
        yield* admin.executor.insert(principalCompanyMemberships).values(
          [legalEntityId, secondCompanyId].map((company) => ({
            affiliation: null,
            legalEntityId: company,
            principalId: agentId,
            status: 'active' as const,
            tenantId,
          })),
        );
        yield* admin.executor.insert(principalAuthBindings).values(
          [actorId, firstHumanId].map((id) => ({
            authenticationNamespaceId: registration.authenticationNamespaceId,
            principalAuthBindingId: id === actorId ? bindingId : firstHumanId,
            principalId: id,
            provider: 'better_auth',
            providerSubjectId: randomUUID(),
            status: 'active' as const,
            subjectType: 'user' as const,
            tenantId,
          })),
        );
        const companyObject = (id: string) =>
          toLegalEntityAccessObjectId(tenantId, id) ?? expect.unreachable('Invalid company identity');
        const role = toScopedRoleObjectId({ roleKey: 'tenant-superadmin', tenantId });
        const rows = [
          ...[actorId, firstHumanId, secondHumanId].map((id) =>
            relationship('tenant', tenantId, 'member', 'principal', id),
          ),
          ...[legalEntityId, secondCompanyId].flatMap((company) => [
            relationship('legal_entity', companyObject(company), 'tenant', 'tenant', tenantId),
            ...[actorId, agentId, legacyAgentId, firstHumanId, secondHumanId].map((id) =>
              relationship('legal_entity', companyObject(company), 'member', 'principal', id),
            ),
          ]),
          relationship('scoped_role', role, 'member', 'principal', actorId),
          relationship('tenant', tenantId, 'superadmin', 'scoped_role', role, 'member'),
          relationship('principal', legacyAgentId, 'operator', 'principal', firstHumanId),
          ...buildActionAuthorizationRelationships(
            [legalEntityId, secondCompanyId].flatMap((company) =>
              [replaceAgentOperatorsAction, manageAgentStatusAction].map(({ descriptor }) => ({
                actionKey: descriptor.actionKey,
                legalEntityId: company,
                tenantId,
              })),
            ),
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
        const principal = {
          authBindingId: bindingId,
          authContextRef: `session:${randomUUID()}`,
          authenticationNamespaceId: registration.authenticationNamespaceId,
          authMethod: 'session' as const,
          legalEntityId,
          principalId: actorId,
          tenantId,
        };
        const invoke = (
          payload: ReplaceAgentOperatorsPayload,
          idempotencyKey = randomUUID(),
          company = legalEntityId,
        ) =>
          runtime
            .runAction({
              payload,
              principal: { ...principal, legalEntityId: company },
              registration: replaceAgentOperatorsAction,
              transport: { correlationId: randomUUID(), idempotencyKey },
            })
            .pipe(Effect.provideService(AuthenticationNamespaceRegistry, registry));
        const payload: ReplaceAgentOperatorsPayload = {
          agentPrincipalId: agentId,
          context: 'operators-edited',
          expectedRevision: 0,
          operatorPrincipalIds: [firstHumanId],
          revokedConnections: 0,
        };
        for (const change of [
          { agentPrincipalId: actorId },
          { agentPrincipalId: foreignAgentId },
          { operatorPrincipalIds: [foreignHumanId] },
          { operatorPrincipalIds: [disabledHumanId] },
          { operatorPrincipalIds: [agentId] },
          { operatorPrincipalIds: [randomUUID()] },
        ]) {
          expect(yield* invoke({ ...payload, ...change }).pipe(Effect.flip)).toBeInstanceOf(IdentityTargetInvalidError);
        }
        expect(
          yield* runtime
            .runAction({
              payload,
              principal: { ...principal, authBindingId: firstHumanId, principalId: firstHumanId },
              registration: replaceAgentOperatorsAction,
              transport: { correlationId: randomUUID(), idempotencyKey: randomUUID() },
            })
            .pipe(Effect.provideService(AuthenticationNamespaceRegistry, registry), Effect.flip),
        ).toBeInstanceOf(ActionPermissionDenied);
        const key = randomUUID();
        expect(yield* invoke(payload, key)).toMatchObject({
          agentPrincipalId: agentId,
          projection: 'pending',
          revision: 1,
        });
        expect(yield* invoke(payload, key).pipe(Effect.flip)).toBeInstanceOf(ActionAlreadyCommitted);
        expect(yield* invoke(payload).pipe(Effect.flip)).toBeInstanceOf(IdentityLifecycleConflictError);
        // Different-company requests compete for the SAME revision and complete desired set.
        expect(
          yield* invoke({ ...payload, operatorPrincipalIds: [secondHumanId] }, randomUUID(), secondCompanyId).pipe(
            Effect.flip,
          ),
        ).toBeInstanceOf(IdentityLifecycleConflictError);
        yield* invoke(
          { ...payload, expectedRevision: 1, operatorPrincipalIds: [secondHumanId] },
          randomUUID(),
          secondCompanyId,
        );
        const latest = yield* readLatestAgentOperatorCommand(admin.executor, tenantId, agentId);
        expect(latest).toMatchObject({
          desiredOperatorPrincipalIds: [secondHumanId],
          legalEntityId: secondCompanyId,
          revision: 2,
        });
        const audits = yield* admin.executor
          .select()
          .from(auditEvents)
          .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.eventType, 'action.executed')));
        expect(audits).toHaveLength(2);
        for (const row of audits) {
          expect(row).toMatchObject({
            auditProfile: 'sensitive',
            authBindingId: bindingId,
            authContextRef: principal.authContextRef,
            authMethod: 'session',
            outcome: 'succeeded',
            principalId: actorId,
          });
          yield* Schema.decodeUnknownEffect(ReplaceAgentOperatorsAuditEvidenceSchema)(row.evidenceJson);
        }
        const events = yield* admin.executor.select().from(domainEvents).where(eq(domainEvents.tenantId, tenantId));
        const wakeups = yield* admin.executor
          .select()
          .from(outboxMessages)
          .where(eq(outboxMessages.tenantId, tenantId));
        expect(events).toHaveLength(2);
        expect(wakeups).toHaveLength(2);
        expect(
          events.every((event) => event.subjectResourceId === agentId && event.subjectResourceType === 'principal'),
        ).toBe(true);
        const lifecycleContext = yield* Layer.build(
          ActionAuthorizationLifecycleLive.pipe(
            Layer.provide(ScopedRoleMembershipLifecycleLive),
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(CoreDatabase, database),
                Layer.succeed(DatabaseConfig, pair.runtime),
                Layer.succeed(SpiceDbConfig, config),
                Layer.succeed(ActiveApplicationCompositionService, authority),
              ),
            ),
          ),
        );
        const lifecycle = Context.get(lifecycleContext, ActionAuthorizationLifecycle);
        const operatorsOf = (id: string) =>
          Effect.promise(() =>
            graph.promises.readRelationships(
              v1.ReadRelationshipsRequest.create({
                consistency: fullyConsistent,
                relationshipFilter: { optionalRelation: 'operator', optionalResourceId: id, resourceType: 'principal' },
              }),
            ),
          ).pipe(Effect.map(operatorIds));
        expect(yield* operatorsOf(agentId)).toEqual([]);
        yield* lifecycle.reconcilePrincipal(tenantId, agentId, composition.revision);
        expect(yield* operatorsOf(agentId)).toEqual([secondHumanId]);
        // Replaying an old delivery still loads revision 2; it cannot append another Action/audit.
        yield* lifecycle.reconcilePrincipal(tenantId, agentId, composition.revision);
        expect(yield* operatorsOf(agentId)).toEqual([secondHumanId]);
        expect(
          yield* admin.executor
            .select()
            .from(auditEvents)
            .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.eventType, 'action.executed'))),
        ).toHaveLength(2);
        // This human has graph-only company membership. Remove it after the command commits.
        yield* Effect.promise(() =>
          graph.promises.writeRelationships(
            v1.WriteRelationshipsRequest.create({
              updates: [
                {
                  operation: v1.RelationshipUpdate_Operation.DELETE,
                  relationship: relationship(
                    'legal_entity',
                    companyObject(secondCompanyId),
                    'member',
                    'principal',
                    secondHumanId,
                  ),
                },
              ],
            }),
          ),
        );
        yield* lifecycle.reconcilePrincipal(tenantId, agentId, composition.revision);
        expect(yield* operatorsOf(agentId)).toEqual([]);
        // An existing agent with no native command retains its operators.
        yield* lifecycle.reconcilePrincipal(tenantId, legacyAgentId, composition.revision);
        expect(yield* operatorsOf(legacyAgentId)).toEqual([firstHumanId]);
        // Archive must remove even an old operator edge unrelated to the newest desired command.
        yield* Effect.promise(() =>
          graph.promises.writeRelationships(
            v1.WriteRelationshipsRequest.create({
              updates: [
                {
                  operation: v1.RelationshipUpdate_Operation.TOUCH,
                  relationship: relationship('principal', agentId, 'operator', 'principal', firstHumanId),
                },
              ],
            }),
          ),
        );
        expect(yield* operatorsOf(agentId)).toEqual([firstHumanId]);
        // Archive is the only deletion command; no operator-change command is recorded for cleanup.
        yield* runtime
          .runAction({
            payload: {
              expectedStatus: 'active',
              operation: 'archive-agent',
              principalId: agentId,
              reason: 'Owned archive proof',
            },
            principal,
            registration: manageAgentStatusAction,
            transport: { correlationId: randomUUID(), idempotencyKey: randomUUID() },
          })
          .pipe(Effect.provideService(AuthenticationNamespaceRegistry, registry));
        yield* lifecycle.reconcilePrincipal(tenantId, agentId, composition.revision);
        expect(yield* operatorsOf(agentId)).toEqual([]);
        expect(yield* invoke({ ...payload, expectedRevision: 2 }).pipe(Effect.flip)).toBeInstanceOf(
          IdentityTargetInvalidError,
        );
      }).pipe(Effect.scoped),
    120_000,
  );
});
