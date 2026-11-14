import { env } from 'cloudflare:workers';
import { ConfigProvider, Effect, Option, Redacted, Schema } from 'effect';

import { DatabaseConfigError } from './config-error.ts';
import type { DatabaseRuntime } from './database-runtime.ts';

/** The part of workerd's Hyperdrive binding a Worker connects with, redacted as soon as it is read. */
const HyperdriveBindingSchema = Schema.Struct({ connectionString: Schema.RedactedFromValue(Schema.String) });

/**
 * A Worker reaches PostgreSQL only through the Hyperdrive binding of the identity it connects as,
 * which pools connections at the edge. The Effect BFF runtime serving a request is built for that
 * request, so its pool never outlives the request whose sockets it holds.
 */
export const databaseRuntime: DatabaseRuntime = Object.freeze<DatabaseRuntime>({
  connectionIdentity: 'hyperdrive',
  runtimeDatabaseProvider: (base, identity) => {
    const hyperdrive = identity.cloudflareHyperdrive;
    if (hyperdrive === null) {
      return Effect.fail(
        new DatabaseConfigError({ reason: 'This database identity has no Cloudflare Worker binding' }),
      );
    }
    return Option.match(Schema.decodeUnknownOption(HyperdriveBindingSchema)(env[hyperdrive.binding]), {
      onNone: () =>
        Effect.fail(new DatabaseConfigError({ reason: `The ${hyperdrive.binding} Worker binding is required` })),
      onSome: ({ connectionString }) =>
        Effect.succeed(
          ConfigProvider.fromUnknown({ [identity.urlKey]: Redacted.value(connectionString) }).pipe(
            ConfigProvider.orElse(base),
          ),
        ),
    });
  },
});
