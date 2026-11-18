/**
 * Evidence of a `{ run }` read: the read's own row plus one row per call, written in one fenced,
 * scoped write transaction of its own after the module's code, all rows or none (see
 * `run-evidence.ts`).
 */
import { Effect, Layer, Schema } from 'effect';
import { isSqlError } from 'effect/sql/SqlError';

import { recoverSqlTransactionError } from '../actions/repository.ts';
import { CoreDatabase } from '../db/client.ts';
import { installOperationalScope } from '../db/scoped-transaction.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../db/types.ts';
import type { CallRecord } from '../execution/contract.ts';
import {
  ApplicationCompositionAuthorityError,
  lockApplicationCompositionAuthority,
} from '../modules/application-composition-authority.ts';
import { TransactionAborted } from '../sdk/index.ts';
import { ReadEvidencePersistenceError } from './errors.ts';
import { persistReadEvidence } from './repository.ts';
import type { PersistReadEvidenceInput } from './repository.ts';
import { ReadRunEvidence } from './run-evidence.ts';
import type { CallEvidenceRows, ReadRunEvidenceService } from './run-evidence.ts';

const snakeCase = (tag: string) =>
  tag.replaceAll(/(?<lower>[a-z0-9])(?<upper>[A-Z])/gu, '$<lower>_$<upper>').toLowerCase();

const callOutcome = (outcome: CallRecord['outcome']): PersistReadEvidenceInput['outcome'] => {
  if (outcome === 'Ok') {
    return 'allowed';
  }
  return outcome === 'Forbidden' ? 'denied' : 'failed';
};

export const callEvidenceRows: CallEvidenceRows = (calls, base) =>
  Object.freeze(
    calls.map((record): PersistReadEvidenceInput =>
      Object.freeze({
        accessKind: base.accessKind,
        captureMode: base.captureMode,
        outcome: callOutcome(record.outcome),
        outcomeCode: `call_${snakeCase(record.outcome)}`,
        outcomeStage: 'execution',
        policyKey: base.policyKey,
        readKey: base.readKey,
        resultCount: record.outcome === 'Ok' ? 1 : 0,
        scope: base.scope,
        servingModuleKey: base.servingModuleKey,
        targetModuleKey: record.provider.moduleId,
        targetResourceType: record.provider.entrypointKey,
      }),
    ),
  );

const persistenceFailure = (cause: unknown): ReadEvidencePersistenceError => {
  const failure = new ReadEvidencePersistenceError({
    code: 'read_evidence_persistence_failed',
    reason: 'Required read evidence could not be persisted',
  });
  return Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

type SettleInput = Parameters<ReadRunEvidenceService['settle']>[0];

const writeRows = Effect.fn('ReadRunEvidence.writeRows')(function* writeRows(
  transaction: CoreTransaction,
  input: SettleInput,
) {
  if (input.admittedRevision !== undefined) {
    yield* lockApplicationCompositionAuthority(transaction, input.admittedRevision, 'read').pipe(
      Effect.mapError((failure) =>
        Schema.is(ApplicationCompositionAuthorityError)(failure)
          ? new TransactionAborted({ reason: 'composition_changed' })
          : persistenceFailure(failure),
      ),
    );
  }
  yield* installOperationalScope(transaction, input.scope).pipe(Effect.mapError(persistenceFailure));
  // One transaction, one connection: the rows go in order, and all of them commit or none does.
  yield* Effect.forEach(input.rows, (row) => persistReadEvidence(transaction, row), { concurrency: 1, discard: true });
});

/** The Core database the evidence is written to; the caller owns the pool and its deadlines. */
interface EvidenceDatabase {
  readonly executor: CoreDatabaseExecutor;
}

const settle = Effect.fn('ReadRunEvidence.settle')(function* settle(database: EvidenceDatabase, input: SettleInput) {
  if (input.rows.length === 0) {
    return;
  }
  yield* database.executor
    .transaction((transaction) => writeRows(transaction, input), {
      accessMode: 'read write',
      isolationLevel: 'read committed',
    })
    .pipe(
      recoverSqlTransactionError,
      Effect.catchIf(isSqlError, (failure) => Effect.fail(persistenceFailure(failure))),
    );
});

export const ReadRunEvidenceLive: Layer.Layer<ReadRunEvidence, never, CoreDatabase> = Layer.effect(
  ReadRunEvidence,
  Effect.gen(function* makeReadRunEvidence() {
    const database = yield* CoreDatabase;
    return ReadRunEvidence.of({
      settle: (input) => settle(database, input),
    });
  }),
);
