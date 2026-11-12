import { Schema } from 'effect';

/** A multi-owner process received its hosted module credentials once already. */
export class HostedModuleCredentialsSealedError extends Schema.TaggedError<HostedModuleCredentialsSealedError>()(
  'HostedModuleCredentialsSealedError',
  { cause: Schema.optionalKey(Schema.Defect()), reason: Schema.String },
) {}
