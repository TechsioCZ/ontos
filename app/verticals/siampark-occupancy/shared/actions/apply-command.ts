import { OccupancyPersistenceUnavailable } from './errors/occupancy-persistence-unavailable.ts';
import { OccupancyNotFound } from './errors/occupancy-not-found.ts';
import { OccupancyConflict } from './errors/occupancy-conflict.ts';
import { OccupancyRejected } from './errors/occupancy-rejected.ts';
import { ContractRefSchema } from '@app/siampark-agreements/resources/contract';
import { Match, Schema } from 'effect';

import { OccupancySchema } from '../apis/records.ts';
import { OccupancyRefSchema } from '../resources/occupancy.ts';

export const OccupancyCommandSchema = Schema.Union([
  Schema.TaggedStruct('CreateDraft', { record: OccupancySchema }),
  Schema.TaggedStruct('UpdateDraft', {
    endDate: OccupancySchema.fields.endDate,
    occupancyRef: OccupancyRefSchema,
    startDate: OccupancySchema.fields.startDate,
  }),
  Schema.TaggedStruct('Confirm', { occupancyRef: OccupancyRefSchema }),
  Schema.TaggedStruct('Activate', {
    contractRef: Schema.toEncoded(Schema.OptionFromNullOr(ContractRefSchema)),
    occupancyRef: OccupancyRefSchema,
  }),
  Schema.TaggedStruct('Complete', { occupancyRef: OccupancyRefSchema }),
  Schema.TaggedStruct('Cancel', { occupancyRef: OccupancyRefSchema }),
  Schema.TaggedStruct('ImportBooking', {
    correlation: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
    observationId: Schema.toEncoded(Schema.String.check(Schema.isUUID()).pipe(Schema.brand('ResourceId'))),
    outcome: Schema.Literals(['SUCCESS', 'FAILED']),
    record: OccupancySchema,
  }),
  Schema.TaggedStruct('RetryBooking', {
    observationId: Schema.toEncoded(Schema.String.check(Schema.isUUID()).pipe(Schema.brand('ResourceId'))),
    record: OccupancySchema,
  }),
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
