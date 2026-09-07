import { Schema } from 'effect';

export class ModuleStateDeniedError extends Schema.TaggedError<ModuleStateDeniedError>()(
  'ModuleStateDeniedError',
  { code: Schema.Literal('module_state_denied'), reason: Schema.String },
) {}
