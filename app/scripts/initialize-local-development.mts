import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { betterAuth } from 'better-auth';
import { verifyPassword } from 'better-auth/crypto';
import { admin } from 'better-auth/plugins/admin';
import { and, eq, or } from 'drizzle-orm';
import type { Crypto } from 'effect';
import { Config, ConfigProvider, Console, DateTime, Effect, FileSystem, Layer, Path, Redacted, Schema } from 'effect';
import { isSqlError } from 'effect/sql/SqlError';

import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '../packages/core-runtime/src/auth/staff-authentication-namespace.ts';
import { AuthConfig } from '../apps/shell-super-app/api/auth/config.ts';
import { AuthDatabase, AuthDatabaseLive } from '../apps/shell-super-app/api/auth/db/client.ts';
import { account, user } from '../apps/shell-super-app/api/auth/db/schema.ts';
import { CoreDatabase, CoreDatabaseLive } from '../packages/core-runtime/src/db/client.ts';
import {
  DatabaseConfig,
  parseDatabaseConfig,
  parseDatabaseConnectionPair,
} from '../packages/core-runtime/src/db/config.ts';
import type { DatabaseConnectionError } from '../packages/core-runtime/src/db/connection-error.ts';
import { LegalEntityIdSchema, PrincipalIdSchema, TenantIdSchema } from '../packages/core-runtime/src/access/ids.ts';
import {
  legalEntities,
  principalAuthBindings,
  principals,
  tenantModuleStates,
  tenants,
} from '../packages/core-runtime/src/db/schema.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../packages/core-runtime/src/db/types.ts';
import {
  bootstrapPrincipalRecord,
  selectBootstrapLegalEntities,
  selectBootstrapPrincipals,
  selectBootstrapAuthBindings,
} from '../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import { parseSpiceDbConfig } from '../packages/core-runtime/src/permissions/config.ts';
import type { SpiceDbConfigValue } from '../packages/core-runtime/src/permissions/config.ts';
import { TenantAccessBootstrap, TenantAccessBootstrapLive } from '@app/core-runtime/access/bootstrap';
import { AccessChangesStoreLive } from '@app/core-runtime/access/changes/persistence/drizzle-store';
import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '@app/core-runtime/access/compiler/spice-db-compiler';
import { AccessCatalogSnapshotWriterLive } from '@app/core-runtime/access/intent/catalog-snapshot-writer';
import { AccessMembershipStoreLive } from '@app/core-runtime/access/intent/memberships';
import { AccessProjectionCompiler } from '@app/core-runtime/access/intent/projection-compiler';
import { AccessProjectionWriterLive } from '@app/core-runtime/access/intent/projection-writer';
import { TenantIntentLoaderLive } from '@app/core-runtime/access/intent/tenant-intent-loader';
import { AccessWriteJournalStoreLive } from '@app/core-runtime/access/lifecycle/persistence/journal-store';
import { installedModuleKeysOf } from '@app/core-runtime/install/stage-context-bootstrap';
import type { InstallationRuntime } from '@app/core-runtime/install/stage-context-bootstrap';
import { AccessWorkloadBindingIdSchema } from '../packages/core-runtime/src/access/workloads/store.ts';
import { writeWorkloadBindings } from '../packages/core-runtime/src/access/workloads/binding-store.ts';
import { WorkloadKeySchema } from '../packages/core-runtime/src/authorization/access-declaration.ts';
import { stableUuid } from '../packages/core-runtime/src/access/catalog/stable-id.ts';
import { stageScopeOf } from '../packages/core-runtime/src/install/stage-context-bootstrap.ts';
import { readAccessCatalogArtifact } from './authorization-catalog-artifact.mts';
import { deriveOntosModuleDeploymentContract } from './generate-ontos-module-contract.mts';

export interface LocalDevelopmentEnvironment {
  readonly BETTER_AUTH_SECRET?: unknown;
  readonly BETTER_AUTH_URL?: string;
  readonly DATABASE_ADMIN_URL?: string;
  readonly DATABASE_URL?: string;
  readonly SPICEDB_CA_CERT?: string;
  readonly SPICEDB_ENDPOINT?: string;
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
  legalName: 'Local Legal Entity',
  password: localDevelopmentPassword,
  principalDisplayName: 'Local User',
  principalId: '72000000-0000-4000-8000-000000000010',
  registrationCountry: 'CZ',
  registrationNumber: 'LOCAL-0001',
  tenantId: '70000000-0000-4000-8000-000000000010',
  tenantName: 'Local Tenant',
  tenantSlug: 'local',
});

/**
 * The trusted machine workload local development registers (O73). The shared Storefront client starts
 * and claims portal enrollments on a visitor's behalf before any human session exists, so a local
 * tenant needs its principal bound for that key: `commerce.customer-context.{start,claim}-portal-enrollment`
 * name `commerce.storefront-client`, and without the binding the local gate refuses every enrollment.
 */
export const LOCAL_DEVELOPMENT_STOREFRONT_CLIENT = Object.freeze({
  principalDisplayName: 'Local Storefront Client',
  principalId: '72000000-0000-4000-8000-000000000011',
  workloadKey: 'commerce.storefront-client',
});

export const LOCAL_DEVELOPMENT_VERTICALS = Object.freeze([
  'party-registry',
  'commerce-market-catalog',
  'commerce-customer-context',
] as const);

export interface LocalDevelopmentConfiguration {
  readonly authBaseUrl: string;
  readonly authSecret: Redacted.Redacted;
  readonly databaseAdminUrl: string;
  readonly email: string;
  readonly password: Redacted.Redacted;
  readonly principalDisplayName: string;
  readonly spiceDb: SpiceDbConfigValue;
  readonly spiceDbCaCertificate: string;
  readonly spiceDbEndpoint: string;
  readonly spiceDbPreSharedKey: Redacted.Redacted;
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
      'local_owner_dependency_missing',
      'local_persistence_failed',
    ]),
    reason: Schema.String,
  },
) {}

const failure = (
  code: LocalDevelopmentInitializationError['code'],
  reason: string,
): LocalDevelopmentInitializationError => new LocalDevelopmentInitializationError({ code, reason });

export const LOCAL_DEVELOPMENT_OWNER_INITIALIZATION_ORDER = Object.freeze([
  'storefront-registry',
  'commerce-market-catalog',
  'catalog',
  'pricing-currency-support',
  'payment-term-catalog',
  'market-subject-restrictions',
  'customer-commerce-policy',
] as const);

export type LocalDevelopmentOwnerInitializationStep = (typeof LOCAL_DEVELOPMENT_OWNER_INITIALIZATION_ORDER)[number];

export interface LocalDevelopmentOwnerInitializationRequest {
  readonly idempotencyKey: string;
  readonly legalEntityId: string;
  readonly owner: LocalDevelopmentOwnerInitializationStep;
  readonly tenantId: string;
}

export type LocalDevelopmentOwnerReconciler = (
  request: LocalDevelopmentOwnerInitializationRequest,
) => Effect.Effect<void, LocalDevelopmentInitializationError>;

export type LocalDevelopmentOwnerReconcilers = Readonly<
  Partial<Record<LocalDevelopmentOwnerInitializationStep, LocalDevelopmentOwnerReconciler>>
>;

const ownerInitializationRequest = (
  owner: LocalDevelopmentOwnerInitializationStep,
): LocalDevelopmentOwnerInitializationRequest => ({
  idempotencyKey: `ontos-local-owner:${LOCAL_DEVELOPMENT_CONTEXT.tenantId}:${owner}:v1`,
  legalEntityId: LOCAL_DEVELOPMENT_CONTEXT.legalEntityId,
  owner,
  tenantId: LOCAL_DEVELOPMENT_CONTEXT.tenantId,
});

/**
 * Reconciles local owner facts in dependency order through owner-provided entrypoints.
 *
 * Each owner receives a stable idempotency key, so a complete reconciliation can be
 * retried without inventing new facts. Missing entrypoints fail before any dependent
 * owner is invoked; owner-specific adapters remain responsible for mapping their
 * typed failure into LocalDevelopmentInitializationError.
 */
export const initializeLocalDevelopmentOwners = Effect.fn('LocalDevelopment.initializeOwners')(
  function* initializeOwners(
    reconcilers: LocalDevelopmentOwnerReconcilers,
  ): Effect.fn.Return<void, LocalDevelopmentInitializationError> {
    for (const owner of LOCAL_DEVELOPMENT_OWNER_INITIALIZATION_ORDER) {
      const reconcile = reconcilers[owner];
      yield* reconcile === undefined
        ? failure('local_owner_dependency_missing', `The ${owner} local owner reconciler is unavailable`)
        : reconcile(ownerInitializationRequest(owner));
    }
  },
);

const loopbackHosts = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

const validateLoopbackHttpOrigin = (value: string): Effect.Effect<string, LocalDevelopmentInitializationError> => {
  const parsed = URL.parse(value);
  if (
    parsed === null ||
    parsed.protocol !== 'http:' ||
    parsed.origin !== value ||
    !loopbackHosts.has(parsed.hostname)
  ) {
    return Effect.fail(failure('local_configuration_invalid', 'BETTER_AUTH_URL must be an exact local HTTP origin'));
  }
  return Effect.succeed(value);
};

const TrimmedNonEmptyString = Schema.Trim.check(Schema.isNonEmpty());

const localDevelopmentConfigSource = Config.all({
  authBaseUrl: Config.schema(TrimmedNonEmptyString, 'BETTER_AUTH_URL'),
  authSecret: Config.Redacted('BETTER_AUTH_SECRET'),
  databaseAdminUrl: Config.schema(TrimmedNonEmptyString, 'DATABASE_ADMIN_URL'),
  databaseUrl: Config.schema(TrimmedNonEmptyString, 'DATABASE_URL'),
  deploymentEnvironment: Config.schema(Schema.Trim, 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT').pipe(
    Config.withDefault('development'),
  ),
  spiceDbCaCertificate: Config.schema(TrimmedNonEmptyString, 'SPICEDB_CA_CERT'),
  spiceDbEndpoint: Config.schema(TrimmedNonEmptyString, 'SPICEDB_ENDPOINT'),
  spiceDbPreSharedKey: Config.Redacted('SPICEDB_PRESHARED_KEY'),
});

const environmentProvider = (environment: LocalDevelopmentEnvironment) => ConfigProvider.fromUnknown(environment);

const parseLocalDevelopmentConfigurationFromProvider = (provider: ConfigProvider.ConfigProvider) =>
  Effect.gen(function* parseConfiguration() {
    const source = yield* localDevelopmentConfigSource
      .parse(provider)
      .pipe(
        Effect.mapError(() => failure('local_configuration_invalid', 'The local development configuration is invalid')),
      );
    if (source.deploymentEnvironment !== 'development') {
      return yield* failure(
        'local_configuration_invalid',
        'Local initialization can run only in the development environment',
      );
    }
    const authSecret = Redacted.make(Redacted.value(source.authSecret).trim());
    if (Redacted.value(authSecret).length < 32) {
      return yield* failure('local_configuration_invalid', 'BETTER_AUTH_SECRET must contain at least 32 characters');
    }
    const databasePair = yield* parseDatabaseConnectionPair({
      DATABASE_ADMIN_URL: source.databaseAdminUrl,
      DATABASE_URL: source.databaseUrl,
    }).pipe(Effect.mapError((error) => failure('local_configuration_invalid', error.reason)));
    if (!loopbackHosts.has(databasePair.admin.host) || !loopbackHosts.has(databasePair.runtime.host)) {
      return yield* failure('local_configuration_invalid', 'Both PostgreSQL endpoints must be local');
    }
    const spiceDbPreSharedKey = Redacted.make(Redacted.value(source.spiceDbPreSharedKey).trim());
    const spiceDb = yield* parseSpiceDbConfig({
      SPICEDB_CA_CERT: source.spiceDbCaCertificate,
      SPICEDB_ENDPOINT: source.spiceDbEndpoint,
      SPICEDB_PRESHARED_KEY: Redacted.value(spiceDbPreSharedKey),
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: source.deploymentEnvironment,
    }).pipe(Effect.mapError((error) => failure('local_configuration_invalid', error.reason)));
    const parsedSpiceDbEndpoint = URL.parse(`http://${spiceDb.endpoint}`);
    if (parsedSpiceDbEndpoint === null || !loopbackHosts.has(parsedSpiceDbEndpoint.hostname)) {
      return yield* failure('local_configuration_invalid', 'SpiceDB must be a local endpoint');
    }
    const authBaseUrl = yield* validateLoopbackHttpOrigin(source.authBaseUrl);
    return {
      authBaseUrl,
      authSecret,
      databaseAdminUrl: databasePair.admin.connectionString,
      email: LOCAL_DEVELOPMENT_CONTEXT.email,
      password: LOCAL_DEVELOPMENT_CONTEXT.password,
      principalDisplayName: LOCAL_DEVELOPMENT_CONTEXT.principalDisplayName,
      spiceDb,
      spiceDbCaCertificate: source.spiceDbCaCertificate,
      spiceDbEndpoint: spiceDb.endpoint,
      spiceDbPreSharedKey,
    };
  });

export const parseLocalDevelopmentConfiguration = (
  environment: LocalDevelopmentEnvironment,
): Effect.Effect<LocalDevelopmentConfiguration, LocalDevelopmentInitializationError> =>
  parseLocalDevelopmentConfigurationFromProvider(environmentProvider(environment));

export const classifyExactLocalRecord = <Expected extends ExactRecord>(
  label: string,
  existing: ExactRecord | undefined,
  expected: Expected,
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
        `Existing ${label} conflicts with the local development definition (${conflictingFields.join(', ')})`,
      );
    }
    return 'existing' as const;
  });

export const classifyLocalModuleState = (
  label: string,
  existing: ExactRecord | undefined,
  expected: ExactRecord,
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
    }),
  ),
});

type DeriveContract = typeof deriveOntosModuleDeploymentContract;

export const deriveActivatedModuleIds = (
  workspaceRoot: string,
  deriveContract: DeriveContract = deriveOntosModuleDeploymentContract,
  activatedVerticals: readonly string[] = LOCAL_DEVELOPMENT_VERTICALS,
) =>
  Effect.gen(function* deriveModuleIds() {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const topologySource = yield* fileSystem
      .readFileString(pathService.join(workspaceRoot, 'topology/reference-topology.json'))
      .pipe(Effect.mapError(() => failure('local_contract_invalid', 'The authoritative topology could not be read')));
    const topology = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TopologySchema))(topologySource).pipe(
      Effect.mapError(() => failure('local_contract_invalid', 'The authoritative topology is invalid')),
    );
    if (topology.verticals.length === 0) {
      return yield* failure('local_contract_invalid', 'The authoritative topology has no MicroVerticals');
    }
    const verticals = topology.verticals.map(({ id }) => id);
    if (new Set(verticals).size !== verticals.length) {
      return yield* failure('local_contract_invalid', 'The authoritative topology has duplicate verticals');
    }
    if (new Set(activatedVerticals).size !== activatedVerticals.length) {
      return yield* failure('local_contract_invalid', 'Local activation contains duplicate MicroVerticals');
    }
    const missingVerticals = activatedVerticals.filter((vertical) => !verticals.includes(vertical));
    if (missingVerticals.length > 0) {
      return yield* failure(
        'local_contract_invalid',
        `Configured local MicroVerticals are missing from the topology (${missingVerticals.join(', ')})`,
      );
    }
    const contracts = yield* Effect.forEach(
      activatedVerticals,
      (vertical) =>
        deriveContract({ vertical, workspaceRoot }).pipe(
          Effect.mapError(() =>
            failure('local_contract_invalid', `The ${vertical} deployment contract could not be derived`),
          ),
        ),
      { concurrency: 'unbounded' },
    );
    const moduleIds = contracts.map((contract) => contract.manifest.module.id);
    if (new Set(moduleIds).size !== moduleIds.length) {
      return yield* failure('local_contract_invalid', 'Generated contracts contain duplicate module IDs');
    }
    const sortedModuleIds: string[] = [];
    for (const moduleId of moduleIds) {
      const insertionIndex = sortedModuleIds.findIndex((existing) => moduleId.localeCompare(existing) < 0);
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

const ensureAuthUser = Effect.fn('LocalDevelopment.ensureAuthUser')(function* ensureAuthUserEffect(
  configuration: LocalDevelopmentConfiguration,
) {
  const { adapter, executor: database } = yield* AuthDatabase;
  const existingUsers = yield* database
    .select({ email: user.email, id: user.id, name: user.name })
    .from(user)
    .where(eq(user.email, configuration.email))
    .limit(2)
    .pipe(Effect.mapError(() => failure('local_persistence_failed', 'The local Better Auth user could not be loaded')));
  if (existingUsers.length > 1) {
    return yield* failure('local_conflict', 'Multiple Better Auth users use the local email');
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
      .where(and(eq(account.userId, existingUser.id), eq(account.providerId, 'credential')))
      .limit(2)
      .pipe(
        Effect.mapError(() =>
          failure('local_persistence_failed', 'The local Better Auth credentials could not be loaded'),
        ),
      );
    const [credential] = credentials.length === 1 ? credentials : [];
    if (credential?.password === null || credential?.password === undefined) {
      return yield* failure('local_conflict', 'The existing local user has conflicting credentials');
    }
    const storedPassword = credential.password;
    const validPassword = yield* Effect.tryPromise({
      catch: () => failure('local_persistence_failed', 'The local Better Auth password could not be verified'),
      try: async () =>
        await verifyPassword({
          hash: storedPassword,
          password: Redacted.value(configuration.password),
        }),
    });
    if (!validPassword) {
      return yield* failure('local_conflict', 'The existing local user has conflicting credentials');
    }
    return { status: 'existing' as const, userId: existingUser.id };
  }
  const created = yield* Effect.tryPromise({
    catch: () => failure('local_persistence_failed', 'The local Better Auth user could not be created'),
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
});

const reconcileLocalModules = Effect.fn('LocalDevelopment.reconcileLocalModules')(function* reconcileModuleStates(
  transaction: CoreTransaction,
  installedModuleKeys: readonly string[],
) {
  const context = LOCAL_DEVELOPMENT_CONTEXT;
  for (const moduleId of installedModuleKeys) {
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
          and(eq(tenantModuleStates.tenantId, context.tenantId), eq(tenantModuleStates.moduleKey, moduleId)),
        ),
      )
      .limit(2);
    if (moduleCandidates.length > 1) {
      return yield* failure('local_conflict', `The ${moduleId} module-state identity conflicts`);
    }
    const expectedModuleState = {
      moduleKey: moduleId,
      state: 'active',
      tenantId: context.tenantId,
      tenantModuleStateId: moduleStateId,
    } as const;
    if (
      (yield* classifyLocalModuleState(`${moduleId} module state`, moduleCandidates[0], expectedModuleState)) ===
      'create'
    ) {
      yield* transaction.insert(tenantModuleStates).values(expectedModuleState);
    }
  }
  return yield* Effect.void;
});

export const reconcileCoreContext = (
  database: CoreDatabaseExecutor,
  authUserId: string,
  installedModuleKeys: readonly string[],
): Effect.Effect<void, LocalDevelopmentInitializationError> =>
  database
    .transaction(
      Effect.fn('LocalDevelopment.reconcileCoreContext')(function* reconcileContext(transaction) {
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
          .where(or(eq(tenants.tenantId, context.tenantId), eq(tenants.slug, context.tenantSlug)))
          .limit(2);
        if (tenantCandidates.length > 1) {
          return yield* failure('local_conflict', 'The local tenant identity conflicts');
        }
        const expectedTenant = {
          defaultLocale: context.defaultLocale,
          name: context.tenantName,
          slug: context.tenantSlug,
          status: 'active',
          tenantId: context.tenantId,
        } as const;
        if ((yield* classifyExactLocalRecord('tenant', tenantCandidates[0], expectedTenant)) === 'create') {
          yield* transaction.insert(tenants).values(expectedTenant);
        }

        const legalCandidates = yield* selectBootstrapLegalEntities(transaction, context);
        if (legalCandidates.length > 1) {
          return yield* failure('local_conflict', 'The local Legal Entity identity conflicts');
        }
        const expectedLegalEntity = {
          legalEntityId: context.legalEntityId,
          legalName: context.legalName,
          registrationCountry: context.registrationCountry,
          registrationNumber: context.registrationNumber,
          status: 'active',
          tenantId: context.tenantId,
        } as const;
        if ((yield* classifyExactLocalRecord('Legal Entity', legalCandidates[0], expectedLegalEntity)) === 'create') {
          yield* transaction.insert(legalEntities).values(expectedLegalEntity);
        }

        const expectedPrincipal = bootstrapPrincipalRecord(context);
        const principalCandidates = yield* selectBootstrapPrincipals(transaction, context);
        if ((yield* classifyExactLocalRecord('principal', principalCandidates[0], expectedPrincipal)) === 'create') {
          yield* transaction.insert(principals).values(expectedPrincipal);
        }

        // The local storefront-client workload principal (O73): a service identity of this tenant whose
        // registered workload the gate admits on the portal-enrollment carriers.
        const storefrontClient = LOCAL_DEVELOPMENT_STOREFRONT_CLIENT;
        const workloadCandidates = yield* transaction
          .select({ kind: principals.kind, status: principals.status, tenantId: principals.tenantId })
          .from(principals)
          .where(eq(principals.principalId, storefrontClient.principalId))
          .limit(1);
        const expectedWorkloadPrincipal = {
          kind: 'service' as const,
          status: 'active' as const,
          tenantId: context.tenantId,
        };
        if (
          (yield* classifyExactLocalRecord('workload principal', workloadCandidates[0], expectedWorkloadPrincipal)) ===
          'create'
        ) {
          yield* transaction.insert(principals).values({
            displayName: storefrontClient.principalDisplayName,
            kind: 'service',
            principalId: storefrontClient.principalId,
            status: 'active',
            tenantId: context.tenantId,
          });
        }

        const bindingCandidates = yield* selectBootstrapAuthBindings(
          transaction,
          context,
          authUserId,
          STAFF_AUTHENTICATION_NAMESPACE_ID,
        );
        if (bindingCandidates.length > 1) {
          return yield* failure('local_conflict', 'The local authentication binding conflicts');
        }
        const expectedBinding = {
          authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
          principalAuthBindingId: context.authBindingId,
          principalId: context.principalId,
          provider: 'better_auth',
          providerSubjectId: authUserId,
          status: 'active',
          subjectType: 'user',
          tenantId: context.tenantId,
        } as const;
        if (
          (yield* classifyExactLocalRecord('authentication binding', bindingCandidates[0], expectedBinding)) ===
          'create'
        ) {
          yield* transaction.insert(principalAuthBindings).values(expectedBinding);
        }

        yield* reconcileLocalModules(transaction, installedModuleKeys);
        return yield* Effect.void;
      }),
    )
    .pipe(
      // Native SQL commit/rollback errors are defects; preserve unrelated defects.
      Effect.catchDefect((defect) => (isSqlError(defect) ? Effect.fail(defect) : Effect.die(defect))),
      Effect.catchTag('EffectDrizzleQueryError', () =>
        failure('local_persistence_failed', 'The local Core context could not be reconciled'),
      ),
      Effect.catchTag('SqlError', () =>
        failure('local_persistence_failed', 'The local Core context could not be reconciled'),
      ),
    );

const loadRootConfiguration = () =>
  Effect.gen(function* loadConfiguration() {
    const fileProvider = yield* ConfigProvider.fromDotEnv({
      path: path.join(import.meta.dirname, '..', '.env'),
    }).pipe(Effect.mapError(() => failure('local_configuration_invalid', 'Unable to load app/.env')));
    const provider = ConfigProvider.orElse(ConfigProvider.fromEnv(), fileProvider);
    return yield* parseLocalDevelopmentConfigurationFromProvider(provider);
  });

/**
 * The installation runtime of this root: the engine transport of the local SpiceDB and the six access
 * writers over the local Core database. `apps/shell-super-app/scripts/bootstrap-stage-accounts.mts`
 * composes the same layer for stage, because each process root owns its own transport and pool.
 */
const localInstallationRuntime = (
  databaseLayers: Layer.Layer<CoreDatabase, DatabaseConnectionError>,
  spiceDb: SpiceDbConfigValue,
): Layer.Layer<InstallationRuntime, DatabaseConnectionError, Crypto.Crypto> => {
  // The engine transport belongs to this run: it is opened with the layer and closed when the run ends.
  const engine = Layer.effect(
    AccessProjectionCompiler,
    Effect.acquireRelease(
      Effect.sync(() => makeAccessProjectionTransport(spiceDb)),
      (transport) => Effect.sync(() => transport.close()),
    ).pipe(Effect.map((transport) => makeAccessProjectionCompiler(transport))),
  );
  const memberships = AccessMembershipStoreLive;
  // A database that cannot be opened is a defect of this seed run, not a decision of the bootstrap.
  const platform = Layer.mergeAll(databaseLayers, engine);
  const stores = Layer.mergeAll(
    TenantIntentLoaderLive,
    AccessWriteJournalStoreLive,
    AccessChangesStoreLive,
    memberships,
  ).pipe(Layer.provide(platform));
  const catalog = AccessCatalogSnapshotWriterLive.pipe(Layer.provide(stores));
  const writer = AccessProjectionWriterLive.pipe(Layer.provide(Layer.mergeAll(stores, platform)));
  const bootstrap = TenantAccessBootstrapLive.pipe(Layer.provide(Layer.mergeAll(stores, platform, catalog, writer)));
  return Layer.mergeAll(bootstrap, writer, catalog, stores, platform) satisfies Layer.Layer<
    InstallationRuntime,
    DatabaseConnectionError,
    Crypto.Crypto
  >;
};

export const initializeLocalDevelopment = (
  environmentEffect?: Effect.Effect<LocalDevelopmentEnvironment, LocalDevelopmentInitializationError>,
): Effect.Effect<
  LocalDevelopmentInitializationResult,
  LocalDevelopmentInitializationError,
  NodeServices.NodeServices
> =>
  Effect.gen(function* initialize() {
    const configuration =
      environmentEffect === undefined
        ? yield* loadRootConfiguration()
        : yield* environmentEffect.pipe(Effect.flatMap(parseLocalDevelopmentConfiguration));
    const workspaceRoot = path.join(import.meta.dirname, '..');
    const moduleIds = yield* deriveActivatedModuleIds(
      workspaceRoot,
      deriveOntosModuleDeploymentContract,
      LOCAL_DEVELOPMENT_VERTICALS,
    );
    // The declarations of the whole composition (O69): a tenant's release is compiled from them, and a
    // release without the governed reads would leave the local user unable to read anything. The set is
    // the pinned catalog artifact, so this process root never scans source code; the drift check keeps it
    // current with the declarations in the tree.
    const accessModules = yield* readAccessCatalogArtifact(workspaceRoot).pipe(
      Effect.mapError(() => failure('local_contract_invalid', 'The pinned access catalog artifact could not be read')),
    );
    const installedModuleKeys = installedModuleKeysOf(moduleIds, accessModules);
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
            }),
          ),
        ),
      ),
      Effect.catchTag('AuthDatabaseConnectionError', () =>
        failure('local_persistence_failed', 'The local authentication database could not be opened'),
      ),
    );
    const databaseConfiguration = yield* parseDatabaseConfig({
      DATABASE_URL: configuration.databaseAdminUrl,
    }).pipe(
      Effect.mapError(() => failure('local_configuration_invalid', 'The local Core database configuration is invalid')),
    );
    const databaseLayers = CoreDatabaseLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, databaseConfiguration)));
    yield* Effect.gen(function* initializeCore() {
      const database = yield* CoreDatabase;
      yield* reconcileCoreContext(database.executor, authUser.userId, installedModuleKeys);
      // One bootstrap of the local tenant: its scopes, its owner's memberships, the release and the role
      // "Plný přístup" — projected by the single Core writer, which is what the local gate reads.
      const scope = yield* stageScopeOf({
        principalId: LOCAL_DEVELOPMENT_CONTEXT.principalId,
        tenantId: LOCAL_DEVELOPMENT_CONTEXT.tenantId,
      }).pipe(Effect.mapError((error) => failure('local_contract_invalid', error.reason)));
      const bootstrap = yield* TenantAccessBootstrap;
      yield* bootstrap
        .bootstrapTenantAccess({
          legalEntityIds: [LegalEntityIdSchema.make(LOCAL_DEVELOPMENT_CONTEXT.legalEntityId)],
          modules: accessModules,
          scope,
        })
        .pipe(Effect.mapError((error) => failure('local_persistence_failed', `${error.code}: ${error.reason}`)));
      // The operator-declared workload of the local tenant: the shared Storefront client, registered
      // through Core's own registry so the gate admits it on the portal-enrollment carriers (O73).
      const storefrontClient = LOCAL_DEVELOPMENT_STOREFRONT_CLIENT;
      yield* writeWorkloadBindings(database, scope, {
        bindings: [
          {
            bindingId: AccessWorkloadBindingIdSchema.make(
              stableUuid(
                [
                  'ontos.local.workload-binding',
                  LOCAL_DEVELOPMENT_CONTEXT.tenantId,
                  storefrontClient.principalId,
                  storefrontClient.workloadKey,
                ].join(':'),
              ),
            ),
            createdAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
            incarnation: AccessWorkloadBindingIdSchema.make(
              stableUuid(
                [
                  'ontos.local.workload-incarnation',
                  LOCAL_DEVELOPMENT_CONTEXT.tenantId,
                  storefrontClient.principalId,
                  storefrontClient.workloadKey,
                ].join(':'),
              ),
            ),
            principalId: PrincipalIdSchema.make(storefrontClient.principalId),
            tenantId: TenantIdSchema.make(LOCAL_DEVELOPMENT_CONTEXT.tenantId),
            workloadKey: WorkloadKeySchema.make(storefrontClient.workloadKey),
          },
        ],
      }).pipe(Effect.mapError((error) => failure('local_persistence_failed', `${error.code}: ${error.reason}`)));
    }).pipe(
      Effect.provide(localInstallationRuntime(databaseLayers, configuration.spiceDb)),
      // A pool that cannot be opened is this seed's failure, reported with the reason it recorded.
      Effect.catchTag('DatabaseConnectionError', () =>
        failure('local_persistence_failed', 'The local Core database could not be opened'),
      ),
    );
    return {
      authUser: authUser.status,
      email: configuration.email,
      legalEntityId: LOCAL_DEVELOPMENT_CONTEXT.legalEntityId,
      moduleIds,
      principalId: LOCAL_DEVELOPMENT_CONTEXT.principalId,
      tenantId: LOCAL_DEVELOPMENT_CONTEXT.tenantId,
    };
  });

const runLocalDevelopmentInitialization = Effect.matchEffect(initializeLocalDevelopment(), {
  onFailure: (error) => Console.error(error.reason).pipe(Effect.as(false)),
  onSuccess: (result) =>
    Console.log(
      `Local development initialized for ${result.email}; auth user ${result.authUser}; ${result.moduleIds.length} module(s) active.`,
    ).pipe(Effect.as(true)),
});

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const succeeded = await Effect.runPromise(runLocalDevelopmentInitialization.pipe(Effect.provide(NodeServices.layer)));
  if (!succeeded) {
    process.exitCode = 1;
  }
}
