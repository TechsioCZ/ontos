import { Schema } from 'effect';

export class ModuleOperationRequirementError extends Schema.TaggedError<ModuleOperationRequirementError>()(
  'ModuleOperationRequirementError',
  {
    code: Schema.Literals(['module_operation_requirement_unavailable', 'module_operation_requirement_unsatisfied']),
    reason: Schema.String,
  },
) {}
