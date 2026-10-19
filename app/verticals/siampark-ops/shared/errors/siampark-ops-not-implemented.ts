import { Schema } from 'effect';

/** Typed stand-in for command logic that lands in the next task. Removed once every command is implemented. */
export class SiamparkOpsNotImplemented extends Schema.TaggedError<SiamparkOpsNotImplemented>()(
  'SiamparkOpsNotImplemented',
  {
    code: Schema.Literal('siampark_ops_not_implemented'),
    reason: Schema.String,
  },
) {}
