import { randomUUID } from 'node:crypto';

import { v1 } from '@authzed/authzed-node';
import { and, eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Layer, Option, Result, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { expect, it } from 'effect-rstest';

import { ActionAlreadyCommitted, ActionPermissionDenied } from '../../src/actions/errors.ts';
import {
  IdentityLifecycleConflictError,
  IdentityTargetInvalidError,
} from '../../src/auth/principal-management-errors.ts';
import { OperationContextDenied } from '../../src/operations/errors.ts';
import { makeActionRepository } from '../../src/actions/repository.ts';
import { makeActionCompositionRevisionResolver, makeActionRuntime } from '../../src/actions/runtime.ts';
import { AuthenticationNamespaceRegistrationSchema } from '../../src/auth/external-identity-contracts.ts';
import {
  AuthenticationNamespaceRegistry,
  makeAuthenticationNamespaceRegistry,
} from '../../src/auth/external-identity/verifier.ts';
import { CoreDatabase, makeCoreDatabase } from '../../src/db/client.ts';
import { DatabaseConfig, loadDatabaseConnectionPair } from '../../src/db/config.ts';
import {
  applicationCompositionAuthority,
  auditEvents,
  domainEvents,
  legalEntities,
  principalAuthBindings,
  principalCompanyMemberships,
  principals,
  tenants,
} from '../../src/db/schema.ts';
import { buildActionAuthorizationRelationships } from '../../src/install/action-authorization-provisioning.ts';
import { ActiveApplicationCompositionService } from '../../src/modules/active-application-composition.ts';
import { setCompanyMembershipAction } from '../../src/modules/actions/set-company-membership.action.ts';
import { makeModuleEntrypointGateway } from '../../src/modules/module-entrypoint-gateway.ts';
import { makeModuleStateGate } from '../../src/modules/module-state-gate.ts';
import { makeTenantModuleStateService } from '../../src/modules/tenant-module-state-service.ts';
import { makeOperationalScopeRepository, makeOperationalScopeResolver } from '../../src/operations/context.ts';
import {
  corePrincipalLifecycleSubscription,
  CORE_SYSTEM_OUTBOX_SUBSCRIPTIONS,
} from '../../src/outbox/core-system-subscriptions.ts';
import { coreSystemOutboxWorkers } from '../../src/outbox/core-system-worker-entry.ts';
import { makeOutboxRepository } from '../../src/outbox/repository.ts';
import { makeOutboxRuntime } from '../../src/outbox/runtime.ts';
import {
  ActionAuthorizationLifecycle,
  ActionAuthorizationLifecycleLive,
} from '../../src/permissions/action-authorization-lifecycle.ts';
import { createSpiceDbPermissionClient, fullyConsistent } from '../../src/permissions/client.ts';
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

type MembershipWirePayload = typeof setCompanyMembershipAction.descriptor.payloadSchema.Encoded;

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

// This suite owns the singleton authority and the graph schema, so never run it against a demo DB.
it.live(
  'commits explicit audited membership with CAS and projects only current SQL state through real PG outbox and SpiceDB',
  () =>
    Effect.gen(function* membershipRuntime() {
      const pair = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
      expect(pair.runtime.database).toMatch(/^people_model_scratch_20261023_[0-9a-f]+$/u);
      expect(pair.admin.database).toBe(pair.runtime.database);
      const configuration = yield* loadSpiceDbConfig();
      expect(configuration.endpoint).toMatch(/^localhost:\d+$/u);
      const database = yield* makeCoreDatabase(pair.runtime);
      const admin = yield* makeCoreDatabase(pair.admin);
      const client = yield* Effect.acquireRelease(
        Effect.sync(() => newSpiceDbGrpcClient(configuration)),
        (rpc) => Effect.sync(() => rpc.close()),
      );
      yield* Effect.promise(() =>
        client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })),
      );
      const composition = makeOutboxWorkerComposition();
      const authority = { load: freshOutboxWorkerCompositionSnapshot(composition) };
      const snapshot = yield* authority.load;
      yield* admin.executor.insert(applicationCompositionAuthority).values({
        authorityKey: 'active',
        phase: 'active',
        revision: composition.revision,
        subscriptionsJson: CORE_SYSTEM_OUTBOX_SUBSCRIPTIONS,
        validUntil: DateTime.toDateUtc(snapshot.validUntil),
      });

      const tenantId = randomUUID();
      const foreignTenantId = randomUUID();
      const companyId = randomUUID();
      const otherCompanyId = randomUUID();
      const companyAdmin = randomUUID();
      const superadmin = randomUUID();
      const auditor = randomUUID();
      const ordinaryMember = randomUUID();
      const human = randomUUID();
      const agent = randomUUID();
      const service = randomUUID();
      const foreignHuman = randomUUID();
      const namespace = Schema.decodeUnknownResult(AuthenticationNamespaceRegistrationSchema)({
        allowedAudiences: ['core-runtime-test'],
        authenticationNamespaceId: 'test.membership.better-auth.v1',
        provider: 'test-provider',
        requiresOperationAdmission: false,
        reservationPrincipalKind: 'human',
        subjectTypes: ['user'],
        trustedAttesterPrincipalIds: [],
      });
      const registration = Result.getOrThrow(namespace);
      const registry = makeAuthenticationNamespaceRegistry([registration]);
      yield* admin.executor.insert(tenants).values(
        [tenantId, foreignTenantId].map((id) => ({
          defaultLocale: 'en',
          name: 'Owned membership runtime',
          slug: `membership-runtime-${id}`,
          status: 'active',
          tenantId: id,
        })),
      );
      yield* admin.executor.insert(legalEntities).values(
        [companyId, otherCompanyId].map((id) => ({
          legalEntityId: id,
          legalName: 'Owned company',
          registrationCountry: 'CZ',
          registrationNumber: id,
          status: 'active',
          tenantId,
        })),
      );
      yield* admin.executor.insert(principals).values([
        ...[companyAdmin, superadmin, auditor, ordinaryMember, human].map((id) => ({
          displayName: 'Owned human',
          kind: 'human' as const,
          principalId: id,
          status: 'active' as const,
          tenantId,
        })),
        { displayName: 'Owned agent', kind: 'agent', principalId: agent, status: 'active', tenantId },
        { displayName: 'Technical service', kind: 'service', principalId: service, status: 'active', tenantId },
        {
          displayName: 'Foreign human',
          kind: 'human',
          principalId: foreignHuman,
          status: 'active',
          tenantId: foreignTenantId,
        },
      ]);
      const actorIds = [companyAdmin, superadmin, auditor, ordinaryMember];
      const bindings = actorIds.map((principalId) => ({
        authenticationNamespaceId: registration.authenticationNamespaceId,
        principalAuthBindingId: randomUUID(),
        principalId,
        provider: 'test-provider',
        providerSubjectId: randomUUID(),
        status: 'active' as const,
        subjectType: 'user' as const,
        tenantId,
      }));
      yield* admin.executor.insert(principalAuthBindings).values(bindings);
      const principal = (id: string, legalEntityId = companyId) => {
        const binding = bindings.find((row) => row.principalId === id);
        if (binding === undefined) {
          return expect.unreachable('Missing fixture binding');
        }
        return {
          authBindingId: binding.principalAuthBindingId,
          authContextRef: `session:${randomUUID()}`,
          authenticationNamespaceId: registration.authenticationNamespaceId,
          authMethod: 'session' as const,
          legalEntityId,
          principalId: id,
          tenantId,
        };
      };
      const roles = {
        auditor: toScopedRoleObjectId({ roleKey: 'tenant-auditor', tenantId }),
        companyAdmin: toScopedRoleObjectId({ legalEntityId: companyId, roleKey: 'company-admin', tenantId }),
        superadmin: toScopedRoleObjectId({ roleKey: 'tenant-superadmin', tenantId }),
      };
      const companyObjectId = (id: string) =>
        toLegalEntityAccessObjectId(tenantId, id) ?? expect.unreachable('Invalid fixture company scope');
      const relationships = [
        ...[...actorIds, human, agent].map((id) => relationship('tenant', tenantId, 'member', 'principal', id)),
        ...[companyId, otherCompanyId].map((id) =>
          relationship('legal_entity', companyObjectId(id), 'tenant', 'tenant', tenantId),
        ),
        ...[companyAdmin, ordinaryMember].map((id) =>
          relationship('legal_entity', companyObjectId(companyId), 'member', 'principal', id),
        ),
        relationship('scoped_role', roles.companyAdmin, 'member', 'principal', companyAdmin),
        relationship('legal_entity', companyObjectId(companyId), 'admin', 'scoped_role', roles.companyAdmin, 'member'),
        relationship('scoped_role', roles.superadmin, 'member', 'principal', superadmin),
        relationship('tenant', tenantId, 'superadmin', 'scoped_role', roles.superadmin, 'member'),
        relationship('scoped_role', roles.auditor, 'member', 'principal', auditor),
        relationship('tenant', tenantId, 'auditor', 'scoped_role', roles.auditor, 'member'),
        ...buildActionAuthorizationRelationships(
          [companyId, otherCompanyId].map((legalEntityId) => ({
            actionKey: setCompanyMembershipAction.descriptor.actionKey,
            legalEntityId,
            tenantId,
          })),
        ),
      ];
      yield* Effect.promise(() =>
        client.promises.writeRelationships(
          v1.WriteRelationshipsRequest.create({
            updates: relationships.map((item) => ({
              operation: v1.RelationshipUpdate_Operation.TOUCH,
              relationship: item,
            })),
          }),
        ),
      );
      const permission = createSpiceDbPermissionClient(configuration, 5000);
      const contextAccess = makeContextAccess(permission);
      const stateGate = makeModuleStateGate(makeTenantModuleStateService(database));
      const runtime = makeActionRuntime(
        database,
        makeActionRepository(),
        makeActionPermissionService(permission),
        makeOperationalScopeResolver(makeOperationalScopeRepository(database), contextAccess),
        {
          contextAccess,
          moduleEntrypointGateway: makeModuleEntrypointGateway(stateGate),
          moduleStateGate: stateGate,
          resolveCompositionRevision: makeActionCompositionRevisionResolver(authority, composition.shell.deployment),
        },
      );
      const invoke = (id: string, payload: MembershipWirePayload, legalEntityId = companyId, key = randomUUID()) =>
        runtime
          .runAction({
            payload,
            principal: principal(id, legalEntityId),
            registration: setCompanyMembershipAction,
            transport: { correlationId: randomUUID(), idempotencyKey: key },
          })
          .pipe(Effect.provideService(AuthenticationNamespaceRegistry, registry));
      const payload = {
        affiliation: 'employee',
        expectedRevision: 0,
        principalRef: { principalId: human, tenantId },
        reason: 'Administrator explicitly selected this company affiliation',
        status: 'active',
      } satisfies MembershipWirePayload;
      const countEvents = () =>
        admin.executor
          .select()
          .from(domainEvents)
          .where(eq(domainEvents.tenantId, tenantId))
          .pipe(Effect.map((rows) => rows.length));
      const initialMemberships = yield* admin.executor
        .select()
        .from(principalCompanyMemberships)
        .where(eq(principalCompanyMemberships.tenantId, tenantId));
      expect(initialMemberships).toHaveLength(0);
      const idempotencyKey = randomUUID();
      const created = yield* invoke(companyAdmin, payload, companyId, idempotencyKey);
      expect(created.revision).toBe(1);
      expect(created.affiliation).toEqual(Option.some('employee'));
      const replayed = yield* invoke(companyAdmin, payload, companyId, idempotencyKey).pipe(Effect.flip);
      expect(Schema.is(ActionAlreadyCommitted)(replayed)).toBe(true);
      expect(yield* countEvents()).toBe(1);
      const audits = yield* admin.executor
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.eventType, 'action.executed')));
      expect(audits).toHaveLength(1);
      expect(audits[0]?.evidenceJson).toMatchObject({
        affiliation: 'employee',
        expectedRevision: 0,
        legalEntityId: companyId,
        principalRef: payload.principalRef,
        reason: payload.reason,
        revision: 1,
        status: 'active',
      });

      yield* Effect.forEach(
        [ordinaryMember, auditor],
        Effect.fn(function* denyNonAdministrators(id) {
          const denied = yield* invoke(id, { ...payload, expectedRevision: 1, status: 'departed' }).pipe(Effect.flip);
          expect(Schema.is(ActionPermissionDenied)(denied)).toBe(true);
        }),
        { concurrency: 1 },
      );
      const invalidPayloads: readonly MembershipWirePayload[] = [
        { ...payload, principalRef: { principalId: foreignHuman, tenantId: foreignTenantId } },
        { ...payload, principalRef: { principalId: foreignHuman, tenantId } },
        { ...payload, principalRef: { principalId: service, tenantId } },
        { ...payload, principalRef: { principalId: agent, tenantId } },
        { ...payload, affiliation: null },
      ];
      yield* Effect.forEach(
        invalidPayloads,
        Effect.fn(function* rejectInvalidTarget(candidate) {
          const rejected = yield* invoke(companyAdmin, candidate).pipe(Effect.flip);
          expect(Schema.is(IdentityTargetInvalidError)(rejected)).toBe(true);
        }),
        { concurrency: 1 },
      );
      const foreignCompany = yield* invoke(companyAdmin, payload, otherCompanyId).pipe(Effect.flip);
      expect(Schema.is(OperationContextDenied)(foreignCompany)).toBe(true);
      expect(yield* countEvents()).toBe(1);
      const stale = yield* invoke(companyAdmin, { ...payload, expectedRevision: 0 }).pipe(Effect.flip);
      expect(Schema.is(IdentityLifecycleConflictError)(stale)).toBe(true);
      const missing = yield* invoke(companyAdmin, {
        ...payload,
        affiliation: null,
        expectedRevision: 1,
        principalRef: { principalId: agent, tenantId },
        status: 'disabled',
      }).pipe(Effect.flip);
      expect(Schema.is(IdentityLifecycleConflictError)(missing)).toBe(true);
      const departed = yield* invoke(companyAdmin, { ...payload, expectedRevision: 1, status: 'departed' });
      expect(departed.revision).toBe(2);
      const agentMembership = yield* invoke(
        superadmin,
        { ...payload, affiliation: null, principalRef: { principalId: agent, tenantId } },
        otherCompanyId,
      );
      expect(agentMembership.affiliation).toEqual(Option.none());

      const lifecycle = yield* ActionAuthorizationLifecycle.pipe(
        Effect.provide(
          ActionAuthorizationLifecycleLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(CoreDatabase, database),
                Layer.succeed(DatabaseConfig, pair.runtime),
                Layer.succeed(ActiveApplicationCompositionService, authority),
              ),
            ),
          ),
        ),
      );
      const outbox = makeOutboxRuntime(makeOutboxRepository(database.executor));
      const workers = coreSystemOutboxWorkers.filter(
        (worker) => worker.descriptor.workerKey === corePrincipalLifecycleSubscription.workerKey,
      );
      const drain = Effect.gen(function* drainMembershipWakeups() {
        yield* outbox.matchMessages({ compositionRevision: composition.revision });
        const [clock] = yield* admin.executor.execute<{ readonly now: Date }>(
          sql`select clock_timestamp() + interval '1 millisecond' as now`,
          'objects',
        );
        if (clock === undefined) {
          return expect.unreachable('Missing database clock');
        }
        return yield* outbox
          .runCycle({
            claimOwner: 'owned-membership-runtime',
            compositionRevision: composition.revision,
            maxDeliveries: 20,
            now: clock.now,
            registrations: workers,
            subscriptions: [corePrincipalLifecycleSubscription],
          })
          .pipe(Effect.provideService(ActionAuthorizationLifecycle, lifecycle));
      });
      const access = (id: string, company = companyId) =>
        Effect.promise(() =>
          client.promises.checkPermission(
            v1.CheckPermissionRequest.create({
              consistency: fullyConsistent,
              permission: 'access',
              resource: { objectId: companyObjectId(company), objectType: 'legal_entity' },
              subject: { object: { objectId: id, objectType: 'principal' } },
            }),
          ),
        ).pipe(
          Effect.map((result) => result.permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION),
        );
      expect(yield* access(human)).toBe(false);
      const firstDrain = yield* drain;
      expect(firstDrain.succeeded).toBe(3);
      expect(firstDrain.failed).toBe(0);
      // Queued active wake-ups cannot resurrect the current departed row.
      expect(yield* access(human)).toBe(false);
      expect(yield* access(agent, otherCompanyId)).toBe(true);
      const active = yield* invoke(companyAdmin, { ...payload, expectedRevision: 2 });
      expect(active.revision).toBe(3);
      expect((yield* drain).succeeded).toBe(1);
      expect(yield* access(human)).toBe(true);
      yield* admin.executor.update(principals).set({ status: 'disabled' }).where(eq(principals.principalId, human));
      yield* lifecycle.reconcilePrincipal(tenantId, human, composition.revision);
      expect(yield* access(human)).toBe(false);
      const retained = yield* admin.executor
        .select()
        .from(principalCompanyMemberships)
        .where(
          and(eq(principalCompanyMemberships.tenantId, tenantId), eq(principalCompanyMemberships.principalId, human)),
        );
      expect(retained).toHaveLength(1);
      expect(retained[0]?.revision).toBe(3);
      expect(retained[0]?.affiliation).toBe('employee');
      const people = yield* admin.executor.select().from(principals).where(eq(principals.principalId, human));
      expect(people).toHaveLength(1);
      // The caller drops the entire owned DB on success or failure; release the
      // singleton here only so another bounded proof can use this same fresh DB.
      yield* admin.executor
        .delete(applicationCompositionAuthority)
        .where(eq(applicationCompositionAuthority.revision, composition.revision));
    }).pipe(Effect.provide(Reactivity.layer)),
);
