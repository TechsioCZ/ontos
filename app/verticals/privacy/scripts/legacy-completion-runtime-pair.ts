import type { LegacyCompletionNativeBinding } from '@app/core-runtime/legacy-completion-publication';
import { LegacyCompletionPublicationError } from '@app/core-runtime/legacy-completion-publication';
import type { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import type { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Effect, Schema } from 'effect';

import type { privacyRelations } from '../src/database/schema.ts';

type PrivacyExecutor = Effect.Success<ReturnType<typeof makeWithDefaults<typeof privacyRelations>>>;
type PrivacyTransaction = Parameters<Parameters<PrivacyExecutor['transaction']>[0]>[0];
const Text = Schema.String.check(Schema.isMinLength(1));
const ChallengeKeySchema = Schema.String.check(Schema.isPattern(/^-?\d+$/u)).pipe(
  Schema.brand('PrivacyLegacyNativeChallengeKey'),
);
const ChallengeSchema = Schema.Struct({ challengeKey: ChallengeKeySchema });
const RuntimeIdentitySchema = Schema.Struct({
  challengeAcquired: Schema.Literal(false),
  databaseName: Text,
  databaseOid: Text,
  databaseUser: Text,
  runtimeRoleOid: Text,
  safeRuntime: Schema.Literal(true),
});
const unavailable = (cause?: unknown) =>
  new LegacyCompletionPublicationError({
    cause,
    reason: 'Privacy requires verified runtime and administrative connections to the same native database',
  });

/** Interpreter for the actual runtime probe; configuration alone never supplies native identity. */
export const validatePrivacyLegacyRuntimeIdentity = Effect.fn('PrivacyLegacyCompletion.validateRuntimeIdentity')(
  function* validatePrivacyLegacyRuntimeIdentity(rows: readonly unknown[], binding: LegacyCompletionNativeBinding) {
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(RuntimeIdentitySchema))(rows).pipe(
      Effect.mapError(unavailable),
    );
    const runtime = decoded.at(0);
    if (
      decoded.length !== 1 ||
      runtime === undefined ||
      runtime.databaseName !== binding.databaseName ||
      runtime.databaseOid !== binding.databaseOid ||
      runtime.databaseUser !== binding.runtimeUser ||
      runtime.runtimeRoleOid !== binding.runtimeRoleOid
    ) {
      return yield* unavailable();
    }
    return yield* Effect.void;
  },
);

/** Both native clients are owner-private; this live challenge writes no persistent state. */
export const verifyPrivacyLegacyRuntimePair = Effect.fn('PrivacyLegacyCompletion.verifyRuntimePair')(
  function* verifyPrivacyLegacyRuntimePair(
    transaction: PrivacyTransaction,
    runtimeClient: PgClient.PgClient,
    binding: LegacyCompletionNativeBinding,
  ) {
    // Native administrative identity work: an unpredictable database-generated key fences a
    // second actual connection. A query builder cannot express this transaction lock challenge.
    const challenges = yield* transaction
      .execute(sql`select hashtextextended(gen_random_uuid()::text, 0)::text as "challengeKey"`, 'objects')
      .pipe(Effect.mapError(unavailable));
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(ChallengeSchema))(challenges).pipe(
      Effect.mapError(unavailable),
    );
    const challenge = decoded.at(0);
    if (decoded.length !== 1 || challenge === undefined) {
      return yield* unavailable();
    }
    yield* transaction
      .execute(sql`select pg_advisory_xact_lock(${challenge.challengeKey}::bigint)`, 'objects')
      .pipe(Effect.mapError(unavailable));
    // Each PgClient.make owns a distinct transactionService. This is the runtime pool's own
    // transaction, never the ambient admin transaction. Advisory locks are database-scoped, so a
    // foreign database/server can acquire this key and must be refused even if its OIDs coincide.
    return yield* runtimeClient
      .withTransaction(
        Effect.gen(function* observeActualRuntimeConnection() {
          const rows = yield* runtimeClient`
        select current_database() as "databaseName", d.oid::text as "databaseOid",
          current_user as "databaseUser", r.oid::text as "runtimeRoleOid",
          (not r.rolsuper and not r.rolbypassrls) as "safeRuntime",
          pg_try_advisory_xact_lock(${challenge.challengeKey}::bigint) as "challengeAcquired"
        from pg_database d join pg_roles r on r.rolname=current_user
        where d.datname=current_database()
      `;
          return yield* validatePrivacyLegacyRuntimeIdentity(rows, binding);
        }),
      )
      .pipe(Effect.mapError(unavailable));
  },
);
