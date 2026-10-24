import { randomUUID } from 'node:crypto';
import { v1 } from '@authzed/authzed-node';
import { and, eq } from 'drizzle-orm';
import { ConfigProvider, DateTime, Effect, Schema } from 'effect';
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
import { makeCoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import {
  applicationCompositionAuthority,
  auditEvents,
  dataAccessEvents,
  domainEvents,
  outboxMessages,
  legalEntities,
  principalAuthBindings,
  principalCompanyMemberships,
  principals,
  tenants,
} from '../../src/db/schema.ts';
import { buildActionAuthorizationRelationships } from '../../src/install/action-authorization-provisioning.ts';
import {
  manageAgentStatusAction,
  ManageAgentStatusAuditEvidenceSchema,
} from '../../src/modules/actions/manage-agent-status.action.ts';
import type { ManageAgentStatusPayload } from '../../src/modules/actions/manage-agent-status.action.ts';
import {
  manageDemoAccountAction,
  ManageDemoAccountPayloadSchema,
} from '../../src/modules/actions/manage-demo-account.action.ts';
import type { ManageDemoAccountPayload } from '../../src/modules/actions/manage-demo-account.action.ts';
import { makeModuleEntrypointGateway } from '../../src/modules/module-entrypoint-gateway.ts';
import { makeModuleStateGate } from '../../src/modules/module-state-gate.ts';
import { makeTenantModuleStateService } from '../../src/modules/tenant-module-state-service.ts';
import { makeOperationalScopeRepository, makeOperationalScopeResolver } from '../../src/operations/context.ts';
import { CORE_SYSTEM_OUTBOX_SUBSCRIPTIONS } from '../../src/outbox/core-system-subscriptions.ts';
import { createSpiceDbPermissionClient } from '../../src/permissions/client.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import { makeContextAccess, toLegalEntityAccessObjectId } from '../../src/permissions/context-access.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';
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

it.live(
  'governs company-admin agent deactivate, reactivate and archive with exact targets, audit, events and idempotence',
  () =>
    Effect.gen(function* nativeAgentStatusProof() {
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
      const composition = makeOutboxWorkerComposition();
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
      const archivedAgentId = randomUUID();
      const inactiveAgentId = randomUUID();
      const affiliatedAgentId = randomUUID();
      const bindingId = randomUUID();
      const registration = yield* staffAuthenticationNamespaceRegistration(['core-runtime-test']);
      const registry = makeAuthenticationNamespaceRegistry([registration]);
      yield* admin.executor.insert(tenants).values({
        defaultLocale: 'cs',
        name: 'Owned agent status proof',
        slug: `agent-status-${tenantId}`,
        status: 'active',
        tenantId,
      });
      yield* admin.executor.insert(legalEntities).values(
        [legalEntityId, otherCompany].map((id) => ({
          legalEntityId: id,
          legalName: 'Owned status company',
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
        ...[stableAgentId, orphanAgentId, inactiveAgentId, affiliatedAgentId].map((principalId) => ({
          displayName: 'Owned native agent',
          kind: 'agent' as const,
          principalId,
          status: 'active' as const,
          tenantId,
        })),
        { displayName: 'Archived agent', kind: 'agent', principalId: archivedAgentId, status: 'archived', tenantId },
      ]);
      yield* admin.executor.insert(principalCompanyMemberships).values([
        ...[actorId, ordinaryId].map((principalId) => ({
          affiliation: 'external' as const,
          legalEntityId,
          principalId,
          status: 'active' as const,
          tenantId,
        })),
        ...[stableAgentId, archivedAgentId].map((principalId) => ({
          affiliation: null,
          legalEntityId,
          principalId,
          status: 'active' as const,
          tenantId,
        })),
        { affiliation: null, legalEntityId, principalId: inactiveAgentId, status: 'disabled', tenantId },
        { affiliation: 'external', legalEntityId, principalId: affiliatedAgentId, status: 'active', tenantId },
      ]);
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
      const role = (company: string) =>
        toScopedRoleObjectId({ legalEntityId: company, roleKey: 'company-admin', tenantId });
      const rows = [
        ...[actorId, ordinaryId].map((id) => relationship('tenant', tenantId, 'member', 'principal', id)),
        ...[legalEntityId, otherCompany].map((id) =>
          relationship('legal_entity', companyObject(id), 'tenant', 'tenant', tenantId),
        ),
        ...[legalEntityId, otherCompany].flatMap((company) => [
          ...[actorId, ordinaryId].map((id) =>
            relationship('legal_entity', companyObject(company), 'member', 'principal', id),
          ),
          relationship('scoped_role', role(company), 'member', 'principal', actorId),
          relationship('legal_entity', companyObject(company), 'admin', 'scoped_role', role(company), 'member'),
        ]),
        ...buildActionAuthorizationRelationships(
          [legalEntityId, otherCompany].map((id) => ({
            actionKey: manageAgentStatusAction.descriptor.actionKey,
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
        payload: ManageAgentStatusPayload,
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
            registration: manageAgentStatusAction,
            transport: { correlationId: randomUUID(), idempotencyKey: key },
          })
          .pipe(Effect.provideService(AuthenticationNamespaceRegistry, registry));
      const tenantPermission = yield* Effect.promise(() =>
        graph.promises.checkPermission(
          v1.CheckPermissionRequest.create({
            consistency: { requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } },
            permission: 'manage_identity',
            resource: { objectId: tenantId, objectType: 'tenant' },
            subject: { object: { objectId: actorId, objectType: 'principal' } },
          }),
        ),
      );
      expect(tenantPermission.permissionship).toBe(v1.CheckPermissionResponse_Permissionship.NO_PERMISSION);
      const payload: ManageAgentStatusPayload = {
        expectedStatus: 'active',
        newStatus: 'disabled',
        operation: 'change-status',
        principalId: stableAgentId,
        reason: 'Owned deactivation proof',
      };
      const idempotencyKey = randomUUID();
      const deactivated = yield* invoke(payload, idempotencyKey);
      expect(deactivated).toMatchObject({ operation: 'change-status', principalId: stableAgentId, status: 'disabled' });
      const loadAgent = () =>
        admin.executor
          .select()
          .from(principals)
          .where(and(eq(principals.tenantId, tenantId), eq(principals.principalId, stableAgentId)));
      const [disabled] = yield* loadAgent();
      expect(disabled?.status).toBe('disabled');
      expect(disabled?.disabledAt).toBeInstanceOf(Date);
      expect(yield* invoke(payload, idempotencyKey).pipe(Effect.flip)).toBeInstanceOf(ActionAlreadyCommitted);
      expect(yield* invoke(payload).pipe(Effect.flip)).toBeInstanceOf(IdentityLifecycleConflictError);
      const reactivate: ManageAgentStatusPayload = { ...payload, expectedStatus: 'disabled', newStatus: 'active' };
      expect((yield* invoke(reactivate)).status).toBe('active');
      const [active] = yield* loadAgent();
      expect(active?.disabledAt).toBeNull();
      expect(yield* invoke(payload, randomUUID(), otherCompany).pipe(Effect.flip)).toBeInstanceOf(
        IdentityTargetInvalidError,
      );
      for (const principalId of [
        actorId,
        ordinaryId,
        orphanAgentId,
        archivedAgentId,
        inactiveAgentId,
        affiliatedAgentId,
        randomUUID(),
      ]) {
        expect(yield* invoke({ ...payload, principalId }).pipe(Effect.flip)).toBeInstanceOf(IdentityTargetInvalidError);
      }
      const { reason: omittedReason, ...withoutReason } = payload;
      expect(omittedReason).toBeDefined();
      expect(yield* invoke(withoutReason).pipe(Effect.flip)).toBeInstanceOf(IdentityTargetInvalidError);
      expect(yield* invoke(payload, randomUUID(), legalEntityId, ordinaryId).pipe(Effect.flip)).toBeInstanceOf(
        ActionPermissionDenied,
      );
      const archive: ManageAgentStatusPayload = {
        expectedStatus: 'active',
        operation: 'archive-agent',
        principalId: stableAgentId,
        reason: 'Owned archive proof',
      };
      const archiveKey = randomUUID();
      expect((yield* invoke(archive, archiveKey)).status).toBe('archived');
      expect(yield* invoke(archive, archiveKey).pipe(Effect.flip)).toBeInstanceOf(ActionAlreadyCommitted);
      expect(yield* invoke(reactivate).pipe(Effect.flip)).toBeInstanceOf(IdentityTargetInvalidError);
      const [archived] = yield* loadAgent();
      expect(archived?.status).toBe('archived');
      expect(archived?.disabledAt).toBeInstanceOf(Date);
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
      const evidence = yield* Effect.forEach(
        events,
        (row) => Schema.decodeUnknownEffect(ManageAgentStatusAuditEvidenceSchema)(row.evidence),
        { concurrency: 1 },
      );
      expect(evidence).toHaveLength(3);
      expect(evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            legalEntityId,
            newStatus: 'disabled',
            previousStatus: 'active',
            reason: payload.reason,
            targetPrincipalId: stableAgentId,
          }),
          expect.objectContaining({
            legalEntityId,
            newStatus: 'active',
            previousStatus: 'disabled',
            targetPrincipalId: stableAgentId,
          }),
          expect.objectContaining({
            legalEntityId,
            newStatus: 'archived',
            previousStatus: 'active',
            reason: archive.reason,
            targetPrincipalId: stableAgentId,
          }),
        ]),
      );
      const lifecycle = yield* admin.executor.select().from(domainEvents).where(eq(domainEvents.tenantId, tenantId));
      expect(lifecycle).toHaveLength(3);
      expect(lifecycle.every((event) => event.subjectResourceId === stableAgentId)).toBe(true);
      const outbox = yield* admin.executor.select().from(outboxMessages).where(eq(outboxMessages.tenantId, tenantId));
      expect(outbox).toHaveLength(3);
      const accessEvents = yield* admin.executor
        .select()
        .from(dataAccessEvents)
        .where(eq(dataAccessEvents.tenantId, tenantId));
      expect(accessEvents).toHaveLength(6);

      // The demo helper retains human administration but no longer accepts any agent lifecycle operation.
      expect(Schema.is(ManageDemoAccountPayloadSchema)(archive)).toBe(false);
      yield* Effect.promise(() =>
        graph.promises.writeRelationships(
          v1.WriteRelationshipsRequest.create({
            updates: [
              ...buildActionAuthorizationRelationships([
                { actionKey: manageDemoAccountAction.descriptor.actionKey, legalEntityId, tenantId },
              ]),
              relationship('tenant', tenantId, 'identity_admin', 'principal', actorId),
            ].map((row) => ({ operation: v1.RelationshipUpdate_Operation.TOUCH, relationship: row })),
          }),
        ),
      );
      const invokeDemo = (demoPayload: ManageDemoAccountPayload) =>
        runtime
          .runAction({
            payload: demoPayload,
            principal: {
              authBindingId: bindingId,
              authContextRef: `session:${randomUUID()}`,
              authenticationNamespaceId: registration.authenticationNamespaceId,
              authMethod: 'session',
              legalEntityId,
              principalId: actorId,
              tenantId,
            },
            registration: manageDemoAccountAction,
            transport: { correlationId: randomUUID(), idempotencyKey: randomUUID() },
          })
          .pipe(
            Effect.provideService(AuthenticationNamespaceRegistry, registry),
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({ ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'development' }),
            ),
          );
      const demoAgentError = yield* invokeDemo({ ...payload, principalId: orphanAgentId }).pipe(Effect.flip);
      expect(demoAgentError).toBeInstanceOf(IdentityTargetInvalidError);
      expect(demoAgentError).toMatchObject({ reason: 'The target is not a human principal of this tenant' });
      const humanDisabled = yield* invokeDemo({ ...payload, principalId: ordinaryId });
      expect(humanDisabled).toMatchObject({ operation: 'change-status', principalId: ordinaryId, status: 'disabled' });
      const humanActive = yield* invokeDemo({
        expectedStatus: 'disabled',
        newStatus: 'active',
        operation: 'change-status',
        principalId: ordinaryId,
      });
      expect(humanActive.status).toBe('active');
    }).pipe(Effect.scoped),
  120_000,
);
