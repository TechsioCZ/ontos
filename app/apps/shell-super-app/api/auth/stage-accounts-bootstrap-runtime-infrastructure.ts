import {
  reconcileStageContextBootstraps,
  stageContextsFromAccountsFile,
} from '@app/core-runtime/install/stage-context-bootstrap';
import type { StageContextBootstrapResult } from '@app/core-runtime/install/stage-context-bootstrap';
import { betterAuth } from 'better-auth';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { admin } from 'better-auth/plugins/admin';
import { and, eq } from 'drizzle-orm';
import { Config, DateTime, Effect, Option, Redacted } from 'effect';

import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { AuthDatabase } from './db/client.ts';
import { account, session, user } from './db/schema.ts';
import type { AuthDatabaseExecutor } from './db/types.ts';
import {
  STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY,
  StageAccountsBootstrapError,
  classifyExactStageAccountsRecord,
  parseStageAccountsBootstrapConfig,
} from './stage-accounts-bootstrap-contract.ts';
import type {
  StageAccountConfig,
  StageAccountResult,
  StageAccountsBootstrapConfig,
  StageAccountsFileReader,
  StageAccountsBootstrapResult,
  StageAccountsEnvironment,
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

const ensureAuthUser = Effect.fn('StageAccountsBootstrap.ensureAuthUser')(function* ensureUser(
  configuration: Pick<StageAccountsBootstrapConfig, 'authBaseUrl' | 'authSecret'>,
  accountConfiguration: StageAccountConfig,
) {
  const { adapter, executor: database } = yield* AuthDatabase;
  const existingUsers = yield* database
    .select({ email: user.email, id: user.id, name: user.name })
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
  if (existingUser !== undefined) {
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
    const validPassword = yield* Effect.tryPromise({
      catch: persistenceFailure,
      // oxlint-disable-next-line typescript/promise-function-async -- Effect owns the Better Auth crypto boundary.
      try: () => verifyPassword({ hash, password: Redacted.value(accountConfiguration.password) }),
    }).pipe(Effect.option, Effect.map(Option.getOrElse(() => false)), bootstrapSdkTimeout);
    if (!validPassword) {
      const replacementHash = yield* Effect.tryPromise({
        catch: persistenceFailure,
        // oxlint-disable-next-line typescript/promise-function-async -- Effect owns the Better Auth crypto boundary.
        try: () => hashPassword(Redacted.value(accountConfiguration.password)),
      }).pipe(bootstrapSdkTimeout);
      const updatedAt = yield* DateTime.nowAsDate;
      yield* database
        .transaction((transaction) =>
          replaceStagePassword(transaction, credential.id, existingUser.id, replacementHash, updatedAt),
        )
        .pipe(Effect.mapError(persistenceFailure));
      return { status: 'password-reset' as const, userId: existingUser.id };
    }
    return { status: 'existing' as const, userId: existingUser.id };
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
          email: accountConfiguration.email,
          name: accountConfiguration.displayName,
          password: Redacted.value(accountConfiguration.password),
        },
      }),
  }).pipe(Effect.uninterruptible);
  return { status: 'created' as const, userId: created.user.id };
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
  function* loadConfiguration(readAccountsFile: StageAccountsFileReader, environment?: StageAccountsEnvironment) {
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
    return yield* parseStageAccountsBootstrapConfig(runtimeEnvironment, readAccountsFile);
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

const toAccountResult = (
  email: string,
  authUser: { readonly status: StageAccountResult['authUser'] },
  context: StageContextBootstrapResult,
): StageAccountResult => ({
  authUser: authUser.status,
  email,
  legalEntityId: context.legalEntityId,
  principalId: context.principalId,
  tenantId: context.tenantId,
});

export const bootstrapStageAccounts = Effect.fn('StageAccountsBootstrap.bootstrap')(function* bootstrap(
  configuration: StageAccountsBootstrapConfig,
): Effect.fn.Return<StageAccountsBootstrapResult, StageAccountsBootstrapError, AuthDatabase> {
  const { accountsFile } = configuration;
  const accountConfigurations = accountsFile.tenants.flatMap(({ accounts }) =>
    accounts.map(({ displayName, email, password }) => ({ displayName, email, password })),
  );
  const authUsers = yield* Effect.forEach(
    accountConfigurations,
    (accountConfiguration) => ensureAuthUser(configuration, accountConfiguration),
    { concurrency: 1 },
  );
  const contexts = stageContextsFromAccountsFile(accountsFile);
  const results = yield* reconcileStageContextBootstraps(
    contexts.map((context, index) => ({ context, providerUserId: authUsers[index]?.userId ?? '' })),
    accountsFile.retiredTenants,
    { authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID },
  ).pipe(
    Effect.mapError(
      (error) =>
        new StageAccountsBootstrapError({
          code: 'stage_accounts_persistence_failed',
          reason: error.reason,
        }),
    ),
  );
  const retiredAccounts = yield* Effect.forEach(accountsFile.retiredAccountEmails, retireAuthUser, {
    concurrency: 1,
  });
  const accounts = results.flatMap((result, index) => {
    const accountConfiguration = accountConfigurations[index];
    const authUser = authUsers[index];
    return accountConfiguration === undefined || authUser === undefined
      ? []
      : [toAccountResult(accountConfiguration.email, authUser, result)];
  });
  return { accounts, retiredAccounts };
});
