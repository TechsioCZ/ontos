import { Schema } from 'effect';

export class SourceProvisioningUnavailable extends Schema.TaggedError<SourceProvisioningUnavailable>()(
  'SourceProvisioningUnavailable',
  {
    code: Schema.Literal('source_provisioning_unavailable'),
    reason: Schema.String,
    retryable: Schema.Literal(true),
  },
) {}
