import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { betterAuth } from 'better-auth';
import { verifyPassword } from 'better-auth/crypto';
import { admin } from 'better-auth/plugins/admin';
import { and, eq, or } from 'drizzle-orm';
import {
  Config,
  ConfigProvider,
  Console,
  Effect,
  FileSystem,
  Layer,
  Path,
  Redacted,
  Schema,
} from 'effect';
import { isSqlError } from 'effect/unstable/sql/SqlError';

import { AuthConfig } from '../apps/shell-super-app/api/auth/config.ts';
import {
  AuthDatabase,
  AuthDatabaseLive,
} from '../apps/shell-super-app/api/auth/db/client.ts';
import { account, user } from '../apps/shell-super-app/api/auth/db/schema.ts';
import {
  CoreDatabase,
  CoreDatabaseLive,
} from '../packages/core-runtime/src/db/client.ts';
import {
  DatabaseConfig,
  parseDatabaseConfig,
  parseDatabaseConnectionPair,
} from '../packages/core-runtime/src/db/config.ts';
import {
  legalEntities,
  principalAuthBindings,
  principals,
  tenantModuleStates,
  tenants,
} from '../packages/core-runtime/src/db/schema.ts';
import type {
  CoreDatabaseExecutor,
  CoreTransaction,
} from '../packages/core-runtime/src/db/types.ts';
import {
  bootstrapPrincipalRecord,
  bootstrapRelationshipRequest,
  selectBootstrapLegalEntities,
  selectBootstrapPrincipals,
  selectBootstrapAuthBindings,
} from '../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import { spiceDbClientSecurity } from '../packages/core-runtime/src/permissions/client.ts';
import { parseSpiceDbConfig } from '../packages/core-runtime/src/permissions/config.ts';
import {
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '../packages/core-runtime/src/permissions/context-access.ts';
import { deriveOntosModuleDeploymentContract } from './generate-ontos-module-contract.mts';

export interface LocalDevelopmentEnvironment {
  readonly BETTER_AUTH_SECRET?: unknown;
  readonly BETTER_AUTH_URL?: string;
  readonly DATABASE_ADMIN_URL?: string;
  readonly DATABASE_URL?: string;
  readonly SPICEDB_ENDPOINT?: string;
  readonly SPICEDB_INSECURE?: string;
  readonly SPICEDB_PRESHARED_KEY?: string;
  readonly ULTRAMODERN_DEPLOYMENT_ENVIRONMENT?: string;
}
type Comparable = boolean | null | number | string;
type ExactRecord = Readonly<Record<string, Comparable>>;

const localDevelopmentPassword = Redacted.make(['password', '1234'].join(''));

export const LOCAL_DEVELOPMENT_CONTEXT = Object.freeze({
  authBindingId: '73000000-0000-4000-8000-000000000010',
  defaultLocale: 'cs',
  email: 'demo@test.com',
  legalEntityId: '71000000-0000-4000-8000-000000000010',
  legalName: 'TechsioCZ',
  password: localDevelopmentPassword,
  principalDisplayName: 'Techsio Demo',
  principalId: '72000000-0000-4000-8000-000000000010',
  registrationCountry: 'CZ',
  registrationNumber: 'DEMO-TECHSIOCZ',
  tenantId: '70000000-0000-4000-8000-000000000010',
  tenantName: 'Techsio',
  tenantSlug: 'techsio',
});

export const LOCAL_DEVELOPMENT_VERTICALS = Object.freeze([
  'party-registry',
] as const);

export interface LocalDevelopmentConfiguration {
  readonly authBaseUrl: string;
  readonly authSecret: Redacted.Redacted;
  readonly databaseAdminUrl: string;
  readonly email: string;
  readonly password: Redacted.Redacted;
  readonly principalDisplayName: string;
  readonly spiceDbEndpoint: string;
  readonly spiceDbInsecureLocal: boolean;
  readonly spiceDbPreSharedKey: Redacted.Redacted;
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
  }
) {}

const failure = (
  code: LocalDevelopmentInitializationError['code'],
  reason: string
): LocalDevelopmentInitializationError =>
  new LocalDevelopmentInitializationError({ code, reason });

const loopbackHosts = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

const validateLoopbackHttpOrigin = (
  value: string
): Effect.Effect<string, LocalDevelopmentInitializationError> => {
  const parsed = URL.parse(value);
  if (
    parsed === null ||
    parsed.protocol !== 'http:' ||
    parsed.origin !== value ||
    !loopbackHosts.has(parsed.hostname)
  ) {
    return Effect.fail(
      failure(
        'local_configuration_invalid',
        'BETTER_AUTH_URL must be an exact local HTTP origin'
      )
    );
  }
  return Effect.succeed(value);
};

const TrimmedNonEmptyString = Schema.Trim.check(Schema.isNonEmpty());

const localDevelopmentConfigSource = Config.all({
  authBaseUrl: Config.schema(TrimmedNonEmptyString, 'BETTER_AUTH_URL'),
  authSecret: Config.redacted('BETTER_AUTH_SECRET'),
  databaseAdminUrl: Config.schema(TrimmedNonEmptyString, 'DATABASE_ADMIN_URL'),
  databaseUrl: Config.schema(TrimmedNonEmptyString, 'DATABASE_URL'),
  deploymentEnvironment: Config.schema(
    Schema.Trim,
    'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'
  ).pipe(Config.withDefault('development')),
  spiceDbEndpoint: Config.schema(TrimmedNonEmptyString, 'SPICEDB_ENDPOINT'),
  spiceDbInsecure: Config.schema(Schema.Trim, 'SPICEDB_INSECURE'),
  spiceDbPreSharedKey: Config.redacted('SPICEDB_PRESHARED_KEY'),
});

const environmentProvider = (environment: LocalDevelopmentEnvironment) =>
  ConfigProvider.fromUnknown(environment);

const parseLocalDevelopmentConfigurationFromProvider = (
  provider: ConfigProvider.ConfigProvider
) =>
  Effect.gen(function* parseConfiguration() {
    const source = yield* localDevelopmentConfigSource
      .parse(provider)
      .pipe(
        Effect.mapError(() =>
          failure(
            'local_configuration_invalid',
            'The local development configuration is invalid'
          )
        )
      );
    if (source.deploymentEnvironment !== 'development') {
      return yield* failure(
        'local_configuration_invalid',
        'Local initialization can run only in the development environment'
      );
    }
    const authSecret = Redacted.make(Redacted.value(source.authSecret).trim());
    if (Redacted.value(authSecret).length < 32) {
      return yield* failure(
        'local_configuration_invalid',
        'BETTER_AUTH_SECRET must contain at least 32 characters'
      );
    }
    const databasePair = yield* parseDatabaseConnectionPair({
      DATABASE_ADMIN_URL: source.databaseAdminUrl,
      DATABASE_URL: source.databaseUrl,
    }).pipe(
      Effect.mapError((error) =>
        failure('local_configuration_invalid', error.reason)
      )
    );
    if (
      !loopbackHosts.has(databasePair.admin.host) ||
      !loopbackHosts.has(databasePair.runtime.host)
    ) {
      return yield* failure(
        'local_configuration_invalid',
        'Both PostgreSQL endpoints must be local'
      );
    }
    const spiceDbPreSharedKey = Redacted.make(
      Redacted.value(source.spiceDbPreSharedKey).trim()
    );
    const spiceDb = yield* parseSpiceDbConfig({
      SPICEDB_ENDPOINT: source.spiceDbEndpoint,
      SPICEDB_INSECURE: source.spiceDbInsecure,
      SPICEDB_PRESHARED_KEY: Redacted.value(spiceDbPreSharedKey),
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: source.deploymentEnvironment,
    }).pipe(
      Effect.mapError((error) =>
        failure('local_configuration_invalid', error.reason)
      )
    );
    const parsedSpiceDbEndpoint = URL.parse(`http://${spiceDb.endpoint}`);
    if (
      parsedSpiceDbEndpoint === null ||
      !loopbackHosts.has(parsedSpiceDbEndpoint.hostname) ||
      !spiceDb.insecureLocal
    ) {
      return yield* failure(
        'local_configuration_invalid',
        'SpiceDB must use insecure transport on a local endpoint'
      );
    }
    const authBaseUrl = yield* validateLoopbackHttpOrigin(source.authBaseUrl);
    return {
      authBaseUrl,
      authSecret,
      databaseAdminUrl: databasePair.admin.connectionString,
      email: LOCAL_DEVELOPMENT_CONTEXT.email,
      password: LOCAL_DEVELOPMENT_CONTEXT.password,
      principalDisplayName: LOCAL_DEVELOPMENT_CONTEXT.principalDisplayName,
      spiceDbEndpoint: spiceDb.endpoint,
      spiceDbInsecureLocal: spiceDb.insecureLocal,
      spiceDbPreSharedKey,
    };
  });

export const parseLocalDevelopmentConfiguration = (
  environment: LocalDevelopmentEnvironment
): Effect.Effect<
  LocalDevelopmentConfiguration,
  LocalDevelopmentInitializationError
> =>
  parseLocalDevelopmentConfigurationFromProvider(
    environmentProvider(environment)
  );

export const classifyExactLocalRecord = <Expected extends ExactRecord>(
  label: string,
  existing: ExactRecord | undefined,
  expected: Expected
): Effect.Effect<'create' | 'existing', LocalDevelopmentInitializationError> =>
  Effect.gen(function* classifyRecord() {
    if (existing === undefined) {
      return 'create' as const;
    }
    const conflictingFields = Object.entries(expected)
      .filter(([key, value]) => existing[key] !== value)
      .map(([key]) => key);
    if (conflictingFields.length > 0) {
      return yield* failure(
        'local_conflict',
        `Existing ${label} conflicts with the local development definition (${conflictingFields.join(', ')})`
      );
    }
    return 'existing' as const;
  });

export const classifyLocalModuleState = (
  label: string,
  existing: ExactRecord | undefined,
  expected: ExactRecord
): Effect.Effect<'create' | 'existing', LocalDevelopmentInitializationError> =>
  classifyExactLocalRecord(label, existing, {
    moduleKey: expected.moduleKey ?? null,
    state: expected.state ?? null,
    tenantId: expected.tenantId ?? null,
  });

const TopologySchema = Schema.Struct({
  verticals: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
    })
  ),
});

type DeriveContract = typeof deriveOntosModuleDeploymentContract;

export const deriveActivatedModuleIds = (
  workspaceRoot: string,
  deriveContract: DeriveContract = deriveOntosModuleDeploymentContract,
  activatedVerticals: readonly string[] = LOCAL_DEVELOPMENT_VERTICALS
) =>
  Effect.gen(function* deriveModuleIds() {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const topologySource = yield* fileSystem
      .readFileString(
        pathService.join(workspaceRoot, 'topology/reference-topology.json')
      )
      .pipe(
        Effect.mapError(() =>
          failure(
            'local_contract_invalid',
            'The authoritative topology could not be read'
          )
        )
      );
    const topology = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(TopologySchema),
      {
        onExcessProperty: 'preserve',
      }
    )(topologySource).pipe(
      Effect.mapError(() =>
        failure(
          'local_contract_invalid',
          'The authoritative topology is invalid'
        )
      )
    );
    if (topology.verticals.length === 0) {
      return yield* failure(
        'local_contract_invalid',
        'The authoritative topology has no MicroVerticals'
      );
    }
    const verticals = topology.verticals.map(({ id }) => id);
    if (new Set(verticals).size !== verticals.length) {
      return yield* failure(
        'local_contract_invalid',
        'The authoritative topology has duplicate verticals'
      );
    }
    if (new Set(activatedVerticals).size !== activatedVerticals.length) {
      return yield* failure(
        'local_contract_invalid',
        'Local activation contains duplicate MicroVerticals'
      );
    }
    const missingVerticals = activatedVerticals.filter(
      (vertical) => !verticals.includes(vertical)
    );
    if (missingVerticals.length > 0) {
      return yield* failure(
        'local_contract_invalid',
        `Configured local MicroVerticals are missing from the topology (${missingVerticals.join(', ')})`
      );
    }
    const contracts = yield* Effect.forEach(
      activatedVerticals,
      (vertical) =>
        deriveContract({ vertical, workspaceRoot }).pipe(
          Effect.mapError(() =>
            failure(
              'local_contract_invalid',
              `The ${vertical} deployment contract could not be derived`
            )
          )
        ),
      { concurrency: 'unbounded' }
    );
    const moduleIds = contracts.map((contract) => contract.manifest.module.id);
    if (new Set(moduleIds).size !== moduleIds.length) {
      return yield* failure(
        'local_contract_invalid',
        'Generated contracts contain duplicate module IDs'
      );
    }
    const sortedModuleIds: string[] = [];
    for (const moduleId of moduleIds) {
      const insertionIndex = sortedModuleIds.findIndex(
        (existing) => moduleId.localeCompare(existing) < 0
      );
      if (insertionIndex === -1) {
        sortedModuleIds.push(moduleId);
      } else {
        sortedModuleIds.splice(insertionIndex, 0, moduleId);
      }
    }
    return sortedModuleIds;
  });

export const moduleStateIdFor = (moduleId: string): string => {
  const hexadecimal = createHash('sha256')
    .update(`ontos-local-module-state:${moduleId}`, 'utf-8')
    .digest('hex')
    .slice(0, 32);
  const variantNibble = Number.parseInt(hexadecimal.charAt(16), 16);
  const value = `${hexadecimal.slice(0, 12)}4${hexadecimal.slice(13, 16)}${((variantNibble % 4) + 8).toString(16)}${hexadecimal.slice(17)}`;
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
};

export const buildLocalDevelopmentRelationships = Effect.fn(
  'LocalDevelopment.buildRelationships'
)(function* buildRelationships(
  moduleIds: readonly string[]
): Effect.fn.Return<
  readonly LocalDevelopmentRelationship[],
  LocalDevelopmentInitializationError
> {
  const context = LOCAL_DEVELOPMENT_CONTEXT;
  const legalEntityObjectId = toLegalEntityAccessObjectId(
    context.tenantId,
    context.legalEntityId
  );
  if (legalEntityObjectId === undefined) {
    return yield* failure(
      'local_contract_invalid',
      'The local Legal Entity authorization ID is invalid'
    );
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
  for (const moduleId of moduleIds) {
    const moduleObjectId = toModuleAccessObjectId(
      context.tenantId,
      context.legalEntityId,
      moduleId
    );
    if (moduleObjectId === undefined) {
      return yield* failure(
        'local_contract_invalid',
        `Module ${moduleId} has an invalid authorization ID`
      );
    }
    shared.push(
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
      }
    );
  }
  return shared;
});

const ensureAuthUser = Effect.fn('LocalDevelopment.ensureAuthUser')(
  function* ensureAuthUserEffect(configuration: LocalDevelopmentConfiguration) {
    const { adapter, executor: database } = yield* AuthDatabase;
    const existingUsers = yield* database
      .select({ email: user.email, id: user.id, name: user.name })
      .from(user)
      .where(eq(user.email, configuration.email))
      .limit(2)
      .pipe(
        Effect.mapError(() =>
          failure(
            'local_persistence_failed',
            'The local Better Auth user could not be loaded'
          )
        )
      );
    if (existingUsers.length > 1) {
      return yield* failure(
        'local_conflict',
        'Multiple Better Auth users use the local email'
      );
    }
    const [existingUser] = existingUsers;
    if (existingUser !== undefined) {
      yield* classifyExactLocalRecord('Better Auth user', existingUser, {
        email: configuration.email,
        name: configuration.principalDisplayName,
      });
      const credentials = yield* database
        .select({ password: account.password })
        .from(account)
        .where(
          and(
            eq(account.userId, existingUser.id),
            eq(account.providerId, 'credential')
          )
        )
        .limit(2)
        .pipe(
          Effect.mapError(() =>
            failure(
              'local_persistence_failed',
              'The local Better Auth credentials could not be loaded'
            )
          )
        );
      const [credential] = credentials.length === 1 ? credentials : [];
      if (credential?.password === null || credential?.password === undefined) {
        return yield* failure(
          'local_conflict',
          'The existing local user has conflicting credentials'
        );
      }
      const storedPassword = credential.password;
      const validPassword = yield* Effect.tryPromise({
        catch: () =>
          failure(
            'local_persistence_failed',
            'The local Better Auth password could not be verified'
          ),
        try: async () =>
          await verifyPassword({
            hash: storedPassword,
            password: Redacted.value(configuration.password),
          }),
      });
      if (!validPassword) {
        return yield* failure(
          'local_conflict',
          'The existing local user has conflicting credentials'
        );
      }
      return { status: 'existing' as const, userId: existingUser.id };
    }
    const created = yield* Effect.tryPromise({
      catch: () =>
        failure(
          'local_persistence_failed',
          'The local Better Auth user could not be created'
        ),
      try: async () => {
        const authentication = betterAuth({
          baseURL: configuration.authBaseUrl,
          database: adapter,
          emailAndPassword: {
            autoSignIn: false,
            disableSignUp: true,
            enabled: true,
          },
          logger: { disabled: true },
          plugins: [admin()],
          secret: Redacted.value(configuration.authSecret),
        });
        return await authentication.api.createUser({
          body: {
            email: configuration.email,
            name: configuration.principalDisplayName,
            password: Redacted.value(configuration.password),
          },
        });
      },
    });
    return { status: 'created' as const, userId: created.user.id };
  }
);

const reconcileLocalModules = Effect.fn(
  'LocalDevelopment.reconcileLocalModules'
)(function* reconcileModuleStates(
  transaction: CoreTransaction,
  moduleIds: readonly string[]
) {
  const context = LOCAL_DEVELOPMENT_CONTEXT;
  for (const moduleId of moduleIds) {
    const moduleStateId = moduleStateIdFor(moduleId);
    const moduleCandidates = yield* transaction
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
            eq(tenantModuleStates.moduleKey, moduleId)
          )
        )
      )
      .limit(2);
    if (moduleCandidates.length > 1) {
      return yield* failure(
        'local_conflict',
        `The ${moduleId} module-state identity conflicts`
      );
    }
    const expectedModuleState = {
      moduleKey: moduleId,
      state: 'active',
      tenantId: context.tenantId,
      tenantModuleStateId: moduleStateId,
    } as const;
    if (
      (yield* classifyLocalModuleState(
        `${moduleId} module state`,
        moduleCandidates[0],
        expectedModuleState
      )) === 'create'
    ) {
      yield* transaction.insert(tenantModuleStates).values(expectedModuleState);
    }
  }
  return yield* Effect.void;
});

export const reconcileCoreContext = (
  database: CoreDatabaseExecutor,
  authUserId: string,
  moduleIds: readonly string[]
): Effect.Effect<void, LocalDevelopmentInitializationError> =>
  database
    .transaction(
      Effect.fn('LocalDevelopment.reconcileCoreContext')(
        function* reconcileContext(transaction) {
          const context = LOCAL_DEVELOPMENT_CONTEXT;
          const tenantCandidates = yield* transaction
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
                eq(tenants.tenantId, context.tenantId),
                eq(tenants.slug, context.tenantSlug)
              )
            )
            .limit(2);
          if (tenantCandidates.length > 1) {
            return yield* failure(
              'local_conflict',
              'The local tenant identity conflicts'
            );
          }
          const expectedTenant = {
            defaultLocale: context.defaultLocale,
            name: context.tenantName,
            slug: context.tenantSlug,
            status: 'active',
            tenantId: context.tenantId,
          } as const;
          if (
            (yield* classifyExactLocalRecord(
              'tenant',
              tenantCandidates[0],
              expectedTenant
            )) === 'create'
          ) {
            yield* transaction.insert(tenants).values(expectedTenant);
          }

          const legalCandidates = yield* selectBootstrapLegalEntities(
            transaction,
            context
          );
          if (legalCandidates.length > 1) {
            return yield* failure(
              'local_conflict',
              'The local Legal Entity identity conflicts'
            );
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
            (yield* classifyExactLocalRecord(
              'Legal Entity',
              legalCandidates[0],
              expectedLegalEntity
            )) === 'create'
          ) {
            yield* transaction
              .insert(legalEntities)
              .values(expectedLegalEntity);
          }

          const expectedPrincipal = bootstrapPrincipalRecord(context);
          const principalCandidates = yield* selectBootstrapPrincipals(
            transaction,
            context
          );
          if (
            (yield* classifyExactLocalRecord(
              'principal',
              principalCandidates[0],
              expectedPrincipal
            )) === 'create'
          ) {
            yield* transaction.insert(principals).values(expectedPrincipal);
          }

          const bindingCandidates = yield* selectBootstrapAuthBindings(
            transaction,
            context,
            authUserId
          );
          if (bindingCandidates.length > 1) {
            return yield* failure(
              'local_conflict',
              'The local authentication binding conflicts'
            );
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
            (yield* classifyExactLocalRecord(
              'authentication binding',
              bindingCandidates[0],
              expectedBinding
            )) === 'create'
          ) {
            yield* transaction
              .insert(principalAuthBindings)
              .values(expectedBinding);
          }

          yield* reconcileLocalModules(transaction, moduleIds);
          return yield* Effect.void;
        }
      )
    )
    .pipe(
      // Native SQL commit/rollback errors are defects; preserve unrelated defects.
      Effect.catchDefect((defect) =>
        isSqlError(defect) ? Effect.fail(defect) : Effect.die(defect)
      ),
      Effect.catchTag('EffectDrizzleQueryError', () =>
        failure(
          'local_persistence_failed',
          'The local Core context could not be reconciled'
        )
      ),
      Effect.catchTag('SqlError', () =>
        failure(
          'local_persistence_failed',
          'The local Core context could not be reconciled'
        )
      )
    );

const acquireSpiceDbClient = (configuration: LocalDevelopmentConfiguration) =>
  Effect.acquireRelease(
    Effect.try({
      catch: () =>
        failure(
          'local_persistence_failed',
          'The local authorization client could not be created'
        ),
      try: () => {
        const preSharedKey = Redacted.value(configuration.spiceDbPreSharedKey);
        return v1.NewClient(
          preSharedKey,
          configuration.spiceDbEndpoint,
          spiceDbClientSecurity({
            endpoint: configuration.spiceDbEndpoint,
            insecureLocal: configuration.spiceDbInsecureLocal,
          })
        );
      },
    }),
    (client) => Effect.sync(() => client.close())
  );

const touchRelationships = (
  configuration: LocalDevelopmentConfiguration,
  relationships: readonly LocalDevelopmentRelationship[]
): Effect.Effect<void, LocalDevelopmentInitializationError> =>
  Effect.scoped(
    Effect.gen(function* touchLocalRelationships() {
      const client = yield* acquireSpiceDbClient(configuration);
      yield* Effect.tryPromise({
        catch: () =>
          failure(
            'local_persistence_failed',
            'The local authorization relationships could not be reconciled'
          ),
        try: async () => {
          await client.promises.writeRelationships(
            bootstrapRelationshipRequest(relationships)
          );
        },
      });
    })
  );

const loadRootConfiguration = () =>
  Effect.gen(function* loadConfiguration() {
    const fileProvider = yield* ConfigProvider.fromDotEnv({
      path: path.join(import.meta.dirname, '..', '.env'),
    }).pipe(
      Effect.mapError(() =>
        failure('local_configuration_invalid', 'Unable to load app/.env')
      )
    );
    const provider = ConfigProvider.orElse(
      ConfigProvider.fromEnv(),
      fileProvider
    );
    return yield* parseLocalDevelopmentConfigurationFromProvider(provider);
  });

export const initializeLocalDevelopment = (
  environmentEffect?: Effect.Effect<
    LocalDevelopmentEnvironment,
    LocalDevelopmentInitializationError
  >
): Effect.Effect<
  LocalDevelopmentInitializationResult,
  LocalDevelopmentInitializationError,
  NodeServices.NodeServices
> =>
  Effect.gen(function* initialize() {
    const configuration =
      environmentEffect === undefined
        ? yield* loadRootConfiguration()
        : yield* environmentEffect.pipe(
            Effect.flatMap(parseLocalDevelopmentConfiguration)
          );
    const moduleIds = yield* deriveActivatedModuleIds(
      path.join(import.meta.dirname, '..'),
      deriveOntosModuleDeploymentContract,
      LOCAL_DEVELOPMENT_VERTICALS
    );
    const relationships = yield* buildLocalDevelopmentRelationships(moduleIds);
    const authUser = yield* ensureAuthUser(configuration).pipe(
      Effect.provide(
        AuthDatabaseLive.pipe(
          Layer.provide(
            Layer.succeed(AuthConfig, {
              baseUrl: configuration.authBaseUrl,
              connectionString: configuration.databaseAdminUrl,
              secret: Redacted.value(configuration.authSecret),
              secureCookies: false,
              supportUserIds: [],
              trustedOrigins: [configuration.authBaseUrl],
            })
          )
        )
      ),
      Effect.catchTag('AuthDatabaseConnectionError', () =>
        failure(
          'local_persistence_failed',
          'The local authentication database could not be opened'
        )
      )
    );
    const databaseConfiguration = yield* parseDatabaseConfig({
      DATABASE_URL: configuration.databaseAdminUrl,
    }).pipe(
      Effect.mapError(() =>
        failure(
          'local_configuration_invalid',
          'The local Core database configuration is invalid'
        )
      )
    );
    yield* Effect.gen(function* initializeCore() {
      const database = yield* CoreDatabase;
      yield* reconcileCoreContext(
        database.executor,
        authUser.userId,
        moduleIds
      );
    }).pipe(
      Effect.provide(
        CoreDatabaseLive.pipe(
          Layer.provide(Layer.succeed(DatabaseConfig, databaseConfiguration))
        )
      ),
      Effect.catchTag('DatabaseConnectionError', () =>
        failure(
          'local_persistence_failed',
          'The local Core database could not be opened'
        )
      )
    );
    yield* touchRelationships(configuration, relationships);
    return {
      authUser: authUser.status,
      email: configuration.email,
      legalEntityId: LOCAL_DEVELOPMENT_CONTEXT.legalEntityId,
      moduleIds,
      principalId: LOCAL_DEVELOPMENT_CONTEXT.principalId,
      tenantId: LOCAL_DEVELOPMENT_CONTEXT.tenantId,
    };
  });

const runLocalDevelopmentInitialization = Effect.matchEffect(
  initializeLocalDevelopment(),
  {
    onFailure: (error) => Console.error(error.reason).pipe(Effect.as(false)),
    onSuccess: (result) =>
      Console.log(
        `Local development initialized for ${result.email}; auth user ${result.authUser}; ${result.moduleIds.length} module(s) active.`
      ).pipe(Effect.as(true)),
  }
);

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const succeeded = await Effect.runPromise(
    runLocalDevelopmentInitialization.pipe(Effect.provide(NodeServices.layer))
  );
  if (!succeeded) {
    process.exitCode = 1;
  }
}
