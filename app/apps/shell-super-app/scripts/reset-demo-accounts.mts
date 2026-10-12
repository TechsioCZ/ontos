import { DatabaseConfig, parseDatabaseConfig } from '@app/core-runtime';
import { NodeServices } from '@effect/platform-node';
import { hashPassword } from 'better-auth/crypto';
import { Config, Console, DateTime, Effect, FileSystem, Layer, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';

import { AuthDatabase, AuthDatabaseFromDatabaseConfigLive } from '../api/auth/db/client.ts';
import { account, user } from '../api/auth/db/schema.ts';

const AuthUserIdSchema = Schema.toEncoded(
  Schema.String.check(Schema.isPattern(/^siampark-(?:management|operations|finance|external)$/u)).pipe(
    Schema.brand('SiamparkAuthUserId'),
  ),
);
const FixtureSchema = Schema.Struct({
  accounts: Schema.Array(
    Schema.Struct({
      authUserId: AuthUserIdSchema,
      displayName: Schema.NonEmptyString,
      email: Schema.String.check(Schema.isPattern(/^(?:management|operations|finance|external)@siampark\.demo$/u)),
    }),
  ),
});
class ResetAccountsError extends Schema.TaggedError<ResetAccountsError>()('ResetAccountsError', {
  reason: Schema.String,
}) {}
const main = (fixturePath: string) =>
  Effect.gen(function* resetDemoAccounts() {
    yield* Config.schema(Schema.Literal('development'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
    const fs = yield* FileSystem.FileSystem;
    const input = yield* fs
      .readFileString(fixturePath)
      .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(FixtureSchema))));
    if (
      input.accounts.length !== 4 ||
      new Set(input.accounts.map((row) => row.authUserId)).size !== 4 ||
      input.accounts.some((row) => row.email !== `${row.authUserId.slice('siampark-'.length)}@siampark.demo`)
    ) {
      return yield* new ResetAccountsError({
        reason: 'The fixture must contain the four distinct Siampark accounts with matching emails',
      });
    }
    const { executor } = yield* AuthDatabase;
    const now = yield* DateTime.nowAsDate;
    const password = yield* Effect.tryPromise({
      catch: () => new ResetAccountsError({ reason: 'Unable to prepare development credentials' }),
      try: async () => await hashPassword('password1234'),
    });
    yield* executor.transaction((transaction) =>
      Effect.gen(function* resetAuthenticationRows() {
        for (const row of input.accounts) {
          yield* transaction
            .insert(user)
            .values({ banned: false, email: row.email, emailVerified: true, id: row.authUserId, name: row.displayName })
            .onConflictDoUpdate({
              set: { banned: false, email: row.email, name: row.displayName, updatedAt: now },
              target: user.id,
            });
          yield* transaction
            .insert(account)
            .values({
              accountId: row.authUserId,
              id: `${row.authUserId}-credential`,
              password,
              providerId: 'credential',
              updatedAt: now,
              userId: row.authUserId,
            })
            .onConflictDoUpdate({ set: { password, updatedAt: now }, target: account.id });
        }
      }),
    );
    return yield* Console.log('Four Siampark development accounts initialized');
  });
const AdminDatabaseConfigLive = Layer.effect(
  DatabaseConfig,
  Effect.gen(function* adminDatabaseConfiguration() {
    yield* Config.schema(Schema.Literal('development'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
    const connection = yield* Config.Redacted('DATABASE_ADMIN_URL');
    const configuration = yield* parseDatabaseConfig({ DATABASE_URL: Redacted.value(connection) });
    if (!['localhost', '127.0.0.1', '[::1]'].includes(configuration.host)) {
      return yield* new ResetAccountsError({ reason: 'Demo accounts require local PostgreSQL' });
    }
    return configuration;
  }),
);
const command = Command.make('demo-fixture', { fixture: Flag.String('fixture') }, ({ fixture }) =>
  Layer.build(
    Layer.effectDiscard(main(fixture)).pipe(
      Layer.provide(AuthDatabaseFromDatabaseConfigLive.pipe(Layer.provide(AdminDatabaseConfigLive))),
    ),
  ).pipe(
    Effect.scoped,
    Effect.asVoid,
    Effect.tapError((failure) => Console.error(`Fixture port failed: ${failure._tag}`)),
  ),
);
const runtimeLive = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
  Layer.provide(NodeServices.layer),
);
await Effect.runPromise(Effect.scoped(Layer.build(runtimeLive)));
