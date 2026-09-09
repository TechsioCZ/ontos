import { reconcileStageContextBootstraps } from '@app/core-runtime/install/stage-context-bootstrap';
import { betterAuth } from 'better-auth';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { admin } from 'better-auth/plugins/admin';
import { and, eq } from 'drizzle-orm';
import { Config, DateTime, Effect, Option, Redacted } from 'effect';

import { AuthDatabase } from './db/client.ts';
import { account, session, user } from './db/schema.ts';
import type { AuthDatabaseExecutor } from './db/types.ts';
import {
  StageDemoBootstrapError,
  classifyExactStageDemoRecord,
  parseStageDemoBootstrapConfig,
} from './stage-demo-bootstrap-contract.ts';
import type {
  StageDemoAccountConfig,
  StageDemoAccountResult,
  StageDemoBootstrapConfig,
  StageDemoBootstrapResult,
  StageDemoEnvironment,
} from './stage-demo-bootstrap-contract.ts';

const persistenceFailure = (cause?: unknown) =>
  Object.defineProperty(
    new StageDemoBootstrapError({
      code: 'stage_demo_persistence_failed',
      reason: 'The stage demo Better Auth user could not be reconciled',
    }),
    'cause',
    { value: cause }
  );

const bootstrapSdkTimeout = Effect.timeoutOrElse({
  duration: '30 seconds',
  orElse: () => Effect.fail(persistenceFailure()),
});

type AuthTransaction = Parameters<
  Parameters<AuthDatabaseExecutor['transaction']>[0]
>[0];

const replaceStagePassword = Effect.fn('StageDemoBootstrap.replacePassword')(
  function* replacePassword(
    transaction: AuthTransaction,
    accountId: string,
    userId: string,
    replacementHash: string,
    updatedAt: Date
  ) {
    const updated = yield* transaction
      .update(account)
      .set({ password: replacementHash, updatedAt })
      .where(eq(account.id, accountId))
      .returning({ id: account.id });
    if (updated.length !== 1) {
      return yield* new StageDemoBootstrapError({
        code: 'stage_demo_conflict',
        reason:
          'The existing stage demo credential changed during password replacement',
      });
    }
    yield* transaction.delete(session).where(eq(session.userId, userId));
    return yield* Effect.void;
  }
);

const ensureAuthUser = Effect.fn('StageDemoBootstrap.ensureAuthUser')(
  function* ensureUser(
    configuration: StageDemoBootstrapConfig,
    accountConfiguration: StageDemoAccountConfig
  ) {
    const { adapter, executor: database } = yield* AuthDatabase;
    const existingUsers = yield* database
      .select({ email: user.email, id: user.id, name: user.name })
      .from(user)
      .where(eq(user.email, accountConfiguration.email))
      .limit(2)
      .pipe(Effect.mapError(persistenceFailure));
    if (existingUsers.length > 1) {
      return yield* new StageDemoBootstrapError({
        code: 'stage_demo_conflict',
        reason: 'Multiple Better Auth users use the stage demo email',
      });
    }
    const [existingUser] = existingUsers;
    if (existingUser !== undefined) {
      yield* classifyExactStageDemoRecord('Better Auth user', existingUser, {
        email: accountConfiguration.email,
        name: accountConfiguration.principalDisplayName,
      });
      const credentials = yield* database
        .select({
          accountId: account.accountId,
          id: account.id,
          issuer: account.issuer,
          password: account.password,
        })
        .from(account)
        .where(
          and(
            eq(account.userId, existingUser.id),
            eq(account.providerId, 'credential')
          )
        )
        .limit(2)
        .pipe(Effect.mapError(persistenceFailure));
      const [credential] = credentials.length === 1 ? credentials : [];
      if (credential?.password === null || credential?.password === undefined) {
        return yield* new StageDemoBootstrapError({
          code: 'stage_demo_conflict',
          reason: 'The existing stage demo user has conflicting credentials',
        });
      }
      yield* classifyExactStageDemoRecord(
        'Better Auth credential account',
        credential,
        {
          accountId: existingUser.id,
          issuer: 'local:credential',
        }
      );
      const hash = credential.password;
      const validPassword = yield* Effect.tryPromise({
        catch: persistenceFailure,
        // oxlint-disable-next-line typescript/promise-function-async -- Effect owns the Better Auth crypto boundary.
        try: () =>
          verifyPassword({ hash, password: accountConfiguration.password }),
      }).pipe(
        Effect.option,
        Effect.map(Option.getOrElse(() => false)),
        bootstrapSdkTimeout
      );
      if (!validPassword) {
        const replacementHash = yield* Effect.tryPromise({
          catch: persistenceFailure,
          // oxlint-disable-next-line typescript/promise-function-async -- Effect owns the Better Auth crypto boundary.
          try: () => hashPassword(accountConfiguration.password),
        }).pipe(bootstrapSdkTimeout);
        const updatedAt = yield* DateTime.nowAsDate;
        yield* database
          .transaction((transaction) =>
            replaceStagePassword(
              transaction,
              credential.id,
              existingUser.id,
              replacementHash,
              updatedAt
            )
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
            name: accountConfiguration.principalDisplayName,
            password: accountConfiguration.password,
          },
        }),
    }).pipe(Effect.uninterruptible);
    return { status: 'created' as const, userId: created.user.id };
  }
);

export { ensureAuthUser as ensureStageDemoAuthUser };

const optionalString = (name: string) =>
  Config.option(Config.string(name)).pipe(Config.map(Option.getOrUndefined));

const optionalSecret = (name: string) =>
  Config.option(Config.redacted(name)).pipe(
    Config.map(Option.map(Redacted.value)),
    Config.map(Option.getOrUndefined)
  );

const loadStageDemoEnvironment = Effect.fn(
  'StageDemoBootstrapRuntimeInfrastructure.loadStageDemoEnvironment'
)(function* loadStageDemoEnvironmentEffect() {
  const values = yield* Effect.all(
    {
      BETTER_AUTH_SECRET: optionalSecret('BETTER_AUTH_SECRET'),
      BETTER_AUTH_URL: optionalString('BETTER_AUTH_URL'),
      DATABASE_ADMIN_URL: optionalSecret('DATABASE_ADMIN_URL'),
      STAGE_DEMO_PASSWORD: optionalSecret('STAGE_DEMO_PASSWORD'),
      STAGE_SIAMPARK_PASSWORD: optionalSecret('STAGE_SIAMPARK_PASSWORD'),
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: optionalString(
        'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'
      ),
    },
    { concurrency: 6 }
  );
  return values satisfies StageDemoEnvironment;
});

export const loadStageDemoConfiguration = Effect.fn(
  'StageDemoBootstrap.loadConfiguration'
)(function* loadConfiguration(environment?: StageDemoEnvironment) {
  const runtimeEnvironment =
    environment ??
    (yield* loadStageDemoEnvironment().pipe(
      Effect.mapError(
        (error) =>
          new StageDemoBootstrapError({
            code: 'stage_demo_configuration_invalid',
            reason: `The stage demo configuration could not be loaded: ${error.message}`,
          })
      )
    ));
  return yield* parseStageDemoBootstrapConfig(runtimeEnvironment);
});

export const bootstrapStageDemo = Effect.fn('StageDemoBootstrap.bootstrap')(
  function* bootstrap(
    configuration: StageDemoBootstrapConfig
  ): Effect.fn.Return<
    StageDemoBootstrapResult,
    StageDemoBootstrapError,
    AuthDatabase
  > {
    const [techsioAccount, siamparkAccount] = configuration.accounts;
    const [techsioAuthUser, siamparkAuthUser] = yield* Effect.all(
      [
        ensureAuthUser(configuration, techsioAccount),
        ensureAuthUser(configuration, siamparkAccount),
      ],
      { concurrency: 1 }
    );
    const [techsioContext, siamparkContext] =
      yield* reconcileStageContextBootstraps([
        techsioAuthUser.userId,
        siamparkAuthUser.userId,
      ]).pipe(
        Effect.mapError(
          (error) =>
            new StageDemoBootstrapError({
              code: 'stage_demo_persistence_failed',
              reason: error.reason,
            })
        )
      );
    const accounts: StageDemoAccountResult[] = [
      {
        authUser: techsioAuthUser.status,
        email: techsioAccount.email,
        legalEntityId: techsioContext.legalEntityId,
        principalId: techsioContext.principalId,
        tenantId: techsioContext.tenantId,
      },
      {
        authUser: siamparkAuthUser.status,
        email: siamparkAccount.email,
        legalEntityId: siamparkContext.legalEntityId,
        principalId: siamparkContext.principalId,
        tenantId: siamparkContext.tenantId,
      },
    ];
    return { accounts };
  }
);
