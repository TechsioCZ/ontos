import { v1 } from '@authzed/authzed-node';
import { and, eq } from 'drizzle-orm';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Match, Predicate, Ref, Schema } from 'effect';
import { SecureRandom } from 'effect/crypto';
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
  coreRelations,
  principalAuthBindings,
  principals,
  tenantModuleStates,
  tenants,
} from '../../src/db/schema.ts';
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
import { cell, makeAuthority, makeCheck, principalHolder } from '../unit/access-decision-support.ts';

/*
 * `core.identity.change-system-workload-enrollment` for a CORE system module on the real Core schema and SpiceDB: a
 * Tenant administrator enrolls the Tenant's one system Principal for `core.media.integrity`, which Core itself declares
 * (`core-system-workloads.ts`), against NO installed module contract (the catalog here is empty) and NO
 * `tenant_module_states` row. The enrolled Principal holds that one workload and nothing else, the Shell's resolver
 * finds exactly it, an end archives it so the next enrollment is a new Principal, and a key the declaration does not
 * list is refused. Access intent is append-only (D27), so this run's Tenants and Principals stay behind under random ids.
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
const nextUuid = SecureRandom.SecureRandom.use((crypto) => crypto.uuidV4());
const capability = 'core.identity.system-workload-enrollment.change';
const coreModule = 'core.media';
const integrity = 'core.media.integrity';
const reason = 'The Tenant runs the Core Media integrity recorder';
const enroll = { _tag: 'ENROLL', moduleKey: coreModule, workloadKey: integrity } as const;
const end = { _tag: 'END', moduleKey: coreModule, workloadKey: integrity } as const;

class EnrollmentAnswerUnexpected extends Schema.TaggedError<EnrollmentAnswerUnexpected>()(
  'EnrollmentAnswerUnexpected',
  { answer: Schema.String },
) {}
type EnrollmentResult = typeof changeSystemWorkloadEnrollmentAction.descriptor.resultSchema.Type;
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

interface Person {
  readonly authBindingId: string;
  readonly principalId: string;
  readonly tenantId: string;
}
const sessionOf = (person: Person) =>
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

it.layer(NodeCrypto.layer, { excludeTestServices: true })('core system workload enrollment', (suite) => {
  suite.effect(
    'enrolls, keeps, ends and re-enrolls the Tenant system Principal of a core module, with no module state',
    () =>
      Effect.gen(function* coreSystemWorkloadEnrollment() {
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
        const foreignAdministrator = {
          authBindingId: yield* nextUuid,
          principalId: yield* nextUuid,
          tenantId: foreignTenantId,
        };
        const member = { authBindingId: yield* nextUuid, principalId: yield* nextUuid, tenantId };
        const people = [administrator, foreignAdministrator, member];
        const administrators = [administrator, foreignAdministrator];

        const spiceDbClient = newSpiceDbGrpcClient(spiceDbConfiguration);
        const permissionClient = createSpiceDbPermissionClient(spiceDbConfiguration, SPICEDB_CHECK_TIMEOUT_MS);
        const operationalScope = yield* makeOperationalScopeResolver(
          makeOperationalScopeRepository({ executor: runtimeDatabase }),
          makeTestOperationalScopeAccess(),
        );
        const identityAuthority = {
          cells: administrators.map(({ principalId }) =>
            cell({ capability, holder: principalHolder(PrincipalIdSchema.make(principalId)) }),
          ),
        };
        const authority = makeAuthority(identityAuthority);
        const actionRuntime = makeActionRuntime(
          { executor: runtimeDatabase },
          makeActionRepository(yield* SecureRandom.SecureRandom),
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
        // No installed module at all: a core module is never resolved from the catalog.
        const catalog = yield* Ref.make(buildInstalledModuleCatalog([]));
        const change = Effect.fn('CoreSystemWorkloadEnrollmentTest.change')(function* runChange(
          principal: Parameters<typeof actionRuntime.runAction>[0]['principal'],
          payload: { readonly _tag: 'END' | 'ENROLL'; readonly moduleKey: string; readonly workloadKey: string },
          idempotencyKey?: string,
        ) {
          return yield* actionRuntime
            .runAction({
              principal,
              payload: { ...payload, reason },
              registration: changeSystemWorkloadEnrollmentAction,
              savedReply: 'answer',
              transport: { correlationId: yield* nextUuid, idempotencyKey: idempotencyKey ?? (yield* nextUuid) },
            })
            .pipe(
              Effect.provideService(InstalledModuleCatalogService, { loadForRevision: () => Ref.get(catalog) }),
              Effect.provideService(AuthenticationNamespaceRegistry, authenticationNamespaceRegistry),
            );
        });
        const resolver = makeSystemPrincipalContextResolver({ executor: runtimeDatabase });
        const resolveIntegrity = Effect.fn('CoreSystemWorkloadEnrollmentTest.resolve')(function* resolveIntegrity(
          enrolledTenantId: string,
        ) {
          return yield* resolver.resolveEnrolled({
            registration: registerSystemWorkload({ jobKey: integrity }),
            runReference: yield* nextUuid,
            tenantId: enrolledTenantId,
          });
        });
        const bindingsOf = (holderTenantId: string, principalId: string) =>
          admin
            .select({ status: accessWorkloadBindings.status, workloadKey: accessWorkloadBindings.workloadKey })
            .from(accessWorkloadBindings)
            .where(
              and(
                eq(accessWorkloadBindings.tenantId, holderTenantId),
                eq(accessWorkloadBindings.principalId, principalId),
              ),
            );
        const principalRow = (holderTenantId: string, principalId: string) =>
          admin
            .select({ kind: principals.kind, status: principals.status })
            .from(principals)
            .where(and(eq(principals.tenantId, holderTenantId), eq(principals.principalId, principalId)));
        const moduleStateRows = (holderTenantId: string) =>
          admin.select().from(tenantModuleStates).where(eq(tenantModuleStates.tenantId, holderTenantId));

        const actionObjectId = toSpiceDbActionObjectId(changeSystemWorkloadEnrollmentAction.descriptor.actionKey);
        const spiceDbRelationships = [
          ...people.map((person) => relationship('tenant', person.tenantId, 'member', person.principalId)),
          ...administrators.map((person) =>
            relationship('tenant', person.tenantId, 'identity_admin', person.principalId),
          ),
          ...administrators.map((person) => relationship('action', actionObjectId, 'executor', person.principalId)),
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
            name: 'Core system workload enrollment tenant',
            slug: `core-system-workload-enrollment-${id}`,
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
            displayName: 'Core system workload enrollment person',
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
            providerSubjectId: `core-system-workload-enrollment-${person.authBindingId}`,
            status: 'active' as const,
            subjectType: 'user' as const,
            tenantId: person.tenantId,
          })),
        );
        // The Tenants have no module state at all, and none is ever written for a core module.
        expect(yield* moduleStateRows(tenantId)).toEqual([]);

        // ENROLL creates the Tenant's one system Principal with the one workload Core declares, and nothing else.
        const firstKey = yield* nextUuid;
        const firstAnswer = yield* change(yield* sessionOf(administrator), enroll, firstKey);
        expect(Predicate.isTagged(firstAnswer, 'ENROLLED')).toBe(true);
        const first = yield* enrollmentOf(firstAnswer);
        expect(first).toMatchObject({
          moduleKey: coreModule,
          pending: [],
          principalStatus: 'active',
          workloadKey: integrity,
        });
        expect(first.held.map(({ workloadKey }) => workloadKey)).toEqual([integrity]);
        expect(first.added).toEqual(first.held);
        expect(yield* principalRow(tenantId, first.principalId)).toEqual([{ kind: 'system', status: 'active' }]);
        expect(yield* bindingsOf(tenantId, first.principalId)).toEqual([{ status: 'active', workloadKey: integrity }]);
        expect(yield* moduleStateRows(tenantId)).toEqual([]);
        // The Shell's resolver finds exactly this Principal.
        const resolved = yield* resolveIntegrity(tenantId);
        expect(resolved.principalId).toBe(first.principalId);
        expect(resolved.tenantId).toBe(tenantId);

        // The same request answers the saved reply; a new request keeps the holder and adds nothing.
        expect(yield* change(yield* sessionOf(administrator), enroll, firstKey)).toEqual(firstAnswer);
        const kept = yield* change(yield* sessionOf(administrator), enroll);
        expect(Predicate.isTagged(kept, 'ALREADY_ENROLLED')).toBe(true);
        expect(kept).toMatchObject({ added: [], held: first.held, pending: [], principalId: first.principalId });

        // A member without the capability, and the enrolled system Principal itself, may not change an enrollment.
        const asMember = yield* Effect.flip(change(yield* sessionOf(member), enroll));
        expect(Predicate.isTagged(asMember, 'ActionPermissionDenied')).toBe(true);
        const asSystem = yield* Effect.flip(change(resolved, end));
        expect(Predicate.isTagged(asSystem, 'ActionPermissionDenied')).toBe(true);
        // A key under a core module that Core does not declare is refused, and creates nothing.
        const undeclared = yield* Effect.flip(
          change(yield* sessionOf(administrator), { ...enroll, workloadKey: 'core.media.other' }),
        );
        expect(Predicate.isTagged(undeclared, 'IdentityTargetInvalidError')).toBe(true);
        expect(undeclared).toMatchObject({ reason: 'The workload is not a system workload the module declares' });
        // A key outside the named module's own id never reaches the handler.
        const foreignKey = yield* Effect.flip(
          change(yield* sessionOf(administrator), { ...enroll, workloadKey: 'core.other.integrity' }),
        );
        expect(Predicate.isTagged(foreignKey, 'ActionPayloadValidationError')).toBe(true);
        // An app module is still resolved from the installed catalog, which is empty here.
        const notInstalled = yield* Effect.flip(
          change(yield* sessionOf(administrator), {
            _tag: 'ENROLL',
            moduleKey: 'integration.symmy',
            workloadKey: 'integration.symmy.execute-symmy-job',
          }),
        );
        expect(notInstalled).toMatchObject({ reason: 'The module is not installed in the current composition' });
        expect(yield* bindingsOf(tenantId, first.principalId)).toEqual([{ status: 'active', workloadKey: integrity }]);

        // Another Tenant's administrator enrolls that Tenant's own Principal; this Tenant's stays as it is.
        const foreign = yield* enrollmentOf(yield* change(yield* sessionOf(foreignAdministrator), enroll));
        expect(foreign.principalId).not.toBe(first.principalId);
        expect((yield* resolveIntegrity(tenantId)).principalId).toBe(first.principalId);
        expect((yield* resolveIntegrity(foreignTenantId)).principalId).toBe(foreign.principalId);

        // END revokes what the enrollment holds and archives the Principal, with no declared calls to list.
        const ended = yield* change(yield* sessionOf(administrator), end);
        expect(Predicate.isTagged(ended, 'ENDED')).toBe(true);
        expect(ended).toMatchObject({ principalId: first.principalId, revoked: first.held });
        expect(Object.hasOwn(ended, 'declaredCalls')).toBe(false);
        expect(yield* principalRow(tenantId, first.principalId)).toEqual([{ kind: 'system', status: 'archived' }]);
        expect(yield* bindingsOf(tenantId, first.principalId)).toEqual([{ status: 'revoked', workloadKey: integrity }]);
        const endedAgain = yield* change(yield* sessionOf(administrator), end);
        expect(Predicate.isTagged(endedAgain, 'NOT_ENROLLED')).toBe(true);

        // The next enrollment is a new Principal, which the resolver finds; the foreign Tenant is unaffected.
        const second = yield* enrollmentOf(yield* change(yield* sessionOf(administrator), enroll));
        expect(Predicate.isTagged(yield* change(yield* sessionOf(administrator), enroll), 'ALREADY_ENROLLED')).toBe(
          true,
        );
        expect(second.principalId).not.toBe(first.principalId);
        expect((yield* resolveIntegrity(tenantId)).principalId).toBe(second.principalId);
        expect((yield* resolveIntegrity(foreignTenantId)).principalId).toBe(foreign.principalId);
        expect(yield* moduleStateRows(tenantId)).toEqual([]);
      }),
  );
});
