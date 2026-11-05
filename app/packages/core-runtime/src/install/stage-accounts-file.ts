import { Effect, FileSystem, Schema } from 'effect';

import { WorkloadKeySchema } from '../authorization/access-declaration.ts';

/** Environment variable naming the operator-provided stage accounts file (JSON, mode 600, outside the repo). */
export const STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY = 'ONTOS_STAGE_ACCOUNTS_FILE';

const TrimmedNonEmptyString = Schema.Trim.check(Schema.isNonEmpty());
const uuid = Schema.String.check(Schema.isUUID());
const TenantIdSchema = uuid.pipe(Schema.brand('TenantId'));
const LegalEntityIdSchema = uuid.pipe(Schema.brand('LegalEntityId'));
const ModuleStateIdSchema = uuid.pipe(Schema.brand('ModuleStateId'));
const PrincipalIdSchema = uuid.pipe(Schema.brand('PrincipalId'));
const AuthBindingIdSchema = uuid.pipe(Schema.brand('AuthBindingId'));
const SlugSchema = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u));
/**
 * The roles one stage account holds, as data. `full_access` is the tenant's own "Plný přístup" role,
 * which the bootstrap compiles from the release; role templates arrive with the role editor and extend
 * this list, so the closed literal is the whole vocabulary an operator may name today (O67-Q6).
 */
const StageAccountRoleSchema = Schema.Literal('full_access');
const AccountEmailSchema = Schema.Trim.check(
  Schema.isNonEmpty(),
  Schema.makeFilter((value) => (/^[^\s@]+@[^\s@]+$/u.test(value) ? undefined : 'must be an email address')),
);

/**
 * The v2 authority one stage account holds, as data (CUTOVER-PLAN §3.5). `owner` names the one account
 * that owns the tenant — it is the principal `bootstrapTenantAccess` creates the tenant's scopes,
 * memberships and "Plný přístup" assignment for. `roles` lists what a further account holds beside its
 * membership; nothing in code assigns rights by account kind.
 */
const StageAccountGrantsSchema = Schema.Struct({
  owner: Schema.Boolean,
  roles: Schema.Array(StageAccountRoleSchema),
});

const StageAccountSchema = Schema.Struct({
  authBindingId: AuthBindingIdSchema,
  displayName: TrimmedNonEmptyString,
  email: AccountEmailSchema,
  grants: StageAccountGrantsSchema,
  password: Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(8))),
  principalId: PrincipalIdSchema,
});

/**
 * The machine workloads a carrier declares with `accessWorkload`: external integrations only. Module-to-module
 * calls register no workload; the receiving carrier declares the calling module with `accessActor` instead.
 */
export const STAGE_DECLARED_WORKLOAD_KEYS: ReadonlySet<string> = new Set([
  'commerce.storefront-client',
  'core.identity-provider',
]);
const StageWorkloadKeySchema = WorkloadKeySchema.check(
  Schema.makeFilter((key) =>
    STAGE_DECLARED_WORKLOAD_KEYS.has(key) ? undefined : 'names no workload a carrier declares',
  ),
);

const StageTenantSchema = Schema.Struct({
  accounts: Schema.NonEmptyArray(StageAccountSchema),
  defaultLocale: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  legalEntity: Schema.Struct({
    legalEntityId: LegalEntityIdSchema,
    legalName: TrimmedNonEmptyString,
    registrationCountry: Schema.String.check(Schema.isPattern(/^[A-Z]{2}$/u)),
    registrationNumber: TrimmedNonEmptyString,
  }),
  moduleStateId: ModuleStateIdSchema,
  slug: SlugSchema,
  tenantId: TenantIdSchema,
  /**
   * The trusted machine workloads this tenant registers, as operator data (O73). Each names a
   * principal of the tenant and one `<module>.<workload-name>` key the principal may run; the stage
   * bootstrap writes the binding through Core's own registry, so a workload Action admits exactly
   * the principals the operator declared and nothing else.
   */
  workloads: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        principalId: PrincipalIdSchema,
        workloadKey: StageWorkloadKeySchema,
      }),
    ),
  ),
});

/** A former stage Tenant whose authority ends and whose Core rows are archived. */
const StageRetiredTenantSchema = Schema.Struct({
  legalEntityId: LegalEntityIdSchema,
  /** Non-empty: the retired tenant is reconciled under the scope of a principal that is leaving it. */
  principalIds: Schema.NonEmptyArray(PrincipalIdSchema),
  tenantId: TenantIdSchema,
});

/**
 * The operator stage accounts file. Its values never enter source control; only this shape does.
 * The number of Tenants and accounts, their identifiers, and their grants are all data.
 */
const StageAccountsFileSchema = Schema.Struct({
  retiredAccountEmails: Schema.Array(AccountEmailSchema),
  retiredTenants: Schema.Array(StageRetiredTenantSchema),
  schemaVersion: Schema.Literal(2),
  tenants: Schema.NonEmptyArray(StageTenantSchema),
});

export type StageAccountsFile = typeof StageAccountsFileSchema.Type;
export type StageTenant = StageAccountsFile['tenants'][number];
export type StageAccount = StageTenant['accounts'][number];
export type StageRetiredTenant = StageAccountsFile['retiredTenants'][number];
export type StageAccountRole = StageAccount['grants']['roles'][number];

/** The accounts file as read by the operator runtime: its text and POSIX permission bits. */
export interface StageAccountsFileContents {
  readonly mode: number;
  readonly source: string;
}

export class StageAccountsFileError extends Schema.TaggedError<StageAccountsFileError>()('StageAccountsFileError', {
  cause: Schema.optionalKey(Schema.Defect()),
  reason: Schema.String,
}) {}

const invalid = (reason: string, cause?: unknown): StageAccountsFileError =>
  new StageAccountsFileError(cause === undefined ? { reason } : { cause, reason });

/** The low six permission bits are the group and other read/write/execute flags. */
const GROUP_AND_OTHER_PERMISSION_RANGE = 0o100;

const hasDuplicates = (values: readonly string[]): boolean =>
  new Set(values.map((value) => value.toLowerCase())).size !== values.length;

/**
 * Validates the operator accounts file without echoing any of its values: owner-only permissions,
 * the documented schema, unique identifiers and emails, grants that name only schema relations,
 * and retired data that never overlaps an active Tenant or account.
 */
export const parseStageAccountsFile = Effect.fn('StageAccountsFile.parse')(function* parseAccountsFile(
  contents: StageAccountsFileContents,
) {
  if (contents.mode % GROUP_AND_OTHER_PERMISSION_RANGE !== 0) {
    return yield* invalid(
      `The ${STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY} file must be readable only by its owner (chmod 600)`,
    );
  }
  const file = yield* Schema.decodeEffect(Schema.fromJsonString(StageAccountsFileSchema), {
    onExcessProperty: 'error',
  })(contents.source).pipe(
    Effect.mapError((cause) =>
      invalid(`The ${STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY} file does not match the documented schema`, cause),
    ),
  );
  const accounts = file.tenants.flatMap(({ accounts: tenantAccounts }) => tenantAccounts);
  const activeTenantIds = file.tenants.map(({ tenantId }) => tenantId);
  const activePrincipalIds = accounts.map(({ principalId }) => principalId);
  const activeTenantIdSet: ReadonlySet<string> = new Set(activeTenantIds);
  const activePrincipalIdSet: ReadonlySet<string> = new Set(activePrincipalIds);
  const activeEmails = new Set(accounts.map(({ email }) => email.toLowerCase()));
  if (
    hasDuplicates(activeTenantIds) ||
    hasDuplicates(file.tenants.map(({ slug }) => slug)) ||
    hasDuplicates(file.tenants.map(({ legalEntity }) => legalEntity.legalEntityId)) ||
    hasDuplicates(file.tenants.map(({ moduleStateId }) => moduleStateId)) ||
    hasDuplicates(activePrincipalIds) ||
    hasDuplicates(accounts.map(({ authBindingId }) => authBindingId))
  ) {
    return yield* invalid('Every stage Tenant, legal entity, module state, Principal, and binding needs its own ID');
  }
  if (activeEmails.size !== accounts.length) {
    return yield* invalid('Every stage account needs its own email');
  }
  if (accounts.some(({ grants }) => hasDuplicates(grants.roles))) {
    return yield* invalid('Stage account roles must be unique');
  }
  const tenantWorkloads = file.tenants.flatMap(({ workloads }) => workloads ?? []);
  if (tenantWorkloads.some(({ principalId }) => !activePrincipalIdSet.has(principalId))) {
    return yield* invalid('Every registered workload needs a principal of its own tenant');
  }
  if (
    file.tenants.some(({ workloads }) =>
      workloads === undefined
        ? false
        : new Set(workloads.map(({ principalId, workloadKey }) => `${principalId}:${workloadKey}`)).size !==
          workloads.length,
    )
  ) {
    return yield* invalid('A tenant may register each workload key for a principal only once');
  }
  if (
    file.tenants.some(
      ({ accounts: tenantAccounts }) => tenantAccounts.filter(({ grants }) => grants.owner).length === 0,
    )
  ) {
    return yield* invalid('Every stage Tenant needs exactly one owner account');
  }
  if (
    file.tenants.some(({ accounts: tenantAccounts }) => tenantAccounts.filter(({ grants }) => grants.owner).length > 1)
  ) {
    return yield* invalid('Every stage Tenant needs exactly one owner account');
  }
  const retiredEmails = file.retiredAccountEmails.map((email) => email.toLowerCase());
  if (hasDuplicates(retiredEmails) || retiredEmails.some((email) => activeEmails.has(email))) {
    return yield* invalid('Retired stage account emails must be unique and not belong to an active account');
  }
  if (
    hasDuplicates(file.retiredTenants.map(({ tenantId }) => tenantId)) ||
    file.retiredTenants.some(
      ({ principalIds, tenantId }) =>
        activeTenantIdSet.has(tenantId) || principalIds.some((principalId) => activePrincipalIdSet.has(principalId)),
    )
  ) {
    return yield* invalid('Retired stage Tenants must be unique and not overlap an active Tenant or Principal');
  }
  return file;
});

/** Reads the accounts file text and permission bits; failures never carry the file contents. */
export const readStageAccountsFileContents = Effect.fn('StageAccountsFile.read')(function* readContents(path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const [{ mode }, source] = yield* Effect.all([fileSystem.stat(path), fileSystem.readFileString(path, 'utf-8')], {
    concurrency: 2,
  }).pipe(
    Effect.mapError((cause) => invalid(`The ${STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY} file could not be read`, cause)),
  );
  return { mode, source } satisfies StageAccountsFileContents;
});
