import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { Context, Effect, Layer, Redacted, Ref, Schema } from 'effect';

import { acquireOutlivingCleanup } from '../../../../packages/core-runtime/tests/support/database.ts';

/**
 * Core's single Application Composition authority for Payment tests that make an operation's effect
 * unknown. An INDETERMINATE Payment Operation is Core durable work of payment.core under the runtime
 * revision of the invocation that made it unknown (#1151/#1153 TECH-01), and Core tracks or clears such
 * work only while exactly that revision is the active, unexpired authority. The fixture holds the
 * publication lock Core's native suites share for the whole test, publishes the requested revision,
 * and on release removes the Payment work it admitted and restores the exact prior authority row.
 */

/** The session lock Core's native suites share for their exclusive use of the authority row. */
const FIXTURE_LOCK = "hashtextextended('ontos.search-test-authority', 0)";
/** Core's own publication lock, which every durable-work tracking call takes shared. */
const PUBLICATION_LOCK = "hashtextextended('ontos.application-composition-authority', 0)";

const PreviousAuthoritySchema = Schema.Struct({
  durable_work_admission: Schema.String,
  phase: Schema.String,
  revision: Schema.String,
  subscriptions_json: Schema.Unknown,
  updated_at: Schema.String,
  valid_until: Schema.String,
});

export const installPaymentTestCompositionAuthority = Effect.fn('PaymentTests.installCompositionAuthority')(
  function* installPaymentTestCompositionAuthority(revision: string) {
    const connections = yield* loadDatabaseConnectionPair();
    const services = yield* acquireOutlivingCleanup(
      Layer.build(PgClient.layerFrom(PgClient.makeClient({ url: Redacted.make(connections.admin.connectionString) }))),
    );
    const session = Context.get(services, PgClient.PgClient);
    yield* session.unsafe(`select pg_advisory_lock(${FIXTURE_LOCK})`);
    const previousRows = yield* session.unsafe(
      "select revision, phase, durable_work_admission, valid_until::text, subscriptions_json, updated_at::text from core.application_composition_authority where authority_key = 'active'",
    );
    const [previous] = yield* Schema.decodeUnknownEffect(Schema.Array(PreviousAuthoritySchema))(previousRows);
    const activated = yield* Ref.make<ReadonlySet<string>>(new Set());
    yield* Effect.addFinalizer(() =>
      session
        .withTransaction(
          Effect.gen(function* restorePaymentTestAuthority() {
            yield* session.unsafe(`select pg_advisory_xact_lock(${PUBLICATION_LOCK})`);
            yield* session.unsafe(
              "delete from core.application_composition_durable_work where owner_module_key = 'payment.core' and original_revision = any($1::text[])",
              [[...(yield* Ref.get(activated))]],
            );
            if (previous === undefined) {
              yield* session.unsafe(
                "delete from core.application_composition_authority where authority_key = 'active'",
              );
            } else {
              const subscriptions = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
                previous.subscriptions_json,
              );
              yield* session.unsafe(
                "insert into core.application_composition_authority (authority_key, revision, phase, durable_work_admission, valid_until, subscriptions_json, updated_at) values ('active', $1, $2, $3, $4::timestamptz, $5::jsonb, $6::timestamptz) on conflict (authority_key) do update set revision = excluded.revision, phase = excluded.phase, durable_work_admission = excluded.durable_work_admission, valid_until = excluded.valid_until, subscriptions_json = excluded.subscriptions_json, updated_at = excluded.updated_at",
                [
                  previous.revision,
                  previous.phase,
                  previous.durable_work_admission,
                  previous.valid_until,
                  subscriptions,
                  previous.updated_at,
                ],
              );
            }
          }),
        )
        .pipe(Effect.andThen(session.unsafe(`select pg_advisory_unlock(${FIXTURE_LOCK})`)), Effect.orDie),
    );
    /** Publishes `selected` as the active, open, unexpired release (the next compatible runtime, R2). */
    const activate = (selected: string) =>
      session
        .withTransaction(
          Effect.gen(function* publishPaymentTestRelease() {
            yield* session.unsafe(`select pg_advisory_xact_lock(${PUBLICATION_LOCK})`);
            yield* session.unsafe(
              "insert into core.application_composition_authority (authority_key, revision, phase, durable_work_admission, valid_until, subscriptions_json) values ('active', $1, 'active', 'open', clock_timestamp() + interval '1 hour', '[]'::jsonb) on conflict (authority_key) do update set revision = excluded.revision, phase = excluded.phase, durable_work_admission = excluded.durable_work_admission, valid_until = excluded.valid_until, subscriptions_json = excluded.subscriptions_json",
              [selected],
            );
          }),
        )
        .pipe(Effect.andThen(Ref.update(activated, (revisions) => new Set([...revisions, selected]))));
    yield* activate(revision);
    return { activate };
  },
);
