import { Context, Crypto, Effect, Layer } from 'effect';

import { recoverSqlTransactionError } from '../../actions/repository.ts';
import { CoreDatabase } from '../../db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../db/database-identities.ts';
import { installOperationalScope } from '../../db/scoped-transaction.ts';
import { accessDecisionLogs } from '../../db/schema.ts';
import { accessDecisionUnavailable } from '../decision/errors.ts';
import type { AccessDecisionUnavailable } from '../decision/errors.ts';
import { decisionLogIdOf, decisionLogRowOf, logUnavailable } from './decision-log.ts';
import type { AccessDecisionLogDatabase, AccessDecisionLogEntry } from './decision-log.ts';

/**
 * Every evidence row of one inspection batch, written together: one transaction, one scope installation and
 * multi-row inserts into the same table, with the same content, as `AccessDecisionLog.record` writes one row. All
 * entries name the same request scope object; a batch spanning scopes is refused. Either every row is written or none
 * is, and a failure is UNAVAILABLE, so a batch whose evidence was not kept is not answered.
 */
export interface AccessDecisionLogBatchWriter {
  readonly recordAll: (entries: readonly AccessDecisionLogEntry[]) => Effect.Effect<void, AccessDecisionUnavailable>;
}

export class AccessDecisionLogBatch extends Context.Service<AccessDecisionLogBatch, AccessDecisionLogBatchWriter>()(
  '@app/core-runtime/access/enforcement/decision-log-batch/AccessDecisionLogBatch',
) {}

/** Rows per INSERT: 16 columns each keeps one statement far below PostgreSQL's 65 535 bind parameters. */
const DECISION_LOG_ROWS_PER_INSERT = 500;

/** Every row of one batch in one transaction, under the one scope all of them were decided in. */
const recordAllEffect = Effect.fn('AccessDecisionLog.recordAll')(function* recordAllDecisionLogs(
  database: AccessDecisionLogDatabase,
  crypto: Crypto.Crypto,
  entries: readonly AccessDecisionLogEntry[],
) {
  const [first] = entries;
  if (first === undefined) {
    return yield* Effect.void;
  }
  if (entries.some((entry) => entry.scope !== first.scope)) {
    return yield* accessDecisionUnavailable('A decision record batch must name exactly one request scope');
  }
  const rows = yield* Effect.forEach(
    entries,
    (entry) => decisionLogIdOf(crypto).pipe(Effect.map((decisionLogId) => decisionLogRowOf(entry, decisionLogId))),
    { concurrency: 1 },
  );
  const chunks = Array.from({ length: Math.ceil(rows.length / DECISION_LOG_ROWS_PER_INSERT) }, (_, index) =>
    rows.slice(index * DECISION_LOG_ROWS_PER_INSERT, (index + 1) * DECISION_LOG_ROWS_PER_INSERT),
  );
  // One connection holds the transaction, so its inserts run one after another.
  return yield* database.executor.transaction((opened) =>
    installOperationalScope(opened, first.scope, database.enrollment).pipe(
      Effect.andThen(() =>
        Effect.forEach(chunks, (chunk) => opened.insert(accessDecisionLogs).values(chunk), {
          concurrency: 1,
          discard: true,
        }),
      ),
    ),
  );
});

export const makeDrizzleAccessDecisionLogBatch = (
  database: AccessDecisionLogDatabase,
  crypto: Crypto.Crypto,
): AccessDecisionLogBatchWriter => ({
  recordAll: (entries) =>
    recordAllEffect(database, crypto, entries).pipe(
      recoverSqlTransactionError,
      Effect.mapError(logUnavailable),
      Effect.asVoid,
    ),
});

export const AccessDecisionLogBatchLive: Layer.Layer<
  AccessDecisionLogBatch,
  never,
  CoreDatabase | Crypto.Crypto | DatabaseIdentityEnrollmentContext
> = Layer.effect(
  AccessDecisionLogBatch,
  Effect.gen(function* accessDecisionLogBatchLive() {
    const database = yield* CoreDatabase;
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    return makeDrizzleAccessDecisionLogBatch({ enrollment, executor: database.executor }, yield* Crypto.Crypto);
  }),
);
