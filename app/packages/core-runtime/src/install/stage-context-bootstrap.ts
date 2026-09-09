import { v1 } from '@authzed/authzed-node';
import { and, eq, or } from 'drizzle-orm';
import { Config, Effect, Option, Redacted, Schema } from 'effect';
import { isSqlError } from 'effect/unstable/sql/SqlError';

// This installer composes the privileged database used only for stage initialization.
// eslint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Native scoped database composition at the installer boundary.
import { makeCoreDatabase } from '../db/client.ts';
import { parseDatabaseConfig } from '../db/config.ts';
import { legalEntities, principalAuthBindings, principals, tenantModuleStates, tenants } from '../db/schema.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../db/types.ts';
import { spiceDbClientSecurity } from '../permissions/client.ts';
import { parseSpiceDbConfig } from '../permissions/config.ts';
import { toLegalEntityAccessObjectId, toModuleAccessObjectId } from '../permissions/context-access.ts';
import {
  bootstrapPrincipalRecord,
  bootstrapRelationshipRequest,
  selectBootstrapLegalEntities,
  selectBootstrapPrincipals,
  selectBootstrapAuthBindings,
} from './context-bootstrap-shared.ts';

type Comparable = boolean | null | number | string;
type ExactRecord = Readonly<Record<string, Comparable>>;

export const STAGE_CONTEXTS = Object.freeze({
  siampark: Object.freeze({
    authBindingId: '73000000-0000-4000-8000-000000000002',
    defaultLocale: 'cs',
    legalEntityId: '71000000-0000-4000-8000-000000000002',
    legalName: 'Siampark',
    moduleId: 'party.registry',
    moduleStateId: '74000000-0000-4000-8000-000000000002',
    principalDisplayName: 'Siampark 01',
    principalId: '72000000-0000-4000-8000-000000000002',
    registrationCountry: 'CZ',
    registrationNumber: 'DEMO-SIAMPARK',
    tenantId: '70000000-0000-4000-8000-000000000002',
    tenantName: 'Siampark',
    tenantSlug: 'siampark',
  }),
  techsio: Object.freeze({
    authBindingId: '73000000-0000-4000-8000-000000000001',
    defaultLocale: 'cs',
    legalEntityId: '71000000-0000-4000-8000-000000000001',
    legalName: 'TechsioCZ',
    moduleId: 'party.registry',
    moduleStateId: '74000000-0000-4000-8000-000000000001',
    principalDisplayName: 'Techsio Demo',
    principalId: '72000000-0000-4000-8000-000000000001',
    registrationCountry: 'CZ',
    registrationNumber: 'DEMO-TECHSIOCZ',
    tenantId: '70000000-0000-4000-8000-000000000001',
    tenantName: 'Techsio',
    tenantSlug: 'techsio',
  }),
});

type StageContextKey = keyof typeof STAGE_CONTEXTS;
type StageContext = (typeof STAGE_CONTEXTS)[StageContextKey];

interface StageContextBootstrapConfiguration {
  readonly databaseAdminUrl: Redacted.Redacted;
  readonly spiceDbEndpoint: string;
  readonly spiceDbPreSharedKey: Redacted.Redacted;
  readonly spiceDbSecurity: v1.ClientSecurity;
}

interface StageContextBootstrapRelationship {
  readonly relation: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly subjectId: string;
  readonly subjectType: string;
}

export interface StageContextBootstrapResult {
  readonly legalEntityId: StageContext['legalEntityId'];
  readonly principalId: StageContext['principalId'];
  readonly tenantId: StageContext['tenantId'];
}

export type StageContextBootstrapProviderUserIds = readonly [string, string];
export type StageContextBootstrapResults = readonly [StageContextBootstrapResult, StageContextBootstrapResult];

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

const loadConfiguration = (): Effect.Effect<StageContextBootstrapConfiguration, StageContextBootstrapError> =>
  Effect.gen(function* loadStageContextBootstrapConfiguration() {
    const source = yield* Effect.all(
      {
        databaseAdminUrl: Config.schema(Schema.Redacted(TrimmedNonEmptyString), 'DATABASE_ADMIN_URL').pipe(
          Effect.mapError((cause) => failure('DATABASE_ADMIN_URL is required', cause)),
        ),
        deploymentEnvironment: Config.schema(StageEnvironmentSchema, 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT').pipe(
          Effect.mapError((cause) => failure('The Core installation bootstrap can run only in stage', cause)),
        ),
        spiceDbEndpoint: Config.schema(TrimmedNonEmptyString, 'SPICEDB_ENDPOINT').pipe(
          Effect.mapError((cause) => failure('SPICEDB_ENDPOINT is required', cause)),
        ),
        spiceDbInsecure: Config.schema(Schema.Trim, 'SPICEDB_INSECURE').pipe(
          Effect.mapError((cause) => failure('SPICEDB_INSECURE must be explicitly true or false', cause)),
        ),
        spiceDbPreSharedKey: Config.redacted('SPICEDB_PRESHARED_KEY').pipe(
          Effect.mapError((cause) => failure('SPICEDB_PRESHARED_KEY is required', cause)),
        ),
      },
      { concurrency: 5 },
    );
    yield* parseDatabaseConfig({
      DATABASE_URL: Redacted.value(source.databaseAdminUrl),
    }).pipe(Effect.mapError((error) => failure(error.reason, error)));
    const spiceDb = yield* parseSpiceDbConfig({
      SPICEDB_ENDPOINT: source.spiceDbEndpoint,
      SPICEDB_INSECURE: source.spiceDbInsecure,
      SPICEDB_PRESHARED_KEY: Redacted.value(source.spiceDbPreSharedKey),
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: source.deploymentEnvironment,
    }).pipe(Effect.mapError((error) => failure(error.reason, error)));
    if (spiceDb.endpoint !== 'spicedb:50051' || !spiceDb.insecureLocal) {
      return yield* failure('The Core installation bootstrap requires stage-private SpiceDB');
    }
    return {
      databaseAdminUrl: source.databaseAdminUrl,
      spiceDbEndpoint: spiceDb.endpoint,
      spiceDbPreSharedKey: Redacted.make(spiceDb.preSharedKey),
      spiceDbSecurity: spiceDbClientSecurity(spiceDb),
    };
  });

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

    const bindingCandidates = yield* selectBootstrapAuthBindings(transaction, context, authUserId).pipe(
      Effect.mapError(bootstrapFailureFromCause),
    );
    if (bindingCandidates.length > 1) {
      return yield* failure('The stage authentication binding conflicts');
    }
    const expectedBinding = {
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

const reconcilePostgresContext = Effect.fn('StageContextBootstrap.reconcilePostgresContext')(
  function* reconcileStagePostgresContext(
    database: CoreDatabaseExecutor,
    context: StageContext,
    authUserId: string,
  ): Effect.fn.Return<void, StageContextBootstrapError> {
    const transactionBody = (transaction: CoreTransaction) =>
      reconcilePostgresTransaction(transaction, context, authUserId);
    yield* database.transaction(transactionBody).pipe(
      Effect.catchDefect((defect) => (isSqlError(defect) ? Effect.fail(defect) : Effect.die(defect))),
      Effect.catchTag('SqlError', (sqlFailure) => Effect.fail(bootstrapFailureFromCause(sqlFailure))),
    );
  },
);

const buildRelationships = Effect.fn('StageContextBootstrap.buildRelationships')(
  function* buildStageContextRelationships(
    context: StageContext,
  ): Effect.fn.Return<readonly StageContextBootstrapRelationship[], StageContextBootstrapError> {
    const legalEntityObjectId = toLegalEntityAccessObjectId(context.tenantId, context.legalEntityId);
    const moduleObjectId = toModuleAccessObjectId(context.tenantId, context.legalEntityId, context.moduleId);
    if (legalEntityObjectId === undefined || moduleObjectId === undefined) {
      return yield* failure('The stage authorization object IDs are invalid');
    }
    return [
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
    ];
  },
);

const touchRelationships = Effect.fn('StageContextBootstrap.touchRelationships')(
  function* touchStageContextRelationships(
    configuration: StageContextBootstrapConfiguration,
    context: StageContext,
  ): Effect.fn.Return<void, StageContextBootstrapError> {
    const relationships = yield* buildRelationships(context);
    const request = bootstrapRelationshipRequest(relationships);
    yield* Effect.acquireUseRelease(
      Effect.try({
        catch: bootstrapFailureFromCause,
        try: () =>
          v1.NewClient(
            Redacted.value(configuration.spiceDbPreSharedKey),
            configuration.spiceDbEndpoint,
            configuration.spiceDbSecurity,
          ),
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

/**
 * Reconciles the complete fixed set of stage contexts before their principals/tenants can exist.
 * The caller supplies only the Shell-owned Better Auth user IDs in the documented fixed order.
 */
export const reconcileStageContextBootstraps = Effect.fn('StageContextBootstrap.reconcileStageContextBootstraps')(
  function* reconcileFixedStageContexts(
    providerUserIds: StageContextBootstrapProviderUserIds,
  ): Effect.fn.Return<StageContextBootstrapResults, StageContextBootstrapError> {
    const [techsioProviderUserId, siamparkProviderUserId] = providerUserIds;
    if (techsioProviderUserId.trim().length === 0 || siamparkProviderUserId.trim().length === 0) {
      return yield* failure('Both Better Auth provider user IDs are required');
    }
    if (techsioProviderUserId === siamparkProviderUserId) {
      return yield* failure('The stage contexts require distinct Better Auth provider user IDs');
    }
    const contexts = [
      { context: STAGE_CONTEXTS.techsio, providerUserId: techsioProviderUserId },
      {
        context: STAGE_CONTEXTS.siampark,
        providerUserId: siamparkProviderUserId,
      },
    ] as const;
    const configuration = yield* loadConfiguration();
    yield* Effect.scoped(
      Effect.gen(function* reconcileStageDatabase() {
        const databaseConfiguration = yield* parseDatabaseConfig({
          DATABASE_URL: Redacted.value(configuration.databaseAdminUrl),
        }).pipe(Effect.mapError(bootstrapFailureFromCause));
        const { executor } = yield* makeCoreDatabase(databaseConfiguration).pipe(
          Effect.mapError(bootstrapFailureFromCause),
        );
        yield* Effect.forEach(
          contexts,
          ({ context, providerUserId }) =>
            reconcilePostgresContext(executor, context, providerUserId).pipe(
              Effect.andThen(touchRelationships(configuration, context)),
            ),
          { concurrency: 1, discard: true },
        );
      }),
    );
    return [
      {
        legalEntityId: STAGE_CONTEXTS.techsio.legalEntityId,
        principalId: STAGE_CONTEXTS.techsio.principalId,
        tenantId: STAGE_CONTEXTS.techsio.tenantId,
      },
      {
        legalEntityId: STAGE_CONTEXTS.siampark.legalEntityId,
        principalId: STAGE_CONTEXTS.siampark.principalId,
        tenantId: STAGE_CONTEXTS.siampark.tenantId,
      },
    ];
  },
);
