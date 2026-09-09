import { Schema } from 'effect';

export class ModuleStateCheckUnavailableError extends Schema.TaggedError<ModuleStateCheckUnavailableError>()(
  'ModuleStateCheckUnavailableError',
  {
    code: Schema.Literal('module_state_check_unavailable'),
    reason: Schema.String,
  },
) {}
