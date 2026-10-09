import { Effect, FileSystem, Schema } from 'effect';

import { ONTOS_SPICEDB_SCHEMA } from '../permissions/schema.ts';

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
const ActionKeySchema = Schema.String.check(Schema.isPattern(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u)).pipe(
  Schema.brand('ActionKey'),
);
const RelationNameSchema = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]*$/u));
const AccountEmailSchema = Schema.Trim.check(
  Schema.isNonEmpty(),
  Schema.makeFilter((value) => (/^[^\s@]+@[^\s@]+$/u.test(value) ? undefined : 'must be an email address')),
);

/**
 * The SpiceDB grants one stage account holds, as data. `tenantRelations` are Principal relations on
 * the account's own Tenant; `explicitActions` lists the `explicit` Action keys the account executes,
 * or `"all"` for every current `explicit` Action. Nothing in code assigns rights by account kind.
 */
const StageAccountGrantsSchema = Schema.Struct({
  explicitActions: Schema.Union([Schema.Literal('all'), Schema.Array(ActionKeySchema)]),
  tenantRelations: Schema.Array(RelationNameSchema),
});

const StageAccountSchema = Schema.Struct({
  authBindingId: AuthBindingIdSchema,
  displayName: TrimmedNonEmptyString,
  email: AccountEmailSchema,
  grants: StageAccountGrantsSchema,
  password: Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(8))),
  principalId: PrincipalIdSchema,
});

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
});

/** A former stage Tenant whose bootstrap relationships are deleted and whose Core rows are archived. */
const StageRetiredTenantSchema = Schema.Struct({
  legalEntityId: LegalEntityIdSchema,
  principalIds: Schema.Array(PrincipalIdSchema),
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

const TENANT_DEFINITION_PATTERN = /definition tenant \{(?<body>[^}]*)\}/u;
const PRINCIPAL_RELATION_PATTERN = /relation (?<name>[a-z_]+): principal\b/gu;

/**
 * Principal relations the SpiceDB schema defines on `tenant`, except `member`, which the bootstrap
 * writes for every account. Grant data may name only these relations.
 */
export const STAGE_GRANTABLE_TENANT_RELATIONS: readonly string[] = Object.freeze(
  [
    ...(TENANT_DEFINITION_PATTERN.exec(ONTOS_SPICEDB_SCHEMA)?.groups?.['body'] ?? '').matchAll(
      PRINCIPAL_RELATION_PATTERN,
    ),
  ].flatMap((match) => {
    const relation = match.groups?.['name'];
    return relation === undefined || relation === 'member' ? [] : [relation];
  }),
);
const GRANTABLE_TENANT_RELATION_SET: ReadonlySet<string> = new Set(STAGE_GRANTABLE_TENANT_RELATIONS);

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
  if (
    accounts.some(
      ({ grants }) =>
        hasDuplicates(grants.tenantRelations) ||
        grants.tenantRelations.some((relation) => !GRANTABLE_TENANT_RELATION_SET.has(relation)) ||
        (grants.explicitActions !== 'all' && hasDuplicates(grants.explicitActions)),
    )
  ) {
    return yield* invalid('Stage account grants must name unique Tenant relations defined by the SpiceDB schema');
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
