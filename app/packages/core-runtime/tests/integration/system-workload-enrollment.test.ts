import { v1 } from '@authzed/authzed-node';
import { and, asc, eq } from 'drizzle-orm';
import { NodeCrypto } from '@effect/platform-node';
import { Crypto, DateTime, Effect, Match, Predicate, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { PrincipalIdSchema, TenantIdSchema } from '../../src/access/ids.ts';
import { makeAccessWorkloadBindingDrizzleStore } from '../../src/access/workloads/binding-store.ts';
import { AccessWorkloadBindingIdSchema } from '../../src/access/workloads/store.ts';
import { makeActionRepository } from '../../src/actions/repository.ts';
import { makeActionRuntime } from '../../src/actions/runtime.ts';
import {
  AuthenticationNamespaceIdSchema,
  AuthenticationNamespaceRegistrationSchema,
} from '../../src/auth/external-identity-contracts.ts';
import {
  AuthenticationNamespaceRegistry,
  makeAuthenticationNamespaceRegistry,
} from '../../src/auth/external-identity/verifier.ts';
import { makeSystemPrincipalContextResolver } from '../../src/auth/system-principal-context.ts';
import { registerSystemWorkload } from '../../src/auth/system-workload-registration.ts';
import { WorkloadKeySchema } from '../../src/authorization/access-declaration.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import {
  accessWorkloadBindings,
  auditEvents,
  coreRelations,
  principalAuthBindings,
  principals,
  tenantModuleStates,
  tenants,
} from '../../src/db/schema.ts';
import { stageScopeOf } from '../../src/install/stage-context-bootstrap.ts';
import { changePrincipalStatusAction } from '../../src/modules/actions/change-principal-status.action.ts';
import { changeSystemWorkloadEnrollmentAction } from '../../src/modules/actions/change-system-workload-enrollment.action.ts';
import { InstalledModuleCatalogService, buildInstalledModuleCatalog } from '../../src/modules/catalog.ts';
import { makeOperationalScopeRepository, makeOperationalScopeResolver } from '../../src/operations/context.ts';
import { SPICEDB_CHECK_TIMEOUT_MS, createSpiceDbPermissionClient } from '../../src/permissions/client.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import { makeContextAccess } from '../../src/permissions/context-access.ts';
import { makeActionPermissionService, toSpiceDbActionObjectId } from '../../src/permissions/service.ts';
import { newSpiceDbGrpcClient } from '../../src/permissions/spicedb-grpc-rpc.ts';
import { makeTestOperationalScopeAccess } from '../../src/testing/access-gate.ts';
import { writeTestTenantScopes } from '../../src/testing/tenant-access.ts';
import { openActionRuntimeOptions } from '../support/action-runtime-options.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { bindFixedAccessGate } from '../support/fixed-access-gate.ts';
import {
  absentWrite,
  dormantWrite,
  enrollmentActiveModules,
  enrollmentCatalog,
  enrollmentDormantJob,
  enrollmentDormantModule,
  enrollmentJob,
  enrollmentWorkerModule,
  readerRead,
  receiverWrite,
} from '../support/system-workload-enrollment-contracts.ts';
import { cell, makeAuthority, makeCheck, principalHolder } from '../unit/access-decision-support.ts';

/*
 * `core.identity.change-system-workload-enrollment` against the real Core schema: a Tenant administrator enrolls the
 * Tenant's one system Principal for a system workload its active module declares, with the module's whole declared
 * worker identity, the worker's reader finds exactly that Principal, no other writer gives a second Principal its
 * workload, and the end revokes everything it holds and archives it, so the next enrollment is a new Principal. Access
 * intent is append-only (D27), so the Tenants, Principals and bindings of this run stay behind under their random ids.
 */
const staffAuthenticationNamespaceId = Schema.decodeSync(AuthenticationNamespaceIdSchema)('test.staff.better-auth.v1');
const authenticationNamespaceRegistry = makeAuthenticationNamespaceRegistry([
  Schema.decodeSync(AuthenticationNamespaceRegistrationSchema)({
    allowedAudiences: ['core-runtime-test'],
    authenticationNamespaceId: staffAuthenticationNamespaceId,
    provider: 'test-provider',
    requiresOperationAdmission: false,
    reservationPrincipalKind: 'human',
    subjectTypes: ['user', 'api_key'],
    trustedAttesterPrincipalIds: [],
  }),
]);
const nextUuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const capability = 'core.identity.system-workload-enrollment.change';
const statusCapability = 'core.identity.principal.change-status';
const workerModule = enrollmentWorkerModule;
const workerKey = enrollmentJob;
const reason = 'The Tenant runs this module job';
const enroll = { _tag: 'ENROLL', moduleKey: workerModule, workloadKey: workerKey } as const;
const end = { _tag: 'END', moduleKey: workerModule, workloadKey: workerKey } as const;
/** The worker identity in the order the Action reports it, by workload key. */
const identityKeys = [readerRead, receiverWrite, workerKey];
const declaredCalls = [
  { audience: 'system-enrollment-absent', entrypointKey: 'enrollment.absent.write-record', schemaVersion: '1' },
  { audience: 'system-enrollment-dormant', entrypointKey: 'enrollment.dormant.write-record', schemaVersion: '1' },
  { audience: 'system-enrollment-receiver', entrypointKey: 'enrollment.receiver.write-record', schemaVersion: '1' },
];

class EnrollmentAnswerUnexpected extends Schema.TaggedError<EnrollmentAnswerUnexpected>()(
  'EnrollmentAnswerUnexpected',
  { answer: Schema.String },
) {}
type EnrollmentResult = typeof changeSystemWorkloadEnrollmentAction.descriptor.resultSchema.Type;
/** The enrollment an ENROLL answered, or a failure naming the answer it gave instead. */
const enrollmentOf = (result: EnrollmentResult) =>
  Match.value(result).pipe(
    Match.tag('ENROLLED', 'ALREADY_ENROLLED', (enrolled) => Effect.succeed(enrolled)),
    Match.orElse(({ _tag }) => Effect.fail(new EnrollmentAnswerUnexpected({ answer: _tag }))),
  );

const relationship = (resourceType: string, resourceId: string, relation: string, subjectId: string) =>
  v1.Relationship.create({
    relation,
    resource: v1.ObjectReference.create({ objectId: resourceId, objectType: resourceType }),
    subject: v1.SubjectReference.create({
      object: v1.ObjectReference.create({ objectId: subjectId, objectType: 'principal' }),
    }),
  });
const relationshipUpdates = (relationships: readonly v1.Relationship[], operation: v1.RelationshipUpdate_Operation) =>
  v1.WriteRelationshipsRequest.create({
    updates: relationships.map((item) => v1.RelationshipUpdate.create({ operation, relationship: item })),
  });

interface EnrollmentPerson {
  readonly authBindingId: string;
  readonly principalId: string;
  readonly tenantId: string;
}
/** A fresh staff session of one person, as the Shell resolves it. */
const sessionOf = (person: EnrollmentPerson) =>
  nextUuid.pipe(
    Effect.map((session) => ({
      authBindingId: person.authBindingId,
      authContextRef: `better-auth-session:${session}`,
      authenticationNamespaceId: staffAuthenticationNamespaceId,
      authMethod: 'session' as const,
      principalId: person.principalId,
      tenantId: person.tenantId,
    })),
  );

/** The owner workloads the identity leaves unbound while the dormant receiver is inactive, by call and reason. */
const pendingWhileDormant = [
  {
    calls: [
      {
        audience: 'system-enrollment-absent',
        entrypointKey: 'enrollment.absent.write-record',
        reason:
          'registered-workload call enrollment.absent.write-record@1 to system-enrollment-absent: the receiver is not installed',
        schemaVersion: '1',
      },
    ],
    workloadKey: absentWrite,
  },
  {
    calls: [
      {
        audience: 'system-enrollment-dormant',
        entrypointKey: 'enrollment.dormant.write-record',
        reason: 'enrollment.dormant is not active for this tenant',
        schemaVersion: '1',
      },
    ],
    workloadKey: dormantWrite,
  },
];
const [pendingAbsent] = pendingWhileDormant;

it.layer(NodeCrypto.layer, { excludeTestServices: true })('system workload enrollment', (suite) => {
  suite.effect('enrolls, keeps, ends and re-enrolls exactly one system Principal per Tenant and workload', () =>
    Effect.gen(function* systemWorkloadEnrollment() {
      const connections = yield* loadDatabaseConnectionPair();
      const spiceDbConfiguration = yield* loadSpiceDbConfig();
      const admin = yield* makeTestDatabaseFromClient(
        yield* makeTestPgClient(connections.admin.connectionString),
        coreRelations,
      );
      const runtimeDatabase = yield* makeTestDatabaseFromClient(
        yield* makeTestPgClient(connections.runtime.connectionString),
        coreRelations,
      );
      const tenantId = yield* nextUuid;
      const foreignTenantId = yield* nextUuid;
      const administrator = { authBindingId: yield* nextUuid, principalId: yield* nextUuid, tenantId };
      const secondAdministrator = { authBindingId: yield* nextUuid, principalId: yield* nextUuid, tenantId };
      const foreignAdministrator = {
        authBindingId: yield* nextUuid,
        principalId: yield* nextUuid,
        tenantId: foreignTenantId,
      };
      const member = { authBindingId: yield* nextUuid, principalId: yield* nextUuid, tenantId };
      const people = [administrator, secondAdministrator, foreignAdministrator, member];
      const administrators = [administrator, secondAdministrator, foreignAdministrator];

      const spiceDbClient = newSpiceDbGrpcClient(spiceDbConfiguration);
      const permissionClient = createSpiceDbPermissionClient(spiceDbConfiguration, SPICEDB_CHECK_TIMEOUT_MS);
      const operationalScope = yield* makeOperationalScopeResolver(
        makeOperationalScopeRepository({ executor: runtimeDatabase }),
        makeTestOperationalScopeAccess(),
      );
      // The administrators hold the enrollment and the Principal status capabilities; the member holds neither.
      const identityAuthority = {
        cells: administrators.flatMap(({ principalId }) =>
          [capability, statusCapability].map((key) =>
            cell({ capability: key, holder: principalHolder(PrincipalIdSchema.make(principalId)) }),
          ),
        ),
      };
      const authority = makeAuthority(identityAuthority);
      const actionRuntime = makeActionRuntime(
        { executor: runtimeDatabase },
        makeActionRepository(yield* Crypto.Crypto),
        makeActionPermissionService(permissionClient),
        operationalScope,
        {
          ...openActionRuntimeOptions,
          accessDecision: bindFixedAccessGate({
            authorityFor: () => authority.port,
            check: makeCheck({ authority: identityAuthority }).port,
            executor: runtimeDatabase,
          }),
          contextAccess: makeContextAccess(permissionClient),
        },
      );
      const catalog = yield* Ref.make(enrollmentCatalog());
      const change = Effect.fn('SystemWorkloadEnrollmentTest.change')(function* runChange(
        principal: Parameters<typeof actionRuntime.runAction>[0]['principal'],
        payload: { readonly _tag: 'END' | 'ENROLL'; readonly moduleKey: string; readonly workloadKey: string },
        idempotencyKey?: string,
      ) {
        return yield* actionRuntime
          .runAction({
            payload: { ...payload, reason },
            principal,
            registration: changeSystemWorkloadEnrollmentAction,
            savedReply: 'answer',
            transport: { correlationId: yield* nextUuid, idempotencyKey: idempotencyKey ?? (yield* nextUuid) },
          })
          .pipe(
            Effect.provideService(InstalledModuleCatalogService, { loadForRevision: () => Ref.get(catalog) }),
            Effect.provideService(AuthenticationNamespaceRegistry, authenticationNamespaceRegistry),
          );
      });
      const changeStatus = Effect.fn('SystemWorkloadEnrollmentTest.changeStatus')(function* runStatusChange(
        principal: Parameters<typeof actionRuntime.runAction>[0]['principal'],
        payload: {
          readonly expectedStatus: 'active' | 'disabled';
          readonly newStatus: 'active' | 'archived' | 'disabled';
          readonly principalId: string;
        },
      ) {
        return yield* actionRuntime
          .runAction({
            payload: { ...payload, reason },
            principal,
            registration: changePrincipalStatusAction,
            savedReply: 'answer',
            transport: { correlationId: yield* nextUuid, idempotencyKey: yield* nextUuid },
          })
          .pipe(Effect.provideService(AuthenticationNamespaceRegistry, authenticationNamespaceRegistry));
      });
      const enrolled = makeSystemPrincipalContextResolver({ executor: runtimeDatabase });
      const workerIdentity = Effect.fn('SystemWorkloadEnrollmentTest.workerIdentity')(function* resolveWorker(
        enrolledTenantId: string,
      ) {
        return yield* enrolled.resolveEnrolled({
          registration: registerSystemWorkload({ jobKey: workerKey }),
          runReference: yield* nextUuid,
          tenantId: enrolledTenantId,
        });
      });
      const activeHolders = (holderTenantId: string) =>
        admin
          .select({ principalId: accessWorkloadBindings.principalId })
          .from(accessWorkloadBindings)
          .where(
            and(
              eq(accessWorkloadBindings.tenantId, holderTenantId),
              eq(accessWorkloadBindings.workloadKey, workerKey),
              eq(accessWorkloadBindings.status, 'active'),
            ),
          );
      const principalBindings = (principalId: string) =>
        admin
          .select({ status: accessWorkloadBindings.status, workloadKey: accessWorkloadBindings.workloadKey })
          .from(accessWorkloadBindings)
          .where(
            and(eq(accessWorkloadBindings.tenantId, tenantId), eq(accessWorkloadBindings.principalId, principalId)),
          )
          .orderBy(asc(accessWorkloadBindings.workloadKey), asc(accessWorkloadBindings.status));
      const principalStatus = (principalId: string) =>
        admin
          .select({ status: principals.status })
          .from(principals)
          .where(and(eq(principals.tenantId, tenantId), eq(principals.principalId, principalId)));
      const setModuleState = (moduleKey: string, state: 'active' | 'quarantined') =>
        admin
          .update(tenantModuleStates)
          .set({ state })
          .where(and(eq(tenantModuleStates.tenantId, tenantId), eq(tenantModuleStates.moduleKey, moduleKey)));

      const actionObjectIds = [changeSystemWorkloadEnrollmentAction, changePrincipalStatusAction].map((action) =>
        toSpiceDbActionObjectId(action.descriptor.actionKey),
      );
      const spiceDbRelationships = [
        ...people.map((person) => relationship('tenant', person.tenantId, 'member', person.principalId)),
        ...administrators.map((person) =>
          relationship('tenant', person.tenantId, 'identity_admin', person.principalId),
        ),
        ...administrators.flatMap((person) =>
          actionObjectIds.map((objectId) => relationship('action', objectId, 'executor', person.principalId)),
        ),
      ];
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          spiceDbClient.promises.writeRelationships(
            relationshipUpdates(spiceDbRelationships, v1.RelationshipUpdate_Operation.DELETE),
          ),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              permissionClient.close();
              spiceDbClient.close();
            }),
          ),
          Effect.orDie,
        ),
      );
      yield* Effect.promise(() =>
        spiceDbClient.promises.writeRelationships(
          relationshipUpdates(spiceDbRelationships, v1.RelationshipUpdate_Operation.TOUCH),
        ),
      );
      yield* admin.insert(tenants).values(
        [tenantId, foreignTenantId].map((id) => ({
          defaultLocale: 'en',
          name: 'System workload enrollment tenant',
          slug: `system-workload-enrollment-${id}`,
          status: 'active' as const,
          tenantId: id,
        })),
      );
      yield* writeTestTenantScopes(admin, { principalId: administrator.principalId, tenantId });
      yield* writeTestTenantScopes(admin, {
        principalId: foreignAdministrator.principalId,
        tenantId: foreignTenantId,
      });
      yield* admin.insert(principals).values(
        people.map((person) => ({
          displayName: 'System workload enrollment person',
          kind: 'human' as const,
          principalId: person.principalId,
          status: 'active' as const,
          tenantId: person.tenantId,
        })),
      );
      yield* admin.insert(principalAuthBindings).values(
        people.map((person) => ({
          authenticationNamespaceId: staffAuthenticationNamespaceId,
          principalAuthBindingId: person.authBindingId,
          principalId: person.principalId,
          provider: 'better_auth' as const,
          providerSubjectId: `system-workload-enrollment-${person.authBindingId}`,
          status: 'active' as const,
          subjectType: 'user' as const,
          tenantId: person.tenantId,
        })),
      );
      yield* admin
        .insert(tenantModuleStates)
        .values([
          ...enrollmentActiveModules.map((moduleKey) => ({ moduleKey, state: 'active', tenantId })),
          { moduleKey: enrollmentDormantModule, state: 'inactive', tenantId },
          { moduleKey: workerModule, state: 'active', tenantId: foreignTenantId },
        ]);

      // The first enrollment creates the Tenant's system Principal with the module's whole declared worker identity:
      // its job key, the receiver's workload and the reader's, which the receiver calls for this job from it. The
      // dormant and the absent receivers' workloads stay pending, each by call and reason.
      const firstKey = yield* nextUuid;
      const firstAnswer = yield* change(yield* sessionOf(administrator), enroll, firstKey);
      expect(Predicate.isTagged(firstAnswer, 'ENROLLED')).toBe(true);
      const first = yield* enrollmentOf(firstAnswer);
      expect(first).toMatchObject({
        moduleKey: workerModule,
        pending: pendingWhileDormant,
        principalStatus: 'active',
        workloadKey: workerKey,
      });
      expect(first.held.map(({ workloadKey }) => workloadKey)).toEqual(identityKeys);
      expect(first.added).toEqual(first.held);
      expect(first.held.find(({ workloadKey }) => workloadKey === workerKey)?.incarnation).toBe(
        first.bindingIncarnation,
      );
      const [created] = yield* admin
        .select({ displayName: principals.displayName, kind: principals.kind, status: principals.status })
        .from(principals)
        .where(and(eq(principals.tenantId, tenantId), eq(principals.principalId, first.principalId)));
      expect(created).toEqual({ displayName: `System workload ${workerKey}`, kind: 'system', status: 'active' });
      expect(yield* principalBindings(first.principalId)).toEqual(
        identityKeys.map((workloadKey) => ({ status: 'active', workloadKey })),
      );
      // The worker's own reader now finds exactly this Principal.
      expect((yield* workerIdentity(tenantId)).principalId).toBe(first.principalId);

      // The same request again answers the saved reply; a new request keeps the holder and adds nothing.
      expect(yield* change(yield* sessionOf(administrator), enroll, firstKey)).toEqual(firstAnswer);
      const kept = yield* change(yield* sessionOf(administrator), enroll);
      expect(Predicate.isTagged(kept, 'ALREADY_ENROLLED')).toBe(true);
      expect(kept).toMatchObject({
        added: [],
        bindingIncarnation: first.bindingIncarnation,
        held: first.held,
        pending: pendingWhileDormant,
        principalId: first.principalId,
        principalStatus: 'active',
      });
      expect(yield* activeHolders(tenantId)).toEqual([{ principalId: first.principalId }]);

      // Who enrolled it, why and which workloads it bound are on the Action's own audit record.
      const audits = yield* admin
        .select({ evidence: auditEvents.evidenceJson, principalId: auditEvents.principalId })
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.eventType, 'action.executed')));
      expect(audits).toContainEqual({
        evidence: {
          actionKey: changeSystemWorkloadEnrollmentAction.descriptor.actionKey,
          bindingIncarnation: first.bindingIncarnation,
          change: 'ENROLLED',
          moduleKey: workerModule,
          reason,
          resultHash: expect.any(String),
          systemPrincipalId: first.principalId,
          workloadKey: workerKey,
          workloads: identityKeys,
        },
        principalId: administrator.principalId,
      });

      // Neither the enrolled system Principal nor a member without the capability may change an enrollment.
      const asSystem = yield* Effect.flip(change(yield* workerIdentity(tenantId), enroll));
      expect(Predicate.isTagged(asSystem, 'ActionPermissionDenied')).toBe(true);
      const asMember = yield* Effect.flip(change(yield* sessionOf(member), end));
      expect(Predicate.isTagged(asMember, 'ActionPermissionDenied')).toBe(true);
      // A key the module does not declare, a module inactive for the Tenant and a module not installed are refused.
      for (const refused of [
        { ...enroll, workloadKey: 'enrollment.worker.other-job' },
        { _tag: 'ENROLL', moduleKey: enrollmentDormantModule, workloadKey: enrollmentDormantJob },
        { _tag: 'ENROLL', moduleKey: 'enrollment.absent', workloadKey: 'enrollment.absent.execute-job' },
      ] as const) {
        const refusal = yield* Effect.flip(change(yield* sessionOf(administrator), refused));
        expect(Predicate.isTagged(refusal, 'IdentityTargetInvalidError')).toBe(true);
      }
      // A key outside the named module's own id never reaches the handler, for an end as for an enrollment.
      for (const foreignKey of [
        { ...enroll, workloadKey: enrollmentDormantJob },
        { ...end, workloadKey: enrollmentDormantJob },
      ]) {
        const refusal = yield* Effect.flip(change(yield* sessionOf(administrator), foreignKey));
        expect(Predicate.isTagged(refusal, 'ActionPayloadValidationError')).toBe(true);
      }
      expect(yield* activeHolders(tenantId)).toEqual([{ principalId: first.principalId }]);

      // Another Tenant's administrator enrolls that Tenant's own Principal, and this Tenant's stays as it is.
      const foreign = yield* enrollmentOf(yield* change(yield* sessionOf(foreignAdministrator), enroll));
      expect(foreign.principalId).not.toBe(first.principalId);
      expect((yield* workerIdentity(tenantId)).principalId).toBe(first.principalId);

      // One holder, whatever the writer: ENROLL P1, disable P1 through the generic status change, ENROLL again,
      // reactivate P1. The status change refuses a system Principal at both steps, so the second ENROLL keeps P1.
      const refusedStatusReason = 'A system principal changes only through its system workload enrollment';
      /** The status change refused the system Principal, by tag and reason. */
      const refusesStatus = Effect.fn('SystemWorkloadEnrollmentTest.refusesStatus')(function* refusesStatus(
        payload: Parameters<typeof changeStatus>[1],
      ) {
        const refusal = yield* Effect.flip(changeStatus(yield* sessionOf(administrator), payload));
        expect(Predicate.isTagged(refusal, 'IdentityTargetInvalidError')).toBe(true);
        expect(refusal).toMatchObject({ reason: refusedStatusReason });
      });
      const disable = { expectedStatus: 'active', newStatus: 'disabled', principalId: first.principalId } as const;
      const reactivate = { expectedStatus: 'disabled', newStatus: 'active', principalId: first.principalId } as const;
      const archive = { expectedStatus: 'active', newStatus: 'archived', principalId: first.principalId } as const;
      yield* refusesStatus(disable);
      expect(yield* principalStatus(first.principalId)).toEqual([{ status: 'active' }]);
      const afterDisable = yield* change(yield* sessionOf(administrator), enroll);
      expect(Predicate.isTagged(afterDisable, 'ALREADY_ENROLLED')).toBe(true);
      expect(afterDisable).toMatchObject({
        added: [],
        principalId: first.principalId,
        principalStatus: 'active',
      });
      yield* refusesStatus(reactivate);
      yield* refusesStatus(archive);
      expect(yield* activeHolders(tenantId)).toEqual([{ principalId: first.principalId }]);
      expect((yield* workerIdentity(tenantId)).principalId).toBe(first.principalId);
      // A holder already disabled (as before that rule; no governed writer disables one now) still holds the
      // enrollment: ENROLL names its state and never mints a second, the status change still refuses to reactivate
      // it, and its worker is denied meanwhile.
      yield* admin
        .update(principals)
        .set({ disabledAt: DateTime.toDateUtc(yield* DateTime.now), status: 'disabled' })
        .where(and(eq(principals.tenantId, tenantId), eq(principals.principalId, first.principalId)));
      const disabled = yield* change(yield* sessionOf(administrator), enroll);
      expect(Predicate.isTagged(disabled, 'ALREADY_ENROLLED')).toBe(true);
      expect(disabled).toMatchObject({
        added: [],
        held: first.held,
        principalId: first.principalId,
        principalStatus: 'disabled',
      });
      yield* refusesStatus(reactivate);
      expect(yield* principalStatus(first.principalId)).toEqual([{ status: 'disabled' }]);
      expect(yield* activeHolders(tenantId)).toEqual([{ principalId: first.principalId }]);
      const deniedWhileDisabled = yield* Effect.flip(workerIdentity(tenantId));
      expect(Predicate.isTagged(deniedWhileDisabled, 'SystemPrincipalContextDeniedError')).toBe(true);
      // The generic binding store, which every bootstrap and fixture writes through, refuses every system Principal:
      // a second one for the job key or an owner workload, and the holder for one its identity does not hold. A batch
      // naming one is refused whole; a service Principal is still bound (the nearby valid control).
      const secondSystem = yield* nextUuid;
      const service = yield* nextUuid;
      // Rows another writer could have left: a second system Principal and a service Principal of the Tenant.
      yield* admin.insert(principals).values([
        {
          displayName: 'Second system principal',
          kind: 'system',
          principalId: secondSystem,
          status: 'active',
          tenantId,
        },
        { displayName: 'Service principal', kind: 'service', principalId: service, status: 'active', tenantId },
      ]);
      const store = makeAccessWorkloadBindingDrizzleStore({ executor: runtimeDatabase });
      const storeScope = yield* stageScopeOf({ principalId: administrator.principalId, tenantId });
      const bindingFor = Effect.fn('SystemWorkloadEnrollmentTest.bindingFor')(function* bindingFor(
        principalId: string,
        workloadKey: string,
      ) {
        return {
          bindingId: AccessWorkloadBindingIdSchema.make(yield* nextUuid),
          createdAt: DateTime.toDateUtc(yield* DateTime.now),
          incarnation: AccessWorkloadBindingIdSchema.make(yield* nextUuid),
          principalId: PrincipalIdSchema.make(principalId),
          tenantId: TenantIdSchema.make(tenantId),
          workloadKey: WorkloadKeySchema.make(workloadKey),
        };
      });
      for (const bindings of [
        [yield* bindingFor(secondSystem, workerKey)],
        [yield* bindingFor(secondSystem, receiverWrite)],
        [yield* bindingFor(first.principalId, dormantWrite)],
        [yield* bindingFor(service, receiverWrite), yield* bindingFor(secondSystem, workerKey)],
      ]) {
        const refusal = yield* Effect.flip(store.registerBindings(storeScope, { bindings }));
        expect(Predicate.isTagged(refusal, 'AccessIntentConflictError')).toBe(true);
        expect(refusal).toMatchObject({ code: 'access_intent_write_refused' });
      }
      yield* store.registerBindings(storeScope, { bindings: [yield* bindingFor(service, receiverWrite)] });
      expect(yield* principalBindings(secondSystem)).toEqual([]);
      expect(yield* principalBindings(service)).toEqual([{ status: 'active', workloadKey: receiverWrite }]);
      expect(yield* principalBindings(first.principalId)).toEqual(
        identityKeys.map((workloadKey) => ({ status: 'active', workloadKey })),
      );
      expect(yield* activeHolders(tenantId)).toEqual([{ principalId: first.principalId }]);

      // The end needs only the Tenant, the key and its holder: a module quarantined since is no obstacle to it, while
      // an enrollment needs the module active. It revokes everything the enrollment holds and archives the Principal,
      // disabled or not; the worker then finds none in this Tenant only.
      yield* setModuleState(workerModule, 'quarantined');
      const quarantined = yield* Effect.flip(change(yield* sessionOf(administrator), enroll));
      expect(Predicate.isTagged(quarantined, 'IdentityTargetInvalidError')).toBe(true);
      expect(quarantined).toMatchObject({ reason: 'The module is not active for this tenant' });
      const ended = yield* change(yield* sessionOf(administrator), end);
      expect(Predicate.isTagged(ended, 'ENDED')).toBe(true);
      expect(ended).toMatchObject({
        bindingIncarnation: first.bindingIncarnation,
        declaredCalls,
        moduleKey: workerModule,
        pendingWork: 'not_visible_to_core',
        principalId: first.principalId,
        revoked: first.held,
        workloadKey: workerKey,
      });
      expect(yield* principalStatus(first.principalId)).toEqual([{ status: 'archived' }]);
      expect(yield* principalBindings(first.principalId)).toEqual(
        identityKeys.map((workloadKey) => ({ status: 'revoked', workloadKey })),
      );
      expect(yield* activeHolders(tenantId)).toEqual([]);
      const noWorker = yield* Effect.flip(workerIdentity(tenantId));
      expect(Predicate.isTagged(noWorker, 'SystemPrincipalContextDeniedError')).toBe(true);
      expect((yield* workerIdentity(foreignTenantId)).principalId).toBe(foreign.principalId);
      const none = yield* change(yield* sessionOf(administrator), end);
      expect(Predicate.isTagged(none, 'NOT_ENROLLED')).toBe(true);
      expect(none).toMatchObject({ moduleKey: workerModule, workloadKey: workerKey });
      yield* setModuleState(workerModule, 'active');

      // Two administrators enrolling at once yield one new Principal: the archived one is never reactivated.
      const [left, right] = yield* Effect.all(
        [change(yield* sessionOf(administrator), enroll), change(yield* sessionOf(secondAdministrator), enroll)],
        { concurrency: 2 },
      );
      expect([left, right].filter((answer) => Predicate.isTagged(answer, 'ENROLLED'))).toHaveLength(1);
      const [leftEnrollment, rightEnrollment] = yield* Effect.all([enrollmentOf(left), enrollmentOf(right)]);
      expect(leftEnrollment.principalId).toBe(rightEnrollment.principalId);
      expect(leftEnrollment.principalId).not.toBe(first.principalId);
      expect(yield* activeHolders(tenantId)).toEqual([{ principalId: leftEnrollment.principalId }]);
      expect((yield* workerIdentity(tenantId)).principalId).toBe(leftEnrollment.principalId);

      // Activated later, the dormant receiver's workload becomes bindable: the next enrollment adds exactly that one
      // to the same Principal and names what is still pending.
      yield* setModuleState(enrollmentDormantModule, 'active');
      const grown = yield* enrollmentOf(yield* change(yield* sessionOf(administrator), enroll));
      expect(grown).toMatchObject({
        pending: [pendingAbsent],
        principalId: leftEnrollment.principalId,
        principalStatus: 'active',
      });
      expect(grown.added.map(({ workloadKey }) => workloadKey)).toEqual([dormantWrite]);
      expect(grown.held.map(({ workloadKey }) => workloadKey)).toEqual([dormantWrite, ...identityKeys]);
      expect(yield* principalBindings(leftEnrollment.principalId)).toEqual(
        [dormantWrite, ...identityKeys].map((workloadKey) => ({ status: 'active', workloadKey })),
      );

      // Once the module is removed from the composition, an enrollment is refused and the end still ends it, without
      // a declared call to list.
      yield* Ref.set(
        catalog,
        buildInstalledModuleCatalog(
          enrollmentCatalog()
            .contracts.filter(({ manifest }) => manifest.module.id !== workerModule)
            .map((contract) => ({ contract, expectedAppId: contract.deployment.appId })),
        ),
      );
      const removed = yield* Effect.flip(change(yield* sessionOf(administrator), enroll));
      expect(Predicate.isTagged(removed, 'IdentityTargetInvalidError')).toBe(true);
      expect(removed).toMatchObject({ reason: 'The module is not installed in the current composition' });
      const endedRemoved = yield* change(yield* sessionOf(administrator), end);
      expect(Predicate.isTagged(endedRemoved, 'ENDED')).toBe(true);
      expect(endedRemoved).toMatchObject({ principalId: leftEnrollment.principalId, revoked: grown.held });
      expect(Object.hasOwn(endedRemoved, 'declaredCalls')).toBe(false);
      expect(yield* activeHolders(tenantId)).toEqual([]);
    }),
  );
});
