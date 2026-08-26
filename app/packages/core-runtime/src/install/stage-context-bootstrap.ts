// @effect-diagnostics asyncFunction:off processEnv:off -- Drizzle and Authzed Promise callbacks are contained by the Effect boundary.
import { v1 } from '@authzed/authzed-node';
import { and, eq, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Effect, Schema } from 'effect';
import { Pool } from 'pg';
import { parseDatabaseConfig } from '../db/config.ts';
import {
  coreDatabaseSchema,
  legalEntities,
  principalAuthBindings,
  principals,
  tenantModuleStates,
  tenants,
} from '../db/schema.ts';
import {
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '../permissions/context-access.ts';
import { parseSpiceDbConfig } from '../permissions/config.ts';

type Comparable = boolean | null | number | string;
type ExactRecord = Readonly<Record<string, Comparable>>;

const STAGE_CONTEXT = Object.freeze({
  authBindingId: '73000000-0000-4000-8000-000000000001',
  defaultLocale: 'cs',
  legalEntityId: '71000000-0000-4000-8000-000000000001',
  legalName: 'TechsioCZ',
  moduleId: 'crm.core',
  moduleStateId: '74000000-0000-4000-8000-000000000001',
  principalDisplayName: 'Techsio Demo',
  principalId: '72000000-0000-4000-8000-000000000001',
  registrationCountry: 'CZ',
  registrationNumber: 'DEMO-TECHSIOCZ',
  tenantId: '70000000-0000-4000-8000-000000000001',
  tenantName: 'Techsio',
  tenantSlug: 'techsio',
} as const);

interface StageContextBootstrapConfiguration {
  readonly databaseAdminUrl: string;
  readonly spiceDbEndpoint: string;
  readonly spiceDbPreSharedKey: string;
}

interface StageContextBootstrapRelationship {
  readonly relation: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly subjectId: string;
  readonly subjectType: string;
}

export interface StageContextBootstrapResult {
  readonly legalEntityId: typeof STAGE_CONTEXT.legalEntityId;
  readonly principalId: typeof STAGE_CONTEXT.principalId;
  readonly tenantId: typeof STAGE_CONTEXT.tenantId;
}

export class StageContextBootstrapError extends Schema.TaggedError<StageContextBootstrapError>()(
  'StageContextBootstrapError',
  {
    code: Schema.Literal('stage_context_bootstrap_failed'),
    reason: Schema.String,
  },
) {}

const failure = (reason: string): StageContextBootstrapError =>
  new StageContextBootstrapError({ code: 'stage_context_bootstrap_failed', reason });

const loadConfiguration = (): Effect.Effect<
  StageContextBootstrapConfiguration,
  StageContextBootstrapError
> =>
  Effect.gen(function* loadStageContextBootstrapConfiguration() {
    const environment = process.env;
    if (environment['ULTRAMODERN_DEPLOYMENT_ENVIRONMENT']?.trim() !== 'stage') {
      return yield* failure('The Core installation bootstrap can run only in stage');
    }
    const databaseAdminUrl = environment['DATABASE_ADMIN_URL']?.trim();
    if (databaseAdminUrl === undefined || databaseAdminUrl.length === 0) {
      return yield* failure('DATABASE_ADMIN_URL is required');
    }
    yield* parseDatabaseConfig({ DATABASE_URL: databaseAdminUrl }).pipe(
      Effect.mapError((error) => failure(error.reason)),
    );
    const spiceDb = yield* parseSpiceDbConfig(environment).pipe(
      Effect.mapError((error) => failure(error.reason)),
    );
    if (spiceDb.endpoint !== 'spicedb:50051' || !spiceDb.insecureLocal) {
      return yield* failure('The Core installation bootstrap requires stage-private SpiceDB');
    }
    return {
      databaseAdminUrl,
      spiceDbEndpoint: spiceDb.endpoint,
      spiceDbPreSharedKey: spiceDb.preSharedKey,
    };
  });

const classifyExactRecord = <Expected extends ExactRecord>(
  label: string,
  existing: ExactRecord | undefined,
  expected: Expected,
): 'create' | 'existing' => {
  if (existing === undefined) {
    return 'create';
  }
  const conflictingFields = Object.entries(expected)
    .filter(([key, value]) => existing[key] !== value)
    .map(([key]) => key);
  if (conflictingFields.length > 0) {
    throw new Error(
      `Existing ${label} conflicts with the stage bootstrap definition (${conflictingFields.join(', ')})`,
    );
  }
  return 'existing';
};

const reconcilePostgresContext = async (
  database: ReturnType<typeof drizzle<typeof coreDatabaseSchema>>,
  authUserId: string,
): Promise<void> => {
  await database.transaction(async (transaction) => {
    const tenantCandidates = await transaction
      .select({
        defaultLocale: tenants.defaultLocale,
        name: tenants.name,
        slug: tenants.slug,
        status: tenants.status,
        tenantId: tenants.tenantId,
      })
      .from(tenants)
      .where(
        or(
          eq(tenants.tenantId, STAGE_CONTEXT.tenantId),
          eq(tenants.slug, STAGE_CONTEXT.tenantSlug),
        ),
      )
      .limit(2);
    if (tenantCandidates.length > 1) {
      throw new Error('The stage tenant identity conflicts');
    }
    const expectedTenant = {
      defaultLocale: STAGE_CONTEXT.defaultLocale,
      name: STAGE_CONTEXT.tenantName,
      slug: STAGE_CONTEXT.tenantSlug,
      status: 'active',
      tenantId: STAGE_CONTEXT.tenantId,
    } as const;
    if (classifyExactRecord('tenant', tenantCandidates[0], expectedTenant) === 'create') {
      await transaction.insert(tenants).values(expectedTenant);
    }

    const legalEntityCandidates = await transaction
      .select({
        legalEntityId: legalEntities.legalEntityId,
        legalName: legalEntities.legalName,
        registrationCountry: legalEntities.registrationCountry,
        registrationNumber: legalEntities.registrationNumber,
        status: legalEntities.status,
        tenantId: legalEntities.tenantId,
      })
      .from(legalEntities)
      .where(
        or(
          eq(legalEntities.legalEntityId, STAGE_CONTEXT.legalEntityId),
          and(
            eq(legalEntities.tenantId, STAGE_CONTEXT.tenantId),
            eq(legalEntities.registrationCountry, STAGE_CONTEXT.registrationCountry),
            eq(legalEntities.registrationNumber, STAGE_CONTEXT.registrationNumber),
          ),
        ),
      )
      .limit(2);
    if (legalEntityCandidates.length > 1) {
      throw new Error('The stage legal-entity identity conflicts');
    }
    const expectedLegalEntity = {
      legalEntityId: STAGE_CONTEXT.legalEntityId,
      legalName: STAGE_CONTEXT.legalName,
      registrationCountry: STAGE_CONTEXT.registrationCountry,
      registrationNumber: STAGE_CONTEXT.registrationNumber,
      status: 'active',
      tenantId: STAGE_CONTEXT.tenantId,
    } as const;
    if (
      classifyExactRecord('legal entity', legalEntityCandidates[0], expectedLegalEntity) ===
      'create'
    ) {
      await transaction.insert(legalEntities).values(expectedLegalEntity);
    }

    const expectedPrincipal = {
      displayName: STAGE_CONTEXT.principalDisplayName,
      kind: 'human',
      principalId: STAGE_CONTEXT.principalId,
      status: 'active',
      tenantId: STAGE_CONTEXT.tenantId,
    } as const;
    const principalCandidates = await transaction
      .select({
        displayName: principals.displayName,
        kind: principals.kind,
        principalId: principals.principalId,
        status: principals.status,
        tenantId: principals.tenantId,
      })
      .from(principals)
      .where(eq(principals.principalId, STAGE_CONTEXT.principalId))
      .limit(1);
    if (classifyExactRecord('principal', principalCandidates[0], expectedPrincipal) === 'create') {
      await transaction.insert(principals).values(expectedPrincipal);
    }

    const bindingCandidates = await transaction
      .select({
        principalAuthBindingId: principalAuthBindings.principalAuthBindingId,
        principalId: principalAuthBindings.principalId,
        provider: principalAuthBindings.provider,
        providerSubjectId: principalAuthBindings.providerSubjectId,
        status: principalAuthBindings.status,
        subjectType: principalAuthBindings.subjectType,
        tenantId: principalAuthBindings.tenantId,
      })
      .from(principalAuthBindings)
      .where(
        or(
          eq(principalAuthBindings.principalAuthBindingId, STAGE_CONTEXT.authBindingId),
          and(
            eq(principalAuthBindings.tenantId, STAGE_CONTEXT.tenantId),
            eq(principalAuthBindings.provider, 'better_auth'),
            eq(principalAuthBindings.subjectType, 'user'),
            eq(principalAuthBindings.providerSubjectId, authUserId),
          ),
        ),
      )
      .limit(2);
    if (bindingCandidates.length > 1) {
      throw new Error('The stage authentication binding conflicts');
    }
    const expectedBinding = {
      principalAuthBindingId: STAGE_CONTEXT.authBindingId,
      principalId: STAGE_CONTEXT.principalId,
      provider: 'better_auth',
      providerSubjectId: authUserId,
      status: 'active',
      subjectType: 'user',
      tenantId: STAGE_CONTEXT.tenantId,
    } as const;
    if (
      classifyExactRecord('authentication binding', bindingCandidates[0], expectedBinding) ===
      'create'
    ) {
      await transaction.insert(principalAuthBindings).values(expectedBinding);
    }

    const moduleStateCandidates = await transaction
      .select({
        moduleKey: tenantModuleStates.moduleKey,
        state: tenantModuleStates.state,
        tenantId: tenantModuleStates.tenantId,
        tenantModuleStateId: tenantModuleStates.tenantModuleStateId,
      })
      .from(tenantModuleStates)
      .where(
        or(
          eq(tenantModuleStates.tenantModuleStateId, STAGE_CONTEXT.moduleStateId),
          and(
            eq(tenantModuleStates.tenantId, STAGE_CONTEXT.tenantId),
            eq(tenantModuleStates.moduleKey, STAGE_CONTEXT.moduleId),
          ),
        ),
      )
      .limit(2);
    if (moduleStateCandidates.length > 1) {
      throw new Error('The stage module-state identity conflicts');
    }
    const expectedModuleState = {
      moduleKey: STAGE_CONTEXT.moduleId,
      state: 'active',
      tenantId: STAGE_CONTEXT.tenantId,
      tenantModuleStateId: STAGE_CONTEXT.moduleStateId,
    } as const;
    if (
      classifyExactRecord('module state', moduleStateCandidates[0], expectedModuleState) ===
      'create'
    ) {
      await transaction.insert(tenantModuleStates).values(expectedModuleState);
    }
  });
};

const buildRelationships = (): readonly StageContextBootstrapRelationship[] => {
  const legalEntityObjectId = toLegalEntityAccessObjectId(
    STAGE_CONTEXT.tenantId,
    STAGE_CONTEXT.legalEntityId,
  );
  const moduleObjectId = toModuleAccessObjectId(
    STAGE_CONTEXT.tenantId,
    STAGE_CONTEXT.legalEntityId,
    STAGE_CONTEXT.moduleId,
  );
  if (legalEntityObjectId === undefined || moduleObjectId === undefined) {
    throw new Error('The stage authorization object IDs are invalid');
  }
  return [
    {
      relation: 'member',
      resourceId: STAGE_CONTEXT.tenantId,
      resourceType: 'tenant',
      subjectId: STAGE_CONTEXT.principalId,
      subjectType: 'principal',
    },
    {
      relation: 'tenant',
      resourceId: legalEntityObjectId,
      resourceType: 'legal_entity',
      subjectId: STAGE_CONTEXT.tenantId,
      subjectType: 'tenant',
    },
    {
      relation: 'member',
      resourceId: legalEntityObjectId,
      resourceType: 'legal_entity',
      subjectId: STAGE_CONTEXT.principalId,
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
      subjectId: STAGE_CONTEXT.principalId,
      subjectType: 'principal',
    },
  ];
};

const touchRelationships = async (
  configuration: StageContextBootstrapConfiguration,
): Promise<void> => {
  const client = v1.NewClient(
    configuration.spiceDbPreSharedKey,
    configuration.spiceDbEndpoint,
    v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED,
  );
  try {
    await client.promises.writeRelationships(
      v1.WriteRelationshipsRequest.create({
        updates: buildRelationships().map((item) =>
          v1.RelationshipUpdate.create({
            operation: v1.RelationshipUpdate_Operation.TOUCH,
            relationship: v1.Relationship.create({
              relation: item.relation,
              resource: v1.ObjectReference.create({
                objectId: item.resourceId,
                objectType: item.resourceType,
              }),
              subject: v1.SubjectReference.create({
                object: v1.ObjectReference.create({
                  objectId: item.subjectId,
                  objectType: item.subjectType,
                }),
              }),
            }),
          }),
        ),
      }),
    );
  } finally {
    client.close();
  }
};

/**
 * Reconciles the one fixed stage context before an Action principal/tenant can exist.
 * The only caller-provided value is the Shell-owned Better Auth provider user ID.
 */
export const reconcileStageContextBootstrap = (
  authUserId: string,
): Effect.Effect<StageContextBootstrapResult, StageContextBootstrapError> =>
  Effect.gen(function* reconcileFixedStageContext() {
    if (authUserId.trim().length === 0) {
      return yield* failure('The Better Auth provider user ID is required');
    }
    const configuration = yield* loadConfiguration();
    yield* Effect.tryPromise({
      catch: (cause) =>
        failure(
          cause instanceof Error
            ? cause.message
            : 'The fixed stage Core context could not be reconciled',
        ),
      try: async () => {
        const pool = new Pool({ connectionString: configuration.databaseAdminUrl });
        try {
          const database = drizzle({ client: pool, schema: coreDatabaseSchema });
          await reconcilePostgresContext(database, authUserId);
          await touchRelationships(configuration);
        } finally {
          await pool.end();
        }
      },
    });
    return {
      legalEntityId: STAGE_CONTEXT.legalEntityId,
      principalId: STAGE_CONTEXT.principalId,
      tenantId: STAGE_CONTEXT.tenantId,
    };
  });
