import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { Config, DateTime, Effect, Match, Option, Redacted, Schema } from 'effect';
import { isSqlError } from 'effect/sql/SqlError';

import { TenantAccessBootstrap } from '../access/bootstrap/bootstrap-tenant-access.ts';
import { administersScope } from '../access/approvals/live-administration.ts';
import { membershipFactsOf } from '../access/approvals/live-authority.ts';
import type { LiveMembershipRow, ScopeRow } from '../access/approvals/live-authority.ts';
import { stableUuid } from '../access/catalog/stable-id.ts';
import { configureBasesOf } from '../access/changes/authority.ts';
import type { TenantProjectionIntent } from '../access/compiler/intent.ts';
import { AccessScopeIdSchema, LegalEntityIdSchema, PrincipalIdSchema, TenantIdSchema } from '../access/ids.ts';
import type { AccessScopeId, TenantId } from '../access/ids.ts';
import { AccessMembershipStore, decodeMembershipRow, membershipColumns } from '../access/intent/memberships.ts';
import type { AccessMembership } from '../access/intent/memberships.ts';
import { AccessPeopleStore, PEOPLE_CHANGE_LOCK_NAMESPACE } from '../access/intent/people-store.ts';
import type { TenantScopeRow } from '../access/intent/people-store.ts';
import { peopleRevisionOf } from '../access/intent/people-revision.ts';
import { asDate } from '../access/intent/persistence.ts';
import { AccessProjectionWriter } from '../access/intent/projection-writer.ts';
import { AccessTeamStore } from '../access/intent/teams.ts';
import type { AccessTeamWithMembers } from '../access/intent/teams.ts';
import { hasLiveMembershipPath, membershipIsLive, planMembershipEnd } from '../access/lifecycle/people-commands.ts';
import type { PeopleIntentWrite } from '../access/lifecycle/people-commands.ts';
import { administrationOf } from '../access/lifecycle/people-service.ts';
import { sameHolder } from '../access/model.ts';
import type { AccessScopeRecord, Assignment, Delegation, Holder } from '../access/model.ts';
import { AccessWorkloadBindingIdSchema } from '../access/workloads/store.ts';
import { writeWorkloadBindings } from '../access/workloads/binding-store.ts';
import { WorkloadKeySchema } from '../authorization/access-declaration.ts';
import { TrustedPrincipalContextSchema } from '../actions/principal-context.ts';
import type { AccessCatalogModule } from '../authorization/access-declaration.ts';
import { companyMembershipManagementFromTransaction } from '../auth/company-membership-management.ts';
import { transitionOAuthGrant } from '../auth/oauth-grant-registry-live.ts';
// The installation run owns the runtime connection: every scope it installs is a session-setting one.
import { CoreDatabase } from '../db/client.ts';
import { parseDatabaseConfig } from '../db/config.ts';
import { DatabaseIdentityEnrollmentContext } from '../db/database-identities.ts';
import type { DatabaseIdentityEnrollment } from '../db/database-identities.ts';
import {
  accessAgentConnections,
  accessAssignments,
  accessMemberships,
  auditEvents,
  legalEntities,
  oauthConnectionGrants,
  principalAuthBindings,
  principalCompanyMemberships,
  principals,
  tenantModuleStates,
  tenants,
} from '../db/schema.ts';
import type { BindingStatus, BindingSubjectType } from '../db/schema.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../db/types.ts';
import { installOperationalScope } from '../db/scoped-transaction.ts';
import type { OperationalScope } from '../operations/context.ts';
import type { CompanyAffiliation } from '../permissions/company-membership.ts';
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

/** An existing login joining an existing tenant: its own Principal there, bound to the login's Better Auth user. */
export interface StageAttachedLoginIdentity {
  readonly authBindingId: string;
  readonly displayName: string;
  readonly principalId: string;
  readonly providerUserId: string;
  readonly tenantId: string;
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
    code: Schema.Literals([
      'stage_context_bootstrap_failed',
      'stage_connected_app_not_administered',
      'stage_last_administrator',
    ]),
    reason: Schema.String,
    /** The access scope a `stage_last_administrator` refusal would leave without anybody who administers it. */
    scopeId: Schema.optionalKey(AccessScopeIdSchema),
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

/** The identity rows one login needs in a tenant: its human Principal and its Better Auth staff binding. */
const reconcileTenantAccount = Effect.fn('StageContextBootstrap.reconcileTenantAccount')(
  function* reconcileTenantAccountEffect(
    transaction: CoreTransaction,
    tenantId: string,
    account: Pick<StageAccountIdentity, 'authBindingId' | 'displayName' | 'principalId' | 'providerUserId'>,
    authenticationNamespaceId: string,
  ): Effect.fn.Return<void, StageContextBootstrapError> {
    const identity = {
      authBindingId: account.authBindingId,
      principalDisplayName: account.displayName,
      principalId: account.principalId,
      tenantId,
    };
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
      tenantId,
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
      legalEntityId: tenant.legalEntity.legalEntityId,
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
      (account) => reconcileTenantAccount(transaction, tenant.tenantId, account, authenticationNamespaceId),
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
      // The tenant ends first: a platform system principal (the release actor) may only change status once its
      // tenant is no longer active, which the database enforces (core.keep_system_principals).
      transaction
        .update(tenants)
        .set({ status: 'archived' })
        .where(and(eq(tenants.tenantId, retired.tenantId), ne(tenants.status, 'archived'))),
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
    ],
    (statement) => statement.pipe(Effect.mapError(bootstrapFailureFromCause)),
    { concurrency: 1, discard: true },
  );
  return yield* Effect.void;
});

/**
 * One person's sign-in to a tenant that stays active, named by its Principal and by the Better Auth user the
 * operator file's email resolved to. The Principal must be signed in to by that user, and by nothing else.
 */
export interface StageRetiredPrincipalIdentity {
  readonly principalId: string;
  readonly providerUserId: string;
  readonly tenantId: string;
}

/**
 * What every row a departure ends records as its reason. The authority is the stage operator's accounts file
 * (ADR-0028), exercised through the tenant's owner, so the history reads who ended the row and through what.
 */
export const STAGE_RETIREMENT_REASON =
  'Ended by the tenant owner through the stage accounts bootstrap, on the stage operator accounts file (ADR-0028)';

/**
 * The tenant's People lock, the one every governed people change commits under, so a retirement never
 * interleaves with an admission, an assignment or another departure of the same tenant.
 */
const lockTenantPeople = (transaction: CoreTransaction, tenantId: string) =>
  transaction
    .execute(
      sql`select pg_advisory_xact_lock(hashtext(${PEOPLE_CHANGE_LOCK_NAMESPACE}), hashtext(${tenantId}))`,
      'objects',
    )
    .pipe(Effect.mapError(bootstrapFailureFromCause), Effect.asVoid);

/**
 * The scope a departure is planned and written in: the tenant's owner acting for the stage operator, whose
 * accounts file is the authority (ADR-0028). Every row the departure ends records that owner, never the person who
 * leaves, and the session reference names the bootstrap the owner acted through.
 */
const operatorScopeOf = (input: {
  readonly legalEntityId?: string;
  readonly ownerId: string;
  readonly tenantId: string;
}): Effect.Effect<OperationalScope, StageContextBootstrapError> => {
  const session = {
    authBindingId: stableUuid(`ontos.stage.accounts-bootstrap.operator:${input.tenantId}:${input.ownerId}`),
    authContextRef: `stage-accounts-bootstrap:operator:${input.tenantId}:${input.ownerId}`,
    authMethod: 'session' as const,
    principalId: input.ownerId,
    tenantId: input.tenantId,
  };
  const context = input.legalEntityId === undefined ? session : { ...session, legalEntityId: input.legalEntityId };
  return Schema.decodeEffect(TrustedPrincipalContextSchema)(context).pipe(
    Effect.map((scope) => ({ ...scope, correlationId: 'stage-accounts-bootstrap' }) satisfies OperationalScope),
    Effect.mapError((cause) => failure('The stage operator scope is invalid', cause)),
  );
};

/** The person a holder is; an agent is nobody's Principal here. */
const personIdsOf = (holder: Holder): readonly string[] =>
  Match.value(holder).pipe(
    Match.tag('Principal', ({ principalId }): readonly string[] => [principalId]),
    Match.orElse((): readonly string[] => []),
  );

/** Whether an existing row carries exactly the expected values. */
const isExactRecord = (existing: ExactRecord, expected: ExactRecord): boolean =>
  Object.entries(expected).every(([key, value]) => existing[key] === value);

const NON_FRESH_ATTACHMENT =
  'An attached login takes a fresh Principal and staff binding, or replays exactly the pair it created';

/**
 * Whether an attached login is new or an exact replay. Only a Principal and a binding that both do not exist
 * yet are created; a Principal that exists is accepted only together with exactly the binding this login
 * created for it and no other, because a further login would inherit everything that Principal holds.
 */
const attachmentOf = Effect.fn('StageContextBootstrap.attachmentOf')(function* attachmentOfEffect(
  transaction: CoreTransaction,
  login: StageAttachedLoginIdentity,
  authenticationNamespaceId: string,
): Effect.fn.Return<'create' | 'replay', StageContextBootstrapError> {
  const [tenant] = yield* transaction
    .select({ status: tenants.status })
    .from(tenants)
    .where(eq(tenants.tenantId, login.tenantId))
    .limit(1)
    .pipe(Effect.mapError(bootstrapFailureFromCause));
  if (tenant?.status !== 'active') {
    return yield* failure('An attached login needs an existing active tenant');
  }
  const identity = {
    authBindingId: login.authBindingId,
    principalDisplayName: login.displayName,
    principalId: login.principalId,
    tenantId: login.tenantId,
  };
  // The Principal, and any binding that claims this binding id, signs this user in to the tenant, or the Principal holds.
  const [[principal], bindings] = yield* Effect.all(
    [
      selectBootstrapPrincipals(transaction, identity),
      transaction
        .select({
          authenticationNamespaceId: principalAuthBindings.authenticationNamespaceId,
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
            eq(principalAuthBindings.principalAuthBindingId, login.authBindingId),
            and(
              eq(principalAuthBindings.tenantId, login.tenantId),
              eq(principalAuthBindings.authenticationNamespaceId, authenticationNamespaceId),
              eq(principalAuthBindings.subjectType, 'user'),
              eq(principalAuthBindings.providerSubjectId, login.providerUserId),
            ),
            and(
              eq(principalAuthBindings.tenantId, login.tenantId),
              eq(principalAuthBindings.principalId, login.principalId),
            ),
          ),
        )
        .limit(3),
    ],
    { concurrency: 1 },
  ).pipe(Effect.mapError(bootstrapFailureFromCause));
  if (principal === undefined && bindings.length === 0) {
    return 'create';
  }
  const expectedBinding = {
    authenticationNamespaceId,
    principalAuthBindingId: login.authBindingId,
    principalId: login.principalId,
    provider: 'better_auth',
    providerSubjectId: login.providerUserId,
    status: 'active',
    subjectType: 'user',
    tenantId: login.tenantId,
  } as const;
  const [binding] = bindings;
  return principal !== undefined &&
    binding !== undefined &&
    bindings.length === 1 &&
    isExactRecord(principal, bootstrapPrincipalRecord(identity)) &&
    isExactRecord(binding, expectedBinding)
    ? 'replay'
    : yield* failure(NON_FRESH_ATTACHMENT);
});

/** A refusal of a Core store, carried with its code. */
const storeFailure = (cause: { readonly code: string; readonly reason: string }): StageContextBootstrapError =>
  failure(`${cause.code}: ${cause.reason}`, cause);

/** The people intent of one tenant a departure is planned on, as the governed People read loads it. */
interface StagePeopleView {
  readonly assignments: readonly Assignment[];
  readonly delegations: readonly Delegation[];
  readonly memberships: readonly AccessMembership[];
  /** The tenant context and every company scope of the tenant. */
  readonly scopes: readonly TenantScopeRow[];
  readonly teams: readonly AccessTeamWithMembers[];
  readonly tenantScopeId: AccessScopeId | undefined;
}

const peopleViewOf = Effect.fn('StageContextBootstrap.peopleViewOf')(function* peopleViewOfEffect(
  scope: OperationalScope,
): Effect.fn.Return<
  StagePeopleView,
  StageContextBootstrapError,
  AccessMembershipStore | AccessPeopleStore | AccessTeamStore
> {
  const [memberships, people, teams] = yield* Effect.all(
    [
      (yield* AccessMembershipStore).loadTenantMemberships(scope),
      (yield* AccessPeopleStore).loadTenantPeople(scope),
      (yield* AccessTeamStore).loadTenantTeams(scope),
    ],
    { concurrency: 1 },
  ).pipe(Effect.mapError(storeFailure));
  return {
    assignments: people.assignments,
    delegations: people.delegations,
    memberships,
    scopes: people.scopes,
    teams,
    tenantScopeId: people.scopes.find((row) => row.tenantContextId !== undefined)?.scopeId,
  };
});

/** The token the People store compares under the tenant's People lock before it writes a plan. */
const peopleRevisionOfView = (view: StagePeopleView): string =>
  peopleRevisionOf({
    assignments: view.assignments,
    delegations: view.delegations,
    memberships: view.memberships,
    teamMembers: view.teams.flatMap(({ members }) => members),
  });

const endedIdsOf = (writes: readonly PeopleIntentWrite[]): ReadonlySet<string> =>
  new Set(
    writes.flatMap((write): readonly string[] =>
      Match.value(write).pipe(
        Match.tag('EndMembership', ({ membershipId }) => [membershipId]),
        Match.tag('EndAssignment', ({ incarnationId }) => [incarnationId]),
        Match.orElse(() => []),
      ),
    ),
  );

/**
 * One planned write applied to a view, exactly as the People store writes it. Every kind of Core's write union is
 * handled (`Match.exhaustive`), so a kind Core adds later fails typecheck here instead of leaving the next plan on
 * a view whose revision the store refuses.
 */
const viewAfterWrite = (view: StagePeopleView, write: PeopleIntentWrite): StagePeopleView =>
  Match.value(write).pipe(
    Match.tag('EndAssignment', ({ incarnationId }): StagePeopleView => ({
      ...view,
      assignments: view.assignments.map((assignment): Assignment =>
        assignment.incarnationId === incarnationId ? { ...assignment, status: 'revoked' } : assignment,
      ),
    })),
    Match.tag('EndDelegation', ({ delegationId }): StagePeopleView => ({
      ...view,
      delegations: view.delegations.map((delegation): Delegation =>
        delegation.id === delegationId ? { ...delegation, status: 'revoked' } : delegation,
      ),
    })),
    Match.tag('EndMembership', ({ membershipId, status }): StagePeopleView => ({
      ...view,
      memberships: view.memberships.map((membership): AccessMembership =>
        membership.id === membershipId ? { ...membership, status } : membership,
      ),
    })),
    Match.tag('RecordAssignment', ({ assignment }): StagePeopleView => ({
      ...view,
      assignments: [...view.assignments, assignment],
    })),
    Match.tag('RecordDelegation', ({ delegation }): StagePeopleView => ({
      ...view,
      delegations: [...view.delegations, delegation],
    })),
    Match.tag('RecordMembership', ({ membership }): StagePeopleView => ({
      ...view,
      memberships: [...view.memberships, membership],
    })),
    Match.tag('RecordTeamMember', ({ member }): StagePeopleView => ({
      ...view,
      teams: view.teams.map((entry): AccessTeamWithMembers =>
        entry.team.id === member.teamId ? { ...entry, members: [...entry.members, member] } : entry,
      ),
    })),
    Match.tag('RemoveTeamMember', ({ teamMemberId }): StagePeopleView => ({
      ...view,
      teams: view.teams.map((entry): AccessTeamWithMembers => ({
        ...entry,
        members: entry.members.filter((member) => member.id !== teamMemberId),
      })),
    })),
    // A precondition writes no row.
    Match.tag('RequireDirectoryMember', (): StagePeopleView => view),
    Match.exhaustive,
  );

/**
 * The view after one departure's plan committed. The next person of the same tenant is planned on it, so two
 * administrators of one scope never each count the other as the successor that stays, and the revision it carries
 * is the one the People store reads once the first plan is written.
 */
const viewAfter = (view: StagePeopleView, writes: readonly PeopleIntentWrite[]): StagePeopleView => {
  let after = view;
  for (const write of writes) {
    after = viewAfterWrite(after, write);
  }
  return after;
};

/** One company directory membership a departure ends, read with its revision for the compare-and-set. */
interface DirectoryDeparture {
  readonly affiliation: CompanyAffiliation;
  readonly revision: number;
  readonly scope: OperationalScope;
}

/** One staff binding as the run read it under its row lock: the compare-and-set its revocation is written with. */
interface WitnessedBinding {
  readonly id: string;
  readonly revision: number;
  readonly status: BindingStatus;
}

/** One binding of a leaver, as the run read it under the leaver's Principal lock. */
export interface StageLeaverBinding {
  readonly authenticationNamespaceId: string;
  readonly bindingRevision: number;
  readonly principalAuthBindingId: string;
  readonly provider: string;
  readonly providerSubjectId: string;
  readonly status: BindingStatus;
  readonly subjectType: BindingSubjectType;
}

/**
 * One connected app of a leaver: an OAuth grant that acts as the person, read under its row lock. An approved grant
 * and its `oauth_grant` binding name each other (the binding's subject is the grant, the grant's `authBindingId` is
 * the binding); a draft, the consent the person has not finished, has no binding yet. Client names and ids only,
 * never a token.
 */
export interface StageConnectedApp {
  readonly authBindingId: string | null;
  readonly clientId: string;
  readonly clientName: string;
  readonly grantId: string;
  readonly lastUsedAt: Date | null;
  /** The company the connection acts in: only somebody who administers it ends somebody else's connection there. */
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly revokedByPrincipalId: string | null;
  readonly revokeReason: string | null;
  readonly status: string;
  readonly tenantId: string;
  /** The person the connection was approved by, as the product's revocation event names them. */
  readonly userPrincipalId: string;
}

/** The grant columns a connected app is read with. */
const connectedAppColumns = {
  authBindingId: oauthConnectionGrants.authBindingId,
  clientId: oauthConnectionGrants.clientId,
  clientName: oauthConnectionGrants.clientName,
  grantId: oauthConnectionGrants.grantId,
  lastUsedAt: oauthConnectionGrants.lastUsedAt,
  legalEntityId: oauthConnectionGrants.legalEntityId,
  principalId: oauthConnectionGrants.actingPrincipalId,
  revokedByPrincipalId: oauthConnectionGrants.revokedByPrincipalId,
  revokeReason: oauthConnectionGrants.revokeReason,
  status: oauthConnectionGrants.status,
  tenantId: oauthConnectionGrants.tenantId,
  userPrincipalId: oauthConnectionGrants.userPrincipalId,
};

/** What a departure ends of the leaver's sign-ins, decided from the rows the run holds locked. */
export interface StageCredentialEnding {
  /** Exactly the bindings the run read that are not revoked yet, the login's and every connected app's. */
  readonly bindings: readonly WitnessedBinding[];
  /** The connected apps still `active` or `draft`: the departure ends each through Core's grant transition. */
  readonly connectedApps: readonly StageConnectedApp[];
  /** The leaver was archived by an earlier run of the same file, which this departure replays. */
  readonly replay: boolean;
}

/** A connected app that can still act or still be approved: an approved grant, or a draft consent. */
const isLiveConnectedApp = ({ status }: StageConnectedApp) => status === 'active' || status === 'draft';

/**
 * Decides what a departure ends of a leaver's sign-ins. The leaver signs in only as the login its email names and
 * through connected apps: an `oauth_grant` binding of the run's namespace whose grant acts as the leaver and names the
 * binding back. Every such binding that is not revoked is revoked with the login's, a `disabled` one too: Core's
 * binding writers may enable a disabled binding again while its Principal is active, and the product's own
 * revocation of a connection only disables it. Every connected app still `active` or `draft` is ended as a company
 * administrator ends somebody else's connection in the product, so only when the acting owner administers the company
 * the app acts in (`actingOwnerAdministers`, decided at the decision time); one in a company the owner does not
 * administer refuses the file with `stage_connected_app_not_administered`, naming the app and the company. Any other
 * binding (an API key, another login, a grant binding no grant of the leaver names) refuses the departure, and so does
 * a person without a live binding of the login, unless an earlier run of the file archived them: then every binding is
 * revoked already and the departure is replayed.
 */
export const stageCredentialEndingOf = (input: {
  /** Whether the tenant owner the run acts through effectively administers a company at the decision time. */
  readonly actingOwnerAdministers: (legalEntityId: string) => boolean;
  readonly authenticationNamespaceId: string;
  readonly bindings: readonly StageLeaverBinding[];
  readonly connectedApps: readonly StageConnectedApp[];
  readonly principalStatus: string;
  readonly providerUserId: string;
}): Effect.Effect<StageCredentialEnding, StageContextBootstrapError> => {
  const staff = (binding: StageLeaverBinding) =>
    binding.authenticationNamespaceId === input.authenticationNamespaceId && binding.provider === 'better_auth';
  const ofTheLogin = (binding: StageLeaverBinding) =>
    staff(binding) && binding.subjectType === 'user' && binding.providerSubjectId === input.providerUserId;
  const ofAConnectedApp = (binding: StageLeaverBinding) =>
    staff(binding) &&
    binding.subjectType === 'oauth_grant' &&
    input.connectedApps.some(
      (app) => app.grantId === binding.providerSubjectId && app.authBindingId === binding.principalAuthBindingId,
    );
  const unrevoked = input.bindings.filter(({ status }) => status !== 'revoked');
  if (unrevoked.some((binding) => !ofTheLogin(binding) && !ofAConnectedApp(binding))) {
    return Effect.fail(
      failure(
        'A retired stage Principal must sign in only as the login its email names; another login or credential is bound to it',
      ),
    );
  }
  // A departure needs the login's live binding. Only a Principal this file already retired comes back without one:
  // archived, every binding revoked, one of them the login's.
  const replay = input.principalStatus === 'archived';
  const signedIn = replay
    ? unrevoked.length === 0 && input.bindings.some(ofTheLogin)
    : unrevoked.some((binding) => binding.status === 'active' && ofTheLogin(binding));
  if (!signedIn) {
    return Effect.fail(
      failure(
        replay
          ? 'An archived stage Principal is retired again only as the exact replay of its departure: every binding revoked, one of them the login its email names'
          : 'A retired stage Principal must hold a live binding of the login its email names',
      ),
    );
  }
  const live = input.connectedApps.filter(isLiveConnectedApp);
  // The product lets only an administrator of the connection's company end somebody else's connection; the run ends it
  // as the acting owner, so the owner must administer that company, which a tenant owner suspended there does not.
  const unadministered = live.find(({ legalEntityId }) => !input.actingOwnerAdministers(legalEntityId));
  if (unadministered !== undefined) {
    return Effect.fail(
      new StageContextBootstrapError({
        code: 'stage_connected_app_not_administered',
        reason: `The connected app ${unadministered.clientName} (${unadministered.clientId}) of a retired stage Principal acts in company ${unadministered.legalEntityId}, which the acting tenant owner does not administer at the decision time; a company administrator ends it there first, or the owner's administration of that company is restored through People`,
      }),
    );
  }
  return Effect.succeed({
    bindings: unrevoked.map(({ bindingRevision, principalAuthBindingId, status }) => ({
      id: principalAuthBindingId,
      revision: bindingRevision,
      status,
    })),
    connectedApps: live,
    replay,
  });
};

/**
 * One connected app of a person the file retires, `status` as the run found it: `endedByThisRun` when this run ended
 * it, otherwise it had ended. `revokedByAdministrator` names who revoked it as a company administrator (`revoked`, reason
 * `admin`) as it stands after the run: the acting owner for an active grant this run ended, or whoever such an ending
 * recorded before; `null` for any other ending. The Shell records the product's `oauth.connection.revoked` event for
 * such an app when none names it yet.
 */
export interface StageRetiredConnectedApp extends StageConnectedApp {
  readonly endedByThisRun: boolean;
  readonly revokedByAdministrator: string | null;
}

/** A connected app as it stands after a run that ended it as `endedBy`, or left it as it was found. */
const retiredConnectedAppOf = (app: StageConnectedApp, endedBy?: string): StageRetiredConnectedApp => {
  if (endedBy !== undefined) {
    // An active grant the run ended is revoked by the acting owner with reason `admin`; a draft is denied.
    return { ...app, endedByThisRun: true, revokedByAdministrator: app.status === 'active' ? endedBy : null };
  }
  return {
    ...app,
    endedByThisRun: false,
    revokedByAdministrator: app.status === 'revoked' && app.revokeReason === 'admin' ? app.revokedByPrincipalId : null,
  };
};

/** Everything one departure writes, decided before anything of the run is written. */
interface PrincipalRetirement {
  readonly archive: boolean;
  /** Exactly the bindings the run read and revokes, each at the revision and status it read. */
  readonly bindings: readonly WitnessedBinding[];
  /** The leaver's connected apps still `active` or `draft`, each ended through Core's grant transition. */
  readonly connectedApps: readonly StageConnectedApp[];
  /** The connections still marked active that the run read, every one ended by time; the commit refuses another set. */
  readonly connectionIds: readonly string[];
  readonly directory: readonly DirectoryDeparture[];
  readonly expectedRevision: string;
  readonly peopleWrites: readonly PeopleIntentWrite[];
  /** The tenant owner acting for the stage operator: every row this departure writes is attributed to it. */
  readonly scope: OperationalScope;
}

/** What every departure of one tenant is decided with, read at decision time under the run's locks. */
interface TenantDecision {
  /** Whether the acting owner effectively administers a company of the tenant at the decision time (Core's live rule). */
  readonly actingOwnerAdministers: (legalEntityId: string) => boolean;
  /** The administrators who are active persons of the tenant, share-locked until the run commits. */
  readonly active: ReadonlySet<string>;
  readonly at: Date;
  readonly authenticationNamespaceId: string;
  readonly enrollment: DatabaseIdentityEnrollment;
  readonly scope: OperationalScope;
}

/** One tenant of a run once every lock of it is held: its leavers, its people intent and its active administrators. */
interface LockedTenant {
  readonly active: ReadonlySet<string>;
  /**
   * Every membership row of every administrator who does not leave, share-locked until the run commits: the rows
   * the effective administration of each scope is decided from, suspensions included.
   */
  readonly administration: readonly AccessMembership[];
  readonly leavers: readonly StageRetiredPrincipalIdentity[];
  readonly reading: OperationalScope;
  readonly view: StagePeopleView;
}

/**
 * Whether a management row still administers at the decision time, read the way the People owner rules should read
 * it: the row itself is active, has started and has not run out; its holder is an active person whose Principal row
 * this run share-locked; and the holder's membership path to the scope it administers (the tenant for an owner) is
 * live then. Every fact is checked at the one time taken after every lock of the run is held.
 */
const administersAt =
  (input: {
    readonly active: ReadonlySet<string>;
    readonly at: Date;
    readonly memberships: readonly AccessMembership[];
    readonly tenantScopeId: AccessScopeId;
  }) =>
  (membership: AccessMembership): boolean =>
    membership.kind !== 'member' &&
    membershipIsLive(membership, input.at) &&
    personIdsOf(membership.holder).some(
      (principalId) =>
        input.active.has(principalId) &&
        hasLiveMembershipPath({
          at: input.at,
          holder: PrincipalIdSchema.make(principalId),
          memberships: input.memberships,
          scopeId: membership.kind === 'owner' ? input.tenantScopeId : membership.scopeId,
          tenantScopeId: input.tenantScopeId,
        }),
    );

/** A row that is not revoked and has not run out: it still projects, now or once it starts. */
const notEnded = (row: { readonly status: string; readonly validUntil?: Date | undefined }, at: Date) =>
  row.status !== 'revoked' && row.status !== 'expired' && (row.validUntil === undefined || at < row.validUntil);

/**
 * Locks every leaver's connected apps (the OAuth grants that act as the person) FOR UPDATE and returns them, then the
 * leaver's Principal row FOR UPDATE, then every binding and agent connection it already has. The grants come first, as
 * Core's revocation and a first approval lock the grant before the person's rows. A reconnect does not follow that
 * order: approving a draft locks the draft, then the person's rows, then the older active grant of the same client it
 * supersedes. The run may hold that older grant while it waits for the draft or the person's row, so the two can
 * deadlock; PostgreSQL then aborts one of them, and when it is the run, nothing of the file is written and the same
 * file is run again. A writer that adds a binding, a personal key or an agent connection to a Principal references that
 * row: its foreign key takes a KEY SHARE lock, which FOR UPDATE excludes, and the external identity writer locks the
 * row FOR UPDATE itself. None of them takes the People lock, so this row lock is what keeps every one of them out
 * between this run's decision and its commit: they wait, then find the Principal archived. The existing bindings and
 * connections are locked here, before the decision time, so no later read of them waits.
 */
const lockLeavers = Effect.fn('StageContextBootstrap.lockLeavers')(function* lockLeaversEffect(
  transaction: CoreTransaction,
  leavers: readonly StageRetiredPrincipalIdentity[],
  enrollment: DatabaseIdentityEnrollment,
): Effect.fn.Return<readonly StageConnectedApp[], StageContextBootstrapError> {
  const [first] = leavers;
  if (first === undefined) {
    return [];
  }
  // A leaver's installer scope only selects the tenant for row security; it locks and attributes nothing.
  yield* installOperationalScope(transaction, yield* stageScopeOf(first), enrollment).pipe(
    Effect.mapError(bootstrapFailureFromCause),
  );
  const leaverIds = leavers.map(({ principalId }) => principalId);
  const connectedApps = yield* transaction
    .select(connectedAppColumns)
    .from(oauthConnectionGrants)
    .where(
      and(
        eq(oauthConnectionGrants.tenantId, first.tenantId),
        inArray(oauthConnectionGrants.actingPrincipalId, leaverIds),
      ),
    )
    .orderBy(oauthConnectionGrants.grantId)
    .for('update')
    .pipe(Effect.mapError(bootstrapFailureFromCause));
  yield* transaction
    .select({ principalId: principals.principalId })
    .from(principals)
    .where(
      and(
        eq(principals.tenantId, first.tenantId),
        inArray(
          principals.principalId,
          leavers.map(({ principalId }) => principalId),
        ),
      ),
    )
    .orderBy(principals.principalId)
    .for('update')
    .pipe(Effect.mapError(bootstrapFailureFromCause));
  yield* transaction
    .select({ id: principalAuthBindings.principalAuthBindingId })
    .from(principalAuthBindings)
    .where(
      and(eq(principalAuthBindings.tenantId, first.tenantId), inArray(principalAuthBindings.principalId, leaverIds)),
    )
    .orderBy(principalAuthBindings.principalAuthBindingId)
    .for('update')
    .pipe(Effect.mapError(bootstrapFailureFromCause));
  yield* transaction
    .select({ id: accessAgentConnections.connectionId })
    .from(accessAgentConnections)
    .where(
      and(eq(accessAgentConnections.tenantId, first.tenantId), inArray(accessAgentConnections.principalId, leaverIds)),
    )
    .orderBy(accessAgentConnections.connectionId)
    .for('update')
    .pipe(Effect.mapError(bootstrapFailureFromCause));
  return connectedApps;
});

/**
 * Share-locks the Principal row of every person who holds an owner or administrator row of the tenant, whatever its
 * validity, so none of them can be disabled or archived before this run commits, and returns those who are active
 * persons. Then it share-locks every membership row of each of them who does not leave (management, member and
 * suspended rows, in every scope), so no suspension, resumption or end of their administration or of its membership
 * path commits before this run does, and returns those rows as the lock read them. Only locks are taken here; what
 * counts is decided at the decision time, after every lock of the run.
 */
const lockAdministrators = Effect.fn('StageContextBootstrap.lockAdministrators')(function* lockAdministratorsEffect(
  transaction: CoreTransaction,
  view: StagePeopleView,
  leavers: readonly StageRetiredPrincipalIdentity[],
  reading: OperationalScope,
  enrollment: DatabaseIdentityEnrollment,
): Effect.fn.Return<Pick<LockedTenant, 'active' | 'administration'>, StageContextBootstrapError> {
  const administrators = [
    ...new Set(
      view.memberships.flatMap((membership) =>
        membership.kind !== 'member' && membership.status !== 'revoked' ? personIdsOf(membership.holder) : [],
      ),
    ),
  ].toSorted();
  if (administrators.length === 0) {
    return { active: new Set<string>(), administration: [] };
  }
  yield* installOperationalScope(transaction, reading, enrollment).pipe(Effect.mapError(bootstrapFailureFromCause));
  const rows = yield* transaction
    .select({ kind: principals.kind, principalId: principals.principalId, status: principals.status })
    .from(principals)
    .where(and(eq(principals.tenantId, reading.tenantId), inArray(principals.principalId, administrators)))
    .orderBy(principals.principalId)
    .for('share')
    .pipe(Effect.mapError(bootstrapFailureFromCause));
  const leaving = new Set(leavers.map(({ principalId }) => principalId));
  const staying = administrators.filter((principalId) => !leaving.has(principalId));
  const membershipRows =
    staying.length === 0
      ? []
      : yield* transaction
          .select(membershipColumns)
          .from(accessMemberships)
          .where(and(eq(accessMemberships.tenantId, reading.tenantId), inArray(accessMemberships.principalId, staying)))
          .orderBy(accessMemberships.membershipId)
          .for('share')
          .pipe(Effect.mapError(bootstrapFailureFromCause));
  const administration = yield* Effect.forEach(membershipRows, decodeMembershipRow, { concurrency: 1 }).pipe(
    Effect.mapError(storeFailure),
  );
  return {
    active: new Set(
      rows.flatMap(({ kind, principalId, status }) => (kind === 'human' && status === 'active' ? [principalId] : [])),
    ),
    administration,
  };
});

/** One membership row as Core's live membership facts read it. */
const liveMembershipRowOf = (membership: AccessMembership): LiveMembershipRow => ({
  agentId: Match.value(membership.holder).pipe(
    Match.tag('Agent', ({ agentId }): string | null => agentId),
    Match.orElse((): string | null => null),
  ),
  kind: membership.kind,
  principalId: personIdsOf(membership.holder)[0] ?? null,
  scopeId: membership.scopeId,
  status: membership.status,
  validFrom: membership.validFrom,
  validUntil: membership.validUntil ?? null,
});

/** The access scope record of one scope row of the tenant: its tenant context or exactly one company. */
const scopeRecordOf = (row: TenantScopeRow, tenantId: TenantId): readonly AccessScopeRecord[] => {
  if (row.tenantContextId !== undefined) {
    return [{ id: row.scopeId, scope: { _tag: 'TenantContext', tenantId } }];
  }
  return row.legalEntityId === undefined
    ? []
    : [{ id: row.scopeId, scope: { _tag: 'LegalEntity', legalEntityId: row.legalEntityId, tenantId } }];
};

/**
 * The tenant intent Core's configure bases are derived from, built from the share-locked rows: the tenant's scope
 * records and its live owners (an active, started, not yet ended `owner` row of the tenant context, as the intent
 * loader states them). It carries no assignment, installation or delegation: a delegated manager administers no
 * scope, so `administersScope` never reads one, and nothing projects this intent.
 */
const administrationIntentOf = (input: {
  readonly at: Date;
  readonly memberships: readonly AccessMembership[];
  readonly scopes: readonly TenantScopeRow[];
  readonly tenantId: TenantId;
  readonly tenantScopeId: AccessScopeId;
}): TenantProjectionIntent => ({
  catalogEntries: [],
  coverage: 'complete',
  legalEntities: [],
  members: [],
  owners: input.memberships.flatMap((membership) =>
    membership.kind === 'owner' && membership.scopeId === input.tenantScopeId && membershipIsLive(membership, input.at)
      ? personIdsOf(membership.holder).map((principalId) => PrincipalIdSchema.make(principalId))
      : [],
  ),
  principals: [],
  scopes: input.scopes.flatMap((row) =>
    scopeRecordOf(row, input.tenantId).map((scope) => ({
      assignments: [],
      connections: [],
      delegations: [],
      installations: [],
      roleRevisions: [],
      scope,
    })),
  ),
  suspended: [],
  tenantId: input.tenantId,
});

/** The tenant's scopes as Core's live administration rule reads them: the tenant context, or exactly one company. */
const scopeRowsOf = (view: StagePeopleView): readonly ScopeRow[] =>
  view.scopes.map((row) => ({ legalEntityId: row.legalEntityId ?? null, scopeId: row.scopeId }));

/**
 * Whether a person who stays effectively administers a scope of the tenant at the decision time: Core's own live
 * rule, `administersScope`, over the share-locked membership rows of the administrators who stay and the configure
 * bases `configureBasesOf` derives from them. A started, unexpired `access_admin` row of that company or tenant
 * ownership, a live membership path, and no live suspension in that scope. A tenant without its tenant context has no
 * administration path at all, so nobody administers anything there.
 */
const effectiveAdministrationOf = (
  locked: LockedTenant,
  at: Date,
): ((principalId: string, row: ScopeRow) => boolean) => {
  const { tenantScopeId } = locked.view;
  if (tenantScopeId === undefined) {
    return () => false;
  }
  const intent = administrationIntentOf({
    at,
    memberships: locked.administration,
    scopes: locked.view.scopes,
    tenantId: TenantIdSchema.make(locked.reading.tenantId),
    tenantScopeId,
  });
  const rows = locked.administration.map(liveMembershipRowOf);
  const tenantScopeIds = scopeRowsOf(locked.view).flatMap(({ legalEntityId, scopeId }) =>
    legalEntityId === null ? [scopeId] : [],
  );
  return (principalId, row) => {
    const actor = PrincipalIdSchema.make(principalId);
    return administersScope({
      at,
      bases: configureBasesOf({ actor, at, intent, memberships: locked.administration }),
      facts: membershipFactsOf({ at, holder: { _tag: 'Principal', principalId: actor }, rows }),
      row,
      tenantScopeIds,
    });
  };
};

/**
 * The first scope a leaver of the file administers that nobody who stays would still effectively administer at the
 * decision time, or `undefined` when every such scope keeps one. A scope counts when a leaver holds an owner or
 * administrator row there that has not ended. Somebody who stays is any administrator of the tenant who is not
 * leaving through this file and is an active person (both share-locked); whether they administer the scope is
 * Core's own live rule, `administersScope`, over their share-locked membership rows and the configure bases
 * `configureBasesOf` derives from them: a started, unexpired `access_admin` row of that company or tenant
 * ownership, a live membership path, and no live suspension in that scope. A tenant owner suspended in a company
 * therefore does not administer that company, although People still counts them there.
 */
const unadministeredScopeOf = (
  locked: LockedTenant,
  at: Date,
  administers: (principalId: string, row: ScopeRow) => boolean,
): ScopeRow | undefined => {
  const leaving = new Set(locked.leavers.map(({ principalId }) => principalId));
  const held = new Set(
    locked.view.memberships.flatMap((membership) =>
      membership.kind !== 'member' &&
      notEnded(membership, at) &&
      personIdsOf(membership.holder).some((principalId) => leaving.has(principalId))
        ? [membership.scopeId]
        : [],
    ),
  );
  if (held.size === 0) {
    return undefined;
  }
  const scopeRows = scopeRowsOf(locked.view);
  const heldRows = [...held]
    .toSorted()
    .map((scopeId): ScopeRow => scopeRows.find((row) => row.scopeId === scopeId) ?? { legalEntityId: null, scopeId });
  const staying = [...locked.active].filter((principalId) => !leaving.has(principalId)).toSorted();
  return heldRows.find((row) => !staying.some((principalId) => administers(principalId, row)));
};

/**
 * The decision facts of one tenant, taken at the decision time with every lock of the run held. A leaver who owns the
 * tenant is refused first. The one owner whose owner row administers at that time (started, not run out, an active
 * person, a live tenant membership path) is the identity the stage operator's file acts through (ADR-0028); a tenant
 * without exactly one such owner is refused, because no accountable identity would write its history. Then every
 * scope a leaver administers must keep somebody who stays and effectively administers it (`unadministeredScopeOf`),
 * or the file is refused with `stage_last_administrator` naming that scope.
 */
const tenantDecisionOf = Effect.fn('StageContextBootstrap.tenantDecisionOf')(function* tenantDecisionOfEffect(
  locked: LockedTenant,
  context: {
    readonly at: Date;
    readonly authenticationNamespaceId: string;
    readonly enrollment: DatabaseIdentityEnrollment;
  },
): Effect.fn.Return<TenantDecision, StageContextBootstrapError> {
  const { at } = context;
  const { active, leavers, reading, view } = locked;
  const leaving = new Set(leavers.map(({ principalId }) => principalId));
  // No tenant owner leaves through the operator path, a co-owner included: ownership moves only through People.
  if (
    view.memberships.some(
      (membership) =>
        membership.kind === 'owner' &&
        notEnded(membership, at) &&
        personIdsOf(membership.holder).some((principalId) => leaving.has(principalId)),
    )
  ) {
    return yield* failure(
      'A tenant owner is never retired through the stage accounts bootstrap; transfer the ownership through People first',
    );
  }
  const { tenantScopeId } = view;
  const administers =
    tenantScopeId === undefined
      ? () => false
      : administersAt({ active, at, memberships: view.memberships, tenantScopeId });
  // `administers` holds an owner only while they are an active person over a live tenant path.
  const owners = [
    ...new Set(
      view.memberships.flatMap((membership) =>
        membership.kind === 'owner' && administers(membership) ? personIdsOf(membership.holder) : [],
      ),
    ),
  ];
  const [owner] = owners;
  if (owner === undefined || owners.length > 1) {
    return yield* failure(
      `The stage accounts bootstrap retires a login only through the tenant's one owner; tenant ${reading.tenantId} has ${owners.length} live owners who are active persons`,
    );
  }
  // Every scope a leaver administers must keep somebody who stays and effectively administers it; the file names no
  // successor, and the acting owner does not administer a company they are suspended in.
  const administration = effectiveAdministrationOf(locked, at);
  const unadministered = unadministeredScopeOf(locked, at, administration);
  if (unadministered !== undefined) {
    return yield* new StageContextBootstrapError({
      code: 'stage_last_administrator',
      reason: `Nobody who stays would administer scope ${unadministered.scopeId}${
        unadministered.legalEntityId === null ? ' (the tenant context)' : ` (company ${unadministered.legalEntityId})`
      } of tenant ${reading.tenantId}: every leaver of the file is excluded, and a tenant owner suspended there does not administer it; name a successor through People first`,
      scopeId: AccessScopeIdSchema.make(unadministered.scopeId),
    });
  }
  // The run ends a leaver's live connected app as a company administrator ends somebody else's, by the same rule.
  const companies = scopeRowsOf(view).filter(({ legalEntityId }) => legalEntityId !== null);
  const actingOwnerAdministers = (legalEntityId: string) =>
    companies.some((row) => row.legalEntityId === legalEntityId && administration(owner, row));
  return {
    ...context,
    actingOwnerAdministers,
    active,
    scope: yield* operatorScopeOf({ ownerId: owner, tenantId: reading.tenantId }),
  };
});

/**
 * Plans one person leaving a tenant that stays, as the governed "person leaves" command does when the tenant owner
 * ends somebody's membership: Core's membership-end planner, run as the owner acting for the stage operator, ends the
 * tenant member row and everything that stood on it, and refuses the last administrator of any scope, counting only
 * a management row that administers at the decision time: started, not run out, held by an active person over a
 * live membership path (a tenant owner was refused with the tenant's facts).
 * Before that it refuses whatever the departure would leave projectable and whatever it would take from somebody else: a binding of another login or
 * credential, a live delegation the person granted or manages, a team place and a live agent connection. The
 * person's connected apps do not refuse it: their bindings are revoked with the login's and the apps still live are
 * ended (`stageCredentialEndingOf`). Every refusal is decided here; nothing is written.
 */
const retirementOf = Effect.fn('StageContextBootstrap.retirementOf')(function* retirementOfEffect(
  transaction: CoreTransaction,
  retired: StageRetiredPrincipalIdentity,
  view: StagePeopleView,
  decision: TenantDecision,
  connectedApps: readonly StageConnectedApp[],
): Effect.fn.Return<PrincipalRetirement, StageContextBootstrapError> {
  const { at, scope } = decision;
  yield* installOperationalScope(transaction, scope, decision.enrollment).pipe(
    Effect.mapError(bootstrapFailureFromCause),
  );
  const [[principal], bindings, connections] = yield* Effect.all(
    [
      transaction
        .select({ kind: principals.kind, status: principals.status })
        .from(principals)
        .where(and(eq(principals.tenantId, retired.tenantId), eq(principals.principalId, retired.principalId)))
        .limit(1),
      // Row-locked: no binding is re-enabled or rewritten between this read and its revocation.
      transaction
        .select({
          authenticationNamespaceId: principalAuthBindings.authenticationNamespaceId,
          bindingRevision: principalAuthBindings.bindingRevision,
          principalAuthBindingId: principalAuthBindings.principalAuthBindingId,
          provider: principalAuthBindings.provider,
          providerSubjectId: principalAuthBindings.providerSubjectId,
          status: principalAuthBindings.status,
          subjectType: principalAuthBindings.subjectType,
        })
        .from(principalAuthBindings)
        .where(
          and(
            eq(principalAuthBindings.tenantId, retired.tenantId),
            eq(principalAuthBindings.principalId, retired.principalId),
          ),
        )
        .orderBy(principalAuthBindings.principalAuthBindingId)
        .for('update'),
      transaction
        .select({
          connectionId: accessAgentConnections.connectionId,
          validUntil: accessAgentConnections.validUntil,
        })
        .from(accessAgentConnections)
        .where(
          and(
            eq(accessAgentConnections.tenantId, retired.tenantId),
            eq(accessAgentConnections.principalId, retired.principalId),
            eq(accessAgentConnections.status, 'active'),
          ),
        )
        .orderBy(accessAgentConnections.connectionId)
        .for('update'),
    ],
    { concurrency: 1 },
  ).pipe(Effect.mapError(bootstrapFailureFromCause));
  if (principal?.kind !== 'human') {
    return yield* failure('A retired stage Principal must be a person of its tenant');
  }
  const leaver = PrincipalIdSchema.make(retired.principalId);
  const holder: Holder = { _tag: 'Principal', principalId: leaver };
  const credentials = yield* stageCredentialEndingOf({
    actingOwnerAdministers: decision.actingOwnerAdministers,
    authenticationNamespaceId: decision.authenticationNamespaceId,
    bindings,
    connectedApps,
    principalStatus: principal.status,
    providerUserId: retired.providerUserId,
  });
  const delegations = view.delegations.filter(
    (delegation) =>
      (delegation.grantedBy === leaver || delegation.managerId === leaver) &&
      delegation.status === 'active' &&
      at < delegation.validUntil,
  );
  if (delegations.length > 0) {
    return yield* failure(
      `A retired stage Principal must hold no live delegation; it granted or manages ${delegations.length}, revoke them through People first`,
    );
  }
  if (view.teams.some(({ members }) => members.some((member) => sameHolder(member.holder, holder)))) {
    return yield* failure('A retired stage Principal must hold no team place; remove it through People first');
  }
  if (connections.some(({ validUntil }) => at < asDate(validUntil))) {
    return yield* failure('A retired stage Principal must operate no live agent connection; end it first');
  }
  const { tenantScopeId } = view;
  const ending =
    tenantScopeId === undefined
      ? undefined
      : view.memberships.find(
          (membership) =>
            membership.scopeId === tenantScopeId &&
            membership.kind === 'member' &&
            membership.status !== 'revoked' &&
            sameHolder(membership.holder, holder) &&
            membership.validFrom <= at &&
            (membership.validUntil === undefined || at < membership.validUntil),
        );
  // Only a management row that administers at the decision time counts for somebody who stays; the leaver's own rows
  // decide what they give up, and member rows only carry the paths.
  const counted = (scopeId: AccessScopeId) => {
    const administers = administersAt({
      active: decision.active,
      at,
      memberships: view.memberships,
      tenantScopeId: scopeId,
    });
    return view.memberships.filter(
      (membership) =>
        membership.kind === 'member' ||
        personIdsOf(membership.holder).includes(retired.principalId) ||
        administers(membership),
    );
  };
  const peopleWrites =
    ending === undefined || tenantScopeId === undefined
      ? []
      : (yield* planMembershipEnd({
          actor: PrincipalIdSchema.make(scope.principalId),
          administration: administrationOf(counted(tenantScopeId), tenantScopeId, at),
          assignments: view.assignments,
          at,
          delegations: view.delegations,
          membershipId: ending.id,
          memberships: view.memberships,
          nextStatus: 'revoked',
          reason: STAGE_RETIREMENT_REASON,
          scopeId: tenantScopeId,
          teamMembers: view.teams.flatMap(({ members }) => members),
          teams: view.teams.map(({ team }) => team),
          tenantId: TenantIdSchema.make(retired.tenantId),
        }).pipe(
          Effect.mapError((refusal) =>
            failure(
              `A retired stage Principal leaves only as People allows: ${refusal.code}: ${refusal.reason}`,
              refusal,
            ),
          ),
        )).writes;
  // The departure must end everything the person still holds; a row it would leave behind is refused, not ignored.
  const ended = endedIdsOf(peopleWrites);
  const leftover =
    view.memberships.some(
      (membership) => sameHolder(membership.holder, holder) && notEnded(membership, at) && !ended.has(membership.id),
    ) ||
    view.assignments.some(
      (assignment) =>
        sameHolder(assignment.holder, holder) && notEnded(assignment, at) && !ended.has(assignment.incarnationId),
    );
  if (leftover) {
    return yield* failure(
      'A retired stage Principal holds a membership or assignment its departure does not end; end it through People first',
    );
  }
  const companies = yield* transaction
    .select({ legalEntityId: legalEntities.legalEntityId, status: legalEntities.status })
    .from(legalEntities)
    .where(eq(legalEntities.tenantId, retired.tenantId))
    .pipe(Effect.mapError(bootstrapFailureFromCause));
  const directory = yield* Effect.forEach(
    companies,
    Effect.fn(function* directoryDepartureOf(company) {
      const companyScope = yield* operatorScopeOf({
        legalEntityId: company.legalEntityId,
        ownerId: scope.principalId,
        tenantId: retired.tenantId,
      });
      yield* installOperationalScope(transaction, companyScope, decision.enrollment).pipe(
        Effect.mapError(bootstrapFailureFromCause),
      );
      const [row] = yield* transaction
        .select({
          affiliation: principalCompanyMemberships.affiliation,
          revision: principalCompanyMemberships.revision,
          status: principalCompanyMemberships.status,
        })
        .from(principalCompanyMemberships)
        .where(
          and(
            eq(principalCompanyMemberships.tenantId, retired.tenantId),
            eq(principalCompanyMemberships.legalEntityId, company.legalEntityId),
            eq(principalCompanyMemberships.principalId, retired.principalId),
          ),
        )
        .pipe(Effect.mapError(bootstrapFailureFromCause));
      if (row === undefined || row.status === 'departed') {
        return [];
      }
      if (company.status !== 'active' || row.affiliation === null) {
        return yield* failure('A retired stage Principal holds a company directory membership Core cannot end');
      }
      return [{ affiliation: row.affiliation, revision: row.revision, scope: companyScope }];
    }),
    { concurrency: 1 },
  );
  return {
    archive: !credentials.replay,
    bindings: credentials.bindings,
    connectedApps: credentials.connectedApps,
    connectionIds: connections.map(({ connectionId }) => connectionId),
    directory: directory.flat(),
    expectedRevision: peopleRevisionOfView(view),
    peopleWrites,
    scope,
  };
});

/**
 * Writes one planned departure as the tenant owner acting for the stage operator: the People plan through the People
 * store (which re-checks the revision it was planned on under the tenant's People lock), the company directory
 * memberships through Core's directory writer, then exactly the bindings the run read, each by compare-and-set, the
 * connected apps still live through Core's grant transition, and the Principal. A binding, grant or connection set that
 * moved since the decision rolls the whole file back.
 */
const writeRetirement = Effect.fn('StageContextBootstrap.writeRetirement')(function* writeRetirementEffect(
  transaction: CoreTransaction,
  retired: StageRetiredPrincipalIdentity,
  retirement: PrincipalRetirement,
  context: { readonly at: Date; readonly enrollment: DatabaseIdentityEnrollment },
): Effect.fn.Return<void, StageContextBootstrapError, AccessPeopleStore> {
  if (retirement.peopleWrites.length > 0) {
    yield* (yield* AccessPeopleStore)
      .applyPeopleChange(retirement.scope, {
        expectedRevision: retirement.expectedRevision,
        writes: retirement.peopleWrites,
      })
      .pipe(Effect.mapError((cause) => failure(`${cause.code}: ${cause.reason}`, cause)));
  }
  yield* Effect.forEach(
    retirement.directory,
    Effect.fn(function* endDirectoryMembership(departure) {
      const scoped = yield* installOperationalScope(transaction, departure.scope, context.enrollment).pipe(
        Effect.mapError(bootstrapFailureFromCause),
      );
      yield* companyMembershipManagementFromTransaction(scoped)
        .set({
          affiliation: Option.some(departure.affiliation),
          expectedRevision: departure.revision,
          principalRef: { principalId: retired.principalId, tenantId: retired.tenantId },
          status: 'departed',
        })
        .pipe(Effect.mapError((cause) => failure(`${cause.code}: ${cause.reason}`, cause)));
    }),
    { concurrency: 1, discard: true },
  );
  yield* installOperationalScope(transaction, retirement.scope, context.enrollment).pipe(
    Effect.mapError(bootstrapFailureFromCause),
  );
  const revoked =
    retirement.bindings.length === 0
      ? []
      : yield* transaction
          .update(principalAuthBindings)
          .set({
            bindingRevision: sql`${principalAuthBindings.bindingRevision} + 1`,
            revokedAt: context.at,
            status: 'revoked',
            updatedAt: context.at,
          })
          .where(
            and(
              eq(principalAuthBindings.tenantId, retired.tenantId),
              eq(principalAuthBindings.principalId, retired.principalId),
              or(
                ...retirement.bindings.map((binding) =>
                  and(
                    eq(principalAuthBindings.principalAuthBindingId, binding.id),
                    eq(principalAuthBindings.bindingRevision, binding.revision),
                    eq(principalAuthBindings.status, binding.status),
                  ),
                ),
              ),
            ),
          )
          .returning({ id: principalAuthBindings.principalAuthBindingId })
          .pipe(Effect.mapError(bootstrapFailureFromCause));
  // Each connected app still live ends through Core's grant transition, as a company administrator ends somebody else's
  // connection in the product: an approved grant is revoked, a draft consent denied, both attributed to the acting
  // owner. Its binding was revoked above, so the transition, which only disables an active one, leaves it revoked.
  const ended = yield* Effect.forEach(
    retirement.connectedApps,
    (app) => {
      const status = app.status === 'draft' ? 'denied' : 'revoked';
      return transitionOAuthGrant(transaction, {
        grantId: app.grantId,
        revokedByPrincipalId: retirement.scope.principalId,
        revokeReason: status === 'revoked' ? 'admin' : null,
        status,
      }).pipe(
        Effect.map(Option.exists((grant) => grant.status === status)),
        Effect.mapError((cause) =>
          failure(
            `The connected app ${app.clientName} (${app.clientId}) of a retired stage Principal could not be ended`,
            cause,
          ),
        ),
      );
    },
    { concurrency: 1 },
  );
  const [unrevoked, connections] = yield* Effect.all(
    [
      transaction
        .select({ id: principalAuthBindings.principalAuthBindingId })
        .from(principalAuthBindings)
        .where(
          and(
            eq(principalAuthBindings.tenantId, retired.tenantId),
            eq(principalAuthBindings.principalId, retired.principalId),
            ne(principalAuthBindings.status, 'revoked'),
          ),
        ),
      transaction
        .select({ connectionId: accessAgentConnections.connectionId })
        .from(accessAgentConnections)
        .where(
          and(
            eq(accessAgentConnections.tenantId, retired.tenantId),
            eq(accessAgentConnections.principalId, retired.principalId),
            eq(accessAgentConnections.status, 'active'),
          ),
        )
        .orderBy(accessAgentConnections.connectionId),
    ],
    { concurrency: 1 },
  ).pipe(Effect.mapError(bootstrapFailureFromCause));
  const witnessed =
    revoked.length === retirement.bindings.length &&
    ended.every(Boolean) &&
    unrevoked.length === 0 &&
    connections.map(({ connectionId }) => connectionId).join(',') === retirement.connectionIds.join(',');
  if (!witnessed) {
    return yield* failure(
      'A binding, connected app or agent connection of a retired stage Principal changed after the run decided; nothing of the file is written',
    );
  }
  if (retirement.archive) {
    yield* transaction
      .update(principals)
      .set({ status: 'archived' })
      .where(
        and(
          eq(principals.tenantId, retired.tenantId),
          eq(principals.principalId, retired.principalId),
          ne(principals.status, 'archived'),
        ),
      )
      .pipe(Effect.mapError(bootstrapFailureFromCause));
  }
  return yield* Effect.void;
});

/** The departures of one tenant planned so far, and the people intent the next one is planned on. */
interface PlannedRetirements {
  readonly plans: readonly {
    readonly retired: StageRetiredPrincipalIdentity;
    readonly retirement: PrincipalRetirement;
  }[];
  readonly view: StagePeopleView;
}

/**
 * Every attached login and retired Principal of one operator file, in ONE transaction: each tenant's People lock,
 * then every leaver's connected apps, Principal row, bindings and connections, then each tenant's administrators' Principal
 * rows and the membership rows of those who stay, then the decision time, then every refusal decided from what the transaction reads, and only then every
 * write. A refusal writes nothing, and a run that stops after the commit is completed by running the same file again,
 * which finds each move already made and reconciles its tenants. It returns every connected app of the people it
 * retires, those it ended and those that had ended, so the Shell can drop the Better Auth tokens of each.
 */
const moveLogins = Effect.fn('StageContextBootstrap.moveLogins')(function* moveLoginsEffect(
  transaction: CoreTransaction,
  input: Pick<StageContextBootstrapInput, 'attachedLogins' | 'retiredPrincipals'>,
  context: {
    readonly authenticationNamespaceId: string;
    readonly enrollment: DatabaseIdentityEnrollment;
  },
): Effect.fn.Return<
  readonly StageRetiredConnectedApp[],
  StageContextBootstrapError,
  AccessMembershipStore | AccessPeopleStore | AccessTeamStore
> {
  const retiredTenantIds = [...new Set(input.retiredPrincipals.map(({ tenantId }) => tenantId))].toSorted();
  const leaversOf = (tenantId: string) => input.retiredPrincipals.filter((retired) => retired.tenantId === tenantId);
  yield* Effect.forEach(retiredTenantIds, (tenantId) => lockTenantPeople(transaction, tenantId), {
    concurrency: 1,
    discard: true,
  });
  const connectedApps = (yield* Effect.forEach(
    retiredTenantIds,
    (tenantId) => lockLeavers(transaction, leaversOf(tenantId), context.enrollment),
    { concurrency: 1 },
  )).flat();
  const locked = yield* Effect.forEach(
    retiredTenantIds,
    Effect.fn(function* lockTenant(tenantId) {
      const leavers = leaversOf(tenantId);
      const [first] = leavers;
      if (first === undefined) {
        return [];
      }
      // The people intent is read under a leaver's installer scope, which only selects the tenant; every decision
      // and write below runs as the tenant owner acting for the stage operator.
      const reading = yield* stageScopeOf(first);
      const view = yield* peopleViewOf(reading);
      const administrators = yield* lockAdministrators(transaction, view, leavers, reading, context.enrollment);
      return [{ ...administrators, leavers, reading, view } satisfies LockedTenant];
    }),
    { concurrency: 1 },
  );
  // Decided now, after every wait for a lock: a row that ran out while this run waited no longer counts, and one that
  // has not started yet does not count either.
  const decided = { ...context, at: yield* DateTime.nowAsDate };
  const attachments = yield* Effect.forEach(
    input.attachedLogins,
    (login) => attachmentOf(transaction, login, context.authenticationNamespaceId),
    { concurrency: 1 },
  );
  const retirements = yield* Effect.forEach(
    locked.flat(),
    Effect.fn(function* tenantRetirementsOf(tenant) {
      const { leavers, view } = tenant;
      const decision = yield* tenantDecisionOf(tenant, decided);
      const planned = yield* Effect.reduce(
        leavers,
        (): PlannedRetirements => ({ plans: [], view }),
        (state, retired) =>
          retirementOf(
            transaction,
            retired,
            state.view,
            decision,
            connectedApps.filter(({ principalId }) => principalId === retired.principalId),
          ).pipe(
            Effect.map((retirement): PlannedRetirements => ({
              plans: [...state.plans, { retired, retirement }],
              view: viewAfter(state.view, retirement.peopleWrites),
            })),
          ),
      );
      return planned.plans;
    }),
    { concurrency: 1 },
  );
  yield* Effect.forEach(
    input.attachedLogins.filter((_login, index) => attachments[index] === 'create'),
    Effect.fn(function* createAttachment(login) {
      yield* transaction
        .insert(principals)
        .values(
          bootstrapPrincipalRecord({
            principalDisplayName: login.displayName,
            principalId: login.principalId,
            tenantId: login.tenantId,
          }),
        )
        .pipe(Effect.mapError(bootstrapFailureFromCause));
      yield* transaction
        .insert(principalAuthBindings)
        .values({
          authenticationNamespaceId: context.authenticationNamespaceId,
          principalAuthBindingId: login.authBindingId,
          principalId: login.principalId,
          provider: 'better_auth',
          providerSubjectId: login.providerUserId,
          status: 'active',
          subjectType: 'user',
          tenantId: login.tenantId,
        })
        .pipe(Effect.mapError(bootstrapFailureFromCause));
    }),
    { concurrency: 1, discard: true },
  );
  const plans = retirements.flat();
  yield* Effect.forEach(
    plans,
    ({ retired, retirement }) => writeRetirement(transaction, retired, retirement, decided),
    {
      concurrency: 1,
      discard: true,
    },
  );
  const endedBy = new Map(
    plans.flatMap(({ retirement }) =>
      retirement.connectedApps.map(({ grantId }) => [grantId, retirement.scope.principalId] as const),
    ),
  );
  return connectedApps.map((app) => retiredConnectedAppOf(app, endedBy.get(app.grantId)));
});

const runTenantTransaction = <Value, Requirements>(
  executor: CoreDatabaseExecutor,
  body: (transaction: CoreTransaction) => Effect.Effect<Value, StageContextBootstrapError, Requirements>,
): Effect.Effect<Value, StageContextBootstrapError, Requirements> =>
  executor.transaction(body).pipe(
    Effect.catchDefect((defect) => (isSqlError(defect) ? Effect.fail(defect) : Effect.die(defect))),
    Effect.catchTag('SqlError', (sqlFailure) => Effect.fail(bootstrapFailureFromCause(sqlFailure))),
  );

/** What one stage run reconciled: its accounts, and every connected app of the people it retired. */
export interface StageContextBootstrapRun {
  readonly accounts: readonly StageContextBootstrapResult[];
  readonly connectedApps: readonly StageRetiredConnectedApp[];
}

/**
 * Every connected app of a tenant's people of the file whose departure an earlier run of it completed: the person is
 * archived, every binding of theirs is revoked and one of them is the login's (the exact replay
 * `stageCredentialEndingOf` accepts), and no app of theirs is still live. Anybody else is left to the run.
 */
const completedRetirementsOfTenant = Effect.fn('StageContextBootstrap.completedRetirementsOfTenant')(
  function* completedRetirementsOfTenantEffect(
    transaction: CoreTransaction,
    leavers: readonly StageRetiredPrincipalIdentity[],
    context: { readonly authenticationNamespaceId: string; readonly enrollment: DatabaseIdentityEnrollment },
  ): Effect.fn.Return<readonly StageRetiredConnectedApp[], StageContextBootstrapError> {
    const [first] = leavers;
    if (first === undefined) {
      return [];
    }
    // A leaver's installer scope only selects the tenant for row security; it locks and attributes nothing.
    yield* installOperationalScope(transaction, yield* stageScopeOf(first), context.enrollment).pipe(
      Effect.mapError(bootstrapFailureFromCause),
    );
    const leaverIds = leavers.map(({ principalId }) => principalId);
    const [people, bindings, apps] = yield* Effect.all(
      [
        transaction
          .select({ kind: principals.kind, principalId: principals.principalId, status: principals.status })
          .from(principals)
          .where(and(eq(principals.tenantId, first.tenantId), inArray(principals.principalId, leaverIds))),
        transaction
          .select({
            authenticationNamespaceId: principalAuthBindings.authenticationNamespaceId,
            bindingRevision: principalAuthBindings.bindingRevision,
            principalAuthBindingId: principalAuthBindings.principalAuthBindingId,
            principalId: principalAuthBindings.principalId,
            provider: principalAuthBindings.provider,
            providerSubjectId: principalAuthBindings.providerSubjectId,
            status: principalAuthBindings.status,
            subjectType: principalAuthBindings.subjectType,
          })
          .from(principalAuthBindings)
          .where(
            and(
              eq(principalAuthBindings.tenantId, first.tenantId),
              inArray(principalAuthBindings.principalId, leaverIds),
            ),
          )
          .orderBy(principalAuthBindings.principalAuthBindingId),
        transaction
          .select(connectedAppColumns)
          .from(oauthConnectionGrants)
          .where(
            and(
              eq(oauthConnectionGrants.tenantId, first.tenantId),
              inArray(oauthConnectionGrants.actingPrincipalId, leaverIds),
            ),
          )
          .orderBy(oauthConnectionGrants.grantId),
      ],
      { concurrency: 1 },
    ).pipe(Effect.mapError(bootstrapFailureFromCause));
    const completed = yield* Effect.forEach(
      leavers,
      (retired): Effect.Effect<readonly StageRetiredConnectedApp[]> => {
        const person = people.find(({ principalId }) => principalId === retired.principalId);
        const own = apps.filter(({ principalId }) => principalId === retired.principalId);
        if (person?.kind !== 'human' || person.status !== 'archived') {
          return Effect.succeed([]);
        }
        return stageCredentialEndingOf({
          // A completed departure has nothing live left to end, so nobody's administration is asked.
          actingOwnerAdministers: () => false,
          authenticationNamespaceId: context.authenticationNamespaceId,
          bindings: bindings.filter(({ principalId }) => principalId === retired.principalId),
          connectedApps: own,
          principalStatus: person.status,
          providerUserId: retired.providerUserId,
        }).pipe(
          Effect.option,
          Effect.map((ending) =>
            Option.isSome(ending) && ending.value.replay && ending.value.connectedApps.length === 0
              ? own.map((app) => retiredConnectedAppOf(app))
              : [],
          ),
        );
      },
      { concurrency: 1 },
    );
    return completed.flat();
  },
);

/**
 * Every connected app of the people of the file whose departure an earlier run of it already completed, read in a
 * transaction of its own that writes and locks nothing, before the run. The Shell finishes the clean-up after such a
 * departure (the Better Auth tokens and consent, and the revocation event) from it, so a run that stopped between its
 * commit and that clean-up is finished by the same file even when the run itself then refuses the file for something
 * else in it, such as a login it attached whose Principal has since connected an app. The run's own rules, the exact
 * replay of a departure and of an attachment included, are unchanged.
 */
export const completedStageRetirementsOf = Effect.fn('StageContextBootstrap.completedStageRetirementsOf')(
  function* completedStageRetirementsOfEffect(
    retiredPrincipals: readonly StageRetiredPrincipalIdentity[],
    options: Pick<StageContextBootstrapOptions, 'authenticationNamespaceId'>,
  ): Effect.fn.Return<
    readonly StageRetiredConnectedApp[],
    StageContextBootstrapError,
    CoreDatabase | DatabaseIdentityEnrollmentContext
  > {
    if (retiredPrincipals.length === 0) {
      return [];
    }
    const { executor } = yield* CoreDatabase;
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    const tenantIds = [...new Set(retiredPrincipals.map(({ tenantId }) => tenantId))].toSorted();
    const completed = yield* runTenantTransaction(executor, (transaction) =>
      Effect.forEach(
        tenantIds,
        (tenantId) =>
          completedRetirementsOfTenant(
            transaction,
            retiredPrincipals.filter((retired) => retired.tenantId === tenantId),
            { authenticationNamespaceId: options.authenticationNamespaceId, enrollment },
          ),
        { concurrency: 1 },
      ),
    );
    return completed.flat();
  },
);

/** The grants among `grantIds` that an `oauth.connection.revoked` event of one company names. */
const recordedRevocationsInCompany = Effect.fn('StageContextBootstrap.recordedRevocationsInCompany')(
  function* recordedRevocationsInCompanyEffect(
    transaction: CoreTransaction,
    company: { readonly grantIds: readonly string[]; readonly legalEntityId: string; readonly tenantId: string },
  ) {
    const grantIdOf = sql<string>`${auditEvents.evidenceJson} ->> 'grantId'`;
    // The observation scope the product's audit writer records in.
    yield* transaction.execute(
      sql`select set_config('ontos.tenant_id', ${company.tenantId}, true), set_config('ontos.legal_entity_id', ${company.legalEntityId}, true)`,
    );
    return yield* transaction
      .select({ grantId: grantIdOf })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, company.tenantId),
          eq(auditEvents.legalEntityId, company.legalEntityId),
          eq(auditEvents.eventType, 'oauth.connection.revoked'),
          inArray(grantIdOf, [...company.grantIds]),
        ),
      );
  },
  Effect.mapError(bootstrapFailureFromCause),
);

/** The company a connected app acts in, as one key. */
const companyKeyOf = ({ legalEntityId, tenantId }: Pick<StageConnectedApp, 'legalEntityId' | 'tenantId'>) =>
  `${tenantId}:${legalEntityId}`;

/**
 * The grants among `apps` whose revocation the product's audit already records: an `oauth.connection.revoked` event
 * naming the grant, in the company the product's audit writer records it in. The Shell writes that event for a
 * connected app an administrator revoked only when this finds none, so the same file run again never writes it twice.
 */
export const recordedConnectionRevocationsOf = Effect.fn('StageContextBootstrap.recordedConnectionRevocationsOf')(
  function* recordedConnectionRevocationsOfEffect(
    apps: readonly Pick<StageConnectedApp, 'grantId' | 'legalEntityId' | 'tenantId'>[],
  ): Effect.fn.Return<ReadonlySet<string>, StageContextBootstrapError, CoreDatabase> {
    const { executor } = yield* CoreDatabase;
    const companies = [...new Map(apps.map((app) => [companyKeyOf(app), app] as const)).values()].map((first) => ({
      grantIds: apps.flatMap((app) => (companyKeyOf(app) === companyKeyOf(first) ? [app.grantId] : [])),
      legalEntityId: first.legalEntityId,
      tenantId: first.tenantId,
    }));
    const recorded = yield* Effect.forEach(
      companies,
      (company) => runTenantTransaction(executor, (transaction) => recordedRevocationsInCompany(transaction, company)),
      { concurrency: 1 },
    );
    return new Set(recorded.flat().map(({ grantId }) => grantId));
  },
);

/** Everything one stage run reconciles, as the operator accounts file names it. */
export interface StageContextBootstrapInput {
  readonly attachedLogins: readonly StageAttachedLoginIdentity[];
  readonly retiredPrincipals: readonly StageRetiredPrincipalIdentity[];
  readonly retiredTenants: readonly StageRetiredTenant[];
  readonly tenants: readonly StageTenantBootstrap[];
}

/** Every refusal a stage run decides before it writes anything, or `undefined` when it may run. */
export const stageBootstrapRefusal = (
  input: StageContextBootstrapInput,
  options: StageContextBootstrapOptions,
): StageContextBootstrapError | undefined => {
  // An operator file may only attach or retire logins, or retire its last tenant, so an empty tenant list is
  // only a refusal when there is nothing at all to reconcile.
  if (
    input.tenants.length === 0 &&
    input.retiredTenants.length === 0 &&
    input.attachedLogins.length === 0 &&
    input.retiredPrincipals.length === 0
  ) {
    return failure('At least one stage account, attached login or retirement is required');
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
 * Reconciles every stage tenant from the operator accounts file, attaches the logins it attaches, and retires
 * the Principals and tenants it retires. The logins move first, all in one transaction, so a refusal stops the
 * run before it writes anything. Results follow the order of the accounts; one transaction writes each
 * tenant's identity rows, one bootstrap creates its authority, and one reconcile projects it.
 */
export const reconcileStageContextBootstraps = Effect.fn('StageContextBootstrap.reconcileStageContextBootstraps')(
  function* reconcileStageContextsEffect(
    input: StageContextBootstrapInput,
    options: StageContextBootstrapOptions,
  ): Effect.fn.Return<
    StageContextBootstrapRun,
    StageContextBootstrapError,
    AccessPeopleStore | AccessTeamStore | DatabaseIdentityEnrollmentContext | InstallationRuntime
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
    const connectedApps =
      input.attachedLogins.length > 0 || input.retiredPrincipals.length > 0
        ? yield* runTenantTransaction(executor, (transaction) =>
            moveLogins(transaction, input, {
              authenticationNamespaceId: options.authenticationNamespaceId,
              enrollment,
            }),
          )
        : [];
    // Each tenant a person left is projected from the intent that remains. The intent committed above is the
    // durable record: a run interrupted before this point is completed by the same file, whose second run
    // finds every move made, writes nothing and reaches this reconcile again.
    yield* Effect.forEach(
      new Map(
        input.retiredPrincipals.map((retired): readonly [string, StageRetiredPrincipalIdentity] => [
          retired.tenantId,
          retired,
        ]),
      ).values(),
      Effect.fn(function* reconcileLeftTenant(retired) {
        const scope = yield* stageScopeOf(retired);
        yield* writer
          .reconcileTenant({ scope })
          .pipe(Effect.mapError((cause) => failure(`${cause.code}: ${cause.reason}`, cause)));
      }),
      { concurrency: 1, discard: true },
    );
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
    return { accounts: results.flat(), connectedApps };
  },
);
