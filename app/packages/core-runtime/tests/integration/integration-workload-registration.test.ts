import { v1 } from '@authzed/authzed-node';
import { and, eq } from 'drizzle-orm';
import { NodeCrypto } from '@effect/platform-node';
import { Crypto, Effect, Predicate, Schema } from 'effect';
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
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import {
  accessWorkloadBindings,
  accessWorkloadCompanyBindings,
  auditEvents,
  coreRelations,
  legalEntities,
  principalAuthBindings,
  principals,
  tenantModuleStates,
  tenants,
} from '../../src/db/schema.ts';
import { registerIntegrationWorkloadsAction } from '../../src/modules/actions/register-integration-workloads.action.ts';
import { InstalledModuleCatalogService } from '../../src/modules/catalog.ts';
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
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';
import { bindFixedAccessGate } from '../support/fixed-access-gate.ts';
import {
  DORMANT_MODULE,
  DORMANT_WORKLOAD,
  PARTNER_ADMISSION_WORKLOAD,
  PARTNER_MODULE,
  PARTNER_READ_WORKLOAD,
  PARTNER_SYSTEM_WORKLOAD,
  integrationWorkloadCatalog,
} from '../../src/testing/integration-workload-catalog.ts';
import { cell, makeAuthority, makeCheck, principalHolder } from '../unit/access-decision-support.ts';

/*
 * `core.identity.register-integration-workloads` against the real Core schema: a Tenant administrator binds a
 * connector partner's published workloads to the Tenant's integration Principal and registers them for the selected
 * company, a re-run keeps them, and a member, another Tenant, another company, a non-integration Principal, a system
 * workload and an inactive module are refused. Access intent is append-only (D27), so this run's rows stay behind under
 * their random ids.
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
const capability = 'core.identity.integration-workloads.register';
const partnerWorkloads = [PARTNER_ADMISSION_WORKLOAD, PARTNER_READ_WORKLOAD] as const;

const actionObjectIdOf = (actionTenantId: string) =>
  toSpiceDbActionObjectId({
    actionKey: registerIntegrationWorkloadsAction.descriptor.actionKey,
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

interface RegistrationPerson {
  readonly authBindingId: string;
  readonly principalId: string;
  readonly tenantId: string;
}
/** A fresh staff session of one person acting in one selected company, as the Shell resolves it. */
const sessionIn = (person: RegistrationPerson, legalEntityId: string) =>
  nextUuid.pipe(
    Effect.map((session) => ({
      authBindingId: person.authBindingId,
      authContextRef: `better-auth-session:${session}`,
      authenticationNamespaceId: staffAuthenticationNamespaceId,
      authMethod: 'session' as const,
      legalEntityId,
      principalId: person.principalId,
      tenantId: person.tenantId,
    })),
  );

/** The tag of the failure a refused attempt carries. */
const refusalOf = <Value, Failure, Requirements>(attempt: Effect.Effect<Value, Failure, Requirements>) =>
  Effect.flip(attempt).pipe(
    Effect.map((failure) => (Predicate.hasProperty(failure, '_tag') ? String(failure._tag) : 'untagged')),
  );

it.layer(NodeCrypto.layer, { excludeTestServices: true })('integration workload registration', (suite) => {
  suite.effect('binds a partner integration to its workloads for one company and refuses everyone else', () =>
    Effect.gen(function* integrationWorkloadRegistration() {
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
      const companyId = yield* nextUuid;
      const otherCompanyId = yield* nextUuid;
      const foreignCompanyId = yield* nextUuid;
      const administrator = { authBindingId: yield* nextUuid, principalId: yield* nextUuid, tenantId };
      const foreignAdministrator = {
        authBindingId: yield* nextUuid,
        principalId: yield* nextUuid,
        tenantId: foreignTenantId,
      };
      const member = { authBindingId: yield* nextUuid, principalId: yield* nextUuid, tenantId };
      const people = [administrator, foreignAdministrator, member];
      const administrators = [administrator, foreignAdministrator];
      const integrationPrincipalId = yield* nextUuid;
      const servicePrincipalId = yield* nextUuid;

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
      const catalog = integrationWorkloadCatalog();
      const register = Effect.fn('IntegrationWorkloadRegistrationTest.register')(function* runRegister(
        principal: Parameters<typeof actionRuntime.runAction>[0]['principal'],
        payload: { readonly principalId: string; readonly workloadKeys: readonly [string, ...string[]] },
        idempotencyKey?: string,
      ) {
        return yield* actionRuntime
          .runAction({
            payload,
            principal,
            registration: registerIntegrationWorkloadsAction,
            savedReply: 'answer',
            transport: { correlationId: yield* nextUuid, idempotencyKey: idempotencyKey ?? (yield* nextUuid) },
          })
          .pipe(
            Effect.provideService(InstalledModuleCatalogService, { loadForRevision: () => Effect.succeed(catalog) }),
            Effect.provideService(AuthenticationNamespaceRegistry, authenticationNamespaceRegistry),
          );
      });
      const companyRegistrations = admin
        .select({
          legalEntityId: accessWorkloadCompanyBindings.legalEntityId,
          workloadKey: accessWorkloadBindings.workloadKey,
        })
        .from(accessWorkloadBindings)
        .innerJoin(
          accessWorkloadCompanyBindings,
          and(
            eq(accessWorkloadCompanyBindings.tenantId, accessWorkloadBindings.tenantId),
            eq(accessWorkloadCompanyBindings.workloadBindingId, accessWorkloadBindings.bindingId),
          ),
        )
        .where(
          and(
            eq(accessWorkloadBindings.tenantId, tenantId),
            eq(accessWorkloadBindings.principalId, integrationPrincipalId),
            eq(accessWorkloadBindings.status, 'active'),
            eq(accessWorkloadCompanyBindings.status, 'active'),
          ),
        );

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
          name: 'Integration workload registration tenant',
          slug: `integration-workload-registration-${id}`,
          status: 'active' as const,
          tenantId: id,
        })),
      );
      yield* admin.insert(legalEntities).values(
        [
          { legalEntityId: companyId, tenantId },
          { legalEntityId: otherCompanyId, tenantId },
          { legalEntityId: foreignCompanyId, tenantId: foreignTenantId },
        ].map((company) => ({
          ...company,
          legalName: 'Integration workload registration company',
          registrationCountry: 'CZ',
          registrationNumber: `INTEGRATION-WORKLOADS-${company.legalEntityId}`,
          status: 'active' as const,
        })),
      );
      // Demo line: scopes are written through the runtime identity, the one role that installs a tenant scope.
      yield* writeTestTenantScopes(runtimeDatabase, {
        legalEntityIds: [companyId, otherCompanyId],
        principalId: administrator.principalId,
        tenantId,
      });
      yield* writeTestTenantScopes(runtimeDatabase, {
        legalEntityIds: [foreignCompanyId],
        principalId: foreignAdministrator.principalId,
        tenantId: foreignTenantId,
      });
      yield* admin.insert(principals).values([
        ...people.map((person) => ({
          displayName: 'Integration workload registration person',
          kind: 'human' as const,
          principalId: person.principalId,
          status: 'active' as const,
          tenantId: person.tenantId,
        })),
        {
          displayName: 'Partner',
          integrationKind: 'symmy' as const,
          kind: 'integration' as const,
          principalId: integrationPrincipalId,
          status: 'active' as const,
          tenantId,
        },
        {
          displayName: 'Robot',
          kind: 'service' as const,
          principalId: servicePrincipalId,
          status: 'active' as const,
          tenantId,
        },
      ]);
      yield* admin.insert(principalAuthBindings).values(
        people.map((person) => ({
          authenticationNamespaceId: staffAuthenticationNamespaceId,
          principalAuthBindingId: person.authBindingId,
          principalId: person.principalId,
          provider: 'better_auth' as const,
          providerSubjectId: `integration-workload-registration-${person.authBindingId}`,
          status: 'active' as const,
          subjectType: 'user' as const,
          tenantId: person.tenantId,
        })),
      );
      yield* admin.insert(tenantModuleStates).values([
        { moduleKey: PARTNER_MODULE, state: 'active', tenantId },
        { moduleKey: DORMANT_MODULE, state: 'inactive', tenantId },
        { moduleKey: PARTNER_MODULE, state: 'active', tenantId: foreignTenantId },
      ]);
      const payload = { principalId: integrationPrincipalId, workloadKeys: partnerWorkloads };

      // The administrator binds both workloads and registers each for the selected company.
      const firstKey = yield* nextUuid;
      const first = yield* register(yield* sessionIn(administrator, companyId), payload, firstKey);
      expect(first).toMatchObject({ legalEntityId: companyId, principalId: integrationPrincipalId });
      expect(first.workloads.map(({ outcome, workloadKey }) => ({ outcome, workloadKey }))).toEqual(
        partnerWorkloads.map((workloadKey) => ({ outcome: 'REGISTERED', workloadKey })),
      );
      expect(
        (yield* companyRegistrations).toSorted((left, right) => left.workloadKey.localeCompare(right.workloadKey)),
      ).toEqual([...partnerWorkloads].toSorted().map((workloadKey) => ({ legalEntityId: companyId, workloadKey })));

      // The same request answers its saved reply; a new one keeps the registrations it finds.
      expect(yield* register(yield* sessionIn(administrator, companyId), payload, firstKey)).toEqual(first);
      const again = yield* register(yield* sessionIn(administrator, companyId), payload);
      expect(again.workloads).toEqual(
        first.workloads.map((workload) => ({ ...workload, outcome: 'ALREADY_REGISTERED' })),
      );

      // Who registered what is on the Action's own audit record.
      const audits = yield* admin
        .select({ evidence: auditEvents.evidenceJson, principalId: auditEvents.principalId })
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.eventType, 'action.executed')));
      expect(audits).toContainEqual({
        evidence: expect.objectContaining({
          actionKey: registerIntegrationWorkloadsAction.descriptor.actionKey,
          integrationPrincipalId,
          legalEntityId: companyId,
          registered: [...partnerWorkloads],
          unchanged: [],
        }),
        principalId: administrator.principalId,
      });

      // A member without the capability is refused by the gate.
      expect(yield* refusalOf(register(yield* sessionIn(member, companyId), payload))).toBe('ActionPermissionDenied');
      // Another Tenant's administrator cannot reach this Tenant's integration.
      expect(yield* refusalOf(register(yield* sessionIn(foreignAdministrator, foreignCompanyId), payload))).toBe(
        'IdentityTargetInvalidError',
      );
      // A binding names one company: the same integration cannot hold the workload for another company too.
      expect(yield* refusalOf(register(yield* sessionIn(administrator, otherCompanyId), payload))).toBe(
        'IdentityTargetInvalidError',
      );
      for (const refused of [
        // Only an integration Principal is bound this way.
        { principalId: servicePrincipalId, workloadKeys: [PARTNER_ADMISSION_WORKLOAD] },
        // A module's system workload belongs to the Tenant's system Principal.
        { principalId: integrationPrincipalId, workloadKeys: [PARTNER_SYSTEM_WORKLOAD] },
        // A workload of a module inactive in the Tenant.
        { principalId: integrationPrincipalId, workloadKeys: [DORMANT_WORKLOAD] },
        // A workload no installed module publishes.
        { principalId: integrationPrincipalId, workloadKeys: ['partner.ingress.unpublished'] },
      ] as const) {
        expect(yield* refusalOf(register(yield* sessionIn(administrator, companyId), refused))).toBe(
          'IdentityTargetInvalidError',
        );
      }
      // Nothing a refusal touched changed the integration's registrations.
      expect(yield* companyRegistrations).toHaveLength(partnerWorkloads.length);
      const serviceBindings = yield* admin
        .select({ workloadKey: accessWorkloadBindings.workloadKey })
        .from(accessWorkloadBindings)
        .where(
          and(
            eq(accessWorkloadBindings.tenantId, tenantId),
            eq(accessWorkloadBindings.principalId, servicePrincipalId),
          ),
        );
      expect(serviceBindings).toEqual([]);
    }),
  );
});
