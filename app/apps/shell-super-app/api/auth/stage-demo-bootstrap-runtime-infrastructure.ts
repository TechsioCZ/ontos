import { reconcileStageContextBootstraps } from '@app/core-runtime/install/stage-context-bootstrap';
import { betterAuth } from 'better-auth';
import { verifyPassword } from 'better-auth/crypto';
import { admin } from 'better-auth/plugins';
import { and, eq } from 'drizzle-orm';
import { Config, Effect, Option, Redacted } from 'effect';

import { AuthDatabase } from './db/client.ts';
import { account, user } from './db/schema.ts';
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
        .select({ password: account.password })
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
      const hash = credential.password;
      const validPassword = yield* Effect.tryPromise({
        catch: persistenceFailure,
        // oxlint-disable-next-line typescript/promise-function-async -- Effect owns the Better Auth crypto boundary.
        try: () =>
          verifyPassword({ hash, password: accountConfiguration.password }),
      }).pipe(bootstrapSdkTimeout);
      if (!validPassword) {
        return yield* new StageDemoBootstrapError({
          code: 'stage_demo_conflict',
          reason: 'The existing stage demo user has conflicting credentials',
        });
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
