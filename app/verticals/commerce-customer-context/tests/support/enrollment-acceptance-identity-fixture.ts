import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { Context, Effect, Layer, Option, Redacted, Schema } from 'effect';

import { layerTestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { acquireFixturePgClient } from './fixture-pg-client.ts';
import { TrustedPrincipalContextSchema } from '../../../../packages/core-runtime/src/actions/principal-context.ts';
import { ActionRepositoryLive } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { ActionRuntime, ActionRuntimeLive } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import {
  AuthenticationNamespaceRegistrationSchema,
  ExternalAuthenticationSubjectSchema,
  TenantIdSchema,
} from '../../../../packages/core-runtime/src/auth/external-identity-contracts.ts';
import { externalIdentityRepositoryFromTransaction } from '../../../../packages/core-runtime/src/auth/external-identity/repository.ts';
import type {
  ChangeExternalIdentityStatusInput,
  ExternalIdentityRepositoryService,
} from '../../../../packages/core-runtime/src/auth/external-identity/repository.ts';
import { AuthenticationNamespaceRegistry } from '../../../../packages/core-runtime/src/auth/external-identity/verifier.ts';
import type { AuthenticationNamespaceRegistryService } from '../../../../packages/core-runtime/src/auth/external-identity/verifier.ts';
import { trustResolvedSystemPrincipalContext } from '../../../../packages/core-runtime/src/auth/system-principal-context-provenance.ts';
import { CoreDatabase } from '../../../../packages/core-runtime/src/db/client.ts';
import { loadDatabaseConnectionPair } from '../../../../packages/core-runtime/src/db/config.ts';
import {
  actionInvocations,
  auditEvents,
  coreRelations,
  dataAccessEvents,
  domainEvents,
  outboxMessages,
  principalAuthBindings,
  principals,
  tenants,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { activatePrincipalBindingAction } from '../../../../packages/core-runtime/src/modules/actions/activate-principal-binding.action.ts';
import { reservePrincipalBindingAction } from '../../../../packages/core-runtime/src/modules/actions/reserve-principal-binding.action.ts';
import { ModuleEntrypointGatewayLive } from '../../../../packages/core-runtime/src/modules/module-entrypoint-gateway.ts';
import { ModuleStateGateLive } from '../../../../packages/core-runtime/src/modules/module-state-gate.ts';
import { TenantModuleStateServiceLive } from '../../../../packages/core-runtime/src/modules/tenant-module-state-service.ts';
import {
  OperationalScopeResolver,
  OperationalScopeResolverLive,
} from '../../../../packages/core-runtime/src/operations/context.ts';
import type { OperationalScopeResolverService } from '../../../../packages/core-runtime/src/operations/context.ts';
import { ContextAccess } from '../../../../packages/core-runtime/src/permissions/context-access.ts';
import type { ContextAccessService } from '../../../../packages/core-runtime/src/permissions/context-access.ts';
import { ActionPermission } from '../../../../packages/core-runtime/src/permissions/service.ts';
import { ExternalIdentityClient } from '../../../../packages/shared-contracts/src/external-identity-client.ts';
import type { ExternalIdentityClientPort } from '../../../../packages/shared-contracts/src/external-identity-client.ts';
import {
  CommerceEnrollmentCommitResolutionService,
  CommerceEnrollmentCommitResolutionServiceLive,
} from '../../src/enrollment/commit-resolution/commit-resolution-service.ts';
import type { CommerceEnrollmentCommitResolutionServicePort } from '../../src/enrollment/commit-resolution/commit-resolution-service.ts';
import { CommercePortalAccountSubjectSchema } from '../../shared/enrollment-contracts.ts';
import type { CommercePortalAccountSubject } from '../../shared/enrollment-contracts.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';

/** The Commerce portal namespace as Core knows it, owned here as this fixture's deployment input. */
const AcceptanceNamespaceRegistryLive = Layer.effect(
  AuthenticationNamespaceRegistry,
  Effect.gen(function* acceptanceNamespaceRegistry() {
    const registration = yield* Schema.decodeEffect(AuthenticationNamespaceRegistrationSchema)({
      allowedAudiences: ['commerce.acceptance.core'],
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      provider: 'commerce-portal-better-auth',
      requiresOperationAdmission: false,
      reservationPrincipalKind: 'human',
      subjectTypes: ['user'],
      trustedAttesterPrincipalIds: [],
    });
    return {
      lookup: (authenticationNamespaceId) =>
        Effect.succeed(
          authenticationNamespaceId === registration.authenticationNamespaceId
            ? Option.some(registration)
            : Option.none(),
        ),
    };
  }),
).pipe(Layer.orDie);

const allowed = (keys: readonly string[]) => Effect.succeed(keys.map((key) => ({ decision: 'allowed' as const, key })));

/**
 * Context authorization is granted wholesale: these scenarios are about Core identity currentness,
 * and a SpiceDB denial would mask the binding answer they exist to prove. The portal-auth
 * permission acceptance covers the authorization gates.
 */
const openContextAccess: ContextAccessService = {
  identityNamespaces: ({ authenticationNamespaceIds }) => allowed(authenticationNamespaceIds),
  legalEntities: ({ legalEntityIds }) => allowed(legalEntityIds),
  modules: ({ moduleIds }) => allowed(moduleIds),
  resources: ({ resources }) =>
    allowed(resources.map(({ moduleId, resourceId, resourceType }) => `${moduleId}:${resourceType}:${resourceId}`)),
  tenants: ({ tenantIds }) => allowed(tenantIds),
};

const AcceptanceContextAccessLive = Layer.succeed(ContextAccess, openContextAccess);
const AcceptanceActionPermissionLive = Layer.succeed(ActionPermission, {
  checkActionPermission: () => Effect.succeed('allowed' as const),
});

/**
 * Small, explicitly bounded pools: the scenarios open nested Core transactions and the shared
 * development PostgreSQL has a modest connection budget.
 */
class AcceptanceCoreDatabase extends Context.Service<
  AcceptanceCoreDatabase,
  TestDatabaseFromClient<typeof coreRelations>
>()('@app/commerce-customer-context/tests/support/AcceptanceCoreDatabase') {}

const acceptanceDatabase = Effect.fnUntraced(function* acceptanceDatabase(connectionString: string) {
  const client = yield* acquireFixturePgClient(connectionString, 3);
  const executor = yield* AcceptanceCoreDatabase.pipe(
    Effect.provide(layerTestDatabaseFromClient(AcceptanceCoreDatabase, client, coreRelations)),
    Effect.orDie,
  );
  return { executor };
});

type CoreDatabaseHandle = Effect.Success<ReturnType<typeof acceptanceDatabase>>;

export interface EnrollmentAcceptanceIdentityFixture {
  /** Actor of every governed reservation and activation run through the real Action runtime. */
  readonly actor: ReturnType<typeof trustResolvedSystemPrincipalContext>;
  /** Owner-role handle, used only to seed and to inspect durable rows. */
  readonly admin: CoreDatabaseHandle;
  readonly commitResolution: CommerceEnrollmentCommitResolutionServicePort;
  readonly identityServicesLive: Layer.Layer<AuthenticationNamespaceRegistry | ContextAccess>;
  readonly registry: AuthenticationNamespaceRegistryService;
  readonly runtime: (typeof ActionRuntime)['Service'];
  /** The production operational-scope resolver over the real `core` tables. */
  readonly scopeResolver: OperationalScopeResolverService;
  readonly tenantId: string;
}

/** A namespace-qualified subject in the Commerce enrollment vocabulary. */
export const makeAccountSubject = () =>
  Schema.decodeSync(CommercePortalAccountSubjectSchema)({
    authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
    providerSubjectId: `portal-user-${randomUUID()}`,
    subjectType: 'user',
  });

const coreSubject = (subject: CommercePortalAccountSubject) =>
  Schema.decodeSync(ExternalAuthenticationSubjectSchema)({
    authenticationNamespaceId: subject.authenticationNamespaceId,
    providerSubjectId: subject.providerSubjectId,
    subjectType: subject.subjectType,
  });

interface RepositoryScope {
  readonly correlationId: string;
  readonly principalId: string;
  readonly registry: AuthenticationNamespaceRegistryService;
  readonly tenantId: string;
}

const withRepository = <Value, Failure>(
  database: CoreDatabaseHandle,
  scope: RepositoryScope,
  operation: (repository: ExternalIdentityRepositoryService) => Effect.Effect<Value, Failure>,
) =>
  database.executor.transaction((transaction) =>
    installOperationalScope(transaction, {
      authMethod: 'system',
      correlationId: scope.correlationId,
      principalId: scope.principalId,
      tenantId: scope.tenantId,
    }).pipe(
      Effect.flatMap((scopedTransaction) =>
        operation(externalIdentityRepositoryFromTransaction(scopedTransaction, { registry: scope.registry })),
      ),
    ),
  );

const unsupportedIdentityCall = (operation: string) =>
  Effect.die(`${operation} is not part of the identity acceptance matrix`);

/**
 * The in-process Core-identity owner effect. The deployed Commerce port speaks HTTP to Shell, and
 * the far side of that transport is this exact Core repository read against
 * `core.principal_auth_bindings`; binding it directly keeps every identity answer a real row.
 */
const identityClientFor = (
  database: CoreDatabaseHandle,
  scope: Omit<RepositoryScope, 'correlationId'>,
): ExternalIdentityClientPort => ({
  activatePrincipalBinding: () => unsupportedIdentityCall('activatePrincipalBinding'),
  changePrincipalBindingStatus: () => unsupportedIdentityCall('changePrincipalBindingStatus'),
  issueExternalGatewayContext: () => unsupportedIdentityCall('issueExternalGatewayContext'),
  readPrincipalBinding: (payload, options) =>
    withRepository(database, { ...scope, correlationId: options.requestCorrelation }, (repository) =>
      repository.read({ ...payload, tenantId: scope.tenantId }),
    ).pipe(Effect.orDie),
  reservePrincipalBinding: () => unsupportedIdentityCall('reservePrincipalBinding'),
  resolveExternalSubject: () => unsupportedIdentityCall('resolveExternalSubject'),
});

export const makeEnrollmentAcceptanceIdentityFixture = Effect.fnUntraced(
  function* makeEnrollmentAcceptanceIdentityFixture() {
    const connections = yield* loadDatabaseConnectionPair();
    const admin = yield* acceptanceDatabase(connections.admin.connectionString);
    const runtimeDatabase = yield* acceptanceDatabase(connections.runtime.connectionString);
    const tenantId = yield* Schema.decodeEffect(TenantIdSchema)(randomUUID());
    const actorPrincipalId = randomUUID();
    const cleanup = Effect.gen(function* removeIdentityFixtureRows() {
      for (const table of [
        outboxMessages,
        domainEvents,
        dataAccessEvents,
        auditEvents,
        actionInvocations,
        principalAuthBindings,
        principals,
        tenants,
      ]) {
        yield* admin.executor.delete(table).where(eq(table.tenantId, tenantId));
      }
    });
    yield* Effect.acquireRelease(cleanup, () => cleanup.pipe(Effect.orDie));
    yield* admin.executor.insert(tenants).values({
      defaultLocale: 'en',
      name: 'Enrollment identity acceptance',
      slug: `enrollment-identity-acceptance-${tenantId}`,
      status: 'active',
      tenantId,
    });
    yield* admin.executor.insert(principals).values({
      displayName: 'Enrollment identity acceptance actor',
      kind: 'system',
      principalId: actorPrincipalId,
      status: 'active',
      tenantId,
    });

    const identityServicesLive = Layer.mergeAll(AcceptanceNamespaceRegistryLive, AcceptanceContextAccessLive);
    const runtimeDatabaseLive = Layer.succeed(CoreDatabase, runtimeDatabase);
    const moduleStateGateLive = ModuleStateGateLive.pipe(
      Layer.provide(TenantModuleStateServiceLive),
      Layer.provide(runtimeDatabaseLive),
    );
    const scopeResolverLive = OperationalScopeResolverLive.pipe(
      Layer.provide(Layer.mergeAll(runtimeDatabaseLive, AcceptanceContextAccessLive)),
    );
    const actionRuntimeLive = ActionRuntimeLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          ActionRepositoryLive,
          AcceptanceActionPermissionLive,
          ModuleEntrypointGatewayLive.pipe(Layer.provide(moduleStateGateLive)),
          moduleStateGateLive,
          scopeResolverLive,
          AcceptanceContextAccessLive,
          runtimeDatabaseLive,
        ),
      ),
    );
    const identityClientLive = Layer.effect(
      ExternalIdentityClient,
      AuthenticationNamespaceRegistry.pipe(
        Effect.map((namespaceRegistry) =>
          identityClientFor(runtimeDatabase, {
            principalId: actorPrincipalId,
            registry: namespaceRegistry,
            tenantId,
          }),
        ),
      ),
    ).pipe(Layer.provide(identityServicesLive));
    const fixtureLive = Layer.mergeAll(
      CommerceEnrollmentCommitResolutionServiceLive.pipe(
        Layer.provide(Layer.mergeAll(actionRuntimeLive, identityClientLive)),
      ),
      actionRuntimeLive,
      scopeResolverLive,
      identityServicesLive,
    ).pipe(Layer.orDie);
    const fixtureScope = yield* Effect.scope;
    const context = yield* Layer.buildWithScope(fixtureLive, fixtureScope);
    return {
      actor: trustResolvedSystemPrincipalContext(
        Schema.decodeSync(TrustedPrincipalContextSchema)({
          authContextRef: `job:enrollment-identity-acceptance:run:${tenantId}`,
          authMethod: 'system',
          principalId: actorPrincipalId,
          tenantId,
        }),
      ),
      admin,
      commitResolution: Context.get(context, CommerceEnrollmentCommitResolutionService),
      identityServicesLive,
      registry: Context.get(context, AuthenticationNamespaceRegistry),
      runtime: Context.get(context, ActionRuntime),
      scopeResolver: Context.get(context, OperationalScopeResolver),
      tenantId,
    } satisfies EnrollmentAcceptanceIdentityFixture;
  },
);

const transportFor = (subject: CommercePortalAccountSubject, idempotencyKey: string) => ({
  correlationId: `enrollment-identity-acceptance-${idempotencyKey}`,
  idempotencyKey,
  targetModuleKey: 'core.identity',
  targetResourceId: subject.providerSubjectId,
  targetResourceType: 'principal-auth-binding',
});

/** The governed Core reservation, run through the real Action runtime so the commit is durable. */
export const runReservation = (
  fixture: EnrollmentAcceptanceIdentityFixture,
  subject: CommercePortalAccountSubject,
  idempotencyKey: string,
  displayName = 'Portal enrollment acceptance principal',
) =>
  fixture.runtime
    .runAction({
      payload: { ...coreSubject(subject), displayName },
      principal: fixture.actor,
      registration: reservePrincipalBindingAction,
      transport: transportFor(subject, idempotencyKey),
    })
    .pipe(Effect.provide(fixture.identityServicesLive));

/** The governed Core activation of a pending reservation, likewise a real committed invocation. */
export const runActivation = (
  fixture: EnrollmentAcceptanceIdentityFixture,
  subject: CommercePortalAccountSubject,
  authBindingId: string,
  expectedRevision: number,
  idempotencyKey: string,
) =>
  fixture.runtime
    .runAction({
      payload: { authBindingId, expectedRevision },
      principal: fixture.actor,
      registration: activatePrincipalBindingAction,
      transport: transportFor(subject, idempotencyKey),
    })
    .pipe(Effect.provide(fixture.identityServicesLive));

/** The invocation id the runtime minted for an idempotency key, as Core recorded it. */
export const committedInvocationId = (fixture: EnrollmentAcceptanceIdentityFixture, idempotencyKey: string) =>
  fixture.admin.executor
    .select({ invocationId: actionInvocations.actionInvocationId, status: actionInvocations.status })
    .from(actionInvocations)
    .where(and(eq(actionInvocations.tenantId, fixture.tenantId), eq(actionInvocations.idempotencyKey, idempotencyKey)))
    .pipe(
      Effect.flatMap((rows) => {
        const [row] = rows;
        return row === undefined
          ? Effect.die(`No Action invocation was recorded for ${idempotencyKey}`)
          : Effect.succeed(row);
      }),
    );

const fixtureRepositoryScope = (
  fixture: EnrollmentAcceptanceIdentityFixture,
  correlationId: string,
): RepositoryScope => ({
  correlationId,
  principalId: fixture.actor.principalId,
  registry: fixture.registry,
  tenantId: fixture.tenantId,
});

export const reserveBinding = (
  fixture: EnrollmentAcceptanceIdentityFixture,
  subject: CommercePortalAccountSubject,
  displayName: string,
) =>
  withRepository(fixture.admin, fixtureRepositoryScope(fixture, `reserve-${subject.providerSubjectId}`), (repository) =>
    repository.prepare({
      displayName,
      invocationId: randomUUID(),
      subject: coreSubject(subject),
      tenantId: fixture.tenantId,
    }),
  );

export const activateBinding = (
  fixture: EnrollmentAcceptanceIdentityFixture,
  authBindingId: string,
  expectedRevision: number,
) =>
  withRepository(fixture.admin, fixtureRepositoryScope(fixture, `activate-${authBindingId}`), (repository) =>
    repository.activate({ authBindingId, expectedRevision, invocationId: randomUUID(), tenantId: fixture.tenantId }),
  );

export const changeBindingStatus = (
  fixture: EnrollmentAcceptanceIdentityFixture,
  authBindingId: string,
  expectedRevision: number,
  requestedStatus: ChangeExternalIdentityStatusInput['requestedStatus'],
) =>
  withRepository(fixture.admin, fixtureRepositoryScope(fixture, `status-${authBindingId}`), (repository) =>
    repository.changeStatus({
      authBindingId,
      expectedRevision,
      invocationId: randomUUID(),
      reason: `identity acceptance ${requestedStatus}`,
      requestedStatus,
      tenantId: fixture.tenantId,
    }),
  );

interface IdentityBindingRow {
  readonly bindingRevision: number;
  readonly principalId: string;
  readonly status: string;
}

/** The durable binding row read with the owner role, so RLS cannot mask a regression. */
export const readBindingRow = (fixture: EnrollmentAcceptanceIdentityFixture, authBindingId: string) =>
  fixture.admin.executor
    .select({
      bindingRevision: principalAuthBindings.bindingRevision,
      principalId: principalAuthBindings.principalId,
      status: principalAuthBindings.status,
    })
    .from(principalAuthBindings)
    .where(
      and(
        eq(principalAuthBindings.tenantId, fixture.tenantId),
        eq(principalAuthBindings.principalAuthBindingId, authBindingId),
      ),
    )
    .pipe(
      Effect.flatMap((rows) => {
        const [row] = rows;
        return row === undefined
          ? Effect.die(`The acceptance binding ${authBindingId} is missing`)
          : Effect.succeed(row satisfies IdentityBindingRow);
      }),
    );

export const countBindings = (fixture: EnrollmentAcceptanceIdentityFixture) =>
  fixture.admin.executor
    .select({ principalId: principalAuthBindings.principalId })
    .from(principalAuthBindings)
    .where(eq(principalAuthBindings.tenantId, fixture.tenantId));

export const countPrincipals = (fixture: EnrollmentAcceptanceIdentityFixture) =>
  fixture.admin.executor
    .select({ principalId: principals.principalId })
    .from(principals)
    .where(eq(principals.tenantId, fixture.tenantId));

/** A session principal presenting an exact stored binding at admission. */
export const sessionPrincipal = (
  fixture: EnrollmentAcceptanceIdentityFixture,
  authBindingId: string,
  principalId: string,
) =>
  Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId,
    authContextRef: `portal-session:${authBindingId}`,
    authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
    authMethod: 'session',
    principalId,
    tenantId: fixture.tenantId,
  });

/** The production admission path: resolve an operation scope for a presented session binding. */
export const admitSession = (
  fixture: EnrollmentAcceptanceIdentityFixture,
  principal: ReturnType<typeof sessionPrincipal>,
) =>
  fixture.scopeResolver
    .resolve({
      correlationId: `admit-${principal.authBindingId ?? 'unbound'}`,
      legalEntityScope: 'forbidden',
      principal,
    })
    .pipe(Effect.provide(fixture.identityServicesLive));

export const identityReadFor = (subject: CommercePortalAccountSubject) => ({
  accountSubject: subject,
  clientOptions: {
    apiKey: Redacted.make('identity-acceptance-service-key'),
    baseUrl: 'https://identity.acceptance.invalid',
    requestCorrelation: `identity-read-${subject.providerSubjectId}`,
  },
});
