/* eslint-disable promise/prefer-await-to-callbacks -- Better Auth and Drizzle expose Promise APIs contained by Effect. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { v1 } from '@authzed/authzed-node';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { verifyPassword } from 'better-auth/crypto';
import { admin } from 'better-auth/plugins';
import { config as loadDotenv } from 'dotenv';
import { and, eq, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Effect, Schema } from 'effect';
import { Pool } from 'pg';
import { account, authDatabaseSchema, user } from '../apps/shell-super-app/api/auth/db/schema.ts';
import { parseDatabaseConnectionPair } from '../packages/core-runtime/src/db/config.ts';
import {
  coreDatabaseSchema,
  legalEntities,
  principalAuthBindings,
  principals,
  tenantModuleStates,
  tenants,
} from '../packages/core-runtime/src/db/schema.ts';
import {
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '../packages/core-runtime/src/permissions/context-access.ts';
import { spiceDbClientSecurity } from '../packages/core-runtime/src/permissions/client.ts';
import { parseSpiceDbConfig } from '../packages/core-runtime/src/permissions/config.ts';
import { deriveOntosModuleDeploymentContract } from './generate-ontos-module-contract.mts';

export type LocalDevelopmentEnvironment = Readonly<Record<string, string | undefined>>;
type Comparable = boolean | null | number | string;
type ExactRecord = Readonly<Record<string, Comparable>>;

export const LOCAL_DEVELOPMENT_CONTEXT = Object.freeze({
  authBindingId: '73000000-0000-4000-8000-000000000010',
  defaultLocale: 'cs',
  email: 'demo@test.com',
  legalEntityId: '71000000-0000-4000-8000-000000000010',
  legalName: 'TechsioCZ',
  password: 'password1234',
  principalDisplayName: 'Techsio Demo',
  principalId: '72000000-0000-4000-8000-000000000010',
  registrationCountry: 'CZ',
  registrationNumber: 'DEMO-TECHSIOCZ',
  tenantId: '70000000-0000-4000-8000-000000000010',
  tenantName: 'Techsio',
  tenantSlug: 'techsio',
});

export const LOCAL_DEVELOPMENT_VERTICALS = Object.freeze(['crm'] as const);

export interface LocalDevelopmentConfiguration {
  readonly authBaseUrl: string;
  readonly authSecret: string;
  readonly databaseAdminUrl: string;
  readonly email: string;
  readonly password: string;
  readonly principalDisplayName: string;
  readonly spiceDbEndpoint: string;
  readonly spiceDbInsecureLocal: boolean;
  readonly spiceDbPreSharedKey: string;
}

export interface LocalDevelopmentRelationship {
  readonly relation: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly subjectId: string;
  readonly subjectType: string;
}

export interface LocalDevelopmentInitializationResult {
  readonly authUser: 'created' | 'existing';
  readonly email: string;
  readonly legalEntityId: string;
  readonly moduleIds: readonly string[];
  readonly principalId: string;
  readonly tenantId: string;
}

export class LocalDevelopmentInitializationError extends Schema.TaggedError<LocalDevelopmentInitializationError>()(
  'LocalDevelopmentInitializationError',
  {
    code: Schema.Literals([
      'local_configuration_invalid',
      'local_contract_invalid',
      'local_conflict',
      'local_persistence_failed',
    ]),
    reason: Schema.String,
  },
) {}

const failure = (
  code: LocalDevelopmentInitializationError['code'],
  reason: string,
): LocalDevelopmentInitializationError => new LocalDevelopmentInitializationError({ code, reason });

const required = (environment: LocalDevelopmentEnvironment, key: string): string => {
  const value = environment[key]?.trim();
  if (value === undefined || value.length === 0) {
    throw failure('local_configuration_invalid', `${key} is required`);
  }
  return value;
};

const loopbackHosts = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

const assertLoopbackHttpOrigin = (value: string): string => {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'http:' ||
    parsed.origin !== value ||
    !loopbackHosts.has(parsed.hostname)
  ) {
    throw failure(
      'local_configuration_invalid',
      'BETTER_AUTH_URL must be an exact local HTTP origin',
    );
  }
  return value;
};

export const parseLocalDevelopmentConfiguration = (
  environment: LocalDevelopmentEnvironment,
): Effect.Effect<LocalDevelopmentConfiguration, LocalDevelopmentInitializationError> =>
  Effect.gen(function* parseConfiguration() {
    const deploymentEnvironment = environment['ULTRAMODERN_DEPLOYMENT_ENVIRONMENT']?.trim();
    if (
      deploymentEnvironment !== undefined &&
      deploymentEnvironment.length > 0 &&
      deploymentEnvironment !== 'development'
    ) {
      return yield* failure(
        'local_configuration_invalid',
        'Local initialization can run only in the development environment',
      );
    }
    const databasePair = yield* parseDatabaseConnectionPair(environment).pipe(
      Effect.mapError((error) => failure('local_configuration_invalid', error.reason)),
    );
    if (
      !loopbackHosts.has(databasePair.admin.host) ||
      !loopbackHosts.has(databasePair.runtime.host)
    ) {
      return yield* failure(
        'local_configuration_invalid',
        'Both PostgreSQL endpoints must be local',
      );
    }
    const spiceDb = yield* parseSpiceDbConfig(environment).pipe(
      Effect.mapError((error) => failure('local_configuration_invalid', error.reason)),
    );
    const parsedSpiceDbEndpoint = new URL(`http://${spiceDb.endpoint}`);
    if (!loopbackHosts.has(parsedSpiceDbEndpoint.hostname) || !spiceDb.insecureLocal) {
      return yield* failure(
        'local_configuration_invalid',
        'SpiceDB must use insecure transport on a local endpoint',
      );
    }
    const authSecret = required(environment, 'BETTER_AUTH_SECRET');
    if (authSecret.length < 32) {
      return yield* failure(
        'local_configuration_invalid',
        'BETTER_AUTH_SECRET must contain at least 32 characters',
      );
    }
    return {
      authBaseUrl: assertLoopbackHttpOrigin(required(environment, 'BETTER_AUTH_URL')),
      authSecret,
      databaseAdminUrl: databasePair.admin.connectionString,
      email: LOCAL_DEVELOPMENT_CONTEXT.email,
      password: LOCAL_DEVELOPMENT_CONTEXT.password,
      principalDisplayName: LOCAL_DEVELOPMENT_CONTEXT.principalDisplayName,
      spiceDbEndpoint: spiceDb.endpoint,
      spiceDbInsecureLocal: spiceDb.insecureLocal,
      spiceDbPreSharedKey: spiceDb.preSharedKey,
    };
  });

export const classifyExactLocalRecord = <Expected extends ExactRecord>(
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
    throw failure(
      'local_conflict',
      `Existing ${label} conflicts with the local development definition (${conflictingFields.join(', ')})`,
    );
  }
  return 'existing';
};

interface TopologyVertical {
  readonly id?: unknown;
}

export const deriveActivatedModuleIds = async (
  workspaceRoot: string,
  deriveContract: typeof deriveOntosModuleDeploymentContract = deriveOntosModuleDeploymentContract,
  activatedVerticals: readonly string[] = LOCAL_DEVELOPMENT_VERTICALS,
): Promise<readonly string[]> => {
  const topologyPath = path.join(workspaceRoot, 'topology/reference-topology.json');
  const topology = JSON.parse(await readFile(topologyPath, 'utf-8')) as {
    readonly verticals?: readonly TopologyVertical[];
  };
  if (!Array.isArray(topology.verticals) || topology.verticals.length === 0) {
    throw failure('local_contract_invalid', 'The authoritative topology has no MicroVerticals');
  }
  const verticals = topology.verticals.map(({ id }) => {
    if (typeof id !== 'string' || id.length === 0) {
      throw failure('local_contract_invalid', 'The authoritative topology has an invalid vertical');
    }
    return id;
  });
  if (new Set(verticals).size !== verticals.length) {
    throw failure('local_contract_invalid', 'The authoritative topology has duplicate verticals');
  }
  if (new Set(activatedVerticals).size !== activatedVerticals.length) {
    throw failure('local_contract_invalid', 'Local activation contains duplicate MicroVerticals');
  }
  const missingVerticals = activatedVerticals.filter((vertical) => !verticals.includes(vertical));
  if (missingVerticals.length > 0) {
    throw failure(
      'local_contract_invalid',
      `Configured local MicroVerticals are missing from the topology (${missingVerticals.join(', ')})`,
    );
  }
  const contracts = await Promise.all(
    activatedVerticals.map((vertical) => deriveContract({ vertical, workspaceRoot })),
  );
  const moduleIds = contracts.map((contract) => contract.manifest.module.id);
  if (new Set(moduleIds).size !== moduleIds.length) {
    throw failure('local_contract_invalid', 'Generated contracts contain duplicate module IDs');
  }
  return moduleIds.toSorted((left, right) => left.localeCompare(right));
};

export const moduleStateIdFor = (moduleId: string): string => {
  const hexadecimal = createHash('sha256')
    .update(`ontos-local-module-state:${moduleId}`, 'utf-8')
    .digest('hex')
    .slice(0, 32)
    .split('');
  hexadecimal[12] = '4';
  hexadecimal[16] = ((Number.parseInt(hexadecimal[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const value = hexadecimal.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
};

export const buildLocalDevelopmentRelationships = (
  moduleIds: readonly string[],
): readonly LocalDevelopmentRelationship[] => {
  const context = LOCAL_DEVELOPMENT_CONTEXT;
  const legalEntityObjectId = toLegalEntityAccessObjectId(context.tenantId, context.legalEntityId);
  if (legalEntityObjectId === undefined) {
    throw failure('local_contract_invalid', 'The local Legal Entity authorization ID is invalid');
  }
  const shared: LocalDevelopmentRelationship[] = [
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
  ];
  return [
    ...shared,
    ...moduleIds.flatMap((moduleId) => {
      const moduleObjectId = toModuleAccessObjectId(
        context.tenantId,
        context.legalEntityId,
        moduleId,
      );
      if (moduleObjectId === undefined) {
        throw failure(
          'local_contract_invalid',
          `Module ${moduleId} has an invalid authorization ID`,
        );
      }
      return [
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
    }),
  ];
};

const ensureAuthUser = async (
  configuration: LocalDevelopmentConfiguration,
  database: ReturnType<typeof drizzle<typeof authDatabaseSchema>>,
): Promise<{ readonly status: 'created' | 'existing'; readonly userId: string }> => {
  const existingUsers = await database
    .select({ email: user.email, id: user.id, name: user.name })
    .from(user)
    .where(eq(user.email, configuration.email))
    .limit(2);
  if (existingUsers.length > 1) {
    throw failure('local_conflict', 'Multiple Better Auth users use the local email');
  }
  const [existingUser] = existingUsers;
  if (existingUser !== undefined) {
    classifyExactLocalRecord('Better Auth user', existingUser, {
      email: configuration.email,
      name: configuration.principalDisplayName,
    });
    const credentials = await database
      .select({ password: account.password })
      .from(account)
      .where(and(eq(account.userId, existingUser.id), eq(account.providerId, 'credential')))
      .limit(2);
    const [credential] = credentials.length === 1 ? credentials : [];
    if (
      credential?.password === null ||
      credential?.password === undefined ||
      !(await verifyPassword({ hash: credential.password, password: configuration.password }))
    ) {
      throw failure('local_conflict', 'The existing local user has conflicting credentials');
    }
    return { status: 'existing', userId: existingUser.id };
  }
  const authentication = betterAuth({
    baseURL: configuration.authBaseUrl,
    database: drizzleAdapter(database, {
      provider: 'pg',
      schema: authDatabaseSchema,
      transaction: true,
    }),
    emailAndPassword: { autoSignIn: false, disableSignUp: true, enabled: true },
    logger: { disabled: true },
    plugins: [admin()],
    secret: configuration.authSecret,
  });
  const created = await authentication.api.createUser({
    body: {
      email: configuration.email,
      name: configuration.principalDisplayName,
      password: configuration.password,
    },
  });
  return { status: 'created', userId: created.user.id };
};

const reconcileCoreContext = async (
  database: ReturnType<typeof drizzle<typeof coreDatabaseSchema>>,
  authUserId: string,
  moduleIds: readonly string[],
): Promise<void> => {
  const context = LOCAL_DEVELOPMENT_CONTEXT;
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
    if (tenantCandidates.length > 1)
      throw failure('local_conflict', 'The local tenant identity conflicts');
    const expectedTenant = {
      defaultLocale: context.defaultLocale,
      name: context.tenantName,
      slug: context.tenantSlug,
      status: 'active',
      tenantId: context.tenantId,
    } as const;
    if (classifyExactLocalRecord('tenant', tenantCandidates[0], expectedTenant) === 'create') {
      await transaction.insert(tenants).values(expectedTenant);
    }

    const legalCandidates = await transaction
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
    if (legalCandidates.length > 1)
      throw failure('local_conflict', 'The local Legal Entity identity conflicts');
    const expectedLegalEntity = {
      legalEntityId: context.legalEntityId,
      legalName: context.legalName,
      registrationCountry: context.registrationCountry,
      registrationNumber: context.registrationNumber,
      status: 'active',
      tenantId: context.tenantId,
    } as const;
    if (
      classifyExactLocalRecord('Legal Entity', legalCandidates[0], expectedLegalEntity) === 'create'
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
    if (
      classifyExactLocalRecord('principal', principalCandidates[0], expectedPrincipal) === 'create'
    ) {
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
    if (bindingCandidates.length > 1)
      throw failure('local_conflict', 'The local authentication binding conflicts');
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
      classifyExactLocalRecord('authentication binding', bindingCandidates[0], expectedBinding) ===
      'create'
    ) {
      await transaction.insert(principalAuthBindings).values(expectedBinding);
    }

    for (const moduleId of moduleIds) {
      const moduleStateId = moduleStateIdFor(moduleId);
      const moduleCandidates = await transaction
        .select({
          moduleKey: tenantModuleStates.moduleKey,
          state: tenantModuleStates.state,
          tenantId: tenantModuleStates.tenantId,
          tenantModuleStateId: tenantModuleStates.tenantModuleStateId,
        })
        .from(tenantModuleStates)
        .where(
          or(
            eq(tenantModuleStates.tenantModuleStateId, moduleStateId),
            and(
              eq(tenantModuleStates.tenantId, context.tenantId),
              eq(tenantModuleStates.moduleKey, moduleId),
            ),
          ),
        )
        .limit(2);
      if (moduleCandidates.length > 1)
        throw failure('local_conflict', `The ${moduleId} module-state identity conflicts`);
      const expectedModuleState = {
        moduleKey: moduleId,
        state: 'active',
        tenantId: context.tenantId,
        tenantModuleStateId: moduleStateId,
      } as const;
      if (
        classifyExactLocalRecord(
          `${moduleId} module state`,
          moduleCandidates[0],
          expectedModuleState,
        ) === 'create'
      ) {
        await transaction.insert(tenantModuleStates).values(expectedModuleState);
      }
    }
  });
};

const touchRelationships = async (
  configuration: LocalDevelopmentConfiguration,
  relationships: readonly LocalDevelopmentRelationship[],
): Promise<void> => {
  const spiceDbConfiguration = {
    endpoint: configuration.spiceDbEndpoint,
    insecureLocal: configuration.spiceDbInsecureLocal,
    preSharedKey: configuration.spiceDbPreSharedKey,
  };
  const client = v1.NewClient(
    configuration.spiceDbPreSharedKey,
    configuration.spiceDbEndpoint,
    spiceDbClientSecurity(spiceDbConfiguration),
  );
  try {
    await client.promises.writeRelationships(
      v1.WriteRelationshipsRequest.create({
        updates: relationships.map((item) =>
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

const loadRootEnvironment = (): LocalDevelopmentEnvironment => {
  const fileEnvironment: Record<string, string> = {};
  const result = loadDotenv({
    path: path.join(import.meta.dirname, '..', '.env'),
    processEnv: fileEnvironment,
    quiet: true,
  });
  if (result.error !== undefined) throw result.error;
  return { ...fileEnvironment, ...process.env };
};

export const initializeLocalDevelopment = (
  environmentEffect: Effect.Effect<
    LocalDevelopmentEnvironment,
    LocalDevelopmentInitializationError
  > = Effect.try({
    catch: () => failure('local_configuration_invalid', 'Unable to load app/.env'),
    try: loadRootEnvironment,
  }),
): Effect.Effect<LocalDevelopmentInitializationResult, LocalDevelopmentInitializationError> =>
  Effect.gen(function* initialize() {
    const environment = yield* environmentEffect;
    const configuration = yield* parseLocalDevelopmentConfiguration(environment);
    const moduleIds = yield* Effect.tryPromise({
      catch: (cause) =>
        cause instanceof LocalDevelopmentInitializationError
          ? cause
          : failure(
              'local_contract_invalid',
              'Installed MicroVertical contracts could not be derived',
            ),
      try: () => deriveActivatedModuleIds(path.join(import.meta.dirname, '..')),
    });
    const relationships = buildLocalDevelopmentRelationships(moduleIds);
    const authUser = yield* Effect.tryPromise({
      catch: (cause) =>
        cause instanceof LocalDevelopmentInitializationError
          ? cause
          : failure(
              'local_persistence_failed',
              'The local Better Auth user could not be reconciled',
            ),
      try: async () => {
        const pool = new Pool({ connectionString: configuration.databaseAdminUrl });
        try {
          const authDatabase = drizzle({ client: pool, schema: authDatabaseSchema });
          return await ensureAuthUser(configuration, authDatabase);
        } finally {
          await pool.end();
        }
      },
    });
    yield* Effect.tryPromise({
      catch: (cause) =>
        cause instanceof LocalDevelopmentInitializationError
          ? cause
          : failure('local_persistence_failed', 'The local Core context could not be reconciled'),
      try: async () => {
        const pool = new Pool({ connectionString: configuration.databaseAdminUrl });
        try {
          const coreDatabase = drizzle({ client: pool, schema: coreDatabaseSchema });
          await reconcileCoreContext(coreDatabase, authUser.userId, moduleIds);
        } finally {
          await pool.end();
        }
        await touchRelationships(configuration, relationships);
      },
    });
    return {
      authUser: authUser.status,
      email: configuration.email,
      legalEntityId: LOCAL_DEVELOPMENT_CONTEXT.legalEntityId,
      moduleIds,
      principalId: LOCAL_DEVELOPMENT_CONTEXT.principalId,
      tenantId: LOCAL_DEVELOPMENT_CONTEXT.tenantId,
    };
  });

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const result = await Effect.runPromise(initializeLocalDevelopment());
    console.log(
      `Local development initialized for ${result.email}; auth user ${result.authUser}; ${result.moduleIds.length} module(s) active.`,
    );
  } catch (error) {
    console.error(
      error instanceof LocalDevelopmentInitializationError
        ? error.reason
        : 'Local development initialization failed',
    );
    process.exitCode = 1;
  }
}
