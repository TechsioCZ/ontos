// Every schema is built from the one shared constant: one authority, nothing to report.
import { Schema } from 'effect';

export const MODULE_STATES = ['enabled', 'disabled', 'pending'] as const;
const MUTABLE_MODULE_STATES = ['enabled', 'disabled'] as const;

export const ModuleState = Schema.Literals(MODULE_STATES);
export const MirroredModuleState = Schema.Literals(MODULE_STATES);
export const MutableModuleState = Schema.Literals(MUTABLE_MODULE_STATES);

export const ModuleRow = Schema.Struct({
  state: ModuleState,
  requested: Schema.Literals(MODULE_STATES),
});
