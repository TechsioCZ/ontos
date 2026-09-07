import { pathToFileURL } from 'node:url';
import { NodeFileSystem, NodeRuntime } from '@effect/platform-node';
import { Config, ConfigProvider, Duration, Effect, Layer, Redacted, Schema } from 'effect';
import { Client } from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';
import { APP_ENV_PATH } from '@app/core-runtime/workspace-environment';

export const ContactsJournalStateSchema = Schema.Literals([
  'ambiguous',
  'contacts',
  'fresh',
  'legacy',
]);
export type ContactsJournalState = typeof ContactsJournalStateSchema.Type;

class ContactsMigrationError extends Schema.TaggedError<ContactsMigrationError>()(
  'ContactsMigrationError',
  {
    cause: Schema.Unknown,
    message: Schema.String,
  },
) {}

const POSTGRES_OPERATION_TIMEOUT = Duration.seconds(30);
const requiredConnectionStringSchema = Schema.Trim.pipe(Schema.check(Schema.isMinLength(1)));
const databaseAdminUrl = Config.schema(
  Schema.Redacted(requiredConnectionStringSchema),
  'DATABASE_ADMIN_URL',
);

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

const query = <Row extends QueryResultRow = QueryResultRow>(
  client: Client,
  text: string,
): Effect.Effect<QueryResult<Row>, ContactsMigrationError> => {
  const executeQuery: (queryText: string) => Promise<QueryResult<Row>> = client.query.bind(client);
  return Effect.tryPromise({
    catch: (cause) => databaseFailure(`PostgreSQL query failed: ${text}`, cause),
    try: executeQuery.bind(undefined, text),
  }).pipe(
    Effect.timeoutOrElse({
      duration: POSTGRES_OPERATION_TIMEOUT,
      orElse: () => Effect.fail(databaseFailure(`PostgreSQL query timed out: ${text}`, 'timeout')),
    }),
  );
};

const connect = Effect.fn('ContactsMigration.connect')(function* connectEffect(
  connectionString: Redacted.Redacted,
) {
  const client = yield* Effect.try({
    catch: (cause) => databaseFailure('Unable to create the PostgreSQL client', cause),
    try: () => new Client({ connectionString: Redacted.value(connectionString) }),
  });
  yield* Effect.tryPromise({
    catch: (cause) => databaseFailure('Unable to connect to PostgreSQL', cause),
    try: client.connect.bind(client),
  }).pipe(
    Effect.timeoutOrElse({
      duration: POSTGRES_OPERATION_TIMEOUT,
      orElse: () =>
        Effect.fail(databaseFailure('PostgreSQL connection attempt timed out', 'timeout')),
    }),
  );
  return client;
});

const close = (client: Client) =>
  Effect.tryPromise({
    catch: (cause) => databaseFailure('Unable to close the PostgreSQL connection', cause),
    try: client.end.bind(client),
  }).pipe(
    Effect.timeoutOrElse({
      duration: POSTGRES_OPERATION_TIMEOUT,
      orElse: () =>
        Effect.fail(databaseFailure('PostgreSQL connection close timed out', 'timeout')),
    }),
  );

export const classifyContactsJournalState = (
  legacy: boolean,
  contacts: boolean,
): ContactsJournalState => {
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

export const prepareContactsMigration = Effect.fn('prepareContactsMigration')(
  function* prepareContactsMigrationEffect(client: Client) {
    return yield* Effect.gen(function* prepareContactsTransactionEffect() {
      yield* query(client, 'begin');
      const result = yield* query<{ contacts: boolean; legacy: boolean }>(
        client,
        `select
        to_regclass('drizzle.__drizzle_migrations_crm') is not null as legacy,
        to_regclass('drizzle.__drizzle_migrations_contacts') is not null as contacts`,
      );
      const state = classifyContactsJournalState(
        result.rows[0]?.legacy === true,
        result.rows[0]?.contacts === true,
      );
      if (state === 'ambiguous') {
        return yield* new ContactsMigrationError({
          cause: state,
          message: 'Ambiguous Contacts migration state: both CRM and Contacts journals exist',
        });
      }
      if (state === 'legacy') {
        yield* query(
          client,
          'alter table drizzle.__drizzle_migrations_crm rename to __drizzle_migrations_contacts',
        );
      }
      yield* query(client, 'commit');
      return state;
    }).pipe(Effect.tapError(() => query(client, 'rollback')));
  },
);

const main = Effect.gen(function* mainEffect() {
  const connectionString = yield* databaseAdminUrl;
  yield* Effect.acquireUseRelease(
    connect(connectionString),
    (client) =>
      prepareContactsMigration(client).pipe(
        Effect.tap((state) =>
          Effect.sync(() => {
            process.stdout.write(`Contacts migration journal preparation: ${state}\n`);
          }),
        ),
      ),
    close,
  );
});

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const MainLayer = Layer.effectDiscard(main).pipe(Layer.provide(RootConfigProvider));
  NodeRuntime.runMain(Effect.scoped(Layer.build(MainLayer)));
}
