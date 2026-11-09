import { OwnerExecutionOutcomeSchema } from '@app/privacy/domain/privacy-measure-handoff';
import { Schema } from 'effect';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { SymmyJobRetentionResultSchema } from './symmy-job-retention.ts';

export const SymmyJobPrivacyExecutionReceiptSchema = Schema.Struct({
  actionInvocationId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('SymmyPrivacyActionInvocationId')),
  handoffFingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  outcome: OwnerExecutionOutcomeSchema,
});
export type SymmyJobPrivacyExecutionReceipt = typeof SymmyJobPrivacyExecutionReceiptSchema.Type;
export const SymmyJobPrivacyExecutionStoredReceiptSchema = Schema.Struct({
  ...SymmyJobPrivacyExecutionReceiptSchema.fields,
  governanceLegalEntityId: LegalEntityIdSchema,
  retentionStatus: SymmyJobRetentionResultSchema,
  targetLegalEntityId: Schema.OptionFromNullOr(LegalEntityIdSchema),
});
export type SymmyJobPrivacyExecutionStoredReceipt = typeof SymmyJobPrivacyExecutionStoredReceiptSchema.Type;
