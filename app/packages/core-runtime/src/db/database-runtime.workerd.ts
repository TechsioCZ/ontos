import { env } from 'cloudflare:workers';
import { ConfigProvider, Effect, Option, Redacted, Schema } from 'effect';

import { DatabaseConfigError } from './config-error.ts';
import type { DatabaseRuntime } from './database-runtime.ts';

/** The part of workerd's Hyperdrive binding a Worker connects with, redacted as soon as it is read. */
const HyperdriveBindingSchema = Schema.Struct({ connectionString: Schema.RedactedFromValue(Schema.String) });

/**
 * A Worker reaches PostgreSQL only through its `HYPERDRIVE` binding, which pools connections at the
 * edge. The Effect BFF runtime serving a request is built for that request, so its pool never
 * outlives the request whose sockets it holds.
 */
export const databaseRuntime: DatabaseRuntime = Object.freeze<DatabaseRuntime>({
  runtimeDatabaseProvider: (base) =>
    Option.match(Schema.decodeUnknownOption(HyperdriveBindingSchema)(env['HYPERDRIVE']), {
      onNone: () => Effect.fail(new DatabaseConfigError({ reason: 'The HYPERDRIVE Worker binding is required' })),
      onSome: ({ connectionString }) =>
        Effect.succeed(
          ConfigProvider.fromUnknown({ DATABASE_URL: Redacted.value(connectionString) }).pipe(
            ConfigProvider.orElse(base),
          ),
        ),
    }),
});
