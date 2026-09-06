// @effect-diagnostics asyncFunction:off processEnv:off -- Drizzle and Authzed Promise callbacks are contained by the Effect boundary.
import { v1 } from '@authzed/authzed-node';
import { and, eq, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Effect, Schema } from 'effect';
import { Pool } from 'pg';
import { parseDatabaseConfig } from '../db/config.ts';
import {
  coreRelations,
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
import { spiceDbClientSecurity } from '../permissions/client.ts';
import { parseSpiceDbConfig } from '../permissions/config.ts';

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
  readonly databaseAdminUrl: string;
  readonly spiceDbEndpoint: string;
  readonly spiceDbPreSharedKey: string;
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
export type StageContextBootstrapResults = readonly [
  StageContextBootstrapResult,
  StageContextBootstrapResult,
];

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
      spiceDbSecurity: spiceDbClientSecurity(spiceDb),
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
  const conflictingFields = Object.entries(expected).flatMap(([key, value]) =>
    existing[key] === value ? [] : [key],
  );
  if (conflictingFields.length > 0) {
    throw new Error(
      `Existing ${label} conflicts with the stage bootstrap definition (${conflictingFields.join(', ')})`,
    );
  }
  return 'existing';
};

const reconcilePostgresContext = async (
  database: NodePgDatabase<typeof coreRelations>,
  context: StageContext,
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
      .where(or(eq(tenants.tenantId, context.tenantId), eq(tenants.slug, context.tenantSlug)))
      .limit(2);
    if (tenantCandidates.length > 1) {
      throw new Error('The stage tenant identity conflicts');
    }
    const expectedTenant = {
      defaultLocale: context.defaultLocale,
      name: context.tenantName,
      slug: context.tenantSlug,
      status: 'active',
      tenantId: context.tenantId,
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
          eq(legalEntities.legalEntityId, context.legalEntityId),
          and(
            eq(legalEntities.tenantId, context.tenantId),
            eq(legalEntities.registrationCountry, context.registrationCountry),
            eq(legalEntities.registrationNumber, context.registrationNumber),
          ),
        ),
      )
      .limit(2);
    if (legalEntityCandidates.length > 1) {
      throw new Error('The stage legal-entity identity conflicts');
    }
    const expectedLegalEntity = {
      legalEntityId: context.legalEntityId,
      legalName: context.legalName,
      registrationCountry: context.registrationCountry,
      registrationNumber: context.registrationNumber,
      status: 'active',
      tenantId: context.tenantId,
    } as const;
    if (
      classifyExactRecord('legal entity', legalEntityCandidates[0], expectedLegalEntity) ===
      'create'
    ) {
      await transaction.insert(legalEntities).values(expectedLegalEntity);
    }

    const expectedPrincipal = {
      displayName: context.principalDisplayName,
      kind: 'human',
      principalId: context.principalId,
      status: 'active',
      tenantId: context.tenantId,
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
      .where(eq(principals.principalId, context.principalId))
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
          eq(principalAuthBindings.principalAuthBindingId, context.authBindingId),
          and(
            eq(principalAuthBindings.tenantId, context.tenantId),
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
      principalAuthBindingId: context.authBindingId,
      principalId: context.principalId,
      provider: 'better_auth',
      providerSubjectId: authUserId,
      status: 'active',
      subjectType: 'user',
      tenantId: context.tenantId,
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
          eq(tenantModuleStates.tenantModuleStateId, context.moduleStateId),
          and(
            eq(tenantModuleStates.tenantId, context.tenantId),
            eq(tenantModuleStates.moduleKey, context.moduleId),
          ),
        ),
      )
      .limit(2);
    if (moduleStateCandidates.length > 1) {
      throw new Error('The stage module-state identity conflicts');
    }
    const expectedModuleState = {
      moduleKey: context.moduleId,
      state: 'active',
      tenantId: context.tenantId,
      tenantModuleStateId: context.moduleStateId,
    } as const;
    if (
      classifyExactRecord('module state', moduleStateCandidates[0], expectedModuleState) ===
      'create'
    ) {
      await transaction.insert(tenantModuleStates).values(expectedModuleState);
    }
  });
};

const buildRelationships = (
  context: StageContext,
): readonly StageContextBootstrapRelationship[] => {
  const legalEntityObjectId = toLegalEntityAccessObjectId(context.tenantId, context.legalEntityId);
  const moduleObjectId = toModuleAccessObjectId(
    context.tenantId,
    context.legalEntityId,
    context.moduleId,
  );
  if (legalEntityObjectId === undefined || moduleObjectId === undefined) {
    throw new Error('The stage authorization object IDs are invalid');
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
};

const touchRelationships = async (
  configuration: StageContextBootstrapConfiguration,
  context: StageContext,
): Promise<void> => {
  const client = v1.NewClient(
    configuration.spiceDbPreSharedKey,
    configuration.spiceDbEndpoint,
    configuration.spiceDbSecurity,
  );
  try {
    await client.promises.writeRelationships(
      v1.WriteRelationshipsRequest.create({
        updates: buildRelationships(context).map((item) =>
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
 * Reconciles the complete fixed set of stage contexts before their principals/tenants can exist.
 * The caller supplies only the Shell-owned Better Auth user IDs in the documented fixed order.
 */
export const reconcileStageContextBootstraps = (
  providerUserIds: StageContextBootstrapProviderUserIds,
): Effect.Effect<StageContextBootstrapResults, StageContextBootstrapError> =>
  Effect.gen(function* reconcileFixedStageContexts() {
    const [techsioProviderUserId, siamparkProviderUserId] = providerUserIds;
    if (techsioProviderUserId.trim().length === 0 || siamparkProviderUserId.trim().length === 0) {
      return yield* failure('Both Better Auth provider user IDs are required');
    }
    if (techsioProviderUserId === siamparkProviderUserId) {
      return yield* failure('The stage contexts require distinct Better Auth provider user IDs');
    }
    const contexts = [
      { context: STAGE_CONTEXTS.techsio, providerUserId: techsioProviderUserId },
      { context: STAGE_CONTEXTS.siampark, providerUserId: siamparkProviderUserId },
    ] as const;
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
          const database = drizzle({ client: pool, relations: coreRelations });
          for (const { context, providerUserId } of contexts) {
            // The fixed installation set is intentionally reconciled in order to avoid racing
            // cross-store bootstrap writes and to make a retry's stopping point deterministic.
            // eslint-disable-next-line no-await-in-loop
            await reconcilePostgresContext(database, context, providerUserId);
            // eslint-disable-next-line no-await-in-loop
            await touchRelationships(configuration, context);
          }
        } finally {
          await pool.end();
        }
      },
    });
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
  });
