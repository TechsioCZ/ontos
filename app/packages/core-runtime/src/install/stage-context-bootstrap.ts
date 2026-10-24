import { and, eq, ne, or } from 'drizzle-orm';
import { v1 } from '@authzed/authzed-node';
import { Config, ConfigProvider, DateTime, Effect, Option, Redacted, Schema } from 'effect';
import { isSqlError } from 'effect/unstable/sql/SqlError';

// This installer composes the privileged database used only for stage initialization.
// eslint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Native scoped database composition at the installer boundary.
import { makeCoreDatabase } from '../db/client.ts';
import { parseDatabaseConfig } from '../db/config.ts';
import { legalEntities, principalAuthBindings, principals, tenantModuleStates, tenants } from '../db/schema.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../db/types.ts';
import { newSpiceDbGrpcClient } from '../permissions/spicedb-grpc-rpc.ts';
import { parseSpiceDbConfig } from '../permissions/config.ts';
import { toLegalEntityAccessObjectId, toModuleAccessObjectId } from '../permissions/context-access.ts';
import { toScopedRoleObjectId } from '../permissions/scoped-role.ts';
import type { ScopedRoleIdentity } from '../permissions/scoped-role.ts';
import {
  bootstrapPrincipalRecord,
  bootstrapRelationshipRequest,
  BootstrapCompanyMembershipSchema,
  installBootstrapCompanyMemberships,
  selectBootstrapLegalEntities,
  selectBootstrapPrincipals,
  selectBootstrapAuthBindings,
} from './context-bootstrap-shared.ts';
import { STAGE_GRANTABLE_TENANT_RELATIONS } from './stage-accounts-file.ts';
import type { StageAccountsFile, StageRetiredTenant } from './stage-accounts-file.ts';

type Comparable = boolean | null | number | string;
type ExactRecord = Readonly<Record<string, Comparable>>;

/** One stage account resolved from the operator accounts file, with the grants it holds as data. */
export interface StageContext {
  readonly affiliation: StageAccountsFile['tenants'][number]['accounts'][number]['affiliation'];
  readonly authBindingId: string;
  readonly defaultLocale: string;
  readonly legalEntityId: string;
  readonly legalName: string;
  readonly moduleId: string;
  readonly moduleStateId: string;
  readonly principalDisplayName: string;
  readonly principalId: string;
  readonly registrationCountry: string;
  readonly registrationNumber: string;
  readonly scopedRoles: readonly ScopedRoleIdentity[];
  readonly tenantId: string;
  readonly tenantName: string;
  /** Principal relations on the own Tenant, copied verbatim from the account's grant data. */
  readonly tenantRelations: readonly string[];
  readonly tenantSlug: string;
}

/** Flattens the operator accounts file into stage contexts, in file order. */
export const stageContextsFromAccountsFile = (file: StageAccountsFile): readonly StageContext[] =>
  file.tenants.flatMap((tenant) =>
    tenant.accounts.map((account) => ({
      affiliation: account.affiliation,
      authBindingId: account.authBindingId,
      defaultLocale: tenant.defaultLocale,
      legalEntityId: tenant.legalEntity.legalEntityId,
      legalName: tenant.legalEntity.legalName,
      moduleId: tenant.moduleKey,
      moduleStateId: tenant.moduleStateId,
      principalDisplayName: account.displayName,
      principalId: account.principalId,
      registrationCountry: tenant.legalEntity.registrationCountry,
      registrationNumber: tenant.legalEntity.registrationNumber,
      scopedRoles: file.scopedRoles.flatMap(({ legalEntityId, principalIds, roleKey, tenantId }) =>
        tenantId !== tenant.tenantId || !principalIds.includes(account.principalId)
          ? []
          : [legalEntityId === undefined ? { roleKey, tenantId } : { legalEntityId, roleKey, tenantId }],
      ),
      tenantId: tenant.tenantId,
      tenantName: tenant.displayName,
      tenantRelations: account.grants.tenantRelations,
      tenantSlug: tenant.slug,
    })),
  );

interface StageContextBootstrapConfiguration {
  readonly databaseAdminUrl: Redacted.Redacted;
  readonly spiceDbCaCertificate: string;
  readonly spiceDbEndpoint: string;
  readonly spiceDbPreSharedKey: Redacted.Redacted;
}

interface StageContextBootstrapRelationship {
  readonly relation: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly subjectId: string;
  readonly subjectType: string;
}

export interface StageContextBootstrapResult {
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

/** A stage context paired with the Shell-owned Better Auth user ID that signs in as it. */
export interface StageContextBootstrapAccount {
  readonly context: StageContext;
  readonly providerUserId: string;
}

export interface StageContextBootstrapOptions {
  /** A validated deployment registration value supplied by Shell composition. */
  readonly authenticationNamespaceId: string;
}

export class StageContextBootstrapError extends Schema.TaggedError<StageContextBootstrapError>()(
  'StageContextBootstrapError',
  {
    cause: Schema.optionalKey(Schema.Unknown),
    code: Schema.Literal('stage_context_bootstrap_failed'),
    reason: Schema.String,
  },
) {}

const failure = (reason: string, cause?: unknown): StageContextBootstrapError =>
  new StageContextBootstrapError(
    cause === undefined
      ? { code: 'stage_context_bootstrap_failed', reason }
      : { cause, code: 'stage_context_bootstrap_failed', reason },
  );

const TrimmedNonEmptyString = Schema.Trim.pipe(Schema.check(Schema.isNonEmpty()));
const StageEnvironmentSchema = Schema.Trim.pipe(Schema.decodeTo(Schema.Literal('stage')));
const CauseMessageSchema = Schema.Struct({ message: Schema.String });

const bootstrapFailureFromCause = (cause: unknown): StageContextBootstrapError => {
  if (Schema.is(StageContextBootstrapError)(cause)) {
    return cause;
  }
  return Schema.decodeUnknownOption(CauseMessageSchema)(cause).pipe(
    Option.match({
      onNone: () => failure('The fixed stage Core context could not be reconciled', cause),
      onSome: ({ message }) => failure(message, cause),
    }),
  );
};

const tryBootstrapPromise = <Value>(
  evaluate: () => PromiseLike<Value>,
): Effect.Effect<Value, StageContextBootstrapError> =>
  Effect.tryPromise({ catch: bootstrapFailureFromCause, try: evaluate }).pipe(
    Effect.timeoutOrElse({
      duration: '30 seconds',
      orElse: () => Effect.fail(failure('Stage authorization reconciliation timed out')),
    }),
  );

const loadConfiguration = Effect.fn('StageContextBootstrap.loadConfiguration')(
  function* loadStageContextBootstrapConfiguration(
    provider: ConfigProvider.ConfigProvider,
  ): Effect.fn.Return<StageContextBootstrapConfiguration, StageContextBootstrapError> {
    const source = yield* Effect.all(
      {
        databaseAdminUrl: Config.schema(Schema.Redacted(TrimmedNonEmptyString), 'DATABASE_ADMIN_URL')
          .parse(provider)
          .pipe(Effect.mapError((cause) => failure('DATABASE_ADMIN_URL is required', cause))),
        deploymentEnvironment: Config.schema(StageEnvironmentSchema, 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT')
          .parse(provider)
          .pipe(Effect.mapError((cause) => failure('The Core installation bootstrap can run only in stage', cause))),
        spiceDbCaCertificate: Config.schema(TrimmedNonEmptyString, 'SPICEDB_CA_CERT')
          .parse(provider)
          .pipe(Effect.mapError((cause) => failure('SPICEDB_CA_CERT is required', cause))),
        spiceDbEndpoint: Config.schema(TrimmedNonEmptyString, 'SPICEDB_ENDPOINT')
          .parse(provider)
          .pipe(Effect.mapError((cause) => failure('SPICEDB_ENDPOINT is required', cause))),
        spiceDbPreSharedKey: Config.Redacted('SPICEDB_PRESHARED_KEY')
          .parse(provider)
          .pipe(Effect.mapError((cause) => failure('SPICEDB_PRESHARED_KEY is required', cause))),
      },
      { concurrency: 5 },
    );
    yield* parseDatabaseConfig({
      DATABASE_URL: Redacted.value(source.databaseAdminUrl),
    }).pipe(Effect.mapError((error) => failure(error.reason, error)));
    const spiceDb = yield* parseSpiceDbConfig({
      SPICEDB_CA_CERT: source.spiceDbCaCertificate,
      SPICEDB_ENDPOINT: source.spiceDbEndpoint,
      SPICEDB_PRESHARED_KEY: Redacted.value(source.spiceDbPreSharedKey),
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: source.deploymentEnvironment,
    }).pipe(Effect.mapError((error) => failure(error.reason, error)));
    if (spiceDb.endpoint !== 'spicedb:50051') {
      return yield* failure('The Core installation bootstrap requires stage-private SpiceDB');
    }
    return {
      databaseAdminUrl: source.databaseAdminUrl,
      spiceDbCaCertificate: source.spiceDbCaCertificate,
      spiceDbEndpoint: spiceDb.endpoint,
      spiceDbPreSharedKey: Redacted.make(spiceDb.preSharedKey),
    };
  },
);

const classifyExactRecord = <Expected extends ExactRecord>(
  label: string,
  existing: ExactRecord | undefined,
  expected: Expected,
): Effect.Effect<'create' | 'existing', StageContextBootstrapError> => {
  if (existing === undefined) {
    return Effect.succeed('create');
  }
  const conflictingFields = Object.entries(expected).flatMap(([key, value]) => (existing[key] === value ? [] : [key]));
  if (conflictingFields.length > 0) {
    return Effect.fail(
      failure(`Existing ${label} conflicts with the stage bootstrap definition (${conflictingFields.join(', ')})`),
    );
  }
  return Effect.succeed('existing');
};

const reconcilePostgresTransaction = Effect.fn('StageContextBootstrap.reconcilePostgresTransaction')(
  function* reconcileStagePostgresTransaction(
    transaction: CoreTransaction,
    context: StageContext,
    authUserId: string,
    authenticationNamespaceId: string,
  ): Effect.fn.Return<void, StageContextBootstrapError> {
    const tenantCandidates = yield* transaction
      .select({
        defaultLocale: tenants.defaultLocale,
        name: tenants.name,
        slug: tenants.slug,
        status: tenants.status,
        tenantId: tenants.tenantId,
      })
      .from(tenants)
      .where(or(eq(tenants.tenantId, context.tenantId), eq(tenants.slug, context.tenantSlug)))
      .limit(2)
      .pipe(Effect.mapError(bootstrapFailureFromCause));
    if (tenantCandidates.length > 1) {
      return yield* failure('The stage tenant identity conflicts');
    }
    const expectedTenant = {
      defaultLocale: context.defaultLocale,
      name: context.tenantName,
      slug: context.tenantSlug,
      status: 'active',
      tenantId: context.tenantId,
    } as const;
    if ((yield* classifyExactRecord('tenant', tenantCandidates[0], expectedTenant)) === 'create') {
      yield* transaction.insert(tenants).values(expectedTenant).pipe(Effect.mapError(bootstrapFailureFromCause));
    }

    const legalEntityCandidates = yield* selectBootstrapLegalEntities(transaction, context).pipe(
      Effect.mapError(bootstrapFailureFromCause),
    );
    if (legalEntityCandidates.length > 1) {
      return yield* failure('The stage legal-entity identity conflicts');
    }
    const expectedLegalEntity = {
      legalEntityId: context.legalEntityId,
      legalName: context.legalName,
      registrationCountry: context.registrationCountry,
      registrationNumber: context.registrationNumber,
      status: 'active',
      tenantId: context.tenantId,
    } as const;
    if ((yield* classifyExactRecord('legal entity', legalEntityCandidates[0], expectedLegalEntity)) === 'create') {
      yield* transaction
        .insert(legalEntities)
        .values(expectedLegalEntity)
        .pipe(Effect.mapError(bootstrapFailureFromCause));
    }

    const expectedPrincipal = bootstrapPrincipalRecord(context);
    const principalCandidates = yield* selectBootstrapPrincipals(transaction, context).pipe(
      Effect.mapError(bootstrapFailureFromCause),
    );
    if ((yield* classifyExactRecord('principal', principalCandidates[0], expectedPrincipal)) === 'create') {
      yield* transaction.insert(principals).values(expectedPrincipal).pipe(Effect.mapError(bootstrapFailureFromCause));
    }

    const membership = yield* Schema.decodeEffect(BootstrapCompanyMembershipSchema)({
      affiliation: context.affiliation,
      legalEntityId: context.legalEntityId,
      principalId: context.principalId,
    }).pipe(Effect.mapError(bootstrapFailureFromCause));
    yield* installBootstrapCompanyMemberships(transaction, context.tenantId, [membership]).pipe(
      Effect.mapError(bootstrapFailureFromCause),
    );

    const bindingCandidates = yield* selectBootstrapAuthBindings(
      transaction,
      context,
      authUserId,
      authenticationNamespaceId,
    ).pipe(Effect.mapError(bootstrapFailureFromCause));
    if (bindingCandidates.length > 1) {
      return yield* failure('The stage authentication binding conflicts');
    }
    const expectedBinding = {
      authenticationNamespaceId,
      principalAuthBindingId: context.authBindingId,
      principalId: context.principalId,
      provider: 'better_auth',
      providerSubjectId: authUserId,
      status: 'active',
      subjectType: 'user',
      tenantId: context.tenantId,
    } as const;
    if ((yield* classifyExactRecord('authentication binding', bindingCandidates[0], expectedBinding)) === 'create') {
      yield* transaction
        .insert(principalAuthBindings)
        .values(expectedBinding)
        .pipe(Effect.mapError(bootstrapFailureFromCause));
    }

    const moduleStateCandidates = yield* transaction
      .select({
        moduleKey: tenantModuleStates.moduleKey,
        state: tenantModuleStates.state,
        tenantId: tenantModuleStates.tenantId,
        tenantModuleStateId: tenantModuleStates.tenantModuleStateId,
      })
      .from(tenantModuleStates)
      .where(
        or(
          eq(tenantModuleStates.tenantModuleStateId, context.moduleStateId),
          and(eq(tenantModuleStates.tenantId, context.tenantId), eq(tenantModuleStates.moduleKey, context.moduleId)),
        ),
      )
      .limit(2)
      .pipe(Effect.mapError(bootstrapFailureFromCause));
    if (moduleStateCandidates.length > 1) {
      return yield* failure('The stage module-state identity conflicts');
    }
    const expectedModuleState = {
      moduleKey: context.moduleId,
      state: 'active',
      tenantId: context.tenantId,
      tenantModuleStateId: context.moduleStateId,
    } as const;
    if ((yield* classifyExactRecord('module state', moduleStateCandidates[0], expectedModuleState)) === 'create') {
      yield* transaction
        .insert(tenantModuleStates)
        .values(expectedModuleState)
        .pipe(Effect.mapError(bootstrapFailureFromCause));
    }
    return yield* Effect.void;
  },
);

export const reconcilePostgresContext = Effect.fn('StageContextBootstrap.reconcilePostgresContext')(
  function* reconcileStagePostgresContext(
    database: CoreDatabaseExecutor,
    context: StageContext,
    authUserId: string,
    authenticationNamespaceId: string,
  ): Effect.fn.Return<void, StageContextBootstrapError> {
    const transactionBody = (transaction: CoreTransaction) =>
      reconcilePostgresTransaction(transaction, context, authUserId, authenticationNamespaceId);
    yield* database.transaction(transactionBody).pipe(
      Effect.catchDefect((defect) => (isSqlError(defect) ? Effect.fail(defect) : Effect.die(defect))),
      Effect.catchTag('SqlError', (sqlFailure) => Effect.fail(bootstrapFailureFromCause(sqlFailure))),
    );
  },
);

export const buildStageContextRelationships = Effect.fn('StageContextBootstrap.buildRelationships')(
  function* buildStageContextRelationships(
    context: StageContext,
  ): Effect.fn.Return<readonly StageContextBootstrapRelationship[], StageContextBootstrapError> {
    const legalEntityObjectId = toLegalEntityAccessObjectId(context.tenantId, context.legalEntityId);
    const moduleObjectId = toModuleAccessObjectId(context.tenantId, context.legalEntityId, context.moduleId);
    if (legalEntityObjectId === undefined || moduleObjectId === undefined) {
      return yield* failure('The stage authorization object IDs are invalid');
    }
    if (
      context.scopedRoles.some(
        (role) =>
          role.tenantId !== context.tenantId ||
          (role.legalEntityId !== undefined && role.legalEntityId !== context.legalEntityId),
      )
    ) {
      return yield* failure('Stage roles must belong to the explicit account tenant/company');
    }
    return [
      ...context.scopedRoles.map((role) => ({
        relation: 'member',
        resourceId: toScopedRoleObjectId(role),
        resourceType: 'scoped_role',
        subjectId: context.principalId,
        subjectType: 'principal',
      })),
      {
        relation: 'tenant',
        resourceId: context.principalId,
        resourceType: 'principal',
        subjectId: context.tenantId,
        subjectType: 'tenant',
      },
      {
        relation: 'self',
        resourceId: context.principalId,
        resourceType: 'principal',
        subjectId: context.principalId,
        subjectType: 'principal',
      },
      {
        relation: 'member',
        resourceId: context.tenantId,
        resourceType: 'tenant',
        subjectId: context.principalId,
        subjectType: 'principal',
      },
      {
        relation: 'tenant',
        resourceId: legalEntityObjectId,
        resourceType: 'legal_entity',
        subjectId: context.tenantId,
        subjectType: 'tenant',
      },
      {
        relation: 'member',
        resourceId: legalEntityObjectId,
        resourceType: 'legal_entity',
        subjectId: context.principalId,
        subjectType: 'principal',
      },
      {
        relation: 'legal_entity',
        resourceId: moduleObjectId,
        resourceType: 'module_access',
        subjectId: legalEntityObjectId,
        subjectType: 'legal_entity',
      },
      {
        relation: 'accessor',
        resourceId: moduleObjectId,
        resourceType: 'module_access',
        subjectId: context.principalId,
        subjectType: 'principal',
      },
      ...context.tenantRelations.map((relation) => ({
        relation,
        resourceId: context.tenantId,
        resourceType: 'tenant',
        subjectId: context.principalId,
        subjectType: 'principal',
      })),
    ];
  },
);

/**
 * Every relationship a bootstrap can have written for a retired Tenant, for exact deletion: the
 * structural links plus membership, module access, and every grantable Tenant relation of each
 * listed Principal. Deleting an absent relationship is a no-op.
 */
export const buildRetiredStageContextRelationships = Effect.fn('StageContextBootstrap.buildRetiredRelationships')(
  function* buildRetiredRelationships(
    context: StageRetiredTenant,
  ): Effect.fn.Return<readonly StageContextBootstrapRelationship[], StageContextBootstrapError> {
    const legalEntityObjectId = toLegalEntityAccessObjectId(context.tenantId, context.legalEntityId);
    const moduleObjectId = toModuleAccessObjectId(context.tenantId, context.legalEntityId, context.moduleKey);
    if (legalEntityObjectId === undefined || moduleObjectId === undefined) {
      return yield* failure('The retired stage authorization object IDs are invalid');
    }
    return [
      {
        relation: 'tenant',
        resourceId: legalEntityObjectId,
        resourceType: 'legal_entity',
        subjectId: context.tenantId,
        subjectType: 'tenant',
      },
      {
        relation: 'legal_entity',
        resourceId: moduleObjectId,
        resourceType: 'module_access',
        subjectId: legalEntityObjectId,
        subjectType: 'legal_entity',
      },
      ...context.principalIds.flatMap((principalId) => [
        {
          relation: 'tenant',
          resourceId: principalId,
          resourceType: 'principal',
          subjectId: context.tenantId,
          subjectType: 'tenant',
        },
        {
          relation: 'self',
          resourceId: principalId,
          resourceType: 'principal',
          subjectId: principalId,
          subjectType: 'principal',
        },
        ...['member', ...STAGE_GRANTABLE_TENANT_RELATIONS].map((relation) => ({
          relation,
          resourceId: context.tenantId,
          resourceType: 'tenant',
          subjectId: principalId,
          subjectType: 'principal',
        })),
        {
          relation: 'member',
          resourceId: legalEntityObjectId,
          resourceType: 'legal_entity',
          subjectId: principalId,
          subjectType: 'principal',
        },
        {
          relation: 'accessor',
          resourceId: moduleObjectId,
          resourceType: 'module_access',
          subjectId: principalId,
          subjectType: 'principal',
        },
      ]),
    ];
  },
);

const retirePostgresTransaction = Effect.fn('StageContextBootstrap.retirePostgresTransaction')(
  function* retireStagePostgresTransaction(
    transaction: CoreTransaction,
    context: StageRetiredTenant,
    retiredAt: Date,
  ): Effect.fn.Return<void, StageContextBootstrapError> {
    yield* transaction
      .update(principalAuthBindings)
      .set({ revokedAt: retiredAt, status: 'revoked' })
      .where(and(eq(principalAuthBindings.tenantId, context.tenantId), ne(principalAuthBindings.status, 'revoked')))
      .pipe(Effect.mapError(bootstrapFailureFromCause));
    yield* transaction
      .update(principals)
      .set({ status: 'archived' })
      .where(and(eq(principals.tenantId, context.tenantId), ne(principals.status, 'archived')))
      .pipe(Effect.mapError(bootstrapFailureFromCause));
    yield* transaction
      .update(tenantModuleStates)
      .set({ state: 'archived' })
      .where(and(eq(tenantModuleStates.tenantId, context.tenantId), ne(tenantModuleStates.state, 'archived')))
      .pipe(Effect.mapError(bootstrapFailureFromCause));
    yield* transaction
      .update(legalEntities)
      .set({ status: 'archived' })
      .where(and(eq(legalEntities.tenantId, context.tenantId), ne(legalEntities.status, 'archived')))
      .pipe(Effect.mapError(bootstrapFailureFromCause));
    yield* transaction
      .update(tenants)
      .set({ status: 'archived' })
      .where(and(eq(tenants.tenantId, context.tenantId), ne(tenants.status, 'archived')))
      .pipe(Effect.mapError(bootstrapFailureFromCause));
    return yield* Effect.void;
  },
);

const writeRelationships = Effect.fn('StageContextBootstrap.writeRelationships')(
  function* writeStageContextRelationships(
    configuration: StageContextBootstrapConfiguration,
    request: ReturnType<typeof bootstrapRelationshipRequest>,
  ): Effect.fn.Return<void, StageContextBootstrapError> {
    yield* Effect.acquireUseRelease(
      Effect.try({
        catch: bootstrapFailureFromCause,
        try: () =>
          newSpiceDbGrpcClient({
            caCertificate: configuration.spiceDbCaCertificate,
            endpoint: configuration.spiceDbEndpoint,
            preSharedKey: Redacted.value(configuration.spiceDbPreSharedKey),
          }),
      }),
      (client) =>
        tryBootstrapPromise(client.promises.writeRelationships.bind(client.promises, request)).pipe(Effect.asVoid),
      (client) =>
        Effect.try({
          catch: bootstrapFailureFromCause,
          try: () => client.close(),
        }),
    );
  },
);

const deleteRelationshipsRequest = (relationships: readonly StageContextBootstrapRelationship[]) =>
  v1.WriteRelationshipsRequest.create({
    updates: bootstrapRelationshipRequest(relationships).updates.map((update) =>
      v1.RelationshipUpdate.create({ ...update, operation: v1.RelationshipUpdate_Operation.DELETE }),
    ),
  });

/**
 * Reconciles every stage account from the operator accounts file and retires former stage Tenants.
 * Results follow the order of `accounts`.
 */
export const reconcileStageContextBootstraps = Effect.fn('StageContextBootstrap.reconcileStageContextBootstraps')(
  function* reconcileStageContexts(
    accounts: readonly StageContextBootstrapAccount[],
    retiredTenants: readonly StageRetiredTenant[],
    options: StageContextBootstrapOptions,
  ): Effect.fn.Return<readonly StageContextBootstrapResult[], StageContextBootstrapError> {
    if (accounts.length === 0) {
      return yield* failure('At least one stage account is required');
    }
    if (accounts.some(({ providerUserId }) => providerUserId.trim().length === 0)) {
      return yield* failure('Every stage Better Auth provider user ID is required');
    }
    if (new Set(accounts.map(({ providerUserId }) => providerUserId)).size !== accounts.length) {
      return yield* failure('The stage contexts require distinct Better Auth provider user IDs');
    }
    const configuration = yield* loadConfiguration(yield* ConfigProvider.ConfigProvider);
    const retiredAt = yield* DateTime.nowAsDate;
    yield* Effect.scoped(
      Effect.gen(function* reconcileStageDatabase() {
        const databaseConfiguration = yield* parseDatabaseConfig({
          DATABASE_URL: Redacted.value(configuration.databaseAdminUrl),
        }).pipe(Effect.mapError(bootstrapFailureFromCause));
        const { executor } = yield* makeCoreDatabase(databaseConfiguration).pipe(
          Effect.mapError(bootstrapFailureFromCause),
        );
        yield* Effect.forEach(
          accounts,
          ({ context, providerUserId }) =>
            reconcilePostgresContext(executor, context, providerUserId, options.authenticationNamespaceId).pipe(
              Effect.andThen(buildStageContextRelationships(context)),
              Effect.flatMap((relationships) =>
                writeRelationships(configuration, bootstrapRelationshipRequest(relationships)),
              ),
            ),
          { concurrency: 1, discard: true },
        );
        yield* Effect.forEach(
          retiredTenants,
          (retired) =>
            buildRetiredStageContextRelationships(retired).pipe(
              Effect.flatMap((relationships) =>
                writeRelationships(configuration, deleteRelationshipsRequest(relationships)),
              ),
              Effect.andThen(
                executor
                  .transaction((transaction) => retirePostgresTransaction(transaction, retired, retiredAt))
                  .pipe(
                    Effect.catchDefect((defect) => (isSqlError(defect) ? Effect.fail(defect) : Effect.die(defect))),
                    Effect.catchTag('SqlError', (sqlFailure) => Effect.fail(bootstrapFailureFromCause(sqlFailure))),
                  ),
              ),
            ),
          { concurrency: 1, discard: true },
        );
      }),
    );
    return accounts.map(({ context: { legalEntityId, principalId, tenantId } }) => ({
      legalEntityId,
      principalId,
      tenantId,
    }));
  },
);

const ServiceTenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('TenantId'));
const ServiceLegalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId'));
const ServicePrincipalIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrincipalId'));
const StageServicePrincipalSchema = Schema.Struct({
  displayName: Schema.Trim.check(Schema.isNonEmpty()),
  legalEntityId: ServiceLegalEntityIdSchema,
  principalId: ServicePrincipalIdSchema,
  tenantId: ServiceTenantIdSchema,
});
export type StageServicePrincipal = typeof StageServicePrincipalSchema.Encoded;
type StageServicePrincipalRecord = Pick<
  typeof principals.$inferSelect,
  'displayName' | 'kind' | 'principalId' | 'status' | 'tenantId'
>;
const stageServicePrincipalRecord = (service: StageServicePrincipal) => ({
  displayName: service.displayName,
  kind: 'service' as const,
  principalId: service.principalId,
  status: 'active' as const,
  tenantId: service.tenantId,
});

/** Never reactivate, rename, move or convert an existing principal during stage provisioning. */
export const classifyStageServicePrincipal = (
  existing: StageServicePrincipalRecord | undefined,
  service: StageServicePrincipal,
) => classifyExactRecord('service principal', existing, stageServicePrincipalRecord(service));

/** Native nonhuman counterpart of the account bootstrap: no Better Auth users, bindings or keys. */
export const reconcileStageServicePrincipals = Effect.fn('StageContextBootstrap.reconcileServicePrincipals')(
  function* reconcileStageServicePrincipals(
    services: readonly StageServicePrincipal[],
    provider: ConfigProvider.ConfigProvider,
  ) {
    const validated = yield* Schema.decodeEffect(Schema.Array(StageServicePrincipalSchema))(services).pipe(
      Effect.mapError((cause) => failure('Invalid stage service principal definition', cause)),
    );
    if (validated.length === 0 || new Set(validated.map(({ principalId }) => principalId)).size !== validated.length) {
      return yield* failure('Stage service principals must have distinct identities');
    }
    const configuration = yield* loadConfiguration(provider);
    const relationships: StageContextBootstrapRelationship[] = [];
    for (const service of validated) {
      const legal = toLegalEntityAccessObjectId(service.tenantId, service.legalEntityId);
      if (legal === undefined) {
        return yield* failure('Invalid stage service company scope');
      }
      relationships.push(
        {
          relation: 'member',
          resourceId: service.tenantId,
          resourceType: 'tenant',
          subjectId: service.principalId,
          subjectType: 'principal',
        },
        {
          relation: 'member',
          resourceId: legal,
          resourceType: 'legal_entity',
          subjectId: service.principalId,
          subjectType: 'principal',
        },
      );
    }
    return yield* Effect.scoped(
      Effect.gen(function* reconcileServiceDatabase() {
        const databaseConfiguration = yield* parseDatabaseConfig({
          DATABASE_URL: Redacted.value(configuration.databaseAdminUrl),
        }).pipe(Effect.mapError(bootstrapFailureFromCause));
        const { executor } = yield* makeCoreDatabase(databaseConfiguration).pipe(
          Effect.mapError(bootstrapFailureFromCause),
        );
        const transactionBody = Effect.fn('StageContextBootstrap.reconcileServiceTransaction')(
          function* reconcileServicesTransaction(transaction: CoreTransaction) {
            // Validate the entire set before the first insert; any SQL conflict rolls back every insert.
            const candidates = yield* Effect.forEach(
              validated,
              Effect.fn('StageContextBootstrap.validateServicePrincipal')(function* validateServicePrincipal(service) {
                const [tenant] = yield* transaction
                  .select({ status: tenants.status })
                  .from(tenants)
                  .where(eq(tenants.tenantId, service.tenantId))
                  .limit(1);
                if (tenant?.status !== 'active') {
                  return yield* failure('The stage service tenant must already exist and be active');
                }
                const [company] = yield* transaction
                  .select({
                    legalEntityId: legalEntities.legalEntityId,
                    status: legalEntities.status,
                    tenantId: legalEntities.tenantId,
                  })
                  .from(legalEntities)
                  .where(eq(legalEntities.legalEntityId, service.legalEntityId))
                  .limit(1);
                if (company === undefined) {
                  return yield* failure('The stage service company must already exist');
                }
                yield* classifyExactRecord('service company', company, {
                  legalEntityId: service.legalEntityId,
                  status: 'active',
                  tenantId: service.tenantId,
                });
                const [existing] = yield* transaction
                  .select({
                    displayName: principals.displayName,
                    kind: principals.kind,
                    principalId: principals.principalId,
                    status: principals.status,
                    tenantId: principals.tenantId,
                  })
                  .from(principals)
                  .where(eq(principals.principalId, service.principalId))
                  .limit(1);
                return (yield* classifyStageServicePrincipal(existing, service)) === 'create'
                  ? [stageServicePrincipalRecord(service)]
                  : [];
              }),
              { concurrency: 1 },
            );
            const missing = candidates.flat();
            if (missing.length > 0) {
              yield* transaction.insert(principals).values(missing);
            }
            return missing.length;
          },
        );
        const created = yield* executor.transaction(transactionBody).pipe(
          Effect.catchDefect((defect) => (isSqlError(defect) ? Effect.fail(defect) : Effect.die(defect))),
          Effect.mapError(bootstrapFailureFromCause),
        );
        yield* writeRelationships(configuration, bootstrapRelationshipRequest(relationships));
        return created;
      }),
    );
  },
);
