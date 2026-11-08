import { and, eq, ne, or } from 'drizzle-orm';
import { Config, DateTime, Effect, Option, Redacted, Schema } from 'effect';
import { isSqlError } from 'effect/sql/SqlError';

import { TenantAccessBootstrap } from '../access/bootstrap/bootstrap-tenant-access.ts';
import { stableUuid } from '../access/catalog/stable-id.ts';
import { LegalEntityIdSchema, PrincipalIdSchema } from '../access/ids.ts';
import { AccessMembershipStore } from '../access/intent/memberships.ts';
import { AccessProjectionWriter } from '../access/intent/projection-writer.ts';
import { AccessWorkloadBindingIdSchema } from '../access/workloads/store.ts';
import { writeWorkloadBindings } from '../access/workloads/binding-store.ts';
import { WorkloadKeySchema } from '../authorization/access-declaration.ts';
import { TrustedPrincipalContextSchema } from '../actions/principal-context.ts';
import type { AccessCatalogModule } from '../authorization/access-declaration.ts';
// The installation run owns the runtime connection: every scope it installs is a session-setting one.
import { CoreDatabase } from '../db/client.ts';
import { parseDatabaseConfig } from '../db/config.ts';
import { DatabaseIdentityEnrollmentContext } from '../db/database-identities.ts';
import type { DatabaseIdentityEnrollment } from '../db/database-identities.ts';
import {
  accessAssignments,
  accessMemberships,
  legalEntities,
  principalAuthBindings,
  principals,
  tenantModuleStates,
  tenants,
} from '../db/schema.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../db/types.ts';
import { installOperationalScope } from '../db/scoped-transaction.ts';
import type { OperationalScope } from '../operations/context.ts';
import { parseSpiceDbConfig } from '../permissions/config.ts';
import type { SpiceDbConfigValue } from '../permissions/config.ts';
import { installedModuleKeysOf } from './installation-runtime.ts';
import type { InstallationRuntime } from './installation-runtime.ts';
import {
  bootstrapPrincipalRecord,
  selectBootstrapAuthBindings,
  selectBootstrapLegalEntities,
  selectBootstrapPrincipals,
} from './context-bootstrap-shared.ts';
import {
  STAGE_ACCOUNT_ROLE_FULL_ACCESS,
  recordStageHolderMemberships,
  stageHolderOf,
  writeStageAssignments,
} from './stage-access-holders.ts';
import type { StageAccountRole, StageAccountsFile, StageRetiredTenant } from './stage-accounts-file.ts';

/*
 * The stage bootstrap of authorization v2 (CUTOVER-PLAN §3.5, ADR-0028, O67-Q6). A stage tenant is
 * created the way a product tenant is: its identity rows first (tenant, company, principals, Better Auth
 * bindings, module states), then `bootstrapTenantAccess`, which gives it its scopes, its owner's
 * memberships, the release of its installed modules and the role "Plný přístup" assigned to the owner in
 * every scope, and finally one reconcile through the single Core writer — the only path that projects
 * tuples out of that intent.
 *
 * Nothing here writes a SpiceDB relationship and nothing assigns rights by account kind: the operator
 * accounts file names, as data, which account owns the tenant and which further accounts hold
 * `full_access`. The legacy `member`/`module_access`/`party_identity_*` grants are gone with the schema
 * that defined them (O62), so a stage tenant's authority is exactly its role assignments.
 *
 * A retired tenant ends the intent that carried its authority — its memberships and assignments are
 * revoked in PostgreSQL — and is reconciled, so its projected tuples go with it. Archiving identity rows
 * alone would leave a graph that still answers.
 */

export { installedModuleKeysOf } from './installation-runtime.ts';
export type { InstallationRuntime } from './installation-runtime.ts';

/** The identity rows one stage tenant needs before its access can be bootstrapped. */
export interface StageTenantIdentity {
  readonly defaultLocale: string;
  readonly displayName: string;
  readonly legalEntity: {
    readonly legalEntityId: string;
    readonly legalName: string;
    readonly registrationCountry: string;
    readonly registrationNumber: string;
  };
  readonly moduleKey: string;
  readonly moduleStateId: string;
  readonly slug: string;
  readonly tenantId: string;
  /** The registered workloads the operator declared for this tenant (O73); absent means none. */
  readonly workloads?: readonly { readonly principalId: string; readonly workloadKey: string }[];
}

/** One stage account: the person, the Better Auth user that signs in as it, and its v2 authority. */
export interface StageAccountIdentity {
  readonly authBindingId: string;
  readonly displayName: string;
  readonly owner: boolean;
  readonly principalId: string;
  readonly providerUserId: string;
  readonly roles: readonly StageAccountRole[];
}

export interface StageTenantBootstrap {
  readonly accounts: readonly StageAccountIdentity[];
  readonly tenant: StageTenantIdentity;
}

export interface StageContextBootstrapResult {
  readonly legalEntityId: string;
  readonly owner: boolean;
  readonly principalId: string;
  readonly roles: readonly StageAccountRole[];
  readonly tenantId: string;
}

export interface StageContextBootstrapOptions {
  /** A validated deployment registration value supplied by Shell composition. */
  readonly authenticationNamespaceId: string;
  /**
   * The declarations of every module the running composition serves (O69). A new tenant's release is
   * compiled from them, so a stage run receives them explicitly rather than Core reading a repository.
   */
  readonly modules: readonly AccessCatalogModule[];
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

/** What a stage run needs before it writes anything: its runtime database and its private engine. */
export interface StageContextBootstrapConfiguration {
  readonly databaseUrl: Redacted.Redacted;
  readonly spiceDb: Redacted.Redacted<SpiceDbConfigValue>;
}

/**
 * Reads and validates the stage bootstrap's configuration. It is an operator action: it refuses to run
 * anywhere but stage, and only against stage-private SpiceDB (ADR-0028).
 *
 * The installation run connects with the runtime identity (`DATABASE_URL`), not the administrative one:
 * every scope it installs is a session-setting scope, which the enrollment it is handed must name, and
 * the identity rows it writes are the shared runtime's own. The administrative connection stays with the
 * migrator and the Better Auth store, which need privileges the access runtime never holds.
 */
export const loadStageContextBootstrapConfiguration = Effect.fn('StageContextBootstrap.loadConfiguration')(
  function* loadStageContextBootstrapConfiguration() {
    const source = yield* Effect.all(
      {
        databaseUrl: Config.schema(Schema.Redacted(TrimmedNonEmptyString), 'DATABASE_URL').pipe(
          Effect.mapError((cause) => failure('DATABASE_URL is required', cause)),
        ),
        deploymentEnvironment: Config.schema(StageEnvironmentSchema, 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT').pipe(
          Effect.mapError((cause) => failure('The Core installation bootstrap can run only in stage', cause)),
        ),
        spiceDbCaCertificate: Config.schema(TrimmedNonEmptyString, 'SPICEDB_CA_CERT').pipe(
          Effect.mapError((cause) => failure('SPICEDB_CA_CERT is required', cause)),
        ),
        spiceDbEndpoint: Config.schema(TrimmedNonEmptyString, 'SPICEDB_ENDPOINT').pipe(
          Effect.mapError((cause) => failure('SPICEDB_ENDPOINT is required', cause)),
        ),
        spiceDbPreSharedKey: Config.Redacted('SPICEDB_PRESHARED_KEY').pipe(
          Effect.mapError((cause) => failure('SPICEDB_PRESHARED_KEY is required', cause)),
        ),
      },
      { concurrency: 5 },
    );
    yield* parseDatabaseConfig({
      DATABASE_URL: Redacted.value(source.databaseUrl),
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
    return { databaseUrl: source.databaseUrl, spiceDb: Redacted.make(spiceDb) };
  },
);

/**
 * One trusted request scope for an installation run: the acting person, the tenant and, when given, the
 * selected company (O66). A bootstrap never trusts a tenant from a command body.
 */
export const stageScopeOf = (input: {
  readonly legalEntityId?: string;
  readonly principalId: string;
  readonly tenantId: string;
}): Effect.Effect<OperationalScope, StageContextBootstrapError> => {
  // The installer is an operator session of its own: one derived binding per tenant and person, so a
  // re-run names the same session identity instead of inventing a new one every time.
  const session = {
    authBindingId: stableUuid(`ontos.stage.bootstrap.scope:${input.tenantId}:${input.principalId}`),
    authContextRef: `stage-bootstrap:${input.tenantId}:${input.principalId}`,
    authMethod: 'session' as const,
    principalId: input.principalId,
    tenantId: input.tenantId,
  };
  const context = input.legalEntityId === undefined ? session : { ...session, legalEntityId: input.legalEntityId };
  return Schema.decodeEffect(TrustedPrincipalContextSchema)(context).pipe(
    Effect.map((scope) => ({ ...scope, correlationId: 'stage-context-bootstrap' }) satisfies OperationalScope),
    Effect.mapError((cause) => failure('The stage bootstrap scope is invalid', cause)),
  );
};

/** An operator may install only a base module that the trusted composition actually declares. */
export const stageModuleIntentRefusal = (
  moduleKeys: readonly string[],
  modules: readonly AccessCatalogModule[],
): StageContextBootstrapError | undefined => {
  const declared = new Set(modules.map(({ moduleId }) => moduleId));
  return moduleKeys.some((moduleKey) => !declared.has(moduleKey))
    ? failure('Every stage base module must be explicitly declared by the running composition')
    : undefined;
};

/** The stage tenants of one operator accounts file, each account paired with its Better Auth user. */
export const stageTenantsFromAccountsFile = Effect.fn('StageContextBootstrap.stageTenantsFromAccountsFile')(
  function* stageTenantsFromAccountsFileEffect(
    file: StageAccountsFile,
    providerUserIds: ReadonlyMap<string, string>,
    modules: readonly AccessCatalogModule[],
  ): Effect.fn.Return<readonly StageTenantBootstrap[], StageContextBootstrapError> {
    const refusal = stageModuleIntentRefusal(
      file.tenants.map(({ moduleKey }) => moduleKey),
      modules,
    );
    if (refusal !== undefined) {
      return yield* refusal;
    }
    const accounts = file.tenants.flatMap(({ accounts: tenantAccounts }) => tenantAccounts);
    const missingUser = accounts.some(({ principalId }) => !providerUserIds.has(principalId));
    if (missingUser) {
      return yield* failure('Every stage account needs the Better Auth user it signs in as');
    }
    return file.tenants.map((tenant): StageTenantBootstrap => {
      const tenantIdentity: StageTenantIdentity = {
        defaultLocale: tenant.defaultLocale,
        displayName: tenant.displayName,
        legalEntity: {
          legalEntityId: tenant.legalEntity.legalEntityId,
          legalName: tenant.legalEntity.legalName,
          registrationCountry: tenant.legalEntity.registrationCountry,
          registrationNumber: tenant.legalEntity.registrationNumber,
        },
        moduleKey: tenant.moduleKey,
        moduleStateId: tenant.moduleStateId,
        slug: tenant.slug,
        tenantId: tenant.tenantId,
      };
      return {
        accounts: tenant.accounts.map((account) => ({
          authBindingId: account.authBindingId,
          displayName: account.displayName,
          owner: account.grants.owner,
          principalId: account.principalId,
          providerUserId: providerUserIds.get(account.principalId) ?? '',
          roles: account.grants.roles,
        })),
        tenant: tenant.workloads === undefined ? tenantIdentity : { ...tenantIdentity, workloads: tenant.workloads },
      };
    });
  },
);

type Comparable = boolean | null | number | string;
type ExactRecord = Readonly<Record<string, Comparable>>;

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

/** The identity of one account as the shared bootstrap reads and writes it. */
const bootstrapIdentityOf = (tenant: StageTenantIdentity, account: StageAccountIdentity) => ({
  authBindingId: account.authBindingId,
  legalEntityId: tenant.legalEntity.legalEntityId,
  legalName: tenant.legalEntity.legalName,
  principalDisplayName: account.displayName,
  principalId: account.principalId,
  registrationCountry: tenant.legalEntity.registrationCountry,
  registrationNumber: tenant.legalEntity.registrationNumber,
  tenantId: tenant.tenantId,
});

/** A module state id derived from what it names, so a re-run resumes the row it wrote (D27). */
const stageModuleStateIdFor = (tenantId: string, moduleKey: string): string =>
  stableUuid(`ontos.stage.module-state:${tenantId}:${moduleKey}`);

/**
 * One module state per module the tenant installs. The id of the tenant's own module is the operator's,
 * so a promotion from the legacy bootstrap keeps the row it created; Core's modules get an id derived
 * from the tenant and the module, which a re-run resumes instead of adding a second row.
 */
const reconcileModuleState = Effect.fn('StageContextBootstrap.reconcileModuleState')(
  function* reconcileModuleStateEffect(
    transaction: CoreTransaction,
    tenant: StageTenantIdentity,
    moduleKey: string,
  ): Effect.fn.Return<void, StageContextBootstrapError> {
    const moduleStateId =
      moduleKey === tenant.moduleKey ? tenant.moduleStateId : stageModuleStateIdFor(tenant.tenantId, moduleKey);
    const candidates = yield* transaction
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
          and(eq(tenantModuleStates.tenantId, tenant.tenantId), eq(tenantModuleStates.moduleKey, moduleKey)),
        ),
      )
      .limit(2)
      .pipe(Effect.mapError(bootstrapFailureFromCause));
    if (candidates.length > 1) {
      return yield* failure('The stage module-state identity conflicts');
    }
    const expected = {
      moduleKey,
      state: 'active',
      tenantId: tenant.tenantId,
      tenantModuleStateId: moduleStateId,
    } as const;
    if ((yield* classifyExactRecord('module state', candidates[0], expected)) === 'create') {
      yield* transaction.insert(tenantModuleStates).values(expected).pipe(Effect.mapError(bootstrapFailureFromCause));
    }
    return yield* Effect.void;
  },
);

/** The account identity rows one tenant needs: principal, Better Auth binding and its own module state. */
const reconcileTenantAccount = Effect.fn('StageContextBootstrap.reconcileTenantAccount')(
  function* reconcileTenantAccountEffect(
    transaction: CoreTransaction,
    tenant: StageTenantIdentity,
    account: StageAccountIdentity,
    authenticationNamespaceId: string,
  ): Effect.fn.Return<void, StageContextBootstrapError> {
    const identity = bootstrapIdentityOf(tenant, account);
    const principalCandidates = yield* selectBootstrapPrincipals(transaction, identity).pipe(
      Effect.mapError(bootstrapFailureFromCause),
    );
    const expectedPrincipal = bootstrapPrincipalRecord(identity);
    if ((yield* classifyExactRecord('principal', principalCandidates[0], expectedPrincipal)) === 'create') {
      yield* transaction.insert(principals).values(expectedPrincipal).pipe(Effect.mapError(bootstrapFailureFromCause));
    }
    const bindingCandidates = yield* selectBootstrapAuthBindings(
      transaction,
      identity,
      account.providerUserId,
      authenticationNamespaceId,
    ).pipe(Effect.mapError(bootstrapFailureFromCause));
    if (bindingCandidates.length > 1) {
      return yield* failure('The stage authentication binding conflicts');
    }
    const expectedBinding = {
      authenticationNamespaceId,
      principalAuthBindingId: account.authBindingId,
      principalId: account.principalId,
      provider: 'better_auth',
      providerSubjectId: account.providerUserId,
      status: 'active',
      subjectType: 'user',
      tenantId: tenant.tenantId,
    } as const;
    if ((yield* classifyExactRecord('authentication binding', bindingCandidates[0], expectedBinding)) === 'create') {
      yield* transaction
        .insert(principalAuthBindings)
        .values(expectedBinding)
        .pipe(Effect.mapError(bootstrapFailureFromCause));
    }
    return yield* Effect.void;
  },
);

const reconcileTenantIdentity = Effect.fn('StageContextBootstrap.reconcileTenantIdentity')(
  function* reconcileTenantIdentityEffect(
    transaction: CoreTransaction,
    input: {
      readonly accounts: readonly StageAccountIdentity[];
      readonly installedModuleKeys: readonly string[];
      readonly tenant: StageTenantIdentity;
    },
    authenticationNamespaceId: string,
  ): Effect.fn.Return<void, StageContextBootstrapError> {
    const { tenant } = input;
    const tenantCandidates = yield* transaction
      .select({
        defaultLocale: tenants.defaultLocale,
        name: tenants.name,
        slug: tenants.slug,
        status: tenants.status,
        tenantId: tenants.tenantId,
      })
      .from(tenants)
      .where(or(eq(tenants.tenantId, tenant.tenantId), eq(tenants.slug, tenant.slug)))
      .limit(2)
      .pipe(Effect.mapError(bootstrapFailureFromCause));
    if (tenantCandidates.length > 1) {
      return yield* failure('The stage tenant identity conflicts');
    }
    const expectedTenant = {
      defaultLocale: tenant.defaultLocale,
      name: tenant.displayName,
      slug: tenant.slug,
      status: 'active',
      tenantId: tenant.tenantId,
    } as const;
    if ((yield* classifyExactRecord('tenant', tenantCandidates[0], expectedTenant)) === 'create') {
      yield* transaction.insert(tenants).values(expectedTenant).pipe(Effect.mapError(bootstrapFailureFromCause));
    }
    const legalEntityCandidates = yield* selectBootstrapLegalEntities(transaction, {
      authBindingId: '',
      legalEntityId: tenant.legalEntity.legalEntityId,
      legalName: tenant.legalEntity.legalName,
      principalDisplayName: '',
      principalId: '',
      registrationCountry: tenant.legalEntity.registrationCountry,
      registrationNumber: tenant.legalEntity.registrationNumber,
      tenantId: tenant.tenantId,
    }).pipe(Effect.mapError(bootstrapFailureFromCause));
    if (legalEntityCandidates.length > 1) {
      return yield* failure('The stage legal-entity identity conflicts');
    }
    const expectedLegalEntity = {
      legalEntityId: tenant.legalEntity.legalEntityId,
      legalName: tenant.legalEntity.legalName,
      registrationCountry: tenant.legalEntity.registrationCountry,
      registrationNumber: tenant.legalEntity.registrationNumber,
      status: 'active',
      tenantId: tenant.tenantId,
    } as const;
    if ((yield* classifyExactRecord('legal entity', legalEntityCandidates[0], expectedLegalEntity)) === 'create') {
      yield* transaction
        .insert(legalEntities)
        .values(expectedLegalEntity)
        .pipe(Effect.mapError(bootstrapFailureFromCause));
    }
    yield* Effect.forEach(
      input.accounts,
      (account) => reconcileTenantAccount(transaction, tenant, account, authenticationNamespaceId),
      { concurrency: 1, discard: true },
    );
    yield* Effect.forEach(
      input.installedModuleKeys,
      (moduleKey) => reconcileModuleState(transaction, tenant, moduleKey),
      { concurrency: 1, discard: true },
    );
    return yield* Effect.void;
  },
);

/**
 * Ends a retired stage tenant's authority in intent: its memberships and assignments are revoked and its
 * identity rows archived. The tuples go with the reconcile that follows, because they are only ever a
 * projection of this intent — deleting them by hand would leave intent that projects them again.
 */
const retireTenant = Effect.fn('StageContextBootstrap.retireTenant')(function* retireTenantEffect(
  transaction: CoreTransaction,
  retired: StageRetiredTenant,
  retiredAt: Date,
  scope: OperationalScope,
  enrollment: DatabaseIdentityEnrollment,
): Effect.fn.Return<void, StageContextBootstrapError> {
  // The review tables are tenant-guarded: without the tenant's own scope installed the retirement would
  // silently match no row and leave a graph that still answers.
  yield* installOperationalScope(transaction, scope, enrollment).pipe(Effect.mapError(bootstrapFailureFromCause));
  yield* transaction
    .update(principalAuthBindings)
    .set({ revokedAt: retiredAt, status: 'revoked' })
    .where(and(eq(principalAuthBindings.tenantId, retired.tenantId), ne(principalAuthBindings.status, 'revoked')))
    .pipe(Effect.mapError(bootstrapFailureFromCause));
  yield* transaction
    .update(accessMemberships)
    // A membership's period is immutable, so retirement ends it by status alone.
    .set({ status: 'revoked' })
    .where(and(eq(accessMemberships.tenantId, retired.tenantId), ne(accessMemberships.status, 'revoked')))
    .pipe(Effect.mapError(bootstrapFailureFromCause));
  yield* transaction
    .update(accessAssignments)
    .set({ status: 'revoked' })
    .where(and(eq(accessAssignments.tenantId, retired.tenantId), ne(accessAssignments.status, 'revoked')))
    .pipe(Effect.mapError(bootstrapFailureFromCause));
  yield* Effect.forEach(
    [
      transaction
        .update(principals)
        .set({ status: 'archived' })
        .where(and(eq(principals.tenantId, retired.tenantId), ne(principals.status, 'archived'))),
      transaction
        .update(tenantModuleStates)
        .set({ state: 'archived' })
        .where(and(eq(tenantModuleStates.tenantId, retired.tenantId), ne(tenantModuleStates.state, 'archived'))),
      transaction
        .update(legalEntities)
        .set({ status: 'archived' })
        .where(and(eq(legalEntities.tenantId, retired.tenantId), ne(legalEntities.status, 'archived'))),
      transaction
        .update(tenants)
        .set({ status: 'archived' })
        .where(and(eq(tenants.tenantId, retired.tenantId), ne(tenants.status, 'archived'))),
    ],
    (statement) => statement.pipe(Effect.mapError(bootstrapFailureFromCause)),
    { concurrency: 1, discard: true },
  );
  return yield* Effect.void;
});

const runTenantTransaction = (
  executor: CoreDatabaseExecutor,
  body: (transaction: CoreTransaction) => Effect.Effect<void, StageContextBootstrapError>,
): Effect.Effect<void, StageContextBootstrapError> =>
  executor.transaction(body).pipe(
    Effect.catchDefect((defect) => (isSqlError(defect) ? Effect.fail(defect) : Effect.die(defect))),
    Effect.catchTag('SqlError', (sqlFailure) => Effect.fail(bootstrapFailureFromCause(sqlFailure))),
  );

/** Every refusal a stage run decides before it writes anything, or `undefined` when it may run. */
export const stageBootstrapRefusal = (
  input: { readonly retiredTenants: readonly StageRetiredTenant[]; readonly tenants: readonly StageTenantBootstrap[] },
  options: StageContextBootstrapOptions,
): StageContextBootstrapError | undefined => {
  // An operator file may retire its last tenant, so an empty tenant list is only a refusal when there is
  // nothing at all to reconcile.
  if (input.tenants.length === 0 && input.retiredTenants.length === 0) {
    return failure('At least one stage account is required');
  }
  if (options.modules.length === 0) {
    // A composition that declares nothing would publish an empty release and deny the owner everything.
    return failure('The stage bootstrap needs the declarations of the running composition');
  }
  const moduleRefusal = stageModuleIntentRefusal(
    input.tenants.map(({ tenant }) => tenant.moduleKey),
    options.modules,
  );
  if (moduleRefusal !== undefined) {
    return moduleRefusal;
  }
  const withoutExactlyOneOwner = input.tenants.some(
    (tenant) => tenant.accounts.filter(({ owner }) => owner).length !== 1,
  );
  if (withoutExactlyOneOwner) {
    return failure('Every stage Tenant needs exactly one owner account');
  }
  // A retired tenant is reconciled under the scope of a principal that leaves it, so it must name one.
  return input.retiredTenants.length > 0 && input.retiredTenants.some(({ principalIds }) => principalIds.length === 0)
    ? failure('A retired stage Tenant needs the Principal that leaves it')
    : undefined;
};

/** The further accounts of a tenant that hold "Plný přístup" beside their membership. */
const fullAccessHoldersOf = (tenant: StageTenantBootstrap): readonly StageAccountIdentity[] =>
  tenant.accounts.filter((account) => !account.owner && account.roles.includes(STAGE_ACCOUNT_ROLE_FULL_ACCESS));

/** Creates one tenant's identity rows, its owner's authority and the roles of its further accounts. */
const reconcileTenant = Effect.fn('StageContextBootstrap.reconcileTenant')(function* reconcileTenantEffect(
  executor: CoreDatabaseExecutor,
  input: { readonly installedModuleKeys: readonly string[]; readonly tenant: StageTenantBootstrap },
  options: StageContextBootstrapOptions,
  at: Date,
  enrollment: DatabaseIdentityEnrollment,
): Effect.fn.Return<readonly StageContextBootstrapResult[], StageContextBootstrapError, InstallationRuntime> {
  const { tenant } = input;
  const bootstrap = yield* TenantAccessBootstrap;
  const memberships = yield* AccessMembershipStore;
  const writer = yield* AccessProjectionWriter;
  const owner = tenant.accounts.find(({ owner: isOwner }) => isOwner);
  if (owner === undefined) {
    return yield* failure('Every stage Tenant needs exactly one owner account');
  }
  yield* runTenantTransaction(executor, (transaction) =>
    reconcileTenantIdentity(
      transaction,
      { accounts: tenant.accounts, installedModuleKeys: input.installedModuleKeys, tenant: tenant.tenant },
      options.authenticationNamespaceId,
    ),
  );
  const ownerScope = yield* stageScopeOf({
    principalId: owner.principalId,
    tenantId: tenant.tenant.tenantId,
  });
  const bootstrapped = yield* bootstrap
    .bootstrapTenantAccess({
      legalEntityIds: [LegalEntityIdSchema.make(tenant.tenant.legalEntity.legalEntityId)],
      modules: options.modules,
      scope: ownerScope,
    })
    .pipe(Effect.mapError((cause) => failure(`${cause.code}: ${cause.reason}`, cause)));
  // The operator-declared workloads are registered through Core's own registry, so a workload Action
  // admits exactly the principals the operator named and nothing else (O73). A tenant with none
  // registers none, and the gate refuses every workload on its carriers.
  const declaredWorkloads = tenant.tenant.workloads ?? [];
  if (declaredWorkloads.length > 0) {
    yield* writeWorkloadBindings({ enrollment, executor }, ownerScope, {
      bindings: declaredWorkloads.map(({ principalId, workloadKey }) => ({
        bindingId: AccessWorkloadBindingIdSchema.make(
          stableUuid(
            ['ontos.access.stage.workload-binding', bootstrapped.tenantId, principalId, workloadKey].join(':'),
          ),
        ),
        createdAt: at,
        incarnation: AccessWorkloadBindingIdSchema.make(
          stableUuid(
            ['ontos.access.stage.workload-incarnation', bootstrapped.tenantId, principalId, workloadKey].join(':'),
          ),
        ),
        principalId: PrincipalIdSchema.make(principalId),
        tenantId: bootstrapped.tenantId,
        workloadKey: WorkloadKeySchema.make(workloadKey),
      })),
    }).pipe(Effect.mapError((cause) => failure(`${cause.code}: ${cause.reason}`, cause)));
  }
  const authority = {
    roleId: bootstrapped.roleId,
    roleRevisionId: bootstrapped.roleRevisionId,
    tenantId: bootstrapped.tenantId,
  } as const;
  const holders = fullAccessHoldersOf(tenant).map((holder) =>
    stageHolderOf({
      authority,
      principalId: holder.principalId,
      scopes: bootstrapped.scopes,
      validFrom: at,
    }),
  );
  if (holders.length > 0) {
    yield* Effect.forEach(
      holders,
      (holder) =>
        recordStageHolderMemberships(memberships, ownerScope, {
          assignedBy: bootstrapped.ownerPrincipalId,
          holder,
        }).pipe(Effect.mapError((cause) => failure(`${cause.code}: ${cause.reason}`, cause))),
      { concurrency: 1, discard: true },
    );
    yield* writeStageAssignments({ enrollment, executor }, ownerScope, {
      assignedBy: bootstrapped.ownerPrincipalId,
      holders,
    }).pipe(Effect.mapError((cause) => failure(`${cause.code}: ${cause.reason}`, cause)));
    // The further holders are intent the first reconcile could not see: project them once.
    yield* writer
      .reconcileTenant({ scope: ownerScope })
      .pipe(Effect.mapError((cause) => failure(`${cause.code}: ${cause.reason}`, cause)));
  }
  return tenant.accounts.map((account): StageContextBootstrapResult => ({
    legalEntityId: tenant.tenant.legalEntity.legalEntityId,
    owner: account.owner,
    principalId: account.principalId,
    roles: account.roles,
    tenantId: tenant.tenant.tenantId,
  }));
});

/**
 * Reconciles every stage tenant from the operator accounts file and retires the tenants the file retires.
 * Results follow the order of the accounts; one transaction writes each tenant's identity rows, one
 * bootstrap creates its authority, and one reconcile projects it.
 */
export const reconcileStageContextBootstraps = Effect.fn('StageContextBootstrap.reconcileStageContextBootstraps')(
  function* reconcileStageContextsEffect(
    input: {
      readonly retiredTenants: readonly StageRetiredTenant[];
      readonly tenants: readonly StageTenantBootstrap[];
    },
    options: StageContextBootstrapOptions,
  ): Effect.fn.Return<
    readonly StageContextBootstrapResult[],
    StageContextBootstrapError,
    InstallationRuntime | DatabaseIdentityEnrollmentContext
  > {
    const refusal = stageBootstrapRefusal(input, options);
    if (refusal !== undefined) {
      return yield* refusal;
    }
    const { executor } = yield* CoreDatabase;
    const writer = yield* AccessProjectionWriter;
    // The identity the run connects as: its enrollment names the session-setting role that installs the
    // scope of every tenant-guarded read and write below, and it is read, never assumed.
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    const at = yield* DateTime.nowAsDate;
    const results = yield* Effect.forEach(
      input.tenants,
      (tenant) =>
        reconcileTenant(
          executor,
          {
            installedModuleKeys: installedModuleKeysOf([tenant.tenant.moduleKey], options.modules),
            tenant,
          },
          options,
          at,
          enrollment,
        ),
      { concurrency: 1 },
    );
    const retireStageTenant = Effect.fn('StageContextBootstrap.retireStageTenant')(function* retireStageTenantEffect(
      retired: StageRetiredTenant,
    ) {
      const [principalId] = retired.principalIds;
      if (principalId === undefined) {
        return yield* failure('A retired stage Tenant needs the Principal that leaves it');
      }
      const retiredScope = yield* stageScopeOf({ principalId, tenantId: retired.tenantId });
      yield* runTenantTransaction(executor, (transaction) =>
        retireTenant(transaction, retired, at, retiredScope, enrollment),
      );
      // The graph is the projection of the intent that just ended, so the reconcile is the deletion.
      yield* writer
        .reconcileTenant({ scope: retiredScope })
        .pipe(Effect.mapError((cause) => failure(`${cause.code}: ${cause.reason}`, cause)));
      return yield* Effect.void;
    });
    yield* Effect.forEach(input.retiredTenants, retireStageTenant, { concurrency: 1, discard: true });
    return results.flat();
  },
);
