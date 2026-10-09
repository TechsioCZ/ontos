import { PgClient } from '@effect/sql-pg';
import { Context, Effect, Layer, Redacted, Schema } from 'effect';

import { loadDatabaseConnectionPair } from '../../src/db/config.ts';

/** The two native search suites share one authority fixture and restore the exact prior row. */
export const installSearchTestAuthority = Effect.fn('SearchTests.installAuthority')(
  function* installSearchAuthorityFixture() {
    const connections = yield* loadDatabaseConnectionPair();
    const services = yield* Layer.build(
      PgClient.layerFrom(PgClient.makeClient({ url: Redacted.make(connections.admin.connectionString) })),
    );
    const session = Context.get(services, PgClient.PgClient);
    yield* session.unsafe("select pg_advisory_lock(hashtextextended('ontos.search-test-authority', 0))");
    const [previous] = yield* session.unsafe<{
      phase: string;
      revision: string;
      subscriptions_json: unknown;
      updated_at: string;
      valid_until: string;
    }>(
      "select revision, phase, valid_until::text, subscriptions_json, updated_at::text from core.application_composition_authority where authority_key = 'active'",
    );
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* restoreSearchTestAuthority() {
        if (previous === undefined) {
          yield* session.unsafe("delete from core.application_composition_authority where authority_key = 'active'");
        } else {
          const subscriptions = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            previous.subscriptions_json,
          );
          yield* session.unsafe(
            "insert into core.application_composition_authority (authority_key, revision, phase, valid_until, subscriptions_json, updated_at) values ('active', $1, $2, $3::timestamptz, $4::jsonb, $5::timestamptz) on conflict (authority_key) do update set revision = excluded.revision, phase = excluded.phase, valid_until = excluded.valid_until, subscriptions_json = excluded.subscriptions_json, updated_at = excluded.updated_at",
            [previous.revision, previous.phase, previous.valid_until, subscriptions, previous.updated_at],
          );
        }
        yield* session.unsafe("select pg_advisory_unlock(hashtextextended('ontos.search-test-authority', 0))");
      }).pipe(Effect.orDie),
    );
    yield* session.unsafe(
      "insert into core.application_composition_authority (authority_key, revision, phase, valid_until, subscriptions_json) values ('active', $1, 'active', clock_timestamp() + interval '1 hour', '[]'::jsonb) on conflict (authority_key) do update set revision = excluded.revision, phase = excluded.phase, valid_until = excluded.valid_until, subscriptions_json = excluded.subscriptions_json",
      ['a'.repeat(64)],
    );
  },
);
