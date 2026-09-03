/* eslint-disable promise/prefer-await-to-callbacks -- Better Auth exposes a Promise-based server API. */
// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off processEnv:off
import { reconcileStageContextBootstraps } from '@app/core-runtime/install/stage-context-bootstrap';
import { betterAuth } from 'better-auth';
import { verifyPassword } from 'better-auth/crypto';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin } from 'better-auth/plugins';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Effect, Schema } from 'effect';
import { Pool } from 'pg';
import { account, authDatabaseSchema, user } from './db/schema.ts';
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

const ensureAuthUser = async (
  configuration: StageDemoBootstrapConfig,
  accountConfiguration: StageDemoAccountConfig,
  database: ReturnType<typeof drizzle<typeof authDatabaseSchema>>,
): Promise<{ readonly status: 'created' | 'existing'; readonly userId: string }> => {
  const existingUsers = await database
    .select({ email: user.email, id: user.id, name: user.name })
    .from(user)
    .where(eq(user.email, accountConfiguration.email))
    .limit(2);
  if (existingUsers.length > 1) {
    throw new StageDemoBootstrapError({
      code: 'stage_demo_conflict',
      reason: 'Multiple Better Auth users use the stage demo email',
    });
  }
  const [existingUser] = existingUsers;
  if (existingUser !== undefined) {
    classifyExactStageDemoRecord('Better Auth user', existingUser, {
      email: accountConfiguration.email,
      name: accountConfiguration.principalDisplayName,
    });
    const credentials = await database
      .select({ password: account.password })
      .from(account)
      .where(and(eq(account.userId, existingUser.id), eq(account.providerId, 'credential')))
      .limit(2);
    const [credential] = credentials.length === 1 ? credentials : [];
    if (
      credential?.password === null ||
      credential?.password === undefined ||
      !(await verifyPassword({
        hash: credential.password,
        password: accountConfiguration.password,
      }))
    ) {
      throw new StageDemoBootstrapError({
        code: 'stage_demo_conflict',
        reason: 'The existing stage demo user has conflicting credentials',
      });
    }
    return { status: 'existing', userId: existingUser.id };
  }

  const authentication = betterAuth({
    baseURL: configuration.authBaseUrl,
    database: drizzleAdapter(database, {
      provider: 'pg',
      schema: authDatabaseSchema,
      transaction: true,
    }),
    emailAndPassword: {
      autoSignIn: false,
      disableSignUp: true,
      enabled: true,
    },
    logger: { disabled: true },
    plugins: [admin()],
    secret: configuration.authSecret,
  });
  const created = await authentication.api.createUser({
    body: {
      email: accountConfiguration.email,
      name: accountConfiguration.principalDisplayName,
      password: accountConfiguration.password,
    },
  });
  return { status: 'created', userId: created.user.id };
};

const reconcileAuthUser = (
  configuration: StageDemoBootstrapConfig,
  accountConfiguration: StageDemoAccountConfig,
) =>
  Effect.tryPromise({
    catch: (cause) =>
      Schema.is(StageDemoBootstrapError)(cause)
        ? cause
        : new StageDemoBootstrapError({
            code: 'stage_demo_persistence_failed',
            reason: 'The stage demo Better Auth user could not be reconciled',
          }),
    try: async () => {
      const pool = new Pool({ connectionString: configuration.databaseAdminUrl });
      try {
        const authDatabase = drizzle({ client: pool, schema: authDatabaseSchema });
        return await ensureAuthUser(configuration, accountConfiguration, authDatabase);
      } finally {
        await pool.end();
      }
    },
  });

export const bootstrapStageDemo = (
  environment: StageDemoEnvironment = process.env,
): Effect.Effect<StageDemoBootstrapResult, StageDemoBootstrapError> =>
  Effect.gen(function* bootstrapStageDemoEffect() {
    const configuration = yield* parseStageDemoBootstrapConfig(environment);
    const [techsioAccount, siamparkAccount] = configuration.accounts;
    const techsioAuthUser = yield* reconcileAuthUser(configuration, techsioAccount);
    const siamparkAuthUser = yield* reconcileAuthUser(configuration, siamparkAccount);
    const [techsioContext, siamparkContext] = yield* reconcileStageContextBootstraps([
      techsioAuthUser.userId,
      siamparkAuthUser.userId,
    ]).pipe(
      Effect.mapError(
        (error) =>
          new StageDemoBootstrapError({
            code: 'stage_demo_persistence_failed',
            reason: error.reason,
          }),
      ),
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
  });
