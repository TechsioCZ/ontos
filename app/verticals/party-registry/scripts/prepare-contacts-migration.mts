import { pathToFileURL } from 'node:url';

import { APP_ENV_PATH } from '@app/core-runtime/workspace-environment';
import { NodeFileSystem, NodeRuntime } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Config, ConfigProvider, Duration, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';

export const ContactsJournalStateSchema = Schema.Literals(['ambiguous', 'contacts', 'fresh', 'legacy']);
export type ContactsJournalState = typeof ContactsJournalStateSchema.Type;

class ContactsMigrationError extends Schema.TaggedError<ContactsMigrationError>()('ContactsMigrationError', {
  cause: Schema.Unknown,
  message: Schema.String,
}) {}

const POSTGRES_OPERATION_TIMEOUT = Duration.seconds(30);
const requiredConnectionStringSchema = Schema.Trim.pipe(Schema.check(Schema.isMinLength(1)));
const databaseAdminUrl = Config.schema(Schema.Redacted(requiredConnectionStringSchema), 'DATABASE_ADMIN_URL');

const fileConfigProvider = ConfigProvider.fromDotEnv({
  path: APP_ENV_PATH,
  preserveEmptyStrings: true,
}).pipe(Effect.orElseSucceed(() => ConfigProvider.fromUnknown({}, { preserveEmptyStrings: true })));

const RootConfigProvider = ConfigProvider.layer(
  fileConfigProvider.pipe(
    Effect.map((fileProvider) =>
      ConfigProvider.orElse(ConfigProvider.fromEnv({ preserveEmptyStrings: true }), fileProvider),
    ),
  ),
).pipe(Layer.provide(NodeFileSystem.layer));

const databaseFailure = (message: string, cause: unknown): ContactsMigrationError =>
  new ContactsMigrationError({ cause, message });

const query = <Row extends object>(client: PgClient.PgClient, text: string) =>
  client.unsafe<Row>(text).pipe(Effect.mapError((cause) => databaseFailure(`PostgreSQL query failed: ${text}`, cause)));

export const classifyContactsJournalState = (legacy: boolean, contacts: boolean): ContactsJournalState => {
  if (legacy && contacts) {
    return 'ambiguous';
  }
  if (legacy) {
    return 'legacy';
  }
  if (contacts) {
    return 'contacts';
  }
  return 'fresh';
};

export const prepareContactsMigration = Effect.fn('prepareContactsMigration')(function* prepareContactsMigrationEffect(
  client: PgClient.PgClient,
) {
  return yield* client
    .withTransaction(
      Effect.gen(function* prepareContactsTransactionEffect() {
        const rows = yield* query<{ contacts: boolean; legacy: boolean }>(
          client,
          `select
        to_regclass('drizzle.__drizzle_migrations_crm') is not null as legacy,
        to_regclass('drizzle.__drizzle_migrations_contacts') is not null as contacts`,
        );
        const state = classifyContactsJournalState(rows[0]?.legacy === true, rows[0]?.contacts === true);
        if (state === 'ambiguous') {
          return yield* new ContactsMigrationError({
            cause: state,
            message: 'Ambiguous Contacts migration state: both CRM and Contacts journals exist',
          });
        }
        if (state === 'legacy') {
          yield* query(client, 'alter table drizzle.__drizzle_migrations_crm rename to __drizzle_migrations_contacts');
        }
        return state;
      }),
    )
    .pipe(
      Effect.catchTag('SqlError', (cause) =>
        Effect.fail(databaseFailure('PostgreSQL transaction control failed', cause)),
      ),
    );
});

const main = Effect.gen(function* mainEffect() {
  const connectionString = yield* databaseAdminUrl;
  // PostgreSQL enforces the statement deadline itself; the driver bounds connection setup.
  const client = yield* PgClient.makeClient({
    connectTimeout: POSTGRES_OPERATION_TIMEOUT,
    startupParameters: { statement_timeout: `${Duration.toMillis(POSTGRES_OPERATION_TIMEOUT)}ms` },
    url: connectionString,
  }).pipe(Effect.mapError((cause) => databaseFailure('Unable to connect to PostgreSQL', cause)));
  const state = yield* prepareContactsMigration(client);
  yield* Effect.sync(() => {
    process.stdout.write(`Contacts migration journal preparation: ${state}\n`);
  });
});

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const MainLayer = Layer.effectDiscard(main).pipe(Layer.provide([RootConfigProvider, Reactivity.layer]));
  NodeRuntime.runMain(Effect.scoped(Layer.build(MainLayer)));
}
