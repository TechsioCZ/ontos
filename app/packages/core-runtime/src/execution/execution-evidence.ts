import { Context } from 'effect';
import type { Effect } from 'effect';

import type { OperationalScope } from '../operations/context.ts';
import type { ReadEvidencePersistenceError } from '../reads/errors.ts';
import type { PersistReadEvidenceInput } from '../reads/repository.ts';
import type { TransactionAborted } from '../sdk/index.ts';

/**
 * Writes the evidence of one execution (`execution/evidence.ts`). Obligations: one `CoreDatabase`
 * transaction that fences `admittedRevision` (as the opener does, failing
 * `TransactionAborted('composition_changed')`), installs `scope`, and inserts every row with
 * `persistReadEvidence`. All rows or none. It is a write transaction, separate from the module's READ
 * ONLY ones.
 */
export interface ExecutionEvidenceService {
  readonly settle: (input: {
    readonly admittedRevision: string | undefined;
    readonly rows: readonly PersistReadEvidenceInput[];
    readonly scope: OperationalScope;
  }) => Effect.Effect<void, ReadEvidencePersistenceError | TransactionAborted>;
}

export class ExecutionEvidence extends Context.Service<ExecutionEvidence, ExecutionEvidenceService>()(
  '@app/core-runtime/execution/execution-evidence/ExecutionEvidence',
) {}
