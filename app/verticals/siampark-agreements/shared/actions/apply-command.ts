import { AgreementsPersistenceUnavailable } from './errors/agreements-persistence-unavailable.ts';
import { AgreementsNotFound } from './errors/agreements-not-found.ts';
import { AgreementsConflict } from './errors/agreements-conflict.ts';
import { AgreementsRejected } from './errors/agreements-rejected.ts';
import { Match, Schema } from 'effect';

import { ContractSchema, DocumentSchema } from '../apis/records.ts';
import { ContractRefSchema } from '../resources/contract.ts';
import { DocumentRefSchema } from '../resources/document.ts';

export const AgreementsCommandSchema = Schema.Union([
  Schema.TaggedStruct('CreateContract', { record: ContractSchema }),
  Schema.TaggedStruct('UpdateContract', { record: ContractSchema }),
  Schema.TaggedStruct('ActivateContract', { contractRef: ContractRefSchema }),
  Schema.TaggedStruct('TerminateContract', { contractRef: ContractRefSchema }),
  Schema.TaggedStruct('RenewContract', { contractRef: ContractRefSchema, successor: ContractSchema }),
  Schema.TaggedStruct('SendSignature', {
    contractRef: ContractRefSchema,
    signerContact: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  }),
  Schema.TaggedStruct('ObserveSignature', {
    contractRef: ContractRefSchema,
    document: Schema.toEncoded(Schema.OptionFromNullOr(DocumentSchema)),
    outcome: Schema.Literals(['SIGNED', 'DECLINED']),
  }),
  Schema.TaggedStruct('CreateDocument', { record: DocumentSchema }),
  Schema.TaggedStruct('UpdateDocument', { record: DocumentSchema }),
  Schema.TaggedStruct('FinalizeDocument', { documentRef: DocumentRefSchema }),
  Schema.TaggedStruct('ArchiveDocument', { documentRef: DocumentRefSchema }),
]);
export type AgreementsCommand = typeof AgreementsCommandSchema.Type;
export const ApplyCommandPayloadSchema = Schema.Struct({
  command: AgreementsCommandSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ApplyCommandPayload = typeof ApplyCommandPayloadSchema.Type;
export const ApplyCommandResultSchema = Schema.Struct({
  resourceRef: Schema.Union([ContractRefSchema, DocumentRefSchema]),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const ApplyCommandErrorSchema = Schema.Union([
  AgreementsRejected,
  AgreementsConflict,
  AgreementsNotFound,
  AgreementsPersistenceUnavailable,
]);
export type AgreementsError = typeof ApplyCommandErrorSchema.Type;

export { AgreementsRejected } from './errors/agreements-rejected.ts';

export { AgreementsConflict } from './errors/agreements-conflict.ts';

export { AgreementsNotFound } from './errors/agreements-not-found.ts';

export { AgreementsPersistenceUnavailable } from './errors/agreements-persistence-unavailable.ts';

export const FeedbackSchema = Schema.Literals([
  'loading',
  'ready',
  'saving',
  'forbidden',
  'conflict',
  'validation',
  'unavailable',
]);
export type Feedback = typeof FeedbackSchema.Type;
export const failureFeedback = (failure: { readonly _tag: string; readonly status?: number }): Feedback =>
  Match.value(failure).pipe(
    Match.when({ status: 403 }, () => 'forbidden' as const),
    Match.when({ status: 409 }, () => 'conflict' as const),
    Match.when({ status: 400 }, () => 'validation' as const),
    Match.when({ status: 422 }, () => 'validation' as const),
    Match.when({ _tag: 'SchemaError' }, () => 'validation' as const),
    Match.orElse(() => 'unavailable' as const),
  );
