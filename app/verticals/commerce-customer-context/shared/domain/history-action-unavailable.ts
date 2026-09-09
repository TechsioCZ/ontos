import { Schema } from 'effect';

const OwnerModuleIdSchema = Schema.String.pipe(
  Schema.brand('HistoryActionOwnerModuleId'),
  Schema.decodeTo(Schema.String),
);

export class HistoryActionUnavailable extends Schema.TaggedError<HistoryActionUnavailable>()(
  'HistoryActionUnavailable',
  {
    code: Schema.Literal('history_action_unavailable'),
    ownerModuleId: OwnerModuleIdSchema,
    reason: Schema.String,
  },
) {}
