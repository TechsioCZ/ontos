import type { AccessCatalogModule, DatabaseIdentityEnrollmentContext } from '@app/core-runtime';
import type { AccessPeopleStore } from '@app/core-runtime/access/intent/people-store';
import type { AccessTeamStore } from '@app/core-runtime/access/intent/teams';
import {
  completedStageRetirementsOf,
  reconcileStageContextBootstraps,
  rehearseStageContextBootstraps,
  stageTenantsFromAccountsFile,
  stageModuleIntentRefusal,
} from '@app/core-runtime/install/stage-context-bootstrap';
import type {
  InstallationRuntime,
  StageAttachment,
  StageContextBootstrapResult,
  StageDeparture,
  StageMoves,
  StageRetiredConnectedApp,
  StageRetiredPrincipalIdentity,
} from '@app/core-runtime/install/stage-context-bootstrap';
import { betterAuth } from 'better-auth';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { admin } from 'better-auth/plugins/admin';
import { and, eq, inArray } from 'drizzle-orm';
import type { Crypto } from 'effect';
import { Config, DateTime, Effect, Option, Redacted } from 'effect';

import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { AuthDatabase } from './db/client.ts';
import { account, oauthAccessToken, oauthConsent, oauthRefreshToken, session, user } from './db/schema.ts';
import type { AuthDatabaseExecutor } from './db/types.ts';
import {
  STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY,
  StageAccountsBootstrapError,
  classifyExactStageAccountsRecord,
  parseStageAccountsBootstrapConfig,
  stageRunFailure,
} from './stage-accounts-bootstrap-contract.ts';
import type {
  StageAccountConfig,
  StageAccountResult,
  StageAccountsBootstrapConfig,
  StageAccountsFileReader,
  StageAccountsBootstrapResult,
  StageAccountsEnvironment,
  StageAccountsRehearsal,
} from './stage-accounts-bootstrap-contract.ts';

const persistenceFailure = (cause?: unknown) =>
  new StageAccountsBootstrapError({
    cause,
    code: 'stage_accounts_persistence_failed',
    reason: 'The stage account Better Auth user could not be reconciled',
  });

const bootstrapSdkTimeout = Effect.timeoutOrElse({
  duration: '30 seconds',
  orElse: () => Effect.fail(persistenceFailure()),
});

type AuthTransaction = Parameters<Parameters<AuthDatabaseExecutor['transaction']>[0]>[0];

const replaceStagePassword = Effect.fn('StageAccountsBootstrap.replacePassword')(function* replacePassword(
  transaction: AuthTransaction,
  accountId: string,
  userId: string,
  replacementHash: string,
  updatedAt: Date,
) {
  const updated = yield* transaction
    .update(account)
    .set({ password: replacementHash, updatedAt })
    .where(eq(account.id, accountId))
    .returning({ id: account.id });
  if (updated.length !== 1) {
    return yield* new StageAccountsBootstrapError({
      code: 'stage_accounts_conflict',
      reason: 'The existing stage account credential changed during password replacement',
    });
  }
  yield* transaction.delete(session).where(eq(session.userId, userId));
  return yield* Effect.void;
});

/**
 * What the run does with one account's Better Auth user, decided from reads alone: none when the user is created, else
 * the existing user with whether the file's password still verifies against it and whether its email is verified.
 * Every conflict is refused while deciding, so a dry run refuses exactly what the real run refuses.
 */
interface ExistingAuthUser {
  readonly credentialId: string;
  readonly emailVerified: boolean;
  readonly passwordValid: boolean;
  readonly userId: string;
}

const planAuthUser = Effect.fn('StageAccountsBootstrap.planAuthUser')(function* planUser(
  accountConfiguration: StageAccountConfig,
): Effect.fn.Return<Option.Option<ExistingAuthUser>, StageAccountsBootstrapError, AuthDatabase> {
  const { executor: database } = yield* AuthDatabase;
  const existingUsers = yield* database
    .select({ email: user.email, emailVerified: user.emailVerified, id: user.id, name: user.name })
    .from(user)
    .where(eq(user.email, accountConfiguration.email))
    .limit(2)
    .pipe(Effect.mapError(persistenceFailure));
  if (existingUsers.length > 1) {
    return yield* new StageAccountsBootstrapError({
      code: 'stage_accounts_conflict',
      reason: 'Multiple Better Auth users use the stage account email',
    });
  }
  const [existingUser] = existingUsers;
  if (existingUser === undefined) {
    return Option.none();
  }
  yield* classifyExactStageAccountsRecord('Better Auth user', existingUser, {
    email: accountConfiguration.email,
    name: accountConfiguration.displayName,
  });
  const credentials = yield* database
    .select({
      accountId: account.accountId,
      id: account.id,
      password: account.password,
    })
    .from(account)
    .where(and(eq(account.userId, existingUser.id), eq(account.providerId, 'credential')))
    .limit(2)
    .pipe(Effect.mapError(persistenceFailure));
  const [credential] = credentials.length === 1 ? credentials : [];
  if (credential?.password === null || credential?.password === undefined) {
    return yield* new StageAccountsBootstrapError({
      code: 'stage_accounts_conflict',
      reason: 'The existing stage account user has conflicting credentials',
    });
  }
  yield* classifyExactStageAccountsRecord('Better Auth credential account', credential, {
    accountId: existingUser.id,
  });
  const hash = credential.password;
  const passwordValid = yield* Effect.tryPromise({
    catch: persistenceFailure,
    // oxlint-disable-next-line typescript/promise-function-async -- Effect owns the Better Auth crypto boundary.
    try: () => verifyPassword({ hash, password: Redacted.value(accountConfiguration.password) }),
  }).pipe(Effect.option, Effect.map(Option.getOrElse(() => false)), bootstrapSdkTimeout);
  return Option.some({
    credentialId: credential.id,
    emailVerified: existingUser.emailVerified,
    passwordValid,
    userId: existingUser.id,
  });
});

/** Writes what `planAuthUser` decided: the user created, or its password replaced and its email verified. */
const applyAuthUser = Effect.fn('StageAccountsBootstrap.applyAuthUser')(function* applyUser(
  configuration: Pick<StageAccountsBootstrapConfig, 'authBaseUrl' | 'authSecret'>,
  accountConfiguration: StageAccountConfig,
  existing: Option.Option<ExistingAuthUser>,
) {
  const { adapter, executor: database } = yield* AuthDatabase;
  if (Option.isSome(existing)) {
    const plan = existing.value;
    if (!plan.passwordValid) {
      const replacementHash = yield* Effect.tryPromise({
        catch: persistenceFailure,
        // oxlint-disable-next-line typescript/promise-function-async -- Effect owns the Better Auth crypto boundary.
        try: () => hashPassword(Redacted.value(accountConfiguration.password)),
      }).pipe(bootstrapSdkTimeout);
      const updatedAt = yield* DateTime.nowAsDate;
      yield* database
        .transaction((transaction) =>
          replaceStagePassword(transaction, plan.credentialId, plan.userId, replacementHash, updatedAt),
        )
        .pipe(Effect.mapError(persistenceFailure));
    }
    if (!plan.emailVerified) {
      // The guarded operator file attests this exact account, not arbitrary users in the database.
      const updatedAt = yield* DateTime.nowAsDate;
      const verified = yield* database
        .update(user)
        .set({ emailVerified: true, updatedAt })
        .where(
          and(
            eq(user.id, plan.userId),
            eq(user.email, accountConfiguration.email),
            eq(user.name, accountConfiguration.displayName),
          ),
        )
        .returning({ id: user.id })
        .pipe(Effect.mapError(persistenceFailure));
      if (verified.length !== 1) {
        return yield* new StageAccountsBootstrapError({
          code: 'stage_accounts_conflict',
          reason: 'The existing stage account user changed during operator verification',
        });
      }
    }
    return {
      status: plan.passwordValid ? ('existing' as const) : ('password-reset' as const),
      userId: plan.userId,
    };
  }

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
    secret: configuration.authSecret,
  });
  // Better Auth cannot cancel this write; keep the database scope alive until it settles.
  // oxlint-disable-next-line effect-native/require-timeout-on-external-effect -- Remove when the SDK supports cancellation or a reconcilable write token.
  const created = yield* Effect.tryPromise({
    catch: persistenceFailure,
    // oxlint-disable-next-line typescript/promise-function-async -- Effect owns the Better Auth SDK boundary.
    try: () =>
      authentication.api.createUser({
        body: {
          data: { emailVerified: true },
          email: accountConfiguration.email,
          name: accountConfiguration.displayName,
          password: Redacted.value(accountConfiguration.password),
        },
      }),
  }).pipe(Effect.uninterruptible);
  return { status: 'created' as const, userId: created.user.id };
});

/** Reconciles one account's Better Auth user: decided from reads, then written. */
const ensureAuthUser = Effect.fn('StageAccountsBootstrap.ensureAuthUser')(function* ensureUser(
  configuration: Pick<StageAccountsBootstrapConfig, 'authBaseUrl' | 'authSecret'>,
  accountConfiguration: StageAccountConfig,
) {
  return yield* applyAuthUser(configuration, accountConfiguration, yield* planAuthUser(accountConfiguration));
});

/** What the run would do with one account's Better Auth user, as the dry run reports it. */
const authUserPreviewOf = (
  accountConfiguration: StageAccountConfig,
  existing: Option.Option<ExistingAuthUser>,
): StageAccountsRehearsal['accounts'][number] =>
  Option.match(existing, {
    onNone: () => ({ email: accountConfiguration.email, status: 'created' as const, verifiesEmail: false }),
    onSome: ({ emailVerified, passwordValid }) => ({
      email: accountConfiguration.email,
      status: passwordValid ? ('existing' as const) : ('password-reset' as const),
      verifiesEmail: !emailVerified,
    }),
  });

export { ensureAuthUser as ensureStageAccountAuthUser };

const optionalString = (name: string) => Config.option(Config.String(name)).pipe(Config.map(Option.getOrUndefined));

const optionalSecret = (name: string) =>
  Config.option(Config.Redacted(name)).pipe(Config.map(Option.map(Redacted.value)), Config.map(Option.getOrUndefined));

const loadStageAccountsEnvironment = Effect.fn(
  'StageAccountsBootstrapRuntimeInfrastructure.loadStageAccountsEnvironment',
)(function* loadStageAccountsEnvironmentEffect() {
  const values = yield* Effect.all(
    {
      BETTER_AUTH_SECRET: optionalSecret('BETTER_AUTH_SECRET'),
      BETTER_AUTH_URL: optionalString('BETTER_AUTH_URL'),
      DATABASE_ADMIN_URL: optionalSecret('DATABASE_ADMIN_URL'),
      [STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY]: optionalString(STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY),
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: optionalString('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'),
    },
    { concurrency: 8 },
  );
  return values satisfies StageAccountsEnvironment;
});

export const loadStageAccountsConfiguration = Effect.fn('StageAccountsBootstrap.loadConfiguration')(
  function* loadConfiguration(
    readAccountsFile: StageAccountsFileReader,
    declaredWorkloadKeys: ReadonlySet<string>,
    environment?: StageAccountsEnvironment,
  ) {
    const runtimeEnvironment =
      environment ??
      (yield* loadStageAccountsEnvironment().pipe(
        Effect.mapError(
          (error) =>
            new StageAccountsBootstrapError({
              code: 'stage_accounts_configuration_invalid',
              reason: `The stage account configuration could not be loaded: ${error.message}`,
            }),
        ),
      ));
    return yield* parseStageAccountsBootstrapConfig(runtimeEnvironment, readAccountsFile, declaredWorkloadKeys);
  },
);

/**
 * Bans a retired stage account's Better Auth user, ends its sessions, and removes its password
 * credential so a previously disclosed password can never sign in again. Absent users are fine.
 */
const retireAuthUserTransaction = Effect.fn('StageAccountsBootstrap.retireAuthUserTransaction')(
  function* retireUserRows(transaction: AuthTransaction, email: string, updatedAt: Date) {
    const users = yield* transaction
      .update(user)
      .set({ banned: true, banReason: 'Stage tenant retired', updatedAt })
      .where(eq(user.email, email))
      .returning({ id: user.id });
    yield* Effect.forEach(
      users,
      ({ id }) =>
        transaction
          .delete(session)
          .where(eq(session.userId, id))
          .pipe(
            Effect.andThen(
              transaction.delete(account).where(and(eq(account.userId, id), eq(account.providerId, 'credential'))),
            ),
          ),
      { concurrency: 1, discard: true },
    );
    return users.length;
  },
);

const retireAuthUser = Effect.fn('StageAccountsBootstrap.retireAuthUser')(function* retireUser(email: string) {
  const { executor: database } = yield* AuthDatabase;
  const updatedAt = yield* DateTime.nowAsDate;
  const banned = yield* database
    .transaction((transaction) => retireAuthUserTransaction(transaction, email, updatedAt))
    .pipe(Effect.mapError(persistenceFailure));
  return { email, status: banned === 0 ? ('absent' as const) : ('banned' as const) };
});

/**
 * Finishes the ending of every connected app of a person the file retired after Core committed it, as the product's
 * revocation finishes one after its own commit (`finishRevocation`): it deletes the Better Auth tokens and consent of
 * each grant by grant id, so no refresh token of an ended grant keeps minting access tokens, and nothing of another
 * grant of the same Better Auth user. The revocation event is Core's, written in the run's own transaction. What is
 * deleted already is left alone, so running it again changes nothing.
 */
export const finishStageConnectedAppEndings = Effect.fn('StageAccountsBootstrap.finishConnectedAppEndings')(
  function* finishStageConnectedAppEndingsEffect(connectedApps: readonly StageRetiredConnectedApp[]) {
    const grantIds = connectedApps.map(({ grantId }) => grantId);
    if (grantIds.length === 0) {
      return yield* Effect.void;
    }
    const { executor: database } = yield* AuthDatabase;
    yield* database
      .transaction((transaction) =>
        Effect.all(
          [
            transaction.delete(oauthAccessToken).where(inArray(oauthAccessToken.referenceId, grantIds)),
            transaction.delete(oauthRefreshToken).where(inArray(oauthRefreshToken.referenceId, grantIds)),
            transaction.delete(oauthConsent).where(inArray(oauthConsent.referenceId, grantIds)),
          ],
          { concurrency: 1, discard: true },
        ),
      )
      .pipe(Effect.mapError(persistenceFailure));
    return yield* Effect.void;
  },
);

/**
 * The Better Auth user a retired Principal's login signs in as. Core retires the Principal only while it holds a live
 * staff binding of this user and no binding of anybody else; the user itself is not changed here.
 */
const retiredLoginUser = Effect.fn('StageAccountsBootstrap.retiredLoginUser')(function* retiredLoginUser(
  email: string,
) {
  const { executor: database } = yield* AuthDatabase;
  const users = yield* database
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(2)
    .pipe(Effect.mapError(persistenceFailure));
  const [existingUser] = users;
  if (users.length !== 1 || existingUser === undefined) {
    return yield* new StageAccountsBootstrapError({
      code: 'stage_accounts_conflict',
      reason: "A retired Principal's login needs exactly one Better Auth user",
    });
  }
  return existingUser.id;
});

/** The Better Auth user an attached login already signs in as; the login is never created or changed here. */
const attachedLoginUser = Effect.fn('StageAccountsBootstrap.attachedLoginUser')(function* attachedLoginUser(
  email: string,
) {
  const { executor: database } = yield* AuthDatabase;
  const users = yield* database
    .select({ banned: user.banned, id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(2)
    .pipe(Effect.mapError(persistenceFailure));
  const [existingUser] = users;
  if (users.length !== 1 || existingUser === undefined || existingUser.banned === true) {
    return yield* new StageAccountsBootstrapError({
      code: 'stage_accounts_conflict',
      reason: 'An attached login needs exactly one Better Auth user that is not banned',
    });
  }
  return existingUser.id;
});

const toAccountResult = (
  accountConfiguration: StageAccountConfig,
  authUser: { readonly status: StageAccountResult['authUser'] },
  context: StageContextBootstrapResult,
): StageAccountResult => ({
  authUser: authUser.status,
  email: accountConfiguration.email,
  legalEntityId: context.legalEntityId,
  owner: context.owner,
  principalId: context.principalId,
  roles: context.roles,
  tenantId: context.tenantId,
});

/**
 * What one operator run did: its accounts and retired accounts, the logins it attached, each departure with every write
 * its move transaction made (a replay's included) and the connected apps the departures ended, and what its move
 * transaction wrote, which its dry run reports beforehand.
 */
export interface StageAccountsBootstrapRunResult extends StageAccountsBootstrapResult {
  /** Each attached login of the file, with the email it names it by and whether this run created it. */
  readonly attachments: readonly (StageAttachment & { readonly email: string })[];
  /** Each departure of the file, with the email it names the person by and every write it made. */
  readonly departures: readonly (StageDeparture & { readonly email: string })[];
  /** The connected apps this run ended, by client name and id; never a token. */
  readonly endedConnectedApps: readonly {
    readonly clientId: string;
    readonly clientName: string;
    readonly email: string;
    readonly grantId: string;
    readonly lastUsedAt: Date | null;
    readonly status: string;
    readonly tenantId: string;
  }[];
  readonly moves: StageMoves;
}

export interface StageAccountsBootstrapOptions {
  /**
   * The declarations of every module the running composition serves (O69). A stage tenant's release is
   * compiled from them, so the operator's run is handed the catalog scan's modules, never a smaller set.
   */
  readonly modules: readonly AccessCatalogModule[];
}

type StageAccountsFile = StageAccountsBootstrapConfig['accountsFile'];

/** A tenant of the file whose base module the running composition does not declare refuses the file first. */
const refuseUndeclaredModules = (accountsFile: StageAccountsFile, modules: readonly AccessCatalogModule[]) => {
  const refusal = stageModuleIntentRefusal(
    accountsFile.tenants.map(({ moduleKey }) => moduleKey),
    modules,
  );
  return refusal === undefined
    ? Effect.void
    : Effect.fail(
        new StageAccountsBootstrapError({ code: 'stage_accounts_configuration_invalid', reason: refusal.reason }),
      );
};

/** Each person the file retires, with the Better Auth user its email names. */
const retiredPrincipalIdentitiesOf = (accountsFile: StageAccountsFile) =>
  Effect.forEach(
    accountsFile.retiredPrincipals ?? [],
    (retired) =>
      retiredLoginUser(retired.email).pipe(
        Effect.map((providerUserId) => ({
          principalId: retired.principalId,
          providerUserId,
          tenantId: retired.tenantId,
        })),
      ),
    { concurrency: 1 },
  );

/** Each login the file attaches, with the Better Auth user it already signs in as. */
const attachedLoginIdentitiesOf = (accountsFile: StageAccountsFile) =>
  Effect.forEach(
    accountsFile.attachedLogins ?? [],
    (login) =>
      attachedLoginUser(login.email).pipe(
        Effect.map((providerUserId) => ({
          authBindingId: login.authBindingId,
          displayName: login.displayName,
          principalId: login.principalId,
          providerUserId,
          tenantId: login.tenantId,
        })),
      ),
    { concurrency: 1 },
  );

/** The read-only pre-step: every connected app of a person of the file whose departure an earlier run completed. */
const completedRetirementsOf = (retiredPrincipals: readonly StageRetiredPrincipalIdentity[]) =>
  completedStageRetirementsOf(retiredPrincipals, {
    authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
  }).pipe(Effect.mapError(stageRunFailure));

/** Each attachment the move transaction made, or would make, with the email the file names its login by. */
const attachmentsOf = (
  attachedLogins: readonly { readonly email: string; readonly principalId: string; readonly tenantId: string }[],
  moves: StageMoves,
): readonly (StageAttachment & { readonly email: string })[] =>
  attachedLogins.flatMap(({ email, principalId, tenantId }) =>
    moves.attachments.flatMap((attachment) =>
      attachment.principalId === principalId && attachment.tenantId === tenantId ? [{ ...attachment, email }] : [],
    ),
  );

/** Each departure the move transaction made, or would make, with the email the file names its person by. */
const departuresOf = (
  retiredPrincipals: readonly { readonly email: string; readonly principalId: string; readonly tenantId: string }[],
  moves: StageMoves,
): readonly (StageDeparture & { readonly email: string })[] =>
  retiredPrincipals.flatMap(({ email, principalId, tenantId }) =>
    moves.departures.flatMap((departure) =>
      departure.principalId === principalId && departure.tenantId === tenantId ? [{ ...departure, email }] : [],
    ),
  );

/** Every account of the file's tenants, tenant by tenant and account by account. */
const accountConfigurationsOf = (accountsFile: StageAccountsFile): readonly StageAccountConfig[] =>
  accountsFile.tenants.flatMap(({ accounts }) =>
    accounts.map(({ displayName, email, password }) => ({ displayName, email, password })),
  );

/**
 * Creates each stage account's Better Auth user and then the tenant's authorization v2 authority: one
 * bootstrap per tenant (owner, memberships, release, "Plný přístup"), the same role for every further
 * account the operator names, and one reconcile through the single Core writer. An attached login gets a
 * Principal in an existing tenant for the Better Auth user it already has. A retired account loses its
 * Better Auth user, a retired Principal its sign-in and authority in its tenant, and a retired tenant its
 * intent, so nothing of them keeps answering.
 */
export const bootstrapStageAccounts = Effect.fn('StageAccountsBootstrap.bootstrap')(function* bootstrap(
  configuration: StageAccountsBootstrapConfig,
  options: StageAccountsBootstrapOptions,
): Effect.fn.Return<
  StageAccountsBootstrapRunResult,
  StageAccountsBootstrapError,
  | AccessPeopleStore
  | AccessTeamStore
  | AuthDatabase
  | Crypto.Crypto
  | DatabaseIdentityEnrollmentContext
  | InstallationRuntime
> {
  const { accountsFile } = configuration;
  const attachedLogins = accountsFile.attachedLogins ?? [];
  const retiredPrincipals = accountsFile.retiredPrincipals ?? [];
  yield* refuseUndeclaredModules(accountsFile, options.modules);
  const retiredPrincipalIdentities = yield* retiredPrincipalIdentitiesOf(accountsFile);
  // The read-only pre-step finishes a departure an earlier run of this file committed first, whatever the run then
  // decides about the rest of the file: a run that stopped before its clean-up is completed even when the rest of the
  // file is refused this time. A person of the
  // file who is archived with every binding revoked, one of them the login's, and nothing live has completed it, since a
  // retirement is one transaction that also archives the Principal; only the tokens and consent of their ended grants
  // are deleted, by grant id, which is idempotent and harmless even for a Principal archived by other means. This and
  // the Better Auth accounts below run before Core's move transaction, so a refused file may already have done them.
  yield* finishStageConnectedAppEndings(yield* completedRetirementsOf(retiredPrincipalIdentities));
  const attachedLoginIdentities = yield* attachedLoginIdentitiesOf(accountsFile);
  const accountConfigurations = accountConfigurationsOf(accountsFile);
  const authUsers = yield* Effect.forEach(
    accountConfigurations,
    (accountConfiguration) => ensureAuthUser(configuration, accountConfiguration),
    { concurrency: 1 },
  );
  // The accounts file is flattened tenant by tenant and account by account, in the order the Better Auth
  // users were created, so each Principal is paired with exactly the user its account signed up as.
  const principals: string[] = [];
  for (const { accounts } of accountsFile.tenants) {
    for (const { principalId } of accounts) {
      principals.push(principalId);
    }
  }
  const providerUserIds = new Map(
    principals.flatMap((principalId, index) => {
      const authUser = authUsers[index];
      return authUser === undefined ? [] : [[principalId, authUser.userId] as const];
    }),
  );
  const tenants = yield* stageTenantsFromAccountsFile(accountsFile, providerUserIds, options.modules).pipe(
    Effect.mapError(
      (error) =>
        new StageAccountsBootstrapError({
          code: 'stage_accounts_configuration_invalid',
          reason: error.reason,
        }),
    ),
  );
  // A refusal keeps the code Core decided it under, so the operator reads why, not a persistence failure.
  const run = yield* reconcileStageContextBootstraps(
    {
      attachedLogins: attachedLoginIdentities,
      retiredPrincipals: retiredPrincipalIdentities,
      retiredTenants: accountsFile.retiredTenants,
      tenants,
    },
    { authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID, modules: options.modules },
  ).pipe(Effect.mapError(stageRunFailure));
  yield* finishStageConnectedAppEndings(run.connectedApps);
  const retiredAccounts = yield* Effect.forEach(accountsFile.retiredAccountEmails, retireAuthUser, {
    concurrency: 1,
  });
  const accounts = run.accounts.flatMap((result, index) => {
    const accountConfiguration = accountConfigurations[index];
    const authUser = authUsers[index];
    return accountConfiguration === undefined || authUser === undefined
      ? []
      : [toAccountResult(accountConfiguration, authUser, result)];
  });
  return {
    accounts,
    attachments: attachmentsOf(attachedLogins, run.moves),
    departures: departuresOf(retiredPrincipals, run.moves),
    endedConnectedApps: retiredPrincipals.flatMap(({ email, principalId, tenantId }) =>
      run.connectedApps.flatMap((app) =>
        app.endedByThisRun && app.principalId === principalId && app.tenantId === tenantId
          ? [
              {
                clientId: app.clientId,
                clientName: app.clientName,
                email,
                grantId: app.grantId,
                lastUsedAt: app.lastUsedAt,
                status: app.status,
                tenantId: app.tenantId,
              },
            ]
          : [],
      ),
    ),
    moves: run.moves,
    retiredAccounts,
  };
});

/**
 * The dry run of `bootstrapStageAccounts` (the operator command's default): every read and refusal of the real run, in the real run's
 * order, then Core's move transaction with every lock, read and write of the real run, rolled back instead of
 * committed. Nothing persists. What the real run writes outside that transaction is skipped and reported instead: the
 * pre-step's deletion of Better Auth tokens and consent (its read runs), the reconciliation of the file's Better Auth
 * accounts (their reads and refusals run), the deletion of the retired people's tokens and consent after the commit,
 * the reconcile of every tenant somebody leaves, every tenant and retired tenant of the file, and every ban of a
 * retired account.
 */
export const rehearseStageAccounts = Effect.fn('StageAccountsBootstrap.rehearse')(function* rehearse(
  configuration: StageAccountsBootstrapConfig,
  options: StageAccountsBootstrapOptions,
): Effect.fn.Return<
  StageAccountsRehearsal,
  StageAccountsBootstrapError,
  AccessPeopleStore | AccessTeamStore | AuthDatabase | DatabaseIdentityEnrollmentContext | InstallationRuntime
> {
  const { accountsFile } = configuration;
  const attachedLogins = accountsFile.attachedLogins ?? [];
  const retiredPrincipals = accountsFile.retiredPrincipals ?? [];
  yield* refuseUndeclaredModules(accountsFile, options.modules);
  const retiredPrincipalIdentities = yield* retiredPrincipalIdentitiesOf(accountsFile);
  // The pre-step reads what an earlier run completed; the dry run reports the deletion instead of making it.
  const completedConnectedApps = yield* completedRetirementsOf(retiredPrincipalIdentities);
  const attachedLoginIdentities = yield* attachedLoginIdentitiesOf(accountsFile);
  // Each account is decided, its refusals included, as the real run decides it; the dry run writes none of it.
  const accounts = yield* Effect.forEach(
    accountConfigurationsOf(accountsFile),
    (accountConfiguration) =>
      planAuthUser(accountConfiguration).pipe(Effect.map((plan) => authUserPreviewOf(accountConfiguration, plan))),
    { concurrency: 1 },
  );
  const moved = yield* rehearseStageContextBootstraps(
    { attachedLogins: attachedLoginIdentities, file: accountsFile, retiredPrincipals: retiredPrincipalIdentities },
    { authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID, modules: options.modules },
  ).pipe(Effect.mapError(stageRunFailure));
  return {
    accounts,
    attachments: attachmentsOf(attachedLogins, moved.moves),
    completedConnectedApps,
    connectedApps: moved.connectedApps,
    departures: departuresOf(retiredPrincipals, moved.moves),
    leftTenantIds: [...new Set(retiredPrincipals.map(({ tenantId }) => tenantId))],
    retiredAccountEmails: accountsFile.retiredAccountEmails,
    retiredTenantIds: accountsFile.retiredTenants.map(({ tenantId }) => tenantId),
    tenantIds: accountsFile.tenants.map(({ tenantId }) => tenantId),
  };
});
