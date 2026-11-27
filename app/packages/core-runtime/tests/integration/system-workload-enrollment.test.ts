import { v1 } from '@authzed/authzed-node';
import { and, eq } from 'drizzle-orm';
import { NodeCrypto } from '@effect/platform-node';
import { Crypto, DateTime, Effect, Match, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { PrincipalIdSchema } from '../../src/access/ids.ts';
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
import { changeSystemWorkloadEnrollmentAction } from '../../src/modules/actions/change-system-workload-enrollment.action.ts';
import { InstalledModuleCatalogService, buildInstalledModuleCatalog } from '../../src/modules/catalog.ts';
import { decodeOntosModuleDeploymentContract } from '../../src/modules/manifest.ts';
import { makeOperationalScopeRepository, makeOperationalScopeResolver } from '../../src/operations/context.ts';
import { SPICEDB_CHECK_TIMEOUT_MS, createSpiceDbPermissionClient } from '../../src/permissions/client.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import { makeContextAccess } from '../../src/permissions/context-access.ts';
import { makeActionPermissionService, toSpiceDbActionObjectId } from '../../src/permissions/service.ts';
import { newSpiceDbGrpcClient } from '../../src/permissions/spicedb-grpc-rpc.ts';
import { makeTestOperationalScopeAccess } from '../../src/testing/access-gate.ts';
import { makeModuleContractFixture } from '../../src/testing/module-contract.ts';
import { writeTestTenantScopes } from '../../src/testing/tenant-access.ts';
import { openActionRuntimeOptions } from '../support/action-runtime-options.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';
import { bindFixedAccessGate } from '../support/fixed-access-gate.ts';
import { cell, makeAuthority, makeCheck, principalHolder } from '../unit/access-decision-support.ts';

/*
 * `core.identity.change-system-workload-enrollment` against the real Core schema: a Tenant administrator enrolls the
 * Tenant's one system Principal for a system workload its active module declares, the worker's reader finds exactly
 * that Principal, and the end archives it, so the next enrollment is a new Principal. Access intent is append-only
 * (D27), so the Tenants, Principals and bindings of this run stay behind under their random ids.
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
const workerModule = 'enrollment.worker';
const dormantModule = 'enrollment.dormant';
const workerKey = 'enrollment.worker.execute-job';
const dormantKey = 'enrollment.dormant.execute-job';
/** An owner workload another writer (Symmy's route enabling, a bootstrap) binds to an enrolled system Principal. */
const ownerWorkload = 'enrollment.receiver.write-record';
const reason = 'The Tenant runs this module job';
const enroll = { _tag: 'ENROLL', moduleKey: workerModule, workloadKey: workerKey } as const;
const end = { _tag: 'END', moduleKey: workerModule, workloadKey: workerKey } as const;

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

// Demo line: an Action's SpiceDB object is scoped to its Tenant.
const actionObjectIdOf = (actionTenantId: string) =>
  toSpiceDbActionObjectId({
    actionKey: changeSystemWorkloadEnrollmentAction.descriptor.actionKey,
    tenantId: actionTenantId,
  });
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

/** The installed contracts: one module declaring its system workload, one declaring another and kept inactive. */
const installedCatalog = () =>
  buildInstalledModuleCatalog(
    [
      { appId: 'system-enrollment-worker', key: workerKey, moduleId: workerModule },
      { appId: 'system-enrollment-dormant', key: dormantKey, moduleId: dormantModule },
    ].map(({ appId, key, moduleId }) => {
      const fixture = makeModuleContractFixture({ appId, buildMarker: 'system-workload-enrollment', moduleId });
      const contract = decodeOntosModuleDeploymentContract({
        ...fixture,
        manifest: { ...fixture.manifest, systemWorkloads: [key] },
      });
      return { contract, expectedAppId: contract.deployment.appId };
    }),
  );

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
        makeOperationalScopeRepository({ executor: runtimeDatabase }, FIXTURE_DATABASE_IDENTITY_ENROLLMENT),
        makeTestOperationalScopeAccess(),
      );
      // The administrators hold the one identity capability; the member of the Tenant holds none.
      const identityAuthority = {
        cells: administrators.map(({ principalId }) =>
          cell({ capability, holder: principalHolder(PrincipalIdSchema.make(principalId)) }),
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
      const catalog = installedCatalog();
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
            Effect.provideService(InstalledModuleCatalogService, { loadForRevision: () => Effect.succeed(catalog) }),
            Effect.provideService(AuthenticationNamespaceRegistry, authenticationNamespaceRegistry),
          );
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
          .orderBy(accessWorkloadBindings.workloadKey);
      const principalStatus = (principalId: string) =>
        admin
          .select({ status: principals.status })
          .from(principals)
          .where(and(eq(principals.tenantId, tenantId), eq(principals.principalId, principalId)));
      // A binding written past the enrollment, as Symmy's route enabling, a bootstrap or an earlier composition left it.
      const leftBinding = Effect.fn('SystemWorkloadEnrollmentTest.leftBinding')(function* insertBinding(
        principalId: string,
        workloadKey: string,
      ) {
        yield* admin.insert(accessWorkloadBindings).values({
          bindingId: yield* nextUuid,
          createdAt: DateTime.toDateUtc(yield* DateTime.now),
          incarnation: yield* nextUuid,
          principalId,
          status: 'active',
          tenantId,
          workloadKey,
        });
      });

      const spiceDbRelationships = [
        ...people.map((person) => relationship('tenant', person.tenantId, 'member', person.principalId)),
        ...administrators.map((person) =>
          relationship('tenant', person.tenantId, 'identity_admin', person.principalId),
        ),
        ...administrators.map((person) =>
          relationship('action', actionObjectIdOf(person.tenantId), 'executor', person.principalId),
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
      // Demo line: scopes are written through the runtime identity, the one role that installs a tenant scope.
      yield* writeTestTenantScopes(runtimeDatabase, { principalId: administrator.principalId, tenantId });
      yield* writeTestTenantScopes(runtimeDatabase, {
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
      yield* admin.insert(tenantModuleStates).values([
        { moduleKey: workerModule, state: 'active', tenantId },
        { moduleKey: dormantModule, state: 'inactive', tenantId },
        { moduleKey: workerModule, state: 'active', tenantId: foreignTenantId },
      ]);

      // The first enrollment creates the Tenant's system Principal and binds exactly that key to it.
      const firstKey = yield* nextUuid;
      const firstAnswer = yield* change(yield* sessionOf(administrator), enroll, firstKey);
      expect(Predicate.isTagged(firstAnswer, 'ENROLLED')).toBe(true);
      const first = yield* enrollmentOf(firstAnswer);
      const [created] = yield* admin
        .select({
          displayName: principals.displayName,
          kind: principals.kind,
          status: principals.status,
          systemWorkloadKey: principals.systemWorkloadKey,
        })
        .from(principals)
        .where(and(eq(principals.tenantId, tenantId), eq(principals.principalId, first.principalId)));
      expect(created).toEqual({
        displayName: `System workload ${workerKey}`,
        kind: 'system',
        status: 'active',
        systemWorkloadKey: workerKey,
      });
      const firstBindings = yield* admin
        .select({ workloadKey: accessWorkloadBindings.workloadKey })
        .from(accessWorkloadBindings)
        .where(
          and(eq(accessWorkloadBindings.tenantId, tenantId), eq(accessWorkloadBindings.principalId, first.principalId)),
        );
      expect(firstBindings).toEqual([{ workloadKey: workerKey }]);
      // The database itself refuses a second live Principal recorded for the same workload.
      const second = yield* Effect.flip(
        admin.insert(principals).values({
          displayName: 'Second holder',
          kind: 'system',
          status: 'disabled',
          systemWorkloadKey: workerKey,
          tenantId,
        }),
      );
      expect(second).toBeDefined();
      // The worker's own reader now finds exactly this Principal.
      expect((yield* workerIdentity(tenantId)).principalId).toBe(first.principalId);

      // The same request again answers the saved reply; a new request keeps the active one unchanged.
      expect(yield* change(yield* sessionOf(administrator), enroll, firstKey)).toEqual(firstAnswer);
      const kept = yield* change(yield* sessionOf(administrator), enroll);
      expect(Predicate.isTagged(kept, 'ALREADY_ENROLLED')).toBe(true);
      expect(kept).toMatchObject({ bindingIncarnation: first.bindingIncarnation, principalId: first.principalId });
      expect(yield* activeHolders(tenantId)).toEqual([{ principalId: first.principalId }]);

      // Who enrolled it and why is on the Action's own audit record.
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
        { _tag: 'ENROLL', moduleKey: dormantModule, workloadKey: dormantKey },
        { _tag: 'ENROLL', moduleKey: 'enrollment.absent', workloadKey: 'enrollment.absent.execute-job' },
      ] as const) {
        const refusal = yield* Effect.flip(change(yield* sessionOf(administrator), refused));
        expect(Predicate.isTagged(refusal, 'IdentityTargetInvalidError')).toBe(true);
      }
      // A key outside the named module's own id never reaches the handler, for an end as for an enrollment.
      for (const foreignKey of [
        { ...enroll, workloadKey: dormantKey },
        { ...end, workloadKey: dormantKey },
      ]) {
        const refusal = yield* Effect.flip(change(yield* sessionOf(administrator), foreignKey));
        expect(Predicate.isTagged(refusal, 'ActionPayloadValidationError')).toBe(true);
      }
      expect(yield* activeHolders(tenantId)).toEqual([{ principalId: first.principalId }]);

      // Another Tenant's administrator enrolls that Tenant's own Principal, and this Tenant's stays as it is.
      const foreign = yield* enrollmentOf(yield* change(yield* sessionOf(foreignAdministrator), enroll));
      expect(foreign.principalId).not.toBe(first.principalId);
      expect((yield* workerIdentity(tenantId)).principalId).toBe(first.principalId);

      // An owner workload bound to the Principal since (as Symmy's route enabling binds one) ends with it too.
      yield* leftBinding(first.principalId, ownerWorkload);
      // The end revokes every binding and archives the Principal; the worker then finds none in this Tenant only.
      const ended = yield* change(yield* sessionOf(administrator), end);
      expect(Predicate.isTagged(ended, 'ENDED')).toBe(true);
      expect(ended).toMatchObject({
        bindingIncarnation: first.bindingIncarnation,
        moduleKey: workerModule,
        pendingWork: 'not_visible_to_core',
        principalId: first.principalId,
        stoppedCalls: [],
        workloadKey: workerKey,
      });
      const [archived] = yield* admin
        .select({ status: principals.status })
        .from(principals)
        .where(and(eq(principals.tenantId, tenantId), eq(principals.principalId, first.principalId)));
      expect(archived).toEqual({ status: 'archived' });
      expect(yield* activeHolders(tenantId)).toEqual([]);
      expect(yield* principalBindings(first.principalId)).toEqual([
        { status: 'revoked', workloadKey: ownerWorkload },
        { status: 'revoked', workloadKey: workerKey },
      ]);
      const endAudits = yield* admin
        .select({ evidence: auditEvents.evidenceJson })
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.eventType, 'action.executed')));
      expect(endAudits).toContainEqual({
        evidence: expect.objectContaining({ change: 'ENDED', workloads: [ownerWorkload, workerKey] }),
      });
      const noWorker = yield* Effect.flip(workerIdentity(tenantId));
      expect(Predicate.isTagged(noWorker, 'SystemPrincipalContextDeniedError')).toBe(true);
      expect((yield* workerIdentity(foreignTenantId)).principalId).toBe(foreign.principalId);
      const none = yield* change(yield* sessionOf(administrator), end);
      expect(Predicate.isTagged(none, 'NOT_ENROLLED')).toBe(true);
      expect(none).toMatchObject({ moduleKey: workerModule, workloadKey: workerKey });

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

      // A binding of another module's system workload key on the worker's Principal never makes it that module's
      // enrollment. Demo line: that module's enrollment leaves the key with it, as an executor holds the owner workloads
      // its routes need (MERGING.md V52).
      yield* admin
        .update(tenantModuleStates)
        .set({ state: 'active' })
        .where(and(eq(tenantModuleStates.tenantId, tenantId), eq(tenantModuleStates.moduleKey, dormantModule)));
      const borrower = leftEnrollment.principalId;
      yield* leftBinding(borrower, dormantKey);
      const owner = { moduleKey: dormantModule, workloadKey: dormantKey };
      const ownerIdentity = Effect.fn('SystemWorkloadEnrollmentTest.ownerIdentity')(function* resolveOwner() {
        return yield* enrolled.resolveEnrolled({
          registration: registerSystemWorkload({ jobKey: dormantKey }),
          runReference: yield* nextUuid,
          tenantId,
        });
      });
      const unresolved = yield* Effect.flip(ownerIdentity());
      expect(Predicate.isTagged(unresolved, 'SystemPrincipalContextDeniedError')).toBe(true);
      const nothingToEnd = yield* change(yield* sessionOf(administrator), { ...owner, _tag: 'END' });
      expect(Predicate.isTagged(nothingToEnd, 'NOT_ENROLLED')).toBe(true);
      const ownAnswer = yield* change(yield* sessionOf(administrator), { ...owner, _tag: 'ENROLL' });
      expect(Predicate.isTagged(ownAnswer, 'ENROLLED')).toBe(true);
      const own = yield* enrollmentOf(ownAnswer);
      expect(own.principalId).not.toBe(borrower);
      expect((yield* ownerIdentity()).principalId).toBe(own.principalId);
      expect(yield* principalBindings(borrower)).toEqual([
        { status: 'active', workloadKey: dormantKey },
        { status: 'active', workloadKey: workerKey },
      ]);
      const reclaimAudits = yield* admin
        .select({ evidence: auditEvents.evidenceJson })
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.eventType, 'action.executed')));
      expect(reclaimAudits).not.toContainEqual({
        evidence: expect.objectContaining({ reclaimedFrom: [borrower] }),
      });

      // A system Principal with no recorded workload, as one made before the record existed: END never ends it and
      // ENROLL never adopts it, but ENROLL takes the key from it and leaves its other bindings.
      const ownEnded = yield* change(yield* sessionOf(administrator), { ...owner, _tag: 'END' });
      expect(Predicate.isTagged(ownEnded, 'ENDED')).toBe(true);
      const unrecorded = yield* nextUuid;
      yield* admin.insert(principals).values({
        displayName: 'Unrecorded system principal',
        kind: 'system',
        principalId: unrecorded,
        status: 'active',
        tenantId,
      });
      yield* leftBinding(unrecorded, dormantKey);
      yield* leftBinding(unrecorded, ownerWorkload);
      expect((yield* ownerIdentity()).principalId).toBe(unrecorded);
      const notEnded = yield* change(yield* sessionOf(administrator), { ...owner, _tag: 'END' });
      expect(Predicate.isTagged(notEnded, 'NOT_ENROLLED')).toBe(true);
      expect(yield* principalStatus(unrecorded)).toEqual([{ status: 'active' }]);
      const replacing = yield* change(yield* sessionOf(administrator), { ...owner, _tag: 'ENROLL' });
      expect(Predicate.isTagged(replacing, 'ENROLLED')).toBe(true);
      const replacement = yield* enrollmentOf(replacing);
      expect(replacement.principalId).not.toBe(unrecorded);
      expect((yield* ownerIdentity()).principalId).toBe(replacement.principalId);
      expect(yield* principalBindings(unrecorded)).toEqual([
        { status: 'revoked', workloadKey: dormantKey },
        { status: 'active', workloadKey: ownerWorkload },
      ]);
      expect(yield* principalStatus(unrecorded)).toEqual([{ status: 'active' }]);

      // A core system module needs no installed contract and no Tenant module state; only a key Core declares for it
      // is enrolled, and the key always starts with the module's own id.
      const integrity = yield* change(yield* sessionOf(administrator), {
        _tag: 'ENROLL',
        moduleKey: 'core.media',
        workloadKey: 'core.media.integrity',
      });
      expect(Predicate.isTagged(integrity, 'ENROLLED')).toBe(true);
      for (const refused of [
        { _tag: 'ENROLL', moduleKey: 'core.media', workloadKey: 'core.media.other-job' },
        { _tag: 'ENROLL', moduleKey: workerModule, workloadKey: 'core.media.integrity' },
      ] as const) {
        expect(yield* Effect.flip(change(yield* sessionOf(administrator), refused))).toBeDefined();
      }
      const integrityEnded = yield* change(yield* sessionOf(administrator), {
        _tag: 'END',
        moduleKey: 'core.media',
        workloadKey: 'core.media.integrity',
      });
      expect(Predicate.isTagged(integrityEnded, 'ENDED')).toBe(true);
      expect(integrityEnded).toMatchObject({ stoppedCalls: [] });
    }),
  );
});
