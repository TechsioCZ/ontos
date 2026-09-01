/* eslint-disable max-classes-per-file -- One closed sanitized module-gate failure vocabulary. */
import { Schema } from 'effect';

export class ModuleStateDeniedError extends Schema.TaggedError<ModuleStateDeniedError>()(
  'ModuleStateDeniedError',
  {
    code: Schema.Literal('module_state_denied'),
    reason: Schema.String,
  },
) {}

export class ModuleStateCheckUnavailableError extends Schema.TaggedError<ModuleStateCheckUnavailableError>()(
  'ModuleStateCheckUnavailableError',
  {
    code: Schema.Literal('module_state_check_unavailable'),
    reason: Schema.String,
  },
) {}

export type ModuleStateGateError = ModuleStateCheckUnavailableError | ModuleStateDeniedError;
