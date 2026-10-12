import { Schema } from 'effect';

/** Typed stand-in for command logic that lands in the next task. Removed once every command is implemented. */
export class MerchandiseNotImplemented extends Schema.TaggedError<MerchandiseNotImplemented>()(
  'MerchandiseNotImplemented',
  {
    code: Schema.Literal('merchandise_not_implemented'),
    reason: Schema.String,
  },
) {}
