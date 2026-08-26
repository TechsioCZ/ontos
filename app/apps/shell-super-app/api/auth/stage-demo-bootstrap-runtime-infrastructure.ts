/* eslint-disable promise/prefer-await-to-callbacks -- Better Auth exposes a Promise-based server API. */
// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off processEnv:off
import { reconcileStageContextBootstrap } from '@app/core-runtime/install/stage-context-bootstrap';
import { betterAuth } from 'better-auth';
import { verifyPassword } from 'better-auth/crypto';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin } from 'better-auth/plugins';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Effect } from 'effect';
import { Pool } from 'pg';
import { account, authDatabaseSchema, user } from './db/schema.ts';
import {
  STAGE_DEMO,
  StageDemoBootstrapError,
  classifyExactStageDemoRecord,
  parseStageDemoBootstrapConfig,
} from './stage-demo-bootstrap-contract.ts';
import type {
  StageDemoBootstrapConfig,
  StageDemoBootstrapResult,
  StageDemoEnvironment,
} from './stage-demo-bootstrap-contract.ts';

const ensureAuthUser = async (
  configuration: StageDemoBootstrapConfig,
  database: ReturnType<typeof drizzle<typeof authDatabaseSchema>>,
): Promise<{ readonly status: 'created' | 'existing'; readonly userId: string }> => {
  const existingUsers = await database
    .select({ email: user.email, id: user.id, name: user.name })
    .from(user)
    .where(eq(user.email, STAGE_DEMO.email))
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
      email: STAGE_DEMO.email,
      name: STAGE_DEMO.principalDisplayName,
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
      !(await verifyPassword({ hash: credential.password, password: configuration.password }))
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
      email: STAGE_DEMO.email,
      name: STAGE_DEMO.principalDisplayName,
      password: configuration.password,
    },
  });
  return { status: 'created', userId: created.user.id };
};

export const bootstrapStageDemo = (
  environment: StageDemoEnvironment = process.env,
): Effect.Effect<StageDemoBootstrapResult, StageDemoBootstrapError> =>
  Effect.gen(function* bootstrapStageDemoEffect() {
    const configuration = yield* parseStageDemoBootstrapConfig(environment);
    const authUser = yield* Effect.tryPromise({
      catch: (cause) =>
        cause instanceof StageDemoBootstrapError
          ? cause
          : new StageDemoBootstrapError({
              code: 'stage_demo_persistence_failed',
              reason: 'The stage demo Better Auth user could not be reconciled',
            }),
      try: async () => {
        const pool = new Pool({ connectionString: configuration.databaseAdminUrl });
        try {
          const authDatabase = drizzle({ client: pool, schema: authDatabaseSchema });
          return await ensureAuthUser(configuration, authDatabase);
        } finally {
          await pool.end();
        }
      },
    });
    const coreContext = yield* reconcileStageContextBootstrap(authUser.userId).pipe(
      Effect.mapError(
        (error) =>
          new StageDemoBootstrapError({
            code: 'stage_demo_persistence_failed',
            reason: error.reason,
          }),
      ),
    );
    return {
      authUser: authUser.status,
      email: STAGE_DEMO.email,
      legalEntityId: coreContext.legalEntityId,
      principalId: coreContext.principalId,
      tenantId: coreContext.tenantId,
    };
  });
