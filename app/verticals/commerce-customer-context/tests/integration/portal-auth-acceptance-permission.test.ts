import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT, DATABASE_IDENTITIES } from '../support/database-identities.ts';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { v1 } from '@authzed/authzed-node';
import {
  DatabaseIdentityEnrollmentContext,
  ActiveApplicationCompositionService,
  ContextAccess,
  makeActionRuntimeLive,
  makeContextAccessLive,
  makeOperationalScopeRepository,
  makeOperationalScopeResolver,
  ModuleEntrypointGateway,
  ModuleStateGate,
  OperationalScopeResolver,
  OwnerAuthorizationOverlay,
  publishApplicationCompositionAuthority,
  ReadRuntime,
} from '@app/core-runtime';
import type { ActiveApplicationCompositionSnapshot } from '@app/core-runtime';
import { makeOwnerActionApprovalsLive } from '@app/core-runtime/access/approvals/owner-runtime';
import { NodeServices } from '@effect/platform-node';
import { eq, sql } from 'drizzle-orm';
import { Context, Crypto, Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import {
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
} from '../../../../packages/core-runtime/src/auth/gateway-assertion-redemption.ts';
import { ActionRepository, makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import {
  ActionPermission,
  makeActionPermissionLive,
} from '../../../../packages/core-runtime/src/permissions/service.ts';
import { CoreDatabase, makeCoreDatabase } from '../../../../packages/core-runtime/src/db/client.ts';
import {
  DatabaseConfig,
  loadDatabaseConnectionPair,
  loadDatabaseIdentityConnections,
  parseDatabaseConnectionPair,
} from '../../../../packages/core-runtime/src/db/config.ts';
import type { DatabaseConfigValue, DatabaseConnectionPair } from '../../../../packages/core-runtime/src/db/config.ts';
import { SHARED_RUNTIME_IDENTITY } from '../../../../packages/core-runtime/src/db/database-identities.ts';
import {
  dataAccessEvents,
  legalEntities,
  principalAuthBindings,
  principals,
  tenantModuleStates,
  tenants,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import { loadSpiceDbConfig } from '../../../../packages/core-runtime/src/permissions/config.ts';
import { newSpiceDbGrpcClient } from '../../../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { makeModuleEntrypointGateway } from '../../../../packages/core-runtime/src/modules/module-entrypoint-gateway.ts';
import { makeModuleStateGate } from '../../../../packages/core-runtime/src/modules/module-state-gate.ts';
import { makeTenantModuleStateService } from '../../../../packages/core-runtime/src/modules/tenant-module-state-service.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import {
  AccessDecisionLive,
  AccessEnforcementPortsLive,
  TenantIntentLoaderLive,
} from '../../../../packages/core-runtime/src/actions/runtime-wiring.ts';
import {
  makeScriptedBoundAccessGate,
  makeTestOperationalScopeAccess,
} from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import type { TestAccessOutcome } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import { acquireOutlivingCleanup, makeTestPgClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { toLegalEntityAccessObjectId } from '../../../../packages/core-runtime/src/permissions/context-access.ts';
import { historicalPermissionObjectId } from '../../../../packages/core-runtime/tests/support/historical-owner-targets.ts';
import { makeCommerceCustomerContextApiRuntime } from '../../api/index.ts';
import { commercePortalAuthRealmUnavailableLive } from '../../api/portal-auth/realm-unavailable.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { CustomerGroupMembersForbiddenProblemSchema } from '../../shared/apis/customer-group-members.ts';
import { SavedAddressListForbiddenProblemSchema } from '../../shared/apis/saved-address-list.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { commerceCustomerContextOwnerAuthorizationOverlayLive } from '../../src/persistence/owner-authorization-overlay.ts';
import { enrollmentApplicationCompositionSnapshot } from '../support/enrollment-application-composition.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';
import {
  issueAcceptanceGatewayAssertion,
  makeAcceptanceGatewayIssuer,
} from '../support/enrollment-acceptance-identity-gateway-assertion.ts';
import type { AcceptanceGatewayIssuer } from '../support/enrollment-acceptance-identity-gateway-assertion.ts';

/**
 * Two refusals on the deployed composition root, one per authority.
 *
 * The first is the *legacy* `authenticated_principal` saved-address read: the read still decides at
 * the business Permission, so its 403 is journalled as `spicedb_permission_denied` and proves the
 * legacy path, not the v2 gate (the read is not yet a `protected` carrier). The second is a real
 * v2-protected read, denied at the one access gate and journalled as `access_denied`, so the
 * suite proves the gate itself refuses and writes nothing.
 *
 * Everything but the Bearer assertion's issuer is the deployed composition: the real read runtime,
 * the real operational-scope revalidation against `core`, and the real SpiceDB authorization.
 */

const ORIGIN = 'http://localhost:3020';
const AUDIENCE = 'commerce-customer-context';
const ISSUER = 'http://gateway.permission-acceptance.test';
/** The namespace the deployed composition registers, so the production registry is what answers. */
const NAMESPACE_ID = COMMERCE_AUTHENTICATION_NAMESPACE_ID;
const KEY_ID = 'permission-acceptance';
const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url));

class PermissionAcceptanceSetupUnavailable extends Schema.TaggedError<PermissionAcceptanceSetupUnavailable>()(
  'PermissionAcceptanceSetupUnavailable',
  { reason: Schema.String },
) {}

const connectionStringForDatabase = (connectionString: string, database: string): string => {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.href;
};

const bootstrapPermissionRuntimeRole = Effect.fn('PermissionAcceptance.bootstrapRuntimeRole')(
  function* bootstrapPermissionRuntimeRole(connections: DatabaseConnectionPair) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // The bootstrap provisions every database identity, so each dedicated login targets this database too.
    const identities = yield* loadDatabaseIdentityConnections({
      enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
      envPath: '/dev/null',
    });
    const database = new URL(connections.admin.connectionString).pathname.slice(1);
    const dedicatedIdentityUrls = Object.fromEntries(
      DATABASE_IDENTITIES.filter(({ id }) => id !== SHARED_RUNTIME_IDENTITY.id).map(({ id, urlKey }) => [
        urlKey,
        connectionStringForDatabase(identities.runtime[id].connectionString, database),
      ]),
    );
    const bootstrap = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [path.join(workspaceRoot, 'scripts/postgres/bootstrap-runtime-role.mts')], {
        cwd: workspaceRoot,
        env: {
          APP_ENV_PATH: '/dev/null',
          ...dedicatedIdentityUrls,
          DATABASE_ADMIN_URL: connections.admin.connectionString,
          DATABASE_URL: connections.runtime.connectionString,
        },
        extendEnv: true,
        stderr: 'ignore',
        stdin: 'ignore',
        stdout: 'ignore',
      }),
    );
    const status = yield* bootstrap.exitCode;
    if (Number(status) !== 0) {
      yield* new PermissionAcceptanceSetupUnavailable({ reason: 'The native runtime-role bootstrap failed' });
    }
  },
);

/** This scenario owns one database; retained proof and authority in the caller's database stay intact. */
const acquirePermissionDatabase = Effect.fn('PermissionAcceptance.acquireDatabase')(
  function* acquirePermissionDatabase() {
    const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    const control = yield* makeTestPgClient(connections.admin.connectionString);
    const database = `ontos_ccc_permission_${randomUUID().replaceAll('-', '')}`;
    yield* Effect.acquireRelease(control.unsafe(`create database "${database}"`), () =>
      control.unsafe(`drop database "${database}"`).pipe(Effect.orDie),
    );
    const isolated = yield* parseDatabaseConnectionPair({
      DATABASE_ADMIN_URL: connectionStringForDatabase(connections.admin.connectionString, database),
      DATABASE_URL: connectionStringForDatabase(connections.runtime.connectionString, database),
    });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    for (const owner of ['packages/core-runtime', 'verticals/commerce-customer-context']) {
      const workingDirectory = path.join(workspaceRoot, owner);
      const migration = yield* spawner.spawn(
        ChildProcess.make(
          path.join(workingDirectory, 'node_modules', '.bin', 'drizzle-kit'),
          ['migrate', '--config', 'drizzle.config.ts'],
          {
            cwd: workingDirectory,
            env: {
              APP_ENV_PATH: '/dev/null',
              DATABASE_ADMIN_URL: isolated.admin.connectionString,
              DATABASE_URL: isolated.runtime.connectionString,
            },
            extendEnv: true,
            stderr: 'ignore',
            stdin: 'ignore',
            stdout: 'ignore',
          },
        ),
      );
      const status = yield* migration.exitCode;
      if (Number(status) !== 0) {
        return yield* new PermissionAcceptanceSetupUnavailable({ reason: `The native ${owner} migration failed` });
      }
    }
    yield* bootstrapPermissionRuntimeRole(isolated);
    const admin = yield* acquireOutlivingCleanup(makeCoreDatabase(isolated.admin));
    const runtime = yield* acquireOutlivingCleanup(makeCoreDatabase(isolated.runtime));
    const snapshot = yield* enrollmentApplicationCompositionSnapshot;
    yield* admin.executor.transaction((transaction) => publishApplicationCompositionAuthority(transaction, snapshot));
    return { admin, runtime, runtimeConfiguration: isolated.runtime, snapshot };
  },
);

interface SeededSubject {
  readonly authBindingId: string;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

const seedCoreSubject = Effect.fnUntraced(function* seedCoreSubject(
  admin: Effect.Success<ReturnType<typeof makeCoreDatabase>>,
) {
  const subject: SeededSubject = {
    authBindingId: randomUUID(),
    legalEntityId: randomUUID(),
    principalId: randomUUID(),
    tenantId: randomUUID(),
  };
  const cleanup = Effect.gen(function* removeSeededRows() {
    for (const table of [
      dataAccessEvents,
      principalAuthBindings,
      tenantModuleStates,
      legalEntities,
      principals,
      tenants,
    ]) {
      yield* admin.executor.delete(table).where(eq(table.tenantId, subject.tenantId));
    }
  });
  yield* Effect.acquireRelease(cleanup, () => cleanup.pipe(Effect.orDie));
  yield* admin.executor.insert(tenants).values({
    defaultLocale: 'en',
    name: 'Permission acceptance tenant',
    slug: `permission-acceptance-${subject.tenantId}`,
    status: 'active',
    tenantId: subject.tenantId,
  });
  yield* admin.executor.insert(principals).values({
    displayName: 'Permission acceptance customer',
    kind: 'human',
    principalId: subject.principalId,
    status: 'active',
    tenantId: subject.tenantId,
  });
  yield* admin.executor.insert(legalEntities).values({
    legalEntityId: subject.legalEntityId,
    legalName: 'Permission acceptance selling entity',
    registrationCountry: 'CZ',
    registrationNumber: `permission-acceptance-${subject.legalEntityId}`,
    status: 'active',
    tenantId: subject.tenantId,
  });
  yield* admin.executor.insert(tenantModuleStates).values({
    moduleKey: 'commerce.customer-context',
    state: 'active',
    tenantId: subject.tenantId,
  });
  yield* admin.executor.insert(principalAuthBindings).values({
    authenticationNamespaceId: NAMESPACE_ID,
    principalAuthBindingId: subject.authBindingId,
    principalId: subject.principalId,
    provider: 'commerce-acceptance-provider',
    providerSubjectId: `permission-acceptance-${subject.principalId}`,
    status: 'active',
    subjectType: 'user',
    tenantId: subject.tenantId,
  });
  return { admin, subject };
});

const requiredObjectId = (value: string | undefined, description: string): string => {
  if (value === undefined) {
    throw new Error(`${description} could not be encoded`);
  }
  return value;
};

/**
 * Tenant membership and Legal Entity access, and nothing else: the `business_permission` grant the
 * profile selection needs is deliberately absent, and is written only by the positive control below.
 */
const seedSpiceDbContext = Effect.fnUntraced(function* seedSpiceDbContext(subject: SeededSubject) {
  const configuration = yield* loadSpiceDbConfig({ envPath: '/dev/null' });
  const client = newSpiceDbGrpcClient(configuration);
  const principalSubject = v1.SubjectReference.create({
    object: v1.ObjectReference.create({ objectId: subject.principalId, objectType: 'principal' }),
  });
  const legalEntityObject = v1.ObjectReference.create({
    objectId: requiredObjectId(
      toLegalEntityAccessObjectId(subject.tenantId, subject.legalEntityId),
      'The Legal Entity access object',
    ),
    objectType: 'legal_entity',
  });
  const write = (operation: v1.RelationshipUpdate_Operation, relationships: readonly v1.Relationship[]) =>
    Effect.promise(
      async () =>
        await client.promises.writeRelationships(
          v1.WriteRelationshipsRequest.create({
            updates: relationships.map((relationship) => v1.RelationshipUpdate.create({ operation, relationship })),
          }),
        ),
    );
  const install = (relationships: readonly v1.Relationship[]) =>
    Effect.gen(function* installRelationships() {
      yield* write(v1.RelationshipUpdate_Operation.TOUCH, relationships);
      yield* Effect.addFinalizer(() =>
        write(v1.RelationshipUpdate_Operation.DELETE, relationships).pipe(Effect.asVoid, Effect.orDie),
      );
    });
  yield* install([
    v1.Relationship.create({
      relation: 'member',
      resource: v1.ObjectReference.create({ objectId: subject.tenantId, objectType: 'tenant' }),
      subject: principalSubject,
    }),
    v1.Relationship.create({
      relation: 'tenant',
      resource: legalEntityObject,
      subject: v1.SubjectReference.create({
        object: v1.ObjectReference.create({ objectId: subject.tenantId, objectType: 'tenant' }),
      }),
    }),
    v1.Relationship.create({
      relation: 'member',
      resource: legalEntityObject,
      subject: principalSubject,
    }),
  ]);
  return (counterpartyId: string) => {
    const businessPermissionObject = v1.ObjectReference.create({
      objectId: requiredObjectId(
        historicalPermissionObjectId('counterparty.address_book.use', {
          counterpartyId,
          kind: 'counterparty',
          legalEntityId: subject.legalEntityId,
          tenantId: subject.tenantId,
        }),
        'The Counterparty address-book permission object',
      ),
      objectType: 'business_permission',
    });
    return install([
      v1.Relationship.create({
        relation: 'legal_entity',
        resource: businessPermissionObject,
        subject: v1.SubjectReference.create({ object: legalEntityObject }),
      }),
      v1.Relationship.create({
        relation: 'grantee',
        resource: businessPermissionObject,
        subject: principalSubject,
      }),
    ]);
  };
});

/** A redemption store that accepts each `jti` exactly once, as a deployed redemption store does. */
const singleUseRedemptionLive = Layer.sync(GatewayAssertionRedemptionService, () => {
  const consumed = new Set<string>();
  return {
    consume: ({ jti }) =>
      consumed.has(jti)
        ? Effect.fail(new GatewayAssertionReplayError({ reason: 'The Bearer assertion was already redeemed' }))
        : Effect.sync(() => {
            consumed.add(jti);
          }),
  };
});

const configuredRuntime = Effect.fn('PermissionAcceptance.configuredRuntime')(function* configuredRuntime(
  gateway: AcceptanceGatewayIssuer,
  database: Effect.Success<ReturnType<typeof makeCoreDatabase>>,
  snapshot: ActiveApplicationCompositionSnapshot,
  databaseConfiguration: DatabaseConfigValue,
  /** The Read gate's scripted answer; the default `allowed` leaves the legacy read path below the decider. */
  readAccess: TestAccessOutcome | Readonly<Record<string, TestAccessOutcome>> = 'allowed',
) {
  const contextAccess = yield* makeContextAccessLive(undefined, () => loadSpiceDbConfig({ envPath: '/dev/null' }));
  const moduleStateGate = makeModuleStateGate(makeTenantModuleStateService(database));
  const moduleGateway = makeModuleEntrypointGateway(moduleStateGate);
  const crypto = yield* Crypto.Crypto;
  const scopeAccess = makeTestOperationalScopeAccess();
  const scopeResolver = yield* makeOperationalScopeResolver(
    makeOperationalScopeRepository(database, FIXTURE_DATABASE_IDENTITY_ENROLLMENT),
    scopeAccess,
  );
  const ownerOverlayContext = yield* Layer.build(commerceCustomerContextOwnerAuthorizationOverlayLive);
  const ownerAuthorizationOverlay = Context.get(ownerOverlayContext, OwnerAuthorizationOverlay);
  // The one v2 gate every protected entrypoint asks (CUTOVER-PLAN §3.1). This scenario's subject is
  // the legacy `authenticated_principal` saved-address read, so the gate answers allowed and the
  // legacy business-permission path below is the decider the assertions describe.
  const accessEnforcementLive = AccessDecisionLive.pipe(
    Layer.provideMerge(AccessEnforcementPortsLive),
    Layer.provide(TenantIntentLoaderLive),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(CoreDatabase, database),
        Layer.succeed(Crypto.Crypto, crypto),
        Layer.succeed(DatabaseIdentityEnrollmentContext, FIXTURE_DATABASE_IDENTITY_ENROLLMENT),
      ),
    ),
  );
  const readRuntime = makeReadRuntime(database, moduleGateway, scopeResolver, contextAccess, {
    accessDecision: makeScriptedBoundAccessGate(readAccess).bound,
    applicationComposition: { load: Effect.succeed(snapshot) },
    databaseIdentities: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
    expectedDeployment: ultramodernApiMarker,
    ownerAuthorizationOverlay,
    ownerRegistration: commerceCustomerContextRegistration,
  });
  const ownerServices = Layer.mergeAll(
    Layer.succeed(ActionRepository, makeActionRepository(crypto)),
    Layer.effect(
      ActionPermission,
      makeActionPermissionLive(undefined, () => loadSpiceDbConfig({ envPath: '/dev/null' })),
    ),
    Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
    Layer.succeed(ContextAccess, contextAccess),
    Layer.succeed(CoreDatabase, database),
    Layer.succeed(Crypto.Crypto, crypto),
    Layer.succeed(DatabaseIdentityEnrollmentContext, FIXTURE_DATABASE_IDENTITY_ENROLLMENT),
    Layer.succeed(ModuleEntrypointGateway, moduleGateway),
    Layer.succeed(ModuleStateGate, moduleStateGate),
    Layer.succeed(OperationalScopeResolver, scopeResolver),
    Layer.succeed(OwnerAuthorizationOverlay, ownerAuthorizationOverlay),
    accessEnforcementLive,
  );
  const ownerApprovals = makeOwnerActionApprovalsLive(ultramodernApiMarker, commerceCustomerContextRegistration).pipe(
    Layer.provide(ownerServices),
  );
  const actionRuntime = makeActionRuntimeLive(ultramodernApiMarker, commerceCustomerContextRegistration).pipe(
    Layer.provideMerge(ownerApprovals),
    Layer.provide(ownerServices),
  );
  return yield* Effect.acquireRelease(
    Effect.sync(() =>
      makeCommerceCustomerContextApiRuntime(
        Layer.succeed(ReadRuntime, readRuntime),
        actionRuntime,
        singleUseRedemptionLive,
        commercePortalAuthRealmUnavailableLive([ORIGIN]),
        gateway.verificationLive,
        Layer.succeed(DatabaseConfig, databaseConfiguration),
        Layer.succeed(ContextAccess, contextAccess),
      ).createHandler(),
    ),
    (runtime) => Effect.promise(async () => await runtime.dispose()),
  );
});

it.live(
  'a legacy authenticated-principal selection without its business Permission is 403 and writes nothing',
  () =>
    Effect.scoped(
      Effect.gen(function* profileSelectionWithoutPermission() {
        const database = yield* acquirePermissionDatabase();
        const gateway = yield* makeAcceptanceGatewayIssuer(ISSUER, KEY_ID);
        const { admin, subject } = yield* seedCoreSubject(database.admin);
        const grantAddressBookPermission = yield* seedSpiceDbContext(subject);
        const runtime = yield* configuredRuntime(
          gateway,
          database.runtime,
          database.snapshot,
          database.runtimeConfiguration,
        );
        const counterpartyId = randomUUID();

        const selectProfile = Effect.fnUntraced(function* selectProfile() {
          const assertion = yield* issueAcceptanceGatewayAssertion(admin.executor, gateway, AUDIENCE, {
            authBindingId: subject.authBindingId,
            authContextRef: `portal-session:${subject.authBindingId}`,
            authenticationNamespaceId: NAMESPACE_ID,
            authMethod: 'session',
            legalEntityId: subject.legalEntityId,
            principalId: subject.principalId,
            tenantId: subject.tenantId,
          });
          return yield* Effect.promise(
            async () =>
              await runtime.handler(
                new Request(`${ORIGIN}/reads/saved-address-list`, {
                  body: JSON.stringify({
                    profile: {
                      counterpartyRef: {
                        moduleId: 'party.registry',
                        resourceId: counterpartyId,
                        resourceType: 'party.registry.counterparty',
                        tenantId: subject.tenantId,
                      },
                      kind: 'COUNTERPARTY',
                      profileRef: {
                        moduleId: 'commerce.customer-context',
                        resourceId: randomUUID(),
                        resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
                        tenantId: subject.tenantId,
                      },
                    },
                  }),
                  headers: {
                    authorization: `Bearer ${assertion}`,
                    'content-type': 'application/json',
                    origin: ORIGIN,
                    'x-correlation-id': `permission-acceptance-${randomUUID()}`,
                  },
                  method: 'POST',
                }),
              ),
          );
        });

        const savedAddressRows = () =>
          admin.executor.execute<{ readonly saved_address_id: string }>(
            sql`
            select saved_address_id
              from commerce_customer_context.saved_addresses
             where tenant_id = ${subject.tenantId}::uuid
             order by saved_address_id
          `,
            'objects',
          );
        const addressesBefore = yield* savedAddressRows();

        const denied = yield* selectProfile();
        expect(denied.status).toBe(403);
        expect(denied.headers.get('content-type')).toContain('application/problem+json');
        const deniedProblem = yield* Effect.promise(async () => await denied.clone().json());
        expect(Schema.is(SavedAddressListForbiddenProblemSchema)(deniedProblem)).toBe(true);
        expect(deniedProblem).toMatchObject({
          detail: 'The principal is not permitted to perform this read.',
          status: 403,
          title: 'Read forbidden',
          type: 'https://ontos.dev/problems/read-forbidden',
        });

        // The denial is journalled as a denial and nothing is served: the access evidence names the
        // authorization stage and the one v2 gate's refusal, and no business row moves.
        expect(
          yield* admin.executor
            .select({
              outcome: dataAccessEvents.outcome,
              outcomeCode: dataAccessEvents.outcomeCode,
              outcomeStage: dataAccessEvents.outcomeStage,
              resultCount: dataAccessEvents.resultCount,
            })
            .from(dataAccessEvents)
            .where(eq(dataAccessEvents.tenantId, subject.tenantId)),
        ).toStrictEqual([
          { outcome: 'denied', outcomeCode: 'read_permission_denied', outcomeStage: 'authz', resultCount: 0 },
        ]);
        expect(yield* savedAddressRows()).toStrictEqual(addressesBefore);

        // The one v2 gate is what answered, and the legacy SpiceDB business Permission is no longer
        // an input to it: with the exact `counterparty.address_book.use` relationship written and
        // every other input identical, the selection is refused by the same gate with the same code
        // (CUTOVER-PLAN §3.1).
        yield* grantAddressBookPermission(counterpartyId);
        yield* selectProfile();
        expect(
          yield* admin.executor
            .select({ outcomeCode: dataAccessEvents.outcomeCode })
            .from(dataAccessEvents)
            .where(eq(dataAccessEvents.tenantId, subject.tenantId))
            .orderBy(dataAccessEvents.occurredAt),
        ).toStrictEqual([{ outcomeCode: 'read_permission_denied' }, { outcomeCode: 'read_permission_denied' }]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  // Building the deployed composition root — every governed route, both runtimes, the Core pools
  // and the SpiceDB client — costs more than this project's default per-test budget.
  180_000,
);

it.live(
  'a v2-protected read is 403 at the one access gate and writes no business row',
  () =>
    Effect.scoped(
      Effect.gen(function* v2ProtectedReadDenied() {
        const database = yield* acquirePermissionDatabase();
        const gateway = yield* makeAcceptanceGatewayIssuer(ISSUER, KEY_ID);
        const { admin, subject } = yield* seedCoreSubject(database.admin);
        // The subject holds every legacy relationship the old path would need, but the one v2 gate
        // answers DENIED for the read's own declaration: the refusal is the gate's, not a legacy
        // business-Permission check (CUTOVER-PLAN §3.1).
        const runtime = yield* configuredRuntime(
          gateway,
          database.runtime,
          database.snapshot,
          database.runtimeConfiguration,
          { 'commerce.customer-context.customer-group.list-members': 'denied' },
        );
        const assertion = yield* issueAcceptanceGatewayAssertion(admin.executor, gateway, AUDIENCE, {
          authBindingId: subject.authBindingId,
          authContextRef: `portal-session:${subject.authBindingId}`,
          authenticationNamespaceId: NAMESPACE_ID,
          authMethod: 'session',
          legalEntityId: subject.legalEntityId,
          principalId: subject.principalId,
          tenantId: subject.tenantId,
        });
        const response = yield* Effect.promise(
          async () =>
            await runtime.handler(
              new Request(`${ORIGIN}/reads/customer-group-members`, {
                body: JSON.stringify({
                  groupRef: {
                    moduleId: 'commerce.customer-context',
                    resourceId: randomUUID(),
                    resourceType: 'commerce.customer-context.customer-group',
                    tenantId: subject.tenantId,
                  },
                }),
                headers: {
                  authorization: `Bearer ${assertion}`,
                  'content-type': 'application/json',
                  origin: ORIGIN,
                  'x-correlation-id': `permission-acceptance-v2-${randomUUID()}`,
                },
                method: 'POST',
              }),
            ),
        );
        expect(response.status).toBe(403);
        expect(response.headers.get('content-type')).toContain('application/problem+json');
        const problem = yield* Effect.promise(async () => await response.clone().json());
        expect(Schema.is(CustomerGroupMembersForbiddenProblemSchema)(problem)).toBe(true);
        // The v2 gate's own denial is the evidence the read journalled, and no owner row moved.
        expect(
          yield* admin.executor
            .select({
              outcome: dataAccessEvents.outcome,
              outcomeCode: dataAccessEvents.outcomeCode,
              outcomeStage: dataAccessEvents.outcomeStage,
              resultCount: dataAccessEvents.resultCount,
            })
            .from(dataAccessEvents)
            .where(eq(dataAccessEvents.tenantId, subject.tenantId)),
        ).toStrictEqual([{ outcome: 'denied', outcomeCode: 'access_denied', outcomeStage: 'authz', resultCount: 0 }]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  180_000,
);
