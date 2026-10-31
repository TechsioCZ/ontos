import { v1 } from '@authzed/authzed-node';
import { and, eq, sql } from 'drizzle-orm';
import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import { Crypto, Effect, Layer, Option, Redacted, Schema, Scope } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';

import { TrustedPrincipalContextSchema } from '../actions/principal-context.ts';
import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
import { transportIdentifier } from '../actions/string-schemas.ts';
import {
  isVerifiedGatewayPrincipalContext,
  readVerifiedGatewayCompositionRevision,
  readVerifiedGatewayScopeAssertion,
} from '../auth/system-principal-context-provenance.ts';
import {
  STAFF_AUTHENTICATION_NAMESPACE_ID,
  staffAuthenticationNamespaceRegistryLayer,
} from '../auth/staff-authentication-namespace.ts';
import { AuthenticationNamespaceRegistry } from '../auth/external-identity/verifier.ts';
import { makeCoreDatabase } from '../db/client.ts';
import { SHARED_RUNTIME_IDENTITY } from '../db/database-identities.ts';
import { loadDatabaseConfig, loadDatabaseConnectionPair, parseDatabaseConnectionPair } from '../db/config.ts';
import {
  dataAccessEvents,
  legalEntities,
  principalAuthBindings,
  principals,
  tenantModuleStates,
  tenants,
} from '../db/schema.ts';
import { installOperationalScope } from '../db/scoped-transaction.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import type { CoreTransaction } from '../db/types.ts';
import type { ApplicationCompositionAuthorityError } from '../modules/application-composition-authority.ts';
import type { ModuleStateGateError } from '../modules/module-state-gate-errors.ts';
import { lockApplicationCompositionAuthority } from '../modules/application-composition-authority.ts';
import { ModuleEntrypointSchema } from '../modules/module-entrypoint.ts';
import type { ModuleEntrypointDescriptor } from '../modules/module-entrypoint.ts';
import { makeModuleEntrypointGateway } from '../modules/module-entrypoint-gateway.ts';
import { makeModuleStateGate } from '../modules/module-state-gate.ts';
import { makeTenantModuleStateService } from '../modules/tenant-module-state-service.ts';
import { makeOperationalScopeRepository, makeOperationalScopeResolver } from '../operations/context.ts';
import type { OperationalScope, OperationalScopeRequest } from '../operations/context.ts';
import type { OperationContextError } from '../operations/errors.ts';
import {
  ContextAccess,
  makeContextAccessLive,
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
  toResourceAccessObjectId,
} from '../permissions/context-access.ts';
import type { ResourceAccessTarget } from '../permissions/context-access.ts';
import { loadSpiceDbConfig } from '../permissions/config.ts';
import { openSpiceDbGrpcRpc } from '../permissions/spicedb-grpc-rpc.ts';
import { ReadRuntime, makeReadRuntime } from '../reads/runtime.ts';

export class NativeReadTestError extends Schema.TaggedError<NativeReadTestError>()('NativeReadTestError', {
  cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())),
  code: Schema.Literal('native_read_test_failed'),
  reason: Schema.String,
}) {}

const unavailable = (cause?: unknown, reason = 'The isolated native Read test fixture is unavailable') =>
  new NativeReadTestError({
    cause: Redacted.make(cause),
    code: 'native_read_test_failed',
    reason,
  });
const requiredObjectId = (id: string | undefined) =>
  id === undefined ? Effect.fail(unavailable()) : Effect.succeed(id);

export interface NativeReadTestContextOptions {
  /** Only the disposable localhost database created by the isolated-native-database fixture. */
  readonly connections?: {
    readonly admin: { readonly connectionString: Redacted.Redacted };
    readonly runtime: { readonly connectionString: Redacted.Redacted };
  };
  readonly contextPermissions: readonly string[];
  readonly moduleId: string;
  /** Dedicated disposable sandbox only: owner append-only history and its complete Core context stay together. */
  readonly ownerFixtureRetention: 'retain-complete-context';
}

type NativeReadTestResource = ResourceAccessTarget & { readonly tenantId: string };

const relation = (resourceType: string, resourceId: string, name: string, subjectType: string, subjectId: string) =>
  v1.Relationship.create({
    relation: name,
    resource: { objectId: resourceId, objectType: resourceType },
    subject: { object: { objectId: subjectId, objectType: subjectType } },
  });

/**
 * Isolated Core fixture for native owner Read tests. Core owns all administrative identity writes;
 * owner producers receive only the usual verified runtime-role transaction capability. No
 * composition authority, authentication transport, service substitution or owner data is invented.
 * Once an owner producer starts, retain its complete Core context/evidence: an uncertain commit
 * must never leave immutable owner history orphaned. Revoke exact SpiceDB grants independently.
 * Disposal of the dedicated sandbox/database requires the operator's later explicit authorization.
 */
export const makeNativeReadTestContext = Effect.fn('NativeReadTestContext.make')(function* makeNativeReadTestContext(
  options: NativeReadTestContextOptions,
) {
  // pg accepts query parameters that override URL authority or read SSL files. The
  // optional disposable fixture seam accepts no query configuration; defaults stay unchanged.
  if (options.connections !== undefined) {
    const { admin, runtime } = options.connections;
    const hasQueryParameters = yield* Effect.try({
      catch: (cause) => unavailable(cause, 'Native Read isolated database configuration failed'),
      try: () =>
        [admin, runtime].some((connection) => new URL(Redacted.value(connection.connectionString)).search !== ''),
    });
    if (hasQueryParameters) {
      return yield* unavailable(undefined, 'Native Read fixture overrides require one isolated localhost database');
    }
  }
  const suppliedConfiguration =
    options.connections === undefined
      ? undefined
      : yield* parseDatabaseConnectionPair({
          DATABASE_ADMIN_URL: Redacted.value(options.connections.admin.connectionString),
          DATABASE_URL: Redacted.value(options.connections.runtime.connectionString),
        }).pipe(Effect.mapError((cause) => unavailable(cause, 'Native Read isolated database configuration failed')));
  if (suppliedConfiguration !== undefined) {
    const { admin, runtime } = suppliedConfiguration;
    if (
      !['localhost', '127.0.0.1'].includes(admin.host) ||
      admin.host !== runtime.host ||
      admin.port !== runtime.port ||
      admin.database !== runtime.database ||
      !admin.database.startsWith('ontos_test_party_gateway_')
    ) {
      return yield* unavailable(undefined, 'Native Read fixture overrides require one isolated localhost database');
    }
  }
  const { configuration, spiceConfiguration } = yield* Effect.all(
    {
      configuration: (suppliedConfiguration === undefined
        ? loadDatabaseConnectionPair()
        : Effect.succeed(suppliedConfiguration)
      ).pipe(Effect.mapError((cause) => unavailable(cause, 'Native Read database configuration failed'))),
      spiceConfiguration: loadSpiceDbConfig().pipe(
        Effect.mapError((cause) => unavailable(cause, 'Native Read SpiceDB configuration failed')),
      ),
    },
    { concurrency: 2 },
  );
  if (
    spiceConfiguration.deploymentEnvironment === 'stage' ||
    spiceConfiguration.deploymentEnvironment === 'production'
  ) {
    return yield* unavailable();
  }
  const crypto = yield* Crypto.Crypto;
  const nextId = () => crypto.randomUUIDv4().pipe(Effect.mapError(unavailable));
  const { authBindingId, legalEntityId, principalId, tenantId } = yield* Effect.all(
    {
      authBindingId: nextId(),
      legalEntityId: nextId(),
      principalId: nextId(),
      tenantId: nextId(),
    },
    { concurrency: 1 },
  );
  const principal = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
    authBindingId,
    authContextRef: `better-auth-session:native-read-test-${principalId}`,
    authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
    authMethod: 'session',
    legalEntityId,
    principalId,
    tenantId,
  }).pipe(Effect.mapError(unavailable));
  // The native pools must remain open while outer-scope cleanup runs.
  const resourcesScope = yield* Scope.make();
  yield* Effect.addFinalizer((exit) => Scope.close(resourcesScope, exit));
  const { admin, database } = yield* Effect.all(
    {
      admin: makeCoreDatabase(configuration.admin).pipe(Scope.provide(resourcesScope), Effect.mapError(unavailable)),
      database: makeCoreDatabase(configuration.runtime).pipe(
        Scope.provide(resourcesScope),
        Effect.mapError(unavailable),
      ),
    },
    { concurrency: 2 },
  );
  const role = yield* database.executor
    .execute<{ readonly rolbypassrls: boolean; readonly rolsuper: boolean }>(
      sql`select rolbypassrls, rolsuper from pg_roles where rolname = current_user`,
      'objects',
    )
    .pipe(Effect.mapError((cause) => unavailable(cause, 'Native Read runtime PostgreSQL role probe failed')));
  const roleIsSafe = Schema.is(
    Schema.Tuple([Schema.Struct({ rolbypassrls: Schema.Literal(false), rolsuper: Schema.Literal(false) })]),
  );
  if (!roleIsSafe(role)) {
    return yield* unavailable();
  }
  const client = yield* Effect.acquireRelease(
    Effect.try({ catch: unavailable, try: () => openSpiceDbGrpcRpc(spiceConfiguration, 10_000) }),
    (connection) => Effect.sync(() => connection.close()),
  );
  const relationships = new Map<string, v1.Relationship>();
  let ownerProducerStarted = false;
  const remember = (values: readonly v1.Relationship[]) => {
    for (const value of values) {
      const key = `${value.resource?.objectType}:${value.resource?.objectId}:${value.relation}:${value.subject?.object?.objectType}:${value.subject?.object?.objectId}`;
      relationships.set(key, value);
    }
  };
  const write = (values: readonly v1.Relationship[], operation: v1.RelationshipUpdate_Operation) => {
    const request = v1.WriteRelationshipsRequest.create({
      updates: values.map((relationship) => ({ operation, relationship })),
    });
    return client.writeRelationships(request).pipe(Effect.mapError(unavailable), Effect.asVoid);
  };
  const cleanUnusedCoreContext = Effect.fn('NativeReadTestContext.cleanupUnused')(function* cleanUnusedCoreContext() {
    if (ownerProducerStarted && options.ownerFixtureRetention === 'retain-complete-context') {
      return;
    }
    yield* admin.executor.transaction(
      Effect.fn('NativeReadTestContext.cleanup')(function* cleanNativeContext(transaction: CoreTransaction) {
        yield* transaction.delete(dataAccessEvents).where(eq(dataAccessEvents.tenantId, tenantId));
        yield* transaction.delete(tenantModuleStates).where(eq(tenantModuleStates.tenantId, tenantId));
        yield* transaction.delete(principalAuthBindings).where(eq(principalAuthBindings.tenantId, tenantId));
        yield* transaction.delete(principals).where(eq(principals.tenantId, tenantId));
        yield* transaction.delete(legalEntities).where(eq(legalEntities.tenantId, tenantId));
        yield* transaction.delete(tenants).where(eq(tenants.tenantId, tenantId));
      }),
    );
  });
  yield* Effect.addFinalizer(() => {
    const revoke =
      relationships.size === 0
        ? Effect.void
        : write([...relationships.values()], v1.RelationshipUpdate_Operation.DELETE);
    return revoke.pipe(Effect.ensuring(cleanUnusedCoreContext().pipe(Effect.orDie)), Effect.orDie);
  });
  yield* admin.executor
    .transaction(
      Effect.fn('NativeReadTestContext.seed')(function* seedNativeContext(transaction: CoreTransaction) {
        yield* transaction.insert(tenants).values({
          defaultLocale: 'en',
          name: 'Isolated native Read test',
          slug: `native-read-${tenantId}`,
          status: 'active',
          tenantId,
        });
        yield* transaction.insert(legalEntities).values({
          legalEntityId,
          legalName: 'Native Read test entity',
          registrationCountry: 'CZ',
          registrationNumber: legalEntityId,
          status: 'active',
          tenantId,
        });
        yield* transaction.insert(principals).values({
          displayName: 'Native Read test principal',
          kind: 'human',
          principalId,
          status: 'active',
          tenantId,
        });
        yield* transaction.insert(principalAuthBindings).values({
          authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
          principalAuthBindingId: authBindingId,
          principalId,
          provider: 'better_auth',
          providerSubjectId: principalId,
          status: 'active',
          subjectType: 'user',
          tenantId,
        });
        yield* transaction
          .insert(tenantModuleStates)
          .values({ moduleKey: options.moduleId, state: 'active', tenantId });
      }),
    )
    .pipe(Effect.mapError(unavailable));
  const legalEntityObjectId = yield* requiredObjectId(toLegalEntityAccessObjectId(tenantId, legalEntityId));
  const moduleObjectId = yield* requiredObjectId(toModuleAccessObjectId(tenantId, legalEntityId, options.moduleId));
  remember([
    relation('tenant', tenantId, 'member', 'principal', principalId),
    relation('legal_entity', legalEntityObjectId, 'tenant', 'tenant', tenantId),
    relation('legal_entity', legalEntityObjectId, 'member', 'principal', principalId),
    relation('module_access', moduleObjectId, 'legal_entity', 'legal_entity', legalEntityObjectId),
    relation('module_access', moduleObjectId, 'accessor', 'principal', principalId),
  ]);
  yield* Effect.forEach(
    options.contextPermissions,
    Effect.fn('NativeReadTestContext.permission')(function* permissionRelations(permission) {
      const id = yield* requiredObjectId(
        toContextPermissionAccessObjectId(tenantId, legalEntityId, { moduleId: options.moduleId, permission }),
      );
      remember([
        relation('context_permission', id, 'tenant', 'tenant', tenantId),
        relation('context_permission', id, 'grantee', 'principal', principalId),
      ]);
    }),
    { concurrency: 1 },
  );
  yield* write([...relationships.values()], v1.RelationshipUpdate_Operation.TOUCH);
  const contextAccess = yield* makeContextAccessLive();
  const scopeResolver = yield* makeOperationalScopeResolver(makeOperationalScopeRepository(database), contextAccess);
  const gateway = makeModuleEntrypointGateway(makeModuleStateGate(makeTenantModuleStateService(database)));
  const runtime = makeReadRuntime(database, gateway, scopeResolver, contextAccess);
  const registry = staffAuthenticationNamespaceRegistryLayer(['catalog']);
  const layer = Layer.mergeAll(
    registry,
    Layer.succeed(ReadRuntime, runtime),
    Layer.succeed(ContextAccess, contextAccess),
  );
  const prepareOwner = Effect.fn('NativeReadTestContext.prepareOwner')(function* prepareOwner<
    Value,
    Failure,
    Requirements,
  >(
    producer: (
      transaction: ScopedTransactionExecutor,
      scope: OperationalScope,
    ) => Effect.Effect<Value, Failure, Requirements>,
  ): Effect.fn.Return<Value, Failure | OperationContextError | SqlError, Requirements> {
    const scope = yield* scopeResolver.resolve({
      correlationId: `native-read-producer-${principalId}`,
      legalEntityScope: 'required',
      principal,
    });
    const produce = Effect.fn('NativeReadTestContext.produce')(function* produce(
      transaction: CoreTransaction,
    ): Effect.fn.Return<Value, Failure | OperationContextError, Requirements> {
      const scoped = yield* installOperationalScope(transaction, scope);
      return yield* producer(scoped, scope);
    });
    ownerProducerStarted = true;
    return yield* database.executor.transaction(produce);
  });
  const resourceRelations = Effect.fn('NativeReadTestContext.resourceRelations')(function* exactResourceRelations(
    resource: NativeReadTestResource,
  ) {
    if (resource.tenantId !== tenantId || resource.moduleId !== options.moduleId) {
      return yield* unavailable();
    }
    const id = yield* requiredObjectId(toResourceAccessObjectId(tenantId, legalEntityId, resource));
    return [
      relation('resource', id, 'module', 'module_access', moduleObjectId),
      relation('resource', id, 'reader', 'principal', principalId),
    ];
  });
  const grantResource = (resource: NativeReadTestResource) =>
    resourceRelations(resource).pipe(
      Effect.flatMap((values) => {
        remember(values);
        return write(values, v1.RelationshipUpdate_Operation.TOUCH);
      }),
    );
  const revokeResource = (resource: NativeReadTestResource) =>
    resourceRelations(resource).pipe(
      Effect.flatMap((values) => write(values.slice(1), v1.RelationshipUpdate_Operation.DELETE)),
    );
  const evidenceCount = () =>
    database.executor.transaction(
      Effect.fn('NativeReadTestContext.evidence')(function* nativeEvidenceCount(transaction: CoreTransaction) {
        yield* transaction.execute(
          sql`select set_config('ontos.tenant_id', ${tenantId}, true), set_config('ontos.legal_entity_id', ${legalEntityId}, true)`,
          'objects',
        );
        const rows = yield* transaction
          .select({ id: dataAccessEvents.dataAccessEventId })
          .from(dataAccessEvents)
          .where(and(eq(dataAccessEvents.tenantId, tenantId), eq(dataAccessEvents.principalId, principalId)));
        return rows.length;
      }),
    );
  return { contextAccess, evidenceCount, grantResource, layer, prepareOwner, principal, revokeResource, runtime };
});

export interface VerifiedNativeReadScopeInput extends Pick<OperationalScopeRequest, 'correlationId'> {
  readonly audience: string;
  readonly entrypoint: ModuleEntrypointDescriptor;
  /** Exact production verifier.verifyAndRedeem result; plain decoded/copied contexts are refused. */
  readonly principal: TrustedPrincipalContext;
}

const verifiedNativeReadRevision = (input: VerifiedNativeReadScopeInput) => {
  const { principal } = input;
  const revision = readVerifiedGatewayCompositionRevision(principal);
  const assertion = readVerifiedGatewayScopeAssertion(principal);
  if (
    !isVerifiedGatewayPrincipalContext(principal) ||
    !Schema.is(TrustedPrincipalContextSchema)(principal) ||
    principal.authenticationNamespaceId !== STAFF_AUTHENTICATION_NAMESPACE_ID ||
    principal.legalEntityId === undefined ||
    revision === undefined ||
    assertion === undefined ||
    assertion.audience !== input.audience ||
    !Schema.is(transportIdentifier)(input.correlationId) ||
    !Schema.is(ModuleEntrypointSchema)(input.entrypoint) ||
    input.entrypoint.scope !== 'tenant' ||
    input.entrypoint.access !== 'read' ||
    input.entrypoint.authorization.kind !== 'context_permission' ||
    input.entrypoint.authorization.permission !== 'module.access'
  ) {
    return Option.none();
  }
  return Option.some(revision);
};

/** Native owner-factory probe only; does not execute or authorize the owning business Read handler. */
export const withVerifiedNativeReadScope = Effect.fn('NativeReadTestContext.withVerifiedScope')(
  function* withVerifiedNativeReadScopeEffect<Value, Failure, Requirements>(
    input: VerifiedNativeReadScopeInput,
    observe: (
      transaction: ScopedTransactionExecutor,
      scope: OperationalScope,
      compositionRevision: string,
    ) => Effect.Effect<Value, Failure, Requirements>,
  ): Effect.fn.Return<
    Value,
    | Failure
    | EffectDrizzleQueryError
    | NativeReadTestError
    | SqlError
    | OperationContextError
    | ModuleStateGateError
    | ApplicationCompositionAuthorityError,
    Requirements | Crypto.Crypto | Scope.Scope | AuthenticationNamespaceRegistry
  > {
    const { principal } = input;
    const admittedRevision = verifiedNativeReadRevision(input);
    if (Option.isNone(admittedRevision)) {
      return yield* unavailable(undefined, 'A genuine redeemed Staff gateway principal and Tenant Read are required');
    }
    const revision = admittedRevision.value;
    const namespaceRegistry = yield* AuthenticationNamespaceRegistry;
    const namespace = yield* namespaceRegistry
      .lookup(STAFF_AUTHENTICATION_NAMESPACE_ID)
      .pipe(Effect.mapError(unavailable));
    if (Option.isNone(namespace) || namespace.value.provider !== 'better-auth') {
      return yield* unavailable(undefined, 'The production Staff authentication namespace is required');
    }
    const configuration = yield* loadDatabaseConfig({ envPath: '/dev/null', identity: SHARED_RUNTIME_IDENTITY }).pipe(
      Effect.mapError((cause) => unavailable(cause, 'Native verified Read runtime configuration failed')),
    );
    const database = yield* makeCoreDatabase(configuration).pipe(Effect.mapError(unavailable));
    const role = yield* database.executor.execute<{
      readonly rolbypassrls: boolean;
      readonly role_name: string;
      readonly rolsuper: boolean;
    }>(
      sql`select current_user as role_name, rolbypassrls, rolsuper from pg_roles where rolname = current_user`,
      'objects',
    );
    if (
      !Schema.is(
        Schema.Tuple([
          Schema.Struct({
            rolbypassrls: Schema.Literal(false),
            role_name: Schema.Literal('ontos_runtime'),
            rolsuper: Schema.Literal(false),
          }),
        ]),
      )(role)
    ) {
      return yield* unavailable(undefined, 'Native verified Read requires the restricted runtime database role');
    }
    const contextAccess = yield* makeContextAccessLive();
    const resolver = yield* makeOperationalScopeResolver(makeOperationalScopeRepository(database), contextAccess);
    const scope = yield* resolver.resolve({
      audience: input.audience,
      correlationId: input.correlationId,
      legalEntityScope: 'required',
      principal,
    });
    if (
      scope.legalEntityId === undefined ||
      !isVerifiedGatewayPrincipalContext(scope) ||
      readVerifiedGatewayCompositionRevision(scope) !== revision ||
      readVerifiedGatewayScopeAssertion(scope)?.audience !== input.audience
    ) {
      return yield* unavailable(undefined, 'Native verified Read scope provenance was not preserved');
    }
    const gateway = makeModuleEntrypointGateway(makeModuleStateGate(makeTenantModuleStateService(database)));
    const snapshot = yield* gateway.prepareSnapshot(scope, [input.entrypoint]);
    yield* gateway.check(snapshot, input.entrypoint);
    const moduleAccess = yield* contextAccess.modules({
      legalEntityId: scope.legalEntityId,
      moduleIds: [input.entrypoint.moduleKey],
      principalId: scope.principalId,
      tenantId: scope.tenantId,
    });
    if (
      moduleAccess.length !== 1 ||
      moduleAccess[0]?.key !== input.entrypoint.moduleKey ||
      moduleAccess[0]?.decision !== 'allowed'
    ) {
      return yield* unavailable(undefined, 'Native verified Read module access was not allowed');
    }
    return yield* database.executor.transaction(
      Effect.fn('NativeReadTestContext.withVerifiedScopeTransaction')(
        function* verifiedScopeTransaction(
          transaction,
        ): Effect.fn.Return<
          Value,
          Failure | EffectDrizzleQueryError | OperationContextError | ApplicationCompositionAuthorityError | SqlError,
          Requirements
        > {
          yield* lockApplicationCompositionAuthority(transaction, revision, 'read');
          const scoped = yield* installOperationalScope(transaction, scope);
          return yield* observe(scoped, scope, revision);
        },
      ),
    );
  },
);
