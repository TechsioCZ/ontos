import { Schema } from 'effect';

export class HistoryRecordNotFound extends Schema.TaggedError<HistoryRecordNotFound>()('HistoryRecordNotFound', {
  code: Schema.Literal('history_record_not_found'),
  reason: Schema.Literal('HISTORICAL_RECORD_NOT_FOUND'),
}) {}
