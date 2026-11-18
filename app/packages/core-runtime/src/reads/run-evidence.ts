import { Context } from 'effect';
import type { Effect } from 'effect';

import type { CallRecord } from '../execution/contract.ts';
import type { OperationalScope } from '../operations/context.ts';
import type { TransactionAborted } from '../sdk/index.ts';
import type { ReadEvidenceCaptureMode } from './definition.ts';
import type { ReadEvidencePersistenceError } from './errors.ts';
import type { PersistReadEvidenceInput } from './repository.ts';

/**
 * One `data_access_events` row per call of a `{ run }` read (`reads/run-evidence-live.ts`, runner
 * lane): `servingModuleKey` = the calling module, `targetModuleKey` = `provider.moduleId`,
 * `targetResourceType` = `provider.entrypointKey`, `outcomeStage: 'execution'`, `outcome` = `allowed`
 * for `Ok`, `denied` for `Forbidden`, otherwise `failed`, `outcomeCode` = `call_` + the snake-cased
 * outcome tag, `resultCount` 1 for `Ok`, else 0, and the read's own `policyKey`, `captureMode`,
 * `readKey` and `accessKind`.
 */
export type CallEvidenceRows = (
  calls: readonly CallRecord[],
  base: Readonly<{
    readonly accessKind: PersistReadEvidenceInput['accessKind'];
    readonly captureMode: ReadEvidenceCaptureMode;
    readonly policyKey: string;
    readonly readKey: string;
    readonly scope: OperationalScope;
    readonly servingModuleKey: string;
  }>,
) => readonly PersistReadEvidenceInput[];

/**
 * Writes the evidence of one `{ run }` read (`reads/run-evidence-live.ts`, runner lane). Obligations:
 * one `CoreDatabase` write transaction (`executor.transaction(body, { accessMode: 'read write',
 * isolationLevel: 'read committed' })`) that fences `admittedRevision` exactly as the opener does
 * (failing `TransactionAborted('composition_changed')`), installs `scope`, and inserts every row with
 * `persistReadEvidence`. All rows or none. Separate from the module's READ ONLY transactions.
 */
export interface ReadRunEvidenceService {
  readonly settle: (input: {
    readonly admittedRevision: string | undefined;
    readonly rows: readonly PersistReadEvidenceInput[];
    readonly scope: OperationalScope;
  }) => Effect.Effect<void, ReadEvidencePersistenceError | TransactionAborted>;
}

export class ReadRunEvidence extends Context.Service<ReadRunEvidence, ReadRunEvidenceService>()(
  '@app/core-runtime/reads/run-evidence/ReadRunEvidence',
) {}
