import { defineScopedRoutine } from '@app/core-runtime';
import type { ScopedRoutineInvoker } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { SymmyJobPrivacyExecutionStoredReceiptSchema } from '../../shared/domain/symmy-job-privacy-execution.ts';
import type { SymmyJobPrivacyExecutionStoredReceipt } from '../../shared/domain/symmy-job-privacy-execution.ts';
import { SymmyJobPrivacyExecutionError } from './symmy-job-privacy-execution-error.ts';

const base = { ownerModuleKey: 'integration.symmy', schema: 'symmy_integration' } as const;
const receiptRowSchema = Schema.Struct({
  receipt: Schema.OptionFromNullOr(SymmyJobPrivacyExecutionStoredReceiptSchema),
});
const read = defineScopedRoutine({
  ...base,
  name: 'read_symmy_privacy_execution',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'integer' },
  ],
  resultSchema: Schema.toEncoded(receiptRowSchema),
  routineKey: 'symmy-privacy.read-execution',
});
const lock = defineScopedRoutine({
  ...base,
  name: 'lock_symmy_privacy_execution',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'text' },
  ],
  resultSchema: Schema.toEncoded(receiptRowSchema),
  routineKey: 'symmy-privacy.lock-execution',
});
const record = defineScopedRoutine({
  ...base,
  name: 'record_symmy_privacy_execution',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: Schema.Struct({ recorded: Schema.Boolean }),
  routineKey: 'symmy-privacy.record-execution',
});
const unavailable = (cause: unknown) =>
  Object.defineProperty(new SymmyJobPrivacyExecutionError({ code: 'privacy_execution_unavailable' }), 'cause', {
    value: cause,
  });
export interface SymmyJobPrivacyExecutionRecord {
  readonly actionInvocationId: string;
  readonly actorPrincipalId: string;
  readonly governanceLegalEntityId: string;
  readonly handoffFingerprint: string;
  readonly outcome: SymmyJobPrivacyExecutionStoredReceipt['outcome'];
  readonly receiptId: string;
  readonly resourceId: string;
  readonly resourceKind: 'JOB' | 'SYNC';
  readonly retentionStatus: SymmyJobPrivacyExecutionStoredReceipt['retentionStatus'];
  readonly targetLegalEntityId: string | null;
}
export const symmyJobPrivacyExecutionStore = (transaction: ScopedRoutineInvoker) => ({
  load: Effect.fn('SymmyJobPrivacyExecutionStore.load')(function* load(digest: string, attempt = 0) {
    const [row] = yield* transaction.invoke(read, [digest, attempt]).pipe(Effect.mapError(unavailable));
    if (row === undefined) {
      return yield* new SymmyJobPrivacyExecutionError({ code: 'privacy_execution_unavailable' });
    }
    const decoded = yield* Schema.decodeUnknownEffect(receiptRowSchema)(row).pipe(Effect.mapError(unavailable));
    return decoded.receipt;
  }),
  lock: Effect.fn('SymmyJobPrivacyExecutionStore.lock')(function* lockReceipt(digest: string) {
    const [row] = yield* transaction.invoke(lock, [digest]).pipe(Effect.mapError(unavailable));
    if (row === undefined) {
      return yield* new SymmyJobPrivacyExecutionError({ code: 'privacy_execution_unavailable' });
    }
    const decoded = yield* Schema.decodeUnknownEffect(receiptRowSchema)(row).pipe(Effect.mapError(unavailable));
    return decoded.receipt;
  }),
  record: Effect.fn('SymmyJobPrivacyExecutionStore.record')(function* save(
    digest: string,
    receipt: SymmyJobPrivacyExecutionRecord,
  ) {
    const [row] = yield* transaction.invoke(record, [digest, receipt]).pipe(Effect.mapError(unavailable));
    return row?.recorded === true;
  }),
});
