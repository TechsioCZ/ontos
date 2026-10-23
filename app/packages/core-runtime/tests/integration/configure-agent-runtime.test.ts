import { randomUUID } from 'node:crypto';
import { v1 } from '@authzed/authzed-node';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Schema } from 'effect';
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
  legalEntities,
  principalAuthBindings,
  principalCompanyMemberships,
  principals,
  tenants,
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
          target: applicationCompositionAuthority.authorityKey,
          set: { revision: composition.revision, validUntil: DateTime.toDateUtc(snapshot.validUntil) },
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
      yield* admin.executor
        .insert(tenants)
        .values({
          defaultLocale: 'cs',
          name: 'Owned agent profile proof',
          slug: `agent-${tenantId}`,
          status: 'active',
          tenantId,
        });
      yield* admin.executor
        .insert(legalEntities)
        .values(
          [legalEntityId, otherCompany].map((id) => ({
            legalEntityId: id,
            legalName: 'Owned profile company',
            registrationCountry: 'CZ',
            registrationNumber: id,
            status: 'active' as const,
            tenantId,
          })),
        );
      yield* admin.executor
        .insert(principals)
        .values([
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
      yield* admin.executor
        .insert(principalAuthBindings)
        .values(
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
        operation: 'configure-agent' as const,
        description: 'Explicit administrator configuration',
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
