import { OccupancyPersistenceUnavailable } from './errors/occupancy-persistence-unavailable.ts';
import { OccupancyNotFound } from './errors/occupancy-not-found.ts';
import { OccupancyConflict } from './errors/occupancy-conflict.ts';
import { OccupancyRejected } from './errors/occupancy-rejected.ts';
import { ContractRefSchema } from '@app/legal-agreements/resources/contract';
import { CounterpartyRefSchema } from '@app/party-registry/resources/counterparty';
import { Match, Schema } from 'effect';

import {
  OccupancySchema,
  RentTermsSchema,
  TenantContactSchema,
  TenantCaseStateSchema,
  TenantCaseDetailsSchema,
  TenantActivityInputSchema,
  NoticeChannelSchema,
  PreparedNoticeSchema,
  RegistrationSheetSchema,
} from '../apis/records.ts';
import { OccupancyRefSchema } from '../resources/occupancy.ts';

export const OccupancyCommandSchema = Schema.Union([
  Schema.TaggedStruct('UpdateTenantDossier', {
    activity: Schema.optionalKey(TenantActivityInputSchema),
    archived: Schema.optionalKey(Schema.Boolean),
    caseDetails: Schema.optionalKey(TenantCaseDetailsSchema),
    caseState: Schema.optionalKey(TenantCaseStateSchema),
    contacts: Schema.optionalKey(Schema.Array(TenantContactSchema).check(Schema.isMaxLength(50))),
    occupancyRef: OccupancyRefSchema,
  }),
  // S01: a prospect or any customer (firm or person) gets contacts, timeline and a business case without a lease.
  Schema.TaggedStruct('UpdateCounterpartyDossier', {
    activity: Schema.optionalKey(TenantActivityInputSchema),
    archived: Schema.optionalKey(Schema.Boolean),
    caseDetails: Schema.optionalKey(TenantCaseDetailsSchema),
    caseState: Schema.optionalKey(TenantCaseStateSchema),
    contacts: Schema.optionalKey(Schema.Array(TenantContactSchema).check(Schema.isMaxLength(50))),
    counterpartyRef: CounterpartyRefSchema,
  }),
  // S10: registration sheet (evidenční list) filled from the reservation or lease.
  Schema.TaggedStruct('CreateRegistrationSheet', {
    note: RegistrationSheetSchema.fields.note,
    occupancyRef: OccupancyRefSchema,
    occupants: RegistrationSheetSchema.fields.occupants,
    purpose: RegistrationSheetSchema.fields.purpose,
    sheetId: RegistrationSheetSchema.fields.sheetId,
  }),
  // S10: notification text prepared from a template; it is stored, never sent by this command.
  Schema.TaggedStruct('PrepareNotice', {
    body: PreparedNoticeSchema.fields.body,
    channel: NoticeChannelSchema,
    noticeId: PreparedNoticeSchema.fields.noticeId,
    occupancyRef: OccupancyRefSchema,
    recipient: PreparedNoticeSchema.fields.recipient,
    subject: PreparedNoticeSchema.fields.subject,
    templateKey: PreparedNoticeSchema.fields.templateKey,
  }),
  Schema.TaggedStruct('CreateDraft', { record: OccupancySchema }),
  Schema.TaggedStruct('UpdateDraft', {
    endDate: OccupancySchema.fields.endDate,
    occupancyRef: OccupancyRefSchema,
    rentTerms: Schema.optionalKey(RentTermsSchema),
    startDate: OccupancySchema.fields.startDate,
  }),
  // Agreed rent can be recorded or corrected while the lease is draft, confirmed or active.
  Schema.TaggedStruct('SetRentTerms', { occupancyRef: OccupancyRefSchema, rentTerms: RentTermsSchema }),
  Schema.TaggedStruct('Confirm', { occupancyRef: OccupancyRefSchema }),
  Schema.TaggedStruct('Activate', {
    contractRef: Schema.toEncoded(Schema.OptionFromNullOr(ContractRefSchema)),
    occupancyRef: OccupancyRefSchema,
  }),
  Schema.TaggedStruct('Complete', { occupancyRef: OccupancyRefSchema }),
  Schema.TaggedStruct('Cancel', { occupancyRef: OccupancyRefSchema }),
]);
export type OccupancyCommand = typeof OccupancyCommandSchema.Type;
export const ApplyCommandPayloadSchema = Schema.Struct({
  command: OccupancyCommandSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ApplyCommandPayload = typeof ApplyCommandPayloadSchema.Type;
export const ApplyCommandResultSchema = Schema.Struct({
  resourceRef: Schema.toEncoded(Schema.OptionFromNullOr(OccupancyRefSchema)),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const ApplyCommandErrorSchema = Schema.Union([
  OccupancyRejected,
  OccupancyConflict,
  OccupancyNotFound,
  OccupancyPersistenceUnavailable,
]);
export type OccupancyError = typeof ApplyCommandErrorSchema.Type;

export { OccupancyRejected } from './errors/occupancy-rejected.ts';

export { OccupancyConflict } from './errors/occupancy-conflict.ts';

export { OccupancyNotFound } from './errors/occupancy-not-found.ts';

export { OccupancyPersistenceUnavailable } from './errors/occupancy-persistence-unavailable.ts';

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
