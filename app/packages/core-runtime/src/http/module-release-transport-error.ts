import { Schema } from 'effect';

export class ModuleReleaseTransportError extends Schema.TaggedError<ModuleReleaseTransportError>()(
  'ModuleReleaseTransportError',
  { cause: Schema.optionalKey(Schema.Defect()), reason: Schema.String },
) {}
