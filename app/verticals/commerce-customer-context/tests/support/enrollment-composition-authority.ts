import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { Context, Effect, Layer, Redacted, Schema, Scope } from 'effect';

import { acquireOutlivingCleanup } from '../../../../packages/core-runtime/tests/support/database.ts';

/** Fixture state is replaced, never transitioned (see the restore below). */
const DELETE_AUTHORITY = "delete from core.application_composition_authority where authority_key = 'active'";

export const ENROLLMENT_TEST_COMPOSITION_REVISION = 'a'.repeat(64);

/** Serialize only this dedicated fixture authority and restore its exact prior release. */
const acquireEnrollmentTestAuthority = Effect.fn('EnrollmentTests.acquireAuthority')(
  function* installEnrollmentTestAuthority(revision: string) {
    const connections = yield* loadDatabaseConnectionPair();
    const services = yield* acquireOutlivingCleanup(
      Layer.build(PgClient.layerFrom(PgClient.makeClient({ url: Redacted.make(connections.admin.connectionString) }))),
    );
    const session = Context.get(services, PgClient.PgClient);
    yield* session.unsafe("select pg_advisory_lock(hashtextextended('ontos.enrollment-test-authority', 0))");
    const [previous] = yield* session.unsafe<{
      durable_work_admission: string;
      phase: string;
      revision: string;
      subscriptions_json: unknown;
      updated_at: string;
      valid_until: string;
    }>(
      "select revision, phase, durable_work_admission, valid_until::text, subscriptions_json, updated_at::text from core.application_composition_authority where authority_key = 'active'",
    );
    yield* Effect.addFinalizer(() =>
      session
        .withTransaction(
          Effect.gen(function* restoreEnrollmentTestAuthority() {
            yield* session.unsafe(
              "select pg_advisory_xact_lock(hashtextextended('ontos.application-composition-authority', 0))",
            );
            if (previous === undefined) {
              yield* session.unsafe(DELETE_AUTHORITY);
            } else {
              const subscriptions = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
                previous.subscriptions_json,
              );
              // Fixture state is replaced, never transitioned: an update from a draining row of the same revision
              // back to active is refused unless a drain abandonment is recorded.
              yield* session.unsafe(DELETE_AUTHORITY);
              yield* session.unsafe(
                "insert into core.application_composition_authority (authority_key, revision, phase, durable_work_admission, valid_until, subscriptions_json, updated_at) values ('active', $1, $2, $3, $4::timestamptz, $5::jsonb, $6::timestamptz)",
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
            yield* session.unsafe("select pg_advisory_unlock(hashtextextended('ontos.enrollment-test-authority', 0))");
          }),
        )
        .pipe(Effect.orDie),
    );
    const setRelease = (selectedRevision: string, phase: 'active' | 'draining') =>
      session.withTransaction(
        Effect.gen(function* setEnrollmentTestRelease() {
          yield* session.unsafe(
            "select pg_advisory_xact_lock(hashtextextended('ontos.application-composition-authority', 0))",
          );
          // Replaced, never transitioned (see the restore above).
          yield* session.unsafe(DELETE_AUTHORITY);
          yield* session.unsafe(
            "insert into core.application_composition_authority (authority_key, revision, phase, durable_work_admission, valid_until, subscriptions_json) values ('active', $1, $2, 'open', clock_timestamp() + interval '1 hour', '[]'::jsonb)",
            [selectedRevision, phase],
          );
        }),
      );
    yield* setRelease(revision, 'active');
    return { setRelease };
  },
);

const authorities = new WeakMap<
  Scope.Scope,
  { readonly authority: ReturnType<typeof acquireEnrollmentTestAuthority>; readonly revision: string }
>();

/** Multiple Tenant fixtures in one scenario use the same session and release. */
export const installEnrollmentTestAuthority = Effect.fn('EnrollmentTests.installAuthority')(
  function* installEnrollmentTestAuthority(revision: string) {
    const scope = yield* Scope.Scope;
    const existing = authorities.get(scope);
    if (existing !== undefined) {
      if (existing.revision !== revision) {
        return yield* Effect.die(new Error('One enrollment fixture scope must use one original release'));
      }
      return yield* existing.authority;
    }
    const authority = yield* Effect.cached(acquireEnrollmentTestAuthority(revision));
    authorities.set(scope, { authority, revision });
    return yield* authority;
  },
);
